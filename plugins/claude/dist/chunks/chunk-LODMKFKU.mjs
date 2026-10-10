import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-EJMGZHBU.mjs";
import {
  SQLITE_STORE_VERSION
} from "./chunk-RQUYBZWF.mjs";
import {
  jsonStoreFiles,
  listBackups
} from "./chunk-OW377LLW.mjs";
import {
  acquireLock
} from "./chunk-SXOF3UPC.mjs";
import {
  archiveJobs
} from "./chunk-2ZFUA57N.mjs";
import {
  ARCHIVE_AGE_ENV,
  DEFAULT_ARCHIVE_AGE_MS,
  archiveOldRuns,
  runFileName,
  runLogFiles
} from "./chunk-VZNRE2HD.mjs";
import {
  ARCHIVE_DB_NAME,
  ARCHIVE_STORE_VERSION,
  JSON_STORE_VERSION,
  checkDatabase,
  isRecord,
  maintenanceLock,
  nullLogger,
  retentionLimit,
  storageLease,
  writeJsonStore
} from "./chunk-6D4OVNOD.mjs";
import {
  DB_FILE_NAME,
  JOBS_FILE
} from "./chunk-DLCSA3SJ.mjs";

// src/core/doctor.ts
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
function doctor(home, now = Date.now()) {
  const report = { checkedAt: now, ok: true, schema: [], findings: [], sizes: [], totalBytes: 0, backups: listBackups(home) };
  const finding = (severity, code, path, detail, fixable = false) => report.findings.push({ severity, code, path, detail, fixable });
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        finding("warning", "symlink", path, "Skipped symbolic link");
        continue;
      }
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
  for (const [name, expected] of [[DB_FILE_NAME, SQLITE_STORE_VERSION], [ARCHIVE_DB_NAME, ARCHIVE_STORE_VERSION]]) {
    const path = join(home, name);
    let actual = null;
    if (existsSync(path)) {
      let db = null;
      try {
        db = new DatabaseSync(path, { readOnly: true, timeout: 50 });
        actual = Number(db.prepare("PRAGMA user_version").get().user_version);
        for (const detail of checkDatabase(db)) finding("error", "sqlite-integrity", path, detail);
        if (actual !== expected) finding(actual > expected ? "error" : "warning", "schema-version", path, `Schema ${actual}; code expects ${expected}`);
      } catch (err) {
        finding("error", "sqlite-unreadable", path, String(err));
      } finally {
        db?.close();
      }
    } else finding("info", "missing-database", path, "Database has not been created");
    report.schema.push({ path, actual, expected });
  }
  for (const path of jsonStoreFiles(home)) {
    try {
      if (path.endsWith(".jsonl")) {
        const lines = readFileSync(path, "utf8").split("\n").filter((s) => s.trim());
        for (const line of lines) {
          try {
            const value2 = JSON.parse(line);
            const timed = isRecord(value2) && typeof value2.at === "number" && Number.isFinite(value2.at);
            const ids = timed ? value2.ids : value2;
            if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) finding("error", "journal-shape", path, "Expected read ids with an optional consumption timestamp");
          } catch {
            finding("warning", "journal-partial", path, "Preserved incomplete read-journal append");
          }
        }
        continue;
      }
      const value = JSON.parse(readFileSync(path, "utf8"));
      const jobs = basename(path) === JOBS_FILE || path.includes("jobs.json.overflow.json-") || /^jobs-.*\.json$/.test(basename(path));
      if (jobs ? !(Array.isArray(value) || isRecord(value) && Array.isArray(value.jobs)) : !isRecord(value)) {
        finding("error", "json-shape", path, jobs ? "Expected a jobs array or jobs envelope" : "Expected a JSON object");
        continue;
      }
      const version = isRecord(value) ? value.version : void 0;
      if (version === void 0 || version === 0) finding("warning", "json-legacy", path, "Legacy version; next versioned write will preserve a migration backup");
      else if (!Number.isInteger(version) || version < 0 || version > JSON_STORE_VERSION) finding("error", "json-version", path, `Unsupported JSON version ${String(version)}; code expects ${JSON_STORE_VERSION}`);
      else if (version < JSON_STORE_VERSION) finding("warning", "json-legacy", path, `Earlier JSON version ${String(version)}; code expects ${JSON_STORE_VERSION}`);
      if (dirname(path) === join(home, "runs") && path.endsWith(".json") && !existsSync(path.replace(/\.json$/, ".log"))) finding("warning", "orphan-metadata", path, "Run metadata has no matching active log; preserved for review");
      if (dirname(path) === join(home, "jobs") && path.endsWith(".spec.json") && !existsSync(path.replace(/\.spec\.json$/, ".json"))) finding("warning", "orphan-runner-spec", path, "Runner specification has no state; it may still be starting");
    } catch (err) {
      finding("error", "json-parse", path, String(err));
    }
  }
  const logs = runLogFiles(home);
  for (const path of logs) {
    const meta = join(dirname(path), runFileName(path).replace(/\.log$/, ".json"));
    if (!existsSync(meta) && !readdirSync(dirname(path)).some((f) => f.startsWith(basename(meta) + "-"))) finding("warning", "orphan-log", path, "Run log has no metadata; log remains readable");
  }
  report.ok = !report.findings.some((f) => f.severity === "error");
  return report;
}
function fixDoctor(home, confirmed) {
  if (!confirmed) throw new Error("doctor fixes require confirmation");
  const unlock = maintenanceLock(home);
  try {
    const fixed = [];
    for (const finding of doctor(home).findings.filter((f) => f.fixable)) {
      const dir = join(home, "archive", "orphaned", randomUUID());
      mkdirSync(dir, { recursive: true, mode: 448 });
      const target = join(dir, basename(finding.path));
      renameSync(finding.path, target);
      fixed.push(target);
    }
    return fixed;
  } finally {
    unlock();
  }
}
function archiveHome(home, confirmed, now = Date.now()) {
  if (!confirmed) throw new Error("archiving requires confirmation");
  const age = retentionLimit(ARCHIVE_AGE_ENV, DEFAULT_ARCHIVE_AGE_MS);
  if (!age) return { messages: 0, jobs: 0, runs: 0 };
  const release = storageLease(home);
  try {
    let messages = 0;
    if (existsSync(join(home, DB_FILE_NAME))) {
      const store = new MessageStore(join(home, DB_FILE_NAME), nullLogger);
      try {
        messages = store.purgeOlderThan(now - age);
      } finally {
        store.close();
      }
    }
    let jobs = 0;
    const path = join(home, JOBS_FILE);
    if (existsSync(path)) {
      const unlock = acquireLock(`${path}.lock`);
      try {
        const previous = JSON.parse(readFileSync(path, "utf8"));
        if (!Array.isArray(previous) && !(isRecord(previous) && Array.isArray(previous.jobs))) throw new Error("invalid jobs store");
        const entries = Array.isArray(previous) ? previous : previous.jobs;
        const old = entries.filter((j) => isRecord(j) && ["done", "failed", "cancelled"].includes(String(j.status)) && typeof j.finishedAt === "number" && j.finishedAt < now - age);
        if (old.length) {
          archiveJobs(path, old);
          writeJsonStore(path, { ...isRecord(previous) ? previous : {}, jobs: entries.filter((j) => !old.includes(j)) }, previous);
          jobs = old.length;
        }
      } finally {
        unlock();
      }
    }
    return { messages, jobs, runs: archiveOldRuns(home, now) };
  } finally {
    release();
  }
}

export {
  doctor,
  fixDoctor,
  archiveHome
};
