import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/display-paths.ts
import { realpath } from "node:fs/promises";
var PATH_ALIAS_CACHE_TTL_MS = 6e4;
var PATH_ALIAS_PROBE_TIMEOUT_MS = 1e3;
var plain = (path) => path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
var driveRoot = (path) => {
  const root = plain(path).replace(/\//g, "\\").replace(/\\*$/, "\\").toUpperCase();
  return /^[A-Z]:\\$/.test(root) ? root : null;
};
var snapshots = /* @__PURE__ */ new WeakMap();
var empty = { observedAt: -Infinity, mappings: [], executionMappings: [], preferred: /* @__PURE__ */ new Map() };
var preferAlias = true;
function configurePathDisplay(settings) {
  preferAlias = settings.preferAlias;
}
function pathDisplayPrefersAlias() {
  return preferAlias;
}
function stateFor(canonical) {
  let state = snapshots.get(canonical);
  if (!state) {
    state = { snapshot: empty, probes: /* @__PURE__ */ new Map() };
    snapshots.set(canonical, state);
  }
  return state;
}
function probeRoot(state, root, canonical) {
  let probe = state.probes.get(root);
  if (!probe) {
    probe = Promise.resolve().then(() => canonical(root)).then((value) => typeof value === "string" ? value : null, () => null);
    state.probes.set(root, probe);
    void probe.then(() => {
      if (state.probes.get(root) === probe) state.probes.delete(root);
    });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), PATH_ALIAS_PROBE_TIMEOUT_MS);
    timer.unref();
    void probe.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
function scheduleRefresh(state, canonical, now) {
  if (state.refresh) return state.refresh;
  const observed = now(), previous = state.snapshot;
  if (observed >= previous.observedAt && observed - previous.observedAt < PATH_ALIAS_CACHE_TTL_MS) return Promise.resolve(previous);
  state.refresh = Promise.resolve().then(async () => {
    const results = await Promise.all(Array.from({ length: 26 }, async (_, index) => {
      const root = `${String.fromCharCode(65 + index)}:\\`;
      return [root, await probeRoot(state, root, canonical)];
    }));
    const roots = /* @__PURE__ */ new Map();
    const executionMappings = [];
    for (const [alias, value] of results) {
      if (value === null) continue;
      const real = driveRoot(value);
      if (real) roots.set(alias, real);
      const physical = plain(value).replace(/[\\/]*$/, "\\");
      if (physical.toUpperCase() !== alias) executionMappings.push(Object.freeze({ alias, real: physical }));
    }
    const mappings = [], preferred = /* @__PURE__ */ new Map();
    for (const [alias, real] of roots) {
      if (alias === real || roots.get(real) !== real) continue;
      mappings.push(Object.freeze({ alias, real }));
      if (!preferred.has(real)) preferred.set(real, alias);
    }
    const snapshot = { observedAt: now(), mappings: Object.freeze(mappings), executionMappings: Object.freeze(executionMappings), preferred };
    state.snapshot = snapshot;
    return snapshot;
  }).catch(() => state.snapshot).finally(() => {
    state.refresh = void 0;
  });
  return state.refresh;
}
function aliases(platform, canonical, now) {
  if (platform !== "win32") return empty;
  const state = stateFor(canonical);
  const observed = now(), previous = state.snapshot.observedAt;
  if (!state.refresh && (observed < previous || observed - previous >= PATH_ALIAS_CACHE_TTL_MS)) void scheduleRefresh(state, canonical, now);
  return state.snapshot;
}
function discoverDriveAliases(platform = process.platform, canonical = realpath, now = Date.now) {
  return aliases(platform, canonical, now).mappings;
}
async function refreshDriveAliases(platform = process.platform, canonical = realpath, now = Date.now) {
  if (platform !== "win32") return [];
  return (await scheduleRefresh(stateFor(canonical), canonical, now)).mappings;
}
function cachedExecutionDriveMappings(platform = process.platform, canonical = realpath) {
  return aliases(platform, canonical, Date.now).executionMappings;
}
async function resolveExecutionDriveRoots(roots, platform = process.platform, canonical = realpath) {
  if (platform !== "win32") return [];
  const state = stateFor(canonical);
  const results = await Promise.all([...new Set(roots)].filter((root) => /^[A-Z]:\\$/.test(root)).map(async (alias) => {
    const value = await probeRoot(state, alias, canonical);
    if (value === null) return null;
    const real = plain(value).replace(/[\\/]*$/, "\\");
    return real.toUpperCase() === alias ? null : { alias, real };
  }));
  return results.filter((mapping) => mapping !== null);
}
function displayPath(path, platform = process.platform, canonical = realpath) {
  if (!preferAlias) return path;
  const value = plain(path);
  if (!/^[a-z]:[\\/]/i.test(value)) return path;
  const alias = aliases(platform, canonical, Date.now).preferred.get(`${value[0].toUpperCase()}:\\`);
  return alias ? `${alias.slice(0, 2)}${value.slice(2)}` : path;
}
function displayPathText(text, platform = process.platform, canonical = realpath) {
  if (!preferAlias || !/[a-z]:[\\/]/i.test(text)) return text;
  const preferred = aliases(platform, canonical, Date.now).preferred;
  if (!preferred.size) return text;
  return text.replace(/(^|[^\w])(?:\\\\\?\\)?([a-z]):([\\/])/gi, (match, prefix, drive, separator) => {
    const alias = preferred.get(`${drive.toUpperCase()}:\\`);
    return alias ? `${prefix}${alias.slice(0, 2)}${separator}` : match;
  });
}

export {
  configurePathDisplay,
  pathDisplayPrefersAlias,
  discoverDriveAliases,
  refreshDriveAliases,
  cachedExecutionDriveMappings,
  resolveExecutionDriveRoots,
  displayPath,
  displayPathText
};
