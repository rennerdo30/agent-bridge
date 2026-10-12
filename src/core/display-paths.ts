import { realpathSync } from "node:fs";

export interface DriveMapping { alias: string; real: string }
export interface PathDisplaySettings { preferAlias: boolean }
type CanonicalPath = (path: string) => string;
export const PATH_ALIAS_CACHE_TTL_MS = 5_000;
const plain = (path: string) => path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
const driveRoot = (path: string) => {
  const root = plain(path).replace(/\//g, "\\").replace(/\\*$/, "\\").toUpperCase();
  return /^[A-Z]:\\$/.test(root) ? root : null;
};
interface AliasSnapshot {
  observedAt: number;
  mappings: readonly DriveMapping[];
  preferred: ReadonlyMap<string, string>;
}
const snapshots = new WeakMap<CanonicalPath, AliasSnapshot>();
const empty: AliasSnapshot = { observedAt: 0, mappings: [], preferred: new Map() };
let preferAlias = true;

/** Effective process presentation preference; never changes identity or execution paths. */
export function configurePathDisplay(settings: PathDisplaySettings): void { preferAlias = settings.preferAlias; }
export function pathDisplayPrefersAlias(): boolean { return preferAlias; }

function aliases(platform: string, canonical: CanonicalPath, now: number): AliasSnapshot {
  if (platform !== "win32") return empty;
  const previous = snapshots.get(canonical);
  if (previous && now >= previous.observedAt && now - previous.observedAt < PATH_ALIAS_CACHE_TTL_MS) return previous;
  const roots = new Map<string, string>();
  // realpath success proves the drive exists. At most 26 probes per TTL,
  // including negative results; no processes, directory walks or per-file IO.
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try { const real = driveRoot(canonical(root)); if (real) roots.set(root, real); }
    catch { /* Missing/inaccessible drives are not evidence of an alias. */ }
  }
  const mappings: DriveMapping[] = [], preferred = new Map<string, string>();
  for (const [alias, real] of roots) {
    if (alias === real || roots.get(real) !== real) continue;
    mappings.push(Object.freeze({ alias, real }));
    // Multiple verified aliases of one root have a deterministic A-Z preference.
    if (!preferred.has(real)) preferred.set(real, alias);
  }
  const snapshot = { observedAt: now, mappings: Object.freeze(mappings), preferred };
  snapshots.set(canonical, snapshot);
  return snapshot;
}

export function discoverDriveAliases(platform: string = process.platform, canonical: CanonicalPath = realpathSync.native, now: () => number = Date.now): readonly DriveMapping[] {
  return aliases(platform, canonical, now()).mappings;
}

export function displayPath(path: string, platform: string = process.platform, canonical: CanonicalPath = realpathSync.native): string {
  if (!preferAlias) return path;
  const value = plain(path);
  if (!/^[a-z]:[\\/]/i.test(value)) return path;
  const alias = aliases(platform, canonical, Date.now()).preferred.get(`${value[0]!.toUpperCase()}:\\`);
  return alias ? `${alias.slice(0, 2)}${value.slice(2)}` : path;
}

/** Format embedded paths once, using the same cached mapping as standalone paths. */
export function displayPathText(text: string, platform: string = process.platform, canonical: CanonicalPath = realpathSync.native): string {
  if (!preferAlias) return text;
  const preferred = aliases(platform, canonical, Date.now()).preferred;
  if (!preferred.size) return text;
  return text.replace(/(^|[^\w])(?:\\\\\?\\)?([a-z]):([\\/])/gi, (match, prefix: string, drive: string, separator: string) => {
    const alias = preferred.get(`${drive.toUpperCase()}:\\`);
    return alias ? `${prefix}${alias.slice(0, 2)}${separator}` : match;
  });
}
