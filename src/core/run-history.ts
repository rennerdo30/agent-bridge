import { readFile } from "node:fs/promises";
import { lstatSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { JOBS_FILE } from "./constants.js";
import { isRecord } from "./json-store.js";
import { RUNS_DIR_NAME, type RunMeta } from "./runfeed.js";
import { safeFile } from "./transcripts/common.js";
import { cloneJson, fileSignature, readJsonSnapshot } from "./file-cache.js";

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
  const root = join(home, RUNS_DIR_NAME);
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync.native(root); } catch { return []; }
  const records = new Map<string, RunLogRecord>();
  const signatures: string[] = [];
  let complete = true, metadataBytes = 0;
  const directories: { archived: boolean; files: { name: string; original: string; file: string; st: Stats }[] }[] = [];
  for (const archived of [true, false]) {
    const dir = archived ? join(root, "archive") : root;
    let canonicalDir: string;
    try { canonicalDir = realpathSync.native(dir); } catch { continue; }
    const rel = relative(canonicalRoot, canonicalDir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    const names = files(canonicalDir).sort();
    // Direct files under a validated canonical directory need only lstat, not a full ancestor
    // realpath traversal per poll. Internal symlinks retain the existing safeFile check.
    const localFile = (name: string) => {
      const file = join(canonicalDir, name);
      try {
        const st = lstatSync(file);
        return st.isFile() ? { file, st } : st.isSymbolicLink() ? (() => {
          const actual = safeFile(root, file, canonicalRoot);
          return actual ? { file: actual, st: statSync(actual) } : null;
        })() : null;
      } catch { return null; }
    };
    const selected: typeof directories[number]["files"] = [];
    for (const name of names) {
      const original = archived ? name.replace(ARCHIVE_SUFFIX, "$1") : name;
      const extension = original.endsWith(".json") ? ".json" : RUN_LOG_NAME.test(original) ? ".log" : null;
      if (!extension || namesFilter && !namesFilter.has(original.slice(0, -extension.length))) continue;
      const record = localFile(name);
      if (!record) continue;
      signatures.push(`${archived}:${name}:${record.file}:${fileSignature(record.st)}`);
      if (extension === ".json") metadataBytes += record.st.size;
      selected.push({ name, original, ...record });
    }
    directories.push({ archived, files: selected });
  }
  const key = `${canonicalRoot}:${namesFilter ? JSON.stringify([...namesFilter].sort()) : "*"}`;
  const signature = signatures.join("\n"), saved = runLogSnapshots.get(key);
  if (saved?.signature === signature) return cloneJson(saved.records);
  for (const { archived, files } of directories) {
    const metadata = new Map<string, RunMeta>();
    for (const { original, file } of files) {
      if (!original.endsWith(".json")) continue;
      try {
        const value = readJsonSnapshot(file).value;
        if (isRecord(value)) metadata.set(original, value as RunMeta);
      } catch { complete = false; }
    }
    for (const { original, file, st } of files) {
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
  const result = [...records.values()];
  runLogSnapshots.delete(key);
  if (complete && metadataBytes <= 256 * 1024 * 1024) runLogSnapshots.set(key, { signature, records: result });
  if (runLogSnapshots.size > 8) runLogSnapshots.delete(runLogSnapshots.keys().next().value!);
  return cloneJson(result);
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
          // Read once: a cold 700-run corpus must not perform duplicate metadata/log stats.
          const meta: unknown = JSON.parse(await readFile(file, "utf8"));
          if (!isRecord(meta) || typeof meta.job !== "string") return;
          const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(name);
          const startedAt = m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : statSync(log).mtimeMs;
          starts.set(runName, { job: meta.job, startedAt, ...(typeof meta.jobStartedAt === "number" ? { jobStartedAt: meta.jobStartedAt } : {}) });
        } catch { /* Concurrent archival or malformed metadata contributes no evidence. */ }
      }));
    }
  }
  return [...starts.values()];
}

/** All durable job snapshots, oldest first; active records take precedence over archives. */
export function readHistoryJobs(home: string): Map<string, Record<string, unknown>> {
  return new Map([...historyJobsSnapshot(home)].map(([name, job]) => [name, cloneJson(job)]));
}

/** Bounded dashboard pages must not clone every retained prompt to display a few settings. */
export function selectHistoryJobs(home: string, names: ReadonlySet<string>): Map<string, Record<string, unknown>> {
  const snapshot = historyJobsSnapshot(home), selected = new Map<string, Record<string, unknown>>();
  for (const name of names) { const job = snapshot.get(name); if (job) selected.set(name, cloneJson(job)); }
  return selected;
}

/** Authority recovery needs one record, even when thousands of finished jobs are retained. */
export function findHistoryJob(home: string, ref: string, id: string): Record<string, unknown> | undefined {
  for (const job of historyJobsSnapshot(home).values()) {
    if (job.name === ref || job.id === id) return cloneJson(job);
  }
  return undefined;
}

function historyJobsSnapshot(home: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  let canonicalHome: string;
  try { canonicalHome = realpathSync.native(home); } catch { return out; }
  const archive = join(home, "archive");
  const archived = files(archive).filter((name) => name.startsWith(`${JOBS_FILE}.`) || name.startsWith(`${JOBS_FILE}-`) || /^jobs-.*\.json$/.test(name)).sort();
  const backups = files(home).filter((name) => name.startsWith(`${JOBS_FILE}.backup-`) || name === `${JOBS_FILE}.overflow.json`).sort();
  const snapshots = [...archived.map((name) => join(archive, name)), ...backups.map((name) => join(home, name))];
  const snapshotTime = (file: string) => {
    const stamp = /(?:jobs-|\.backup-|\.overflow\.json-|jobs\.json-)(\d+)/.exec(file)?.[1];
    if (stamp) return Number(stamp);
    try { return statSync(file).mtimeMs; } catch { return 0; }
  };
  snapshots.sort((a, b) => snapshotTime(a) - snapshotTime(b) || (a < b ? -1 : a > b ? 1 : 0));
  const sources: string[] = [], signatures: string[] = [];
  let complete = true;
  let bytes = 0;
  for (const candidate of [...snapshots, join(home, JOBS_FILE)]) {
    const file = safeFile(home, candidate, canonicalHome);
    if (!file) continue;
    try {
      const st = statSync(file);
      sources.push(file); signatures.push(`${file}:${fileSignature(st)}`); bytes += st.size;
    } catch { /* Concurrent archival is observed on the next poll. */ }
  }
  const signature = signatures.join("\n"), saved = historyJobSnapshots.get(canonicalHome);
  if (saved?.signature === signature) return saved.jobs;
  for (const file of sources) {
    let value: unknown;
    try { value = readJsonSnapshot(file).value; }
    catch { complete = false; continue; }
    const jobs = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.jobs) ? value.jobs : [];
    for (const job of jobs) {
      if (!isRecord(job) || typeof job.name !== "string" || !RUN_LOG_NAME.test(`${job.name}.log`)) continue;
      out.set(job.name, { ...out.get(job.name), ...job });
    }
  }
  historyJobSnapshots.delete(canonicalHome);
  if (complete && bytes <= 256 * 1024 * 1024) historyJobSnapshots.set(canonicalHome, { signature, jobs: out });
  if (historyJobSnapshots.size > 4) historyJobSnapshots.delete(historyJobSnapshots.keys().next().value!);
  return out;
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
