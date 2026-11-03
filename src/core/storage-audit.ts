import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalProjectRoot, projectKey } from "./project-identity.js";
import { fileSignature } from "./file-cache.js";
import { openPreservedReader } from "./storage-preservation.js";

export const AUDIT_LIMITS = { maxDepth: 8, maxEntries: 10_000, maxMs: 5_000, maxRecords: 100 };
export const AUDIT_MAXIMUMS = { maxDepth: 64, maxEntries: 100_000, maxMs: 60_000, maxRecords: 1_000 };
type Limits = typeof AUDIT_LIMITS;
interface Problem { path: string; code: string }
interface AttributionRecord { source: string; job?: string; session?: string; agent?: string; project?: string; workdir?: string; owner?: string }
interface AuditDirectory {
  path: string; createdAt: string | null; modifiedAt: string; bytes: number; directBytes: number; files: number;
  complete: boolean; problems: Problem[]; historicalCause: "unknown";
  project: { canonicalRoot: string | null; reason: string; nestedUnderSameGitRoot: boolean | null };
  attribution: { status: "unknown" | "observed" | "partial"; records: AttributionRecord[]; complete: boolean; problems: Problem[]; meaning: string };
}
const display = (path: string) => path.replace(/^\\\\\?\\/, "").replace(/^D:([\\/])/i, "E:$1");
const same = (a: string, b: string) => projectKey(display(a)) === projectKey(display(b));
const contains = (parent: string, child: string) => {
  const rel = relative(display(parent), display(child));
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
};
const problemCode = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "UNAVAILABLE";
};
function unlinked(path: string): void {
  for (let at = resolve(path); ; at = dirname(at)) {
    if (lstatSync(at).isSymbolicLink()) throw Object.assign(new Error(), { code: "LINK_SKIPPED" });
    if (dirname(at) === at) break;
  }
}
// Metadata text fields only. Control characters cannot become terminal instructions.
const text = (value: unknown): string | undefined => typeof value === "string" && value.length <= 1024
  ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "?") : undefined;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Descriptor-bound, byte-bounded read of allowlisted metadata, never a generic JSON crawler. */
function metadataJson(path: string): unknown {
  unlinked(path);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > 256n * 1024n) throw Object.assign(new Error(), { code: "METADATA_LIMIT_OR_UNSAFE" });
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (fileSignature(before) !== fileSignature(fstatSync(fd, { bigint: true }))) throw new Error();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let n = 0, read = 0;
    do { read = readSync(fd, buffer, n, buffer.length - n, n); n += read; } while (read && n < buffer.length);
    unlinked(path);
    if (n !== Number(before.size) || fileSignature(before) !== fileSignature(lstatSync(path, { bigint: true })) ||
        fileSignature(before) !== fileSignature(fstatSync(fd, { bigint: true }))) throw new Error();
    return JSON.parse(buffer.subarray(0, n).toString("utf8"));
  } finally { closeSync(fd); }
}

/** Explicit-root diagnostic only: no leases, config loaders, migration, broker or writable store APIs. */
export function auditStorage(roots: string[], options: Partial<Limits> = {}) {
  const limits = { ...AUDIT_LIMITS, ...options };
  if (!roots.length || roots.length > 32 || roots.some(root => !root.trim())) throw new Error("Supply 1 to 32 explicit roots.");
  for (const key of Object.keys(limits) as (keyof Limits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < (key === "maxDepth" ? 0 : 1) || limits[key] > AUDIT_MAXIMUMS[key]) throw new Error(`Invalid ${key}.`);
  }
  const started = performance.now(), directories: AuditDirectory[] = [], problems: Problem[] = [];
  const covered = new Set<string>(), counted = new Set<string>(), found = new Map<string, AuditDirectory>();
  const rootResults: { path: string; complete: boolean; problems: Problem[] }[] = [];
  let entries = 0, records = 0, metadataFiles = 0;
  const timedOut = () => performance.now() - started >= limits.maxMs;
  const exhausted = () => entries >= limits.maxEntries || timedOut();
  function attribution(file: string, item: AuditDirectory): void {
    const rel = relative(item.path, file).replace(/\\/g, "/");
    const mirror = /^conversations-[a-f0-9]+\.db$/i.test(rel) || rel === "history.db" || rel === "bridge.db";
    const archive = rel === "job-archive.db";
    const run = /^runs\/\d{4}(?:-\d{2}){5}-[\w.-]+\.json$/.test(rel);
    if (!mirror && !archive && !run && rel !== "jobs.json") return;
    const report = (code: string) => { item.attribution.complete = false; item.attribution.problems.push({ path: display(file), code }); };
    if (records >= limits.maxRecords || metadataFiles >= 128 || timedOut()) { report("ATTRIBUTION_LIMIT"); return; }
    metadataFiles++;
    const add = (value: unknown) => {
      if (records >= limits.maxRecords || timedOut()) { report("ATTRIBUTION_LIMIT"); return; }
      const row = object(value), wt = object(row.worktree);
      const record: AttributionRecord = { source: display(file) };
      for (const [key, value] of Object.entries({ job: row.job ?? row.name, session: row.session ?? row.sessionId,
        agent: row.agent ?? row.byAgent, project: row.project ?? row.projectRoot ?? wt.repoRoot,
        workdir: row.workdir ?? wt.path, owner: row.owner ?? row.by })) {
        const safe = text(value); if (safe) Object.assign(record, { [key]: key === "workdir" || key === "project" ? display(safe) : safe });
      }
      records++;
      if (Object.keys(record).length > 1) item.attribution.records.push(record);
    };
    try {
      if (mirror || archive) {
        if (lstatSync(file).size > 32 * 1024 ** 2) { report("DATABASE_SIZE_LIMIT"); return; }
        const db = openPreservedReader(file, 100);
        try {
          // LIMIT bounds metadata rows; no transcript/body/prompt columns or joins are read.
          const query = mirror ? "SELECT job,session,agent,project FROM conversations LIMIT ?"
            : "SELECT json_extract(metadata,'$.name') AS job, json_extract(metadata,'$.sessionId') AS session, json_extract(metadata,'$.agent') AS agent, json_extract(metadata,'$.projectRoot') AS project, json_extract(metadata,'$.workdir') AS workdir, json_extract(metadata,'$.owner') AS owner FROM job_records LIMIT ?";
          const remaining = limits.maxRecords - records, rows = db.prepare(query).all(remaining + 1);
          for (const row of rows.slice(0, remaining)) add(row);
          if (rows.length > remaining) report("ATTRIBUTION_LIMIT");
        } finally { db.close(); }
      } else {
        const value = metadataJson(file), envelope = object(value);
        const rows = run ? [value] : Array.isArray(value) ? value : Array.isArray(envelope.jobs) ? envelope.jobs : null;
        if (!rows) { report("METADATA_FORMAT_UNKNOWN"); return; }
        for (const row of rows) { if (records >= limits.maxRecords || timedOut()) { report("ATTRIBUTION_LIMIT"); break; } add(row); }
      }
    } catch { report("METADATA_UNAVAILABLE_OR_UNSAFE"); }
  }
  function project(parent: string): AuditDirectory["project"] {
    const root = canonicalProjectRoot(parent, { discoveryOnly: true });
    if (!root) return { canonicalRoot: null, reason: "Current resolver unavailable or excluded; historical cause unknown.", nestedUnderSameGitRoot: null };
    const gitRoot = (() => { try { const st = lstatSync(join(root, ".git")); return st.isDirectory() || st.isFile(); } catch { return false; } })();
    const rel = relative(root, realpathSync.native(parent));
    const nested = gitRoot && rel !== "" && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
    return { canonicalRoot: display(root), reason: gitRoot ? "Current Git/common-directory identity; ordinary Git subdirectories share the repository root."
      : "Current directory fallback (no supported Git root detected); not evidence of historical creation.", nestedUnderSameGitRoot: gitRoot ? nested : null };
  }
  // Visit physical ancestors first so a later overlapping root cannot hide bytes
  // from a storage directory discovered by an earlier, narrower scan.
  const orderedRoots = roots.map(input => {
    const path = resolve(input);
    try { unlinked(path); return { input, physical: realpathSync.native(path) }; }
    catch { return { input, physical: path }; }
  }).sort((a, b) => a.physical.split(/[\\/]/).length - b.physical.split(/[\\/]/).length);
  for (const { input, physical } of orderedRoots) {
    const root = resolve(input), result = { path: display(root), complete: true, problems: [] as Problem[] }; rootResults.push(result);
    const fail = (path: string, code: string, active: AuditDirectory[]) => {
      const p = { path: display(path), code }; result.complete = false; result.problems.push(p); problems.push(p);
      for (const item of active) { item.complete = false; item.problems.push(p); }
    };
    // Every explicit root is validated, even if an ancestor covered its contents or exhausted a budget.
    try {
      unlinked(root);
      if (!lstatSync(root).isDirectory()) { fail(root, "ROOT_NOT_DIRECTORY", []); continue; }
    } catch (error) { fail(root, problemCode(error), []); continue; }
    function visit(path: string, depth: number, active: AuditDirectory[]): void {
      if (timedOut()) { fail(path, "TIME_LIMIT", active); return; }
      try {
        unlinked(path);
        const st = lstatSync(path, { bigint: true });
        const key = projectKey(realpathSync.native(path));
        // Validate the physical entry before reuse, but do not charge proven coverage twice.
        if (st.isDirectory() && covered.has(key)) return;
        if (st.isFile() && depth !== 0 && counted.has(key)) return;
        if (exhausted()) { fail(path, timedOut() ? "TIME_LIMIT" : "ENTRY_LIMIT", active); return; }
        entries++;
        if (st.isFile()) {
          if (depth === 0) { fail(path, "ROOT_NOT_DIRECTORY", active); return; }
          counted.add(key);
          for (const item of active) {
            if (st.size > BigInt(Number.MAX_SAFE_INTEGER - item.bytes)) { fail(path, "SIZE_LIMIT", [item]); continue; }
            item.bytes += Number(st.size); item.files++;
            if (same(dirname(path), item.path)) item.directBytes += Number(st.size);
          }
          const item = active.at(-1); if (item) attribution(path, item);
          return;
        }
        if (!st.isDirectory()) { fail(path, "SPECIAL_FILE_SKIPPED", active); return; }
        // Success proves every descendant was visited, without a depth/budget/error stop.
        const before = result.problems.length;
        if (basename(path) === ".agent-bridge") {
          let item = found.get(key);
          if (!item) {
            if (directories.length >= 128) { fail(path, "DIRECTORY_LIMIT", active); return; }
            item = { path: display(path), createdAt: st.birthtimeMs > 0n ? new Date(Number(st.birthtimeMs)).toISOString() : null,
              modifiedAt: new Date(Number(st.mtimeMs)).toISOString(), bytes: 0, directBytes: 0, files: 0, complete: true, problems: [], historicalCause: "unknown",
              project: project(dirname(path)), attribution: { status: "unknown", records: [], complete: true, problems: [], meaning: "Observed metadata associations, not directory creators; absent or incomplete evidence is unknown." } };
            directories.push(item); found.set(key, item);
          }
          active = [...active, item];
        }
        // Incremental enumeration avoids allocating an unbounded directory listing.
        unlinked(path);
        const dir = opendirSync(path, { bufferSize: 1 });
        try {
          for (;;) {
            if (exhausted()) { fail(path, timedOut() ? "TIME_LIMIT" : "ENTRY_LIMIT", active); break; }
            const entry = dir.readSync(); if (!entry) break;
            if (entry.name === ".git") continue;
            const child = join(path, entry.name);
            if (depth >= limits.maxDepth) { fail(child, "DEPTH_LIMIT", active); break; }
            visit(child, depth + 1, active);
          }
        } finally { dir.closeSync(); }
        if (result.problems.length === before) covered.add(key);
      } catch (error) { fail(path, problemCode(error), active); }
    }
    // A deeper explicit root can extend an already discovered storage directory's recursive total.
    const ancestors = directories.filter(item => !same(item.path, physical) && contains(item.path, physical));
    visit(root, 0, ancestors);
  }
  directories.sort((a, b) => a.path.localeCompare(b.path));
  for (const item of directories) item.attribution.status = !item.attribution.complete || !item.complete ? "partial" : item.attribution.records.length ? "observed" : "unknown";
  return { schemaVersion: 1, readOnly: true, complete: rootResults.every(root => root.complete), limits, entries,
    roots: rootResults, directories, problems, excludedNames: [".git"], sizeMeaning: "Observed logical file bytes, not allocated disk space; partial totals are lower bounds. Overlapping roots are deduplicated; .git entries excluded; no snapshot isolation." };
}
