import { packedRunRecords } from "./finished-run-bundles.js";
import { readFile } from "node:fs/promises";
import { lstatSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { JOBS_FILE } from "./constants.js";
import { indexedJobProjectionCurrent, readIndexedJobs, type ArchiveSelection } from "./job-archive-index.js";
import { isRecord } from "./json-store.js";
import { RUNS_DIR_NAME, type RunMeta } from "./runfeed.js";
import { safeFile } from "./transcripts/common.js";
import { cloneJson, fileSignature, readJsonSnapshot } from "./file-cache.js";
import { drainScan, drainScanResponsive } from "./responsive-scan.js";

export const DEFAULT_RUN_PAGE_SIZE = 50;
export const MAX_RUN_PAGE_SIZE = 500;
export const RUN_LOG_NAME = /^[\w.-]+\.log$/;
// AB-84 also accepts older short unique suffixes; only strip after a known file extension.
const ARCHIVE_SUFFIX = /(\.(?:log|json))-\d+-[\w-]+$/;

/** Unlike readJsonStore, inspection never repairs or renames malformed data. */
export function readHistoryJson(file: string): unknown {
  try { return cloneJson(readJsonSnapshot(file).value); } catch { return null; }
}

function files(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export interface RunLogRecord { name: string; file: string; updatedAt: number; size: number; signature: string; archived: boolean; meta: RunMeta }
const runLogSnapshots = new Map<string, { signature: string; records: RunLogRecord[] }>();
const historyJobSnapshots = new Map<string, { signature: string; jobs: Map<string, Record<string, unknown>> }>();

/** Match independently archived metadata by original name, not by its archive timestamp/UUID. */
export function readRunLogs(home: string, namesFilter?: Set<string>): RunLogRecord[] {
  return drainScan(readRunLogsSteps(home, namesFilter));
}

export function readRunLogsResponsive(home: string, namesFilter?: Set<string>): Promise<RunLogRecord[]> {
  return drainScanResponsive(readRunLogsSteps(home, namesFilter, true));
}

export function* readRunLogsSteps(home: string, namesFilter?: Set<string>, responsive = false): Generator<void, RunLogRecord[]> {
  const root = join(home, RUNS_DIR_NAME);
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync.native(root); } catch { return []; }
  const warmWitness = responsive ? captureWarmRunRoot(root, canonicalRoot) : undefined;
  const records = new Map<string, RunLogRecord>();
  const signatures: string[] = [];
  let complete = !responsive || Boolean(warmWitness), metadataBytes = 0;
  const directories: { archived: boolean; files: { name: string; original: string; file: string; st: Stats }[] }[] = [];
  for (const archived of [true, false]) {
    const dir = archived ? join(root, "archive") : root;
    let canonicalDir: string;
    try { canonicalDir = realpathSync.native(dir); } catch { continue; }
    const rel = relative(canonicalRoot, canonicalDir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(canonicalDir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    // Fresh lstat validates identity and type, including replacements after enumeration.
    // Internal symlinks retain the existing safeFile containment check on every scan.
    const localFile = (entry: import("node:fs").Dirent) => {
      const file = join(canonicalDir, entry.name);
      try {
        const direct = lstatSync(file);
        return direct.isFile() ? { file, st: direct } : direct.isSymbolicLink() ? (() => {
          const actual = safeFile(root, file, canonicalRoot);
          return actual ? { file: actual, st: statSync(actual) } : null;
        })() : null;
      } catch { return null; }
    };
    const selected: typeof directories[number]["files"] = [];
    for (const entry of entries) {
      yield;
      const name = entry.name;
      const original = archived ? name.replace(ARCHIVE_SUFFIX, "$1") : name;
      const extension = original.endsWith(".json") ? ".json" : RUN_LOG_NAME.test(original) ? ".log" : null;
      if (!extension || namesFilter && !namesFilter.has(original.slice(0, -extension.length))) continue;
      const record = localFile(entry);
      if (!record) continue;
      if (warmWitness && !captureWarmRunParents(warmWitness, dirname(record.file))) complete = false;
      signatures.push(`${archived}:${name}:${record.file}:${fileSignature(record.st)}`);
      if (extension === ".json") metadataBytes += record.st.size;
      selected.push({ name, original, ...record });
    }
    directories.push({ archived, files: selected });
  }
  // Packed finished runs (AB-208) come from one indexed query instead of a directory scan.
  const packed = packedRunRecords(home, namesFilter);
  signatures.push(`packed:${packed.length}:${packed.reduce((n, r) => Math.max(n, r.updatedAt), 0)}`);
  const key = `${canonicalRoot}:${namesFilter ? JSON.stringify([...namesFilter].sort()) : "*"}`;
  const signature = signatures.join("\n"), saved = runLogSnapshots.get(key);
  if (saved?.signature === signature) {
    if (!responsive || warmWitness && (yield* stableWarmRunFiles(warmWitness, directories))) return yield* cloneRunRecords(saved.records);
    // Do not reuse discovery paths after a failed witness; the next scan is fresh.
    runLogSnapshots.delete(key);
    return [];
  }
  for (const { archived, files } of directories) {
    const metadata = new Map<string, RunMeta>();
    for (const { original, file, st } of files) {
      yield;
      if (!original.endsWith(".json")) continue;
      try {
        if (responsive && !unchangedContainedFile(root, file, st, canonicalRoot)) { complete = false; continue; }
        const value = readJsonSnapshot(file, { file, stat: st }).value;
        if (isRecord(value)) metadata.set(original, value as RunMeta);
      } catch { complete = false; }
    }
    for (const { original, file, st } of files) {
      yield;
      if (!RUN_LOG_NAME.test(original)) continue;
      try {
        if (!st.isFile()) continue;
        const key = original.slice(0, -".log".length);
        const record = { name: key, file, updatedAt: st.mtimeMs, size: st.size, signature: fileSignature(st), archived, meta: metadata.get(`${key}.json`) ?? {} };
        const previous = records.get(key);
        if (!previous || !archived || record.updatedAt >= previous.updatedAt) records.set(key, record);
      } catch { /* A concurrent archiver may have moved the file; retry on the next read. */ }
    }
  }
  for (const record of packed) if (!records.has(record.name)) records.set(record.name, record as RunLogRecord);
  const result = [...records.values()];
  if (responsive) complete &&= yield* stableRunFiles(root, directories, canonicalRoot);
  runLogSnapshots.delete(key);
  if (complete && metadataBytes <= 256 * 1024 * 1024) runLogSnapshots.set(key, { signature, records: result });
  if (runLogSnapshots.size > 8) runLogSnapshots.delete(runLogSnapshots.keys().next().value!);
  return yield* cloneRunRecords(result);
}

type DirectoryIdentity = { dev: number; ino: number };
interface WarmRunWitness {
  root: string; canonicalRoot: string; alias: DirectoryIdentity;
  parents: Map<string, DirectoryIdentity>; valid: boolean;
}
function sameDirectory(st: Stats, identity: DirectoryIdentity): boolean {
  return st.dev === identity.dev && st.ino === identity.ino;
}
function captureWarmRunRoot(root: string, canonicalRoot: string): WarmRunWitness | undefined {
  try {
    const alias = lstatSync(root), physical = lstatSync(canonicalRoot);
    if ((!alias.isDirectory() && !alias.isSymbolicLink()) || !physical.isDirectory() || physical.isSymbolicLink() || realpathSync.native(root) !== canonicalRoot) return undefined;
    return { root, canonicalRoot, alias: { dev: alias.dev, ino: alias.ino }, parents: new Map([[canonicalRoot, { dev: physical.dev, ino: physical.ino }]]), valid: true };
  } catch { return undefined; }
}
/** Capture each resolved target's physical parent chain before the next suspension. */
function captureWarmRunParents(witness: WarmRunWitness, parent: string): boolean {
  if (!witness.valid) return false;
  const rel = relative(witness.canonicalRoot, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return witness.valid = false;
  try {
    for (let at = parent; !witness.parents.has(at); at = dirname(at)) {
      const st = lstatSync(at);
      if (!st.isDirectory() || st.isSymbolicLink()) return witness.valid = false;
      witness.parents.set(at, { dev: st.dev, ino: st.ino });
    }
    return true;
  } catch { return witness.valid = false; }
}
function warmRunBatchParents(witness: WarmRunWitness, files: { file: string }[]): Set<string> | undefined {
  const parents = new Set([witness.canonicalRoot]);
  for (const file of files) for (let at = dirname(file.file);; at = dirname(at)) {
    if (!witness.parents.has(at)) return undefined;
    parents.add(at);
    if (at === witness.canonicalRoot) break;
    if (dirname(at) === at) return undefined;
  }
  return parents;
}
function unchangedWarmRunParents(witness: WarmRunWitness, parents: Iterable<string> = [witness.canonicalRoot]): boolean {
  if (!witness.valid) return false;
  try {
    const alias = lstatSync(witness.root);
    if (!sameDirectory(alias, witness.alias) || realpathSync.native(witness.root) !== witness.canonicalRoot) return false;
    for (const path of parents) {
      const identity = witness.parents.get(path);
      if (!identity) return false;
      const st = path === witness.root ? alias : lstatSync(path);
      if (!st.isDirectory() || st.isSymbolicLink() || !sameDirectory(st, identity)) return false;
    }
    return true;
  } catch { return false; }
}
/** Warm hits read no bytes. Guard ancestors around each bounded, nonsuspending stat batch. */
function* stableWarmRunFiles(witness: WarmRunWitness, directories: { files: { file: string; st: Stats }[] }[]): Generator<void, boolean> {
  for (const directory of directories) {
    let index = 0;
    while (index < directory.files.length) {
      yield;
      const candidates = directory.files.slice(index, index + 32), parents = warmRunBatchParents(witness, candidates);
      if (!parents || !unchangedWarmRunParents(witness, parents)) return false;
      const started = performance.now(); let checked = 0;
      do {
        const file = directory.files[index++]!;
        try {
          const direct = lstatSync(file.file);
          if (!direct.isFile() || fileSignature(direct) !== fileSignature(file.st)) return false;
        } catch { return false; }
        checked++;
      } while (index < directory.files.length && checked < 32 && performance.now() - started < 4);
      if (!unchangedWarmRunParents(witness, parents)) return false;
    }
  }
  return unchangedWarmRunParents(witness);
}

function* stableRunFiles(root: string, directories: { files: { file: string; st: Stats }[] }[], canonicalRoot: string): Generator<void, boolean> {
  for (const directory of directories) for (const file of directory.files) {
    yield;
    if (!unchangedContainedFile(root, file.file, file.st, canonicalRoot)) return false;
  }
  return true;
}

function* cloneRunRecords(records: RunLogRecord[]): Generator<void, RunLogRecord[]> {
  const result: RunLogRecord[] = [];
  for (const record of records) { yield; result.push(cloneJson(record)); }
  return result;
}

/** A yielding scan must not trust an entry witnessed before a suspension. */
export function unchangedContainedFile(root: string, file: string, before: Stats, canonicalRoot?: string): boolean {
  try {
    const direct = lstatSync(file);
    return direct.isFile() && fileSignature(direct) === fileSignature(before) &&
      safeFile(root, file, canonicalRoot) === file;
  } catch { return false; }
}

/** Receipt boundaries need metadata only, not a stat/read of every unrelated log.
 * Directory entries validate direct files; links retain the same contained read policy. */
export async function readRunStarts(home: string): Promise<{ job: string; jobStartedAt?: number; startedAt: number }[]> {
  const root = join(home, RUNS_DIR_NAME);
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync.native(root); } catch { return []; }
  const starts = new Map<string, { job: string; jobStartedAt?: number; startedAt: number }>();
  for (const archived of [true, false]) {
    let dir: string;
    try { dir = realpathSync.native(archived ? join(root, "archive") : root); } catch { continue; }
    const rel = relative(canonicalRoot, dir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const paths = new Map<string, string>();
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const original = archived ? entry.name.replace(ARCHIVE_SUFFIX, "$1") : entry.name;
      const file = join(dir, entry.name);
      const contained = entry.isFile() ? file : entry.isSymbolicLink() ? safeFile(root, file, canonicalRoot) : null;
      if (contained) {
        const previous = paths.get(original);
        if (previous && original.endsWith(".log")) {
          try { if (statSync(previous).mtimeMs > statSync(contained).mtimeMs) continue; } catch { continue; }
        }
        paths.set(original, contained);
      }
    }
    const metadata: { name: string; runName: string; file: string; log: string }[] = [];
    for (const [name, log] of paths) {
      if (!RUN_LOG_NAME.test(name)) continue;
      const runName = name.slice(0, -4), file = paths.get(`${runName}.json`);
      // Active logs override archived copies even when their metadata is missing/corrupt.
      if (!archived) starts.delete(runName);
      if (file) metadata.push({ name, runName, file, log });
    }
    // Bound open files and yield while cold metadata is read. Peers remain responsive.
    for (let offset = 0; offset < metadata.length; offset += 32) {
      await Promise.all(metadata.slice(offset, offset + 32).map(async ({ name, runName, file, log }) => {
        try {
          // Recheck after enumeration and immediately before an asynchronous read.
          // A newly inserted link must still pass the same storage-root containment guard.
          const direct = lstatSync(file);
          const readable = direct.isFile() ? file : direct.isSymbolicLink() ? safeFile(root, file, canonicalRoot) : null;
          if (!readable) return;
          const before = direct.isFile() ? direct : statSync(readable);
          if (!before.isFile()) return;
          const raw = await readFile(readable, "utf8");
          const after = lstatSync(readable);
          if (!after.isFile() || fileSignature(after) !== fileSignature(before)) return;
          const meta: unknown = JSON.parse(raw);
          if (!isRecord(meta) || typeof meta.job !== "string") return;
          const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(name);
          const startedAt = m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : statSync(log).mtimeMs;
          starts.set(runName, { job: meta.job, startedAt, ...(typeof meta.jobStartedAt === "number" ? { jobStartedAt: meta.jobStartedAt } : {}) });
        } catch { /* Concurrent archival or malformed metadata contributes no evidence. */ }
      }));
    }
  }
  for (const record of packedRunRecords(home)) {
    if (starts.has(record.name) || typeof record.meta.job !== "string") continue;
    const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(record.name);
    starts.set(record.name, { job: record.meta.job, startedAt: m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : record.updatedAt, ...(typeof record.meta.jobStartedAt === "number" ? { jobStartedAt: record.meta.jobStartedAt } : {}) });
  }
  return [...starts.values()];
}

/** All durable job snapshots, oldest first; active records take precedence over archives. */
export function readHistoryJobs(home: string): Map<string, Record<string, unknown>> {
  return drainScan(historyJobCopies(home));
}

function* historyJobCopies(home: string, responsive = false): Generator<void, Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const [name, job] of yield* historyJobsSteps(home, responsive)) { yield; result.set(name, cloneJson(job)); }
  return result;
}

export function readHistoryJobsResponsive(home: string): Promise<Map<string, Record<string, unknown>>> {
  return drainScanResponsive(historyJobCopies(home, true));
}

/** Bounded dashboard pages must not clone every retained prompt to display a few settings. */
export function selectHistoryJobs(home: string, names: ReadonlySet<string>): Map<string, Record<string, unknown>> {
  const snapshot = drainScan(historyJobsSteps(home, false, { names })), selected = new Map<string, Record<string, unknown>>();
  for (const name of names) { const job = snapshot.get(name); if (job) selected.set(name, cloneJson(job)); }
  return selected;
}

export async function selectHistoryJobsResponsive(home: string, names: ReadonlySet<string>): Promise<Map<string, Record<string, unknown>>> {
  return drainScanResponsive((function* () {
    const snapshot = yield* historyJobsSteps(home, true, { names }), selected = new Map<string, Record<string, unknown>>();
    for (const name of names) { yield; const job = snapshot.get(name); if (job) selected.set(name, cloneJson(job)); }
    return selected;
  })());
}

/** Authority recovery needs one record, even when thousands of finished jobs are retained. */
export function findHistoryJob(home: string, ref: string, id: string): Record<string, unknown> | undefined {
  for (const job of drainScan(historyJobsSteps(home, false, { ids: new Set([id]), names: new Set([ref]) })).values()) {
    if (job.name === ref || job.id === id) return cloneJson(job);
  }
  return undefined;
}

function historyJobsSnapshot(home: string): Map<string, Record<string, unknown>> {
  return drainScan(historyJobsSteps(home));
}

/** Internal immutable records; callers must detach every exposed nested value. */
export function* historyJobsSteps(home: string, responsive = false, selection: ArchiveSelection = {}): Generator<void, Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>(), path = join(home, JOBS_FILE);
  if (responsive) yield;
  for (const job of readIndexedJobs(path, { ...selection, history: true }).jobs) {
    if (typeof job.name === "string" && RUN_LOG_NAME.test(job.name + ".log")) out.set(job.name, job);
  }
  if (indexedJobProjectionCurrent(path)) return out;
  // Active compatibility data overrides the index. Validate containment on every
  // read, including a suspended read after an ancestor replacement.
  let canonicalHome: string;
  try { canonicalHome = realpathSync.native(home); } catch { return out; }
  const active = safeFile(home, path, canonicalHome);
  if (!active) return out;
  const st = statSync(active);
  if (responsive) yield;
  if (!unchangedContainedFile(home, active, st, canonicalHome)) return out;
  let value: unknown;
  try { value = readJsonSnapshot(active, { file: active, stat: st }).value; }
  catch { return out; }
  const jobs = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.jobs) ? value.jobs : [];
  for (const job of jobs) {
    if (responsive) yield;
    if (!isRecord(job) || typeof job.name !== "string" || !RUN_LOG_NAME.test(job.name + ".log")) continue;
    if (selection.names || selection.ids) {
      if (!selection.names?.has(job.name) && !selection.ids?.has(String(job.id))) continue;
    }
    out.set(job.name, job);
  }
  if (responsive && !unchangedContainedFile(home, active, st, canonicalHome)) return new Map();
  return out;
}

function* stableHistoryFiles(home: string, files: { file: string; st: Stats }[]): Generator<void, boolean> {
  for (const file of files) { yield; if (!unchangedContainedFile(home, file.file, file.st, home)) return false; }
  return true;
}

export interface RunPage<T> { runs: T[]; next: string | null; total: number }
/**
 * A page of runs, newest first. The first page also carries every run still running, however old, so a
 * long job never drops out of the dashboard behind newer finished ones (later pages may repeat it; the page
 * dedupes by name).
 */
export function pageRuns<T extends { name: string; startedAt: number; status?: string }>(runs: T[], before: string | null, limit: number): RunPage<T> {
  let at: number | undefined, name: string | undefined;
  if (before !== null) {
    const match = /^(\d+)(?::([\w.-]+))?$/.exec(before);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("invalid run cursor");
    at = Number(match[1]); name = match[2];
  }
  const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const older = sorted.filter((run) => at === undefined || run.startedAt < at || (name !== undefined && run.startedAt === at && run.name < name));
  const page = older.slice(0, limit), last = page.at(-1);
  const running = before === null ? older.slice(limit).filter((run) => run.status === "running") : [];
  return { runs: [...page, ...running], next: older.length > page.length && last ? `${last.startedAt}:${last.name}` : null, total: runs.length };
}
