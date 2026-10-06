import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JOBS_FILE } from "./constants.js";
import { isRecord } from "./json-store.js";
import { RUNS_DIR_NAME, type RunMeta } from "./runfeed.js";
import { safeFile } from "./transcripts/common.js";

export const DEFAULT_RUN_PAGE_SIZE = 50;
export const MAX_RUN_PAGE_SIZE = 500;
export const RUN_LOG_NAME = /^[\w.-]+\.log$/;
// AB-84 also accepts older short unique suffixes; only strip after a known file extension.
const ARCHIVE_SUFFIX = /(\.(?:log|json))-\d+-[\w-]+$/;

/** Unlike readJsonStore, inspection never repairs or renames malformed data. */
export function readHistoryJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function files(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export interface RunLogRecord { name: string; file: string; updatedAt: number; archived: boolean; meta: RunMeta }

/** Match independently archived metadata by original name, not by its archive timestamp/UUID. */
export function readRunLogs(home: string): RunLogRecord[] {
  const root = join(home, RUNS_DIR_NAME);
  const records = new Map<string, RunLogRecord>();
  for (const archived of [true, false]) {
    const dir = archived ? join(root, "archive") : root;
    const names = files(dir).sort();
    const metadata = new Map<string, RunMeta>();
    for (const name of names) {
      const original = archived ? name.replace(ARCHIVE_SUFFIX, "$1") : name;
      if (!original.endsWith(".json")) continue;
      const file = safeFile(root, join(dir, name));
      const value = file ? readHistoryJson(file) : null;
      if (isRecord(value)) metadata.set(original, value as RunMeta);
    }
    for (const name of names) {
      const original = archived ? name.replace(ARCHIVE_SUFFIX, "$1") : name;
      if (!RUN_LOG_NAME.test(original)) continue;
      const file = safeFile(root, join(dir, name));
      if (!file) continue;
      try {
        const st = statSync(file);
        if (!st.isFile()) continue;
        const key = original.slice(0, -".log".length);
        const record = { name: key, file, updatedAt: st.mtimeMs, archived, meta: metadata.get(`${key}.json`) ?? {} };
        const previous = records.get(key);
        if (!previous || !archived || record.updatedAt >= previous.updatedAt) records.set(key, record);
      } catch { /* A concurrent archiver may have moved the file; retry on the next read. */ }
    }
  }
  return [...records.values()];
}

/** All durable job snapshots, oldest first; active records take precedence over archives. */
export function readHistoryJobs(home: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
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
  for (const candidate of [...snapshots, join(home, JOBS_FILE)]) {
    const file = safeFile(home, candidate);
    const value = file ? readHistoryJson(file) : null;
    const jobs = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.jobs) ? value.jobs : [];
    for (const job of jobs) {
      if (!isRecord(job) || typeof job.name !== "string" || !RUN_LOG_NAME.test(`${job.name}.log`)) continue;
      out.set(job.name, { ...out.get(job.name), ...job });
    }
  }
  return out;
}

export interface RunPage<T> { runs: T[]; next: string | null; total: number }
export function pageRuns<T extends { name: string; startedAt: number }>(runs: T[], before: string | null, limit: number): RunPage<T> {
  let at: number | undefined, name: string | undefined;
  if (before !== null) {
    const match = /^(\d+)(?::([\w.-]+))?$/.exec(before);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("invalid run cursor");
    at = Number(match[1]); name = match[2];
  }
  const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const older = sorted.filter((run) => at === undefined || run.startedAt < at || (name !== undefined && run.startedAt === at && run.name < name));
  const page = older.slice(0, limit), last = page.at(-1);
  return { runs: page, next: older.length > page.length && last ? `${last.startedAt}:${last.name}` : null, total: runs.length };
}
