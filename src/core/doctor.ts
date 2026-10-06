import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE_NAME, JOBS_FILE } from "./constants.js";
import { jsonStoreFiles, listBackups } from "./backups.js";
import { isRecord, JSON_STORE_VERSION, retentionLimit, writeJsonStore } from "./json-store.js";
import { ARCHIVE_DB_NAME, ARCHIVE_STORE_VERSION, checkDatabase } from "./sqlite-maintenance.js";
import { SQLITE_STORE_VERSION, MessageStore } from "./store.js";
import { maintenanceLock, storageLease } from "./storage-lock.js";
import { ARCHIVE_AGE_ENV, DEFAULT_ARCHIVE_AGE_MS, archiveOldRuns, runLogFiles, runFileName } from "./run-archive.js";
import { archiveJobs } from "./job-archive.js";
import { nullLogger } from "./logger.js";
import { acquireLock } from "../mcp/jobs.js";

export interface DoctorFinding {
  severity: "info" | "warning" | "error";
  code: string;
  path: string;
  detail: string;
  fixable: boolean;
}
export interface DoctorReport {
  checkedAt: number;
  ok: boolean;
  schema: { path: string; actual: number | null; expected: number }[];
  findings: DoctorFinding[];
  sizes: { path: string; bytes: number }[];
  totalBytes: number;
  backups: { path: string; createdAt: number }[];
}

/** Strictly read-only: do not use readJsonStore, whose recovery renames corrupt files. */
export function doctor(home: string, now = Date.now()): DoctorReport {
  const report: DoctorReport = { checkedAt: now, ok: true, schema: [], findings: [], sizes: [], totalBytes: 0, backups: listBackups(home) };
  const finding = (severity: DoctorFinding["severity"], code: string, path: string, detail: string, fixable = false) => report.findings.push({ severity, code, path, detail, fixable });
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) { finding("warning", "symlink", path, "Skipped symbolic link"); continue; }
      if (st.isDirectory()) walk(path);
      else {
        report.sizes.push({ path: relative(home, path), bytes: st.size });
        report.totalBytes += st.size;
        if (file.endsWith(".tmp") && !relative(home, path).split(/[\\/]/).some((s) => ["archive", "backups"].includes(s))) finding("warning", "orphan-temp", path, "Temporary file; quarantine only with all writers stopped", true);
        if (file.includes(".corrupt-")) finding("error", "preserved-corrupt", path, "Preserved corrupt data needs manual recovery");
      }
    }
  };
  walk(home);
  for (const [name, expected] of [[DB_FILE_NAME, SQLITE_STORE_VERSION], [ARCHIVE_DB_NAME, ARCHIVE_STORE_VERSION]] as const) {
    const path = join(home, name);
    let actual: number | null = null;
    if (existsSync(path)) {
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(path, { readOnly: true });
        actual = Number(db.prepare("PRAGMA user_version").get()!.user_version);
        for (const detail of checkDatabase(db)) finding("error", "sqlite-integrity", path, detail);
        if (actual !== expected) finding(actual > expected ? "error" : "warning", "schema-version", path, `Schema ${actual}; code expects ${expected}`);
      } catch (err) { finding("error", "sqlite-unreadable", path, String(err)); }
      finally { db?.close(); }
    } else finding("info", "missing-database", path, "Database has not been created");
    report.schema.push({ path, actual, expected });
  }
  for (const path of jsonStoreFiles(home)) {
    try {
      if (path.endsWith(".jsonl")) {
        const lines = readFileSync(path, "utf8").split("\n").filter((s) => s.trim());
        for (const line of lines) {
          try {
            const value: unknown = JSON.parse(line);
            const timed = isRecord(value) && typeof value.at === "number" && Number.isFinite(value.at);
            const ids = timed ? value.ids : value;
            if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) finding("error", "journal-shape", path, "Expected read ids with an optional consumption timestamp");
          } catch { finding("warning", "journal-partial", path, "Preserved incomplete read-journal append"); }
        }
        continue;
      }
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      const jobs = basename(path) === JOBS_FILE || path.includes("jobs.json.overflow.json-") || /^jobs-.*\.json$/.test(basename(path));
      if (jobs ? !(Array.isArray(value) || isRecord(value) && Array.isArray(value.jobs)) : !isRecord(value)) {
        finding("error", "json-shape", path, jobs ? "Expected a jobs array or jobs envelope" : "Expected a JSON object");
        continue;
      }
      const version = isRecord(value) ? value.version : undefined;
      if (version === undefined || version === 0) finding("warning", "json-legacy", path, "Legacy version; next versioned write will preserve a migration backup");
      else if (!Number.isInteger(version) || (version as number) < 0 || (version as number) > JSON_STORE_VERSION) finding("error", "json-version", path, `Unsupported JSON version ${String(version)}; code expects ${JSON_STORE_VERSION}`);
      else if ((version as number) < JSON_STORE_VERSION) finding("warning", "json-legacy", path, `Earlier JSON version ${String(version)}; code expects ${JSON_STORE_VERSION}`);
      if (dirname(path) === join(home, "runs") && path.endsWith(".json") && !existsSync(path.replace(/\.json$/, ".log"))) finding("warning", "orphan-metadata", path, "Run metadata has no matching active log; preserved for review");
      if (dirname(path) === join(home, "jobs") && path.endsWith(".spec.json") && !existsSync(path.replace(/\.spec\.json$/, ".json"))) finding("warning", "orphan-runner-spec", path, "Runner specification has no state; it may still be starting");
    } catch (err) { finding("error", "json-parse", path, String(err)); }
  }
  const logs = runLogFiles(home);
  for (const path of logs) {
    const meta = join(dirname(path), runFileName(path).replace(/\.log$/, ".json"));
    if (!existsSync(meta) && !readdirSync(dirname(path)).some((f) => f.startsWith(basename(meta) + "-"))) finding("warning", "orphan-log", path, "Run log has no metadata; log remains readable");
  }
  report.ok = !report.findings.some((f) => f.severity === "error");
  return report;
}

/** The only automatic repair is preserving orphan temporary files, never guessing missing data. */
export function fixDoctor(home: string, confirmed: boolean): string[] {
  if (!confirmed) throw new Error("doctor fixes require confirmation");
  const unlock = maintenanceLock(home);
  try {
    const fixed: string[] = [];
    for (const finding of doctor(home).findings.filter((f) => f.fixable)) {
      const dir = join(home, "archive", "orphaned", randomUUID());
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const target = join(dir, basename(finding.path));
      renameSync(finding.path, target);
      fixed.push(target);
    }
    return fixed;
  } finally { unlock(); }
}

export function archiveHome(home: string, confirmed: boolean, now = Date.now()): { messages: number; jobs: number; runs: number } {
  if (!confirmed) throw new Error("archiving requires confirmation");
  const age = retentionLimit(ARCHIVE_AGE_ENV, DEFAULT_ARCHIVE_AGE_MS);
  if (!age) return { messages: 0, jobs: 0, runs: 0 };
  const release = storageLease(home);
  try {
    let messages = 0;
    if (existsSync(join(home, DB_FILE_NAME))) {
      const store = new MessageStore(join(home, DB_FILE_NAME), nullLogger);
      try { messages = store.purgeOlderThan(now - age); } finally { store.close(); }
    }
    let jobs = 0;
    const path = join(home, JOBS_FILE);
    if (existsSync(path)) {
      const unlock = acquireLock(`${path}.lock`);
      try {
        const previous: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!Array.isArray(previous) && !(isRecord(previous) && Array.isArray(previous.jobs))) throw new Error("invalid jobs store");
        const entries: unknown[] = Array.isArray(previous) ? previous : (previous as Record<string, unknown>).jobs as unknown[];
        const old = entries.filter((j) => isRecord(j) && (j.status === "done" || j.status === "failed") && typeof j.finishedAt === "number" && j.finishedAt < now - age);
        if (old.length) {
          archiveJobs(path, old);
          writeJsonStore(path, { ...(isRecord(previous) ? previous : {}), jobs: entries.filter((j) => !old.includes(j)) }, previous);
          jobs = old.length;
        }
      } finally { unlock(); }
    }
    return { messages, jobs, runs: archiveOldRuns(home, now) };
  } finally { release(); }
}
