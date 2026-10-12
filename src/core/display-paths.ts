import { realpath } from "node:fs/promises";

export interface DriveMapping { alias: string; real: string }
export interface PathDisplaySettings { preferAlias: boolean }
export type CanonicalPath = (path: string) => Promise<string> | string;
export const PATH_ALIAS_CACHE_TTL_MS = 60_000;
export const PATH_ALIAS_PROBE_TIMEOUT_MS = 1_000;
const plain = (path: string) => path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
const driveRoot = (path: string) => {
  const root = plain(path).replace(/\//g, "\\").replace(/\\*$/, "\\").toUpperCase();
  return /^[A-Z]:\\$/.test(root) ? root : null;
};
interface AliasSnapshot {
  observedAt: number;
  mappings: readonly DriveMapping[];
  executionMappings: readonly DriveMapping[];
  preferred: ReadonlyMap<string, string>;
}
interface AliasState {
  snapshot: AliasSnapshot;
  refresh?: Promise<AliasSnapshot>;
  probes: Map<string, Promise<string | null>>;
}
const snapshots = new WeakMap<CanonicalPath, AliasState>();
const empty: AliasSnapshot = { observedAt: -Infinity, mappings: [], executionMappings: [], preferred: new Map() };
let preferAlias = true;

/** Effective process presentation preference; never changes identity or execution paths. */
export function configurePathDisplay(settings: PathDisplaySettings): void { preferAlias = settings.preferAlias; }
export function pathDisplayPrefersAlias(): boolean { return preferAlias; }

function stateFor(canonical: CanonicalPath): AliasState {
  let state = snapshots.get(canonical);
  if (!state) { state = { snapshot: empty, probes: new Map() }; snapshots.set(canonical, state); }
  return state;
}

function probeRoot(state: AliasState, root: string, canonical: CanonicalPath): Promise<string | null> {
  let probe = state.probes.get(root);
  if (!probe) {
    // Never invoke a resolver in a display call's stack. A timed-out OS request
    // cannot be cancelled by realpath; retain it so future refreshes never duplicate it.
    probe = Promise.resolve().then(() => canonical(root)).then((value) => typeof value === "string" ? value : null, () => null);
    state.probes.set(root, probe);
    void probe.then(() => { if (state.probes.get(root) === probe) state.probes.delete(root); });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), PATH_ALIAS_PROBE_TIMEOUT_MS);
    timer.unref();
    void probe!.then((value) => { clearTimeout(timer); resolve(value); });
  });
}

function scheduleRefresh(state: AliasState, canonical: CanonicalPath, now: () => number): Promise<AliasSnapshot> {
  if (state.refresh) return state.refresh;
  const observed = now(), previous = state.snapshot;
  if (observed >= previous.observedAt && observed - previous.observedAt < PATH_ALIAS_CACHE_TTL_MS) return Promise.resolve(previous);
  // Lazy, parallel and bounded: no refresh interval or timer is kept alive while idle.
  state.refresh = Promise.resolve().then(async () => {
    const results = await Promise.all(Array.from({ length: 26 }, async (_, index) => {
      const root = `${String.fromCharCode(65 + index)}:\\`;
      return [root, await probeRoot(state, root, canonical)] as const;
    }));
    const roots = new Map<string, string>();
    const executionMappings: DriveMapping[] = [];
    for (const [alias, value] of results) {
      if (value === null) continue;
      const real = driveRoot(value);
      if (real) roots.set(alias, real);
      const physical = plain(value).replace(/[\\/]*$/, "\\");
      if (physical.toUpperCase() !== alias) executionMappings.push(Object.freeze({ alias, real: physical }));
    }
    const mappings: DriveMapping[] = [], preferred = new Map<string, string>();
    for (const [alias, real] of roots) {
      if (alias === real || roots.get(real) !== real) continue;
      mappings.push(Object.freeze({ alias, real }));
      // Multiple verified aliases of one root have a deterministic A-Z preference.
      if (!preferred.has(real)) preferred.set(real, alias);
    }
    const snapshot = { observedAt: now(), mappings: Object.freeze(mappings), executionMappings: Object.freeze(executionMappings), preferred };
    state.snapshot = snapshot;
    return snapshot;
  }).catch(() => state.snapshot).finally(() => { state.refresh = undefined; });
  return state.refresh;
}

function aliases(platform: string, canonical: CanonicalPath, now: () => number): AliasSnapshot {
  if (platform !== "win32") return empty;
  const state = stateFor(canonical);
  const observed = now(), previous = state.snapshot.observedAt;
  if (!state.refresh && (observed < previous || observed - previous >= PATH_ALIAS_CACHE_TTL_MS)) void scheduleRefresh(state, canonical, now);
  return state.snapshot;
}

export function discoverDriveAliases(platform: string = process.platform, canonical: CanonicalPath = realpath, now: () => number = Date.now): readonly DriveMapping[] {
  return aliases(platform, canonical, now).mappings;
}

/** Only native preparation/tests await a refresh; display/report callers never do. */
export async function refreshDriveAliases(platform: string = process.platform, canonical: CanonicalPath = realpath, now: () => number = Date.now): Promise<readonly DriveMapping[]> {
  if (platform !== "win32") return [];
  return (await scheduleRefresh(stateFor(canonical), canonical, now)).mappings;
}

/** Includes subfolder/UNC resolutions for sandbox execution, never for alias display. */
export function cachedExecutionDriveMappings(platform: string = process.platform, canonical: CanonicalPath = realpath): readonly DriveMapping[] {
  return aliases(platform, canonical, Date.now).executionMappings;
}

/** Native preparation can validate requested roots without trusting a stale display snapshot. */
export async function resolveExecutionDriveRoots(roots: readonly string[], platform: string = process.platform, canonical: CanonicalPath = realpath): Promise<DriveMapping[]> {
  if (platform !== "win32") return [];
  const state = stateFor(canonical);
  const results = await Promise.all([...new Set(roots)].filter((root) => /^[A-Z]:\\$/.test(root)).map(async (alias) => {
    const value = await probeRoot(state, alias, canonical);
    if (value === null) return null;
    const real = plain(value).replace(/[\\/]*$/, "\\");
    return real.toUpperCase() === alias ? null : { alias, real };
  }));
  return results.filter((mapping): mapping is DriveMapping => mapping !== null);
}

export function displayPath(path: string, platform: string = process.platform, canonical: CanonicalPath = realpath): string {
  if (!preferAlias) return path;
  const value = plain(path);
  if (!/^[a-z]:[\\/]/i.test(value)) return path;
  const alias = aliases(platform, canonical, Date.now).preferred.get(`${value[0]!.toUpperCase()}:\\`);
  return alias ? `${alias.slice(0, 2)}${value.slice(2)}` : path;
}

/** Format embedded paths once, using the same cached mapping as standalone paths. */
export function displayPathText(text: string, platform: string = process.platform, canonical: CanonicalPath = realpath): string {
  if (!preferAlias || !/[a-z]:[\\/]/i.test(text)) return text;
  const preferred = aliases(platform, canonical, Date.now).preferred;
  if (!preferred.size) return text;
  return text.replace(/(^|[^\w])(?:\\\\\?\\)?([a-z]):([\\/])/gi, (match, prefix: string, drive: string, separator: string) => {
    const alias = preferred.get(`${drive.toUpperCase()}:\\`);
    return alias ? `${prefix}${alias.slice(0, 2)}${separator}` : match;
  });
}
