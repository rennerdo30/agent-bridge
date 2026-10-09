import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  bundleFilesBounded,
  extractBundle,
  retireBundled
} from "./chunks/chunk-R5DQIVZ4.mjs";
import {
  importRunnerFiles,
  packArchivedRuns,
  runnerFilesImported
} from "./chunks/chunk-OG3EDS6T.mjs";
import "./chunks/chunk-2BSEKRNX.mjs";
import "./chunks/chunk-TFQZM67X.mjs";
import {
  JSON_STORE_VERSION,
  archivedRecordId,
  assertStoreUpgrade,
  closeMetadataDbs,
  estimatedJsonBytes,
  fileSignature,
  jobArchivePath,
  jobDigest,
  markJobProjection,
  migrationLock,
  openJobArchive,
  physicalArchivePath,
  putJobRecords,
  refreshStorePeerIdentities
} from "./chunks/chunk-OMBGRGBY.mjs";
import "./chunks/chunk-ENZISWMO.mjs";
import "./chunks/chunk-Q372BWBW.mjs";
import "./chunks/chunk-HHAVWD7J.mjs";

// src/core/job-archive-worker.ts
import { parentPort, workerData } from "node:worker_threads";
import { dirname as dirname2 } from "node:path";
import { setImmediate as yieldTurn, setTimeout as sleep } from "node:timers/promises";

// src/core/job-archive-migration.ts
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as yieldWriter } from "node:timers/promises";
var isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var acceptArchive = (name) => /^jobs-.*\.json$/.test(name) || /^jobs\.json(?:-|\.(?:overflow\.json|backup)-)/.test(name);
function records(raw, file) {
  const value = JSON.parse(raw.toString("utf8"));
  if (isRecord(value) && value.version !== void 0 && (!Number.isInteger(value.version) || Number(value.version) < 0 || Number(value.version) > JSON_STORE_VERSION))
    throw new Error(`unsupported job archive: ${basename(file)}; originals retained`);
  const jobs = Array.isArray(value) ? value : isRecord(value) ? value.jobs : void 0;
  if (!Array.isArray(jobs)) throw new Error(`invalid job archive: ${basename(file)}; originals retained`);
  return jobs;
}
async function migrateJobArchives(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  physicalArchivePath(path);
  const release = migrationLock(`${jobArchivePath(path)}.legacy`);
  let close = () => {
  };
  const result = { imported: 0, moved: 0, kept: 0, deferred: false, manifests: [] };
  try {
    const db = openJobArchive(path, true);
    close = () => db.close();
    const state = db.prepare("SELECT state FROM archive_migrations WHERE version=1").get();
    if (state?.state === "complete") return result;
    const groups = [];
    for (const dir of [join(dirname(path), "archive"), dirname(path)]) {
      if (!existsSync(dir)) continue;
      physicalArchivePath(dir);
      const names = readdirSync(dir).filter((name) => dir === dirname(path) ? /^jobs\.json\.backup-/.test(name) || name === "jobs.json.overflow.json" : acceptArchive(name));
      names.sort((a, b) => {
        const time = (n) => Number(/(?:^jobs-|jobs\.json-|\.backup-|\.overflow\.json-)(\d+)/.exec(n)?.[1] ?? lstatSync(join(dir, n)).mtimeMs);
        return time(a) - time(b) || a.localeCompare(b);
      });
      groups.push({ dir, names });
    }
    const imported = /* @__PURE__ */ new Map();
    const verified = /* @__PURE__ */ new Set();
    let parsedBytes = 0;
    const importSource = (file, raw) => {
      const digest = jobDigest(raw);
      if (db.prepare("SELECT 1 FROM archive_sources WHERE path=? AND sha256=?").get(file, digest)) return;
      let jobs = imported.get(digest);
      if (!jobs) {
        jobs = records(raw, file);
        const cost = estimatedJsonBytes(jobs, 16 * 1024 * 1024);
        if (cost + parsedBytes <= 16 * 1024 * 1024) {
          imported.set(digest, jobs);
          parsedBytes += cost;
        }
      }
      const ownTransaction = !db.isTransaction;
      if (ownTransaction) db.exec("BEGIN IMMEDIATE");
      try {
        {
          const stamp = /(?:^jobs-|jobs\.json-|\.backup-|\.overflow\.json-)(\d+)/.exec(basename(file))?.[1];
          putJobRecords(db, jobs, stamp ? Number(stamp) : lstatSync(file).mtimeMs, false, true);
          const query = db.prepare("SELECT payload FROM job_versions WHERE id=? AND sha256=?");
          for (const job of verified.has(digest) ? [] : jobs) if (isRecord(job) && archivedRecordId(job) !== void 0) {
            const json = JSON.stringify(job), row = query.get(archivedRecordId(job), jobDigest(json));
            if (!row || row.payload !== json) throw new Error("job archive import verification failed; originals retained");
          }
          verified.add(digest);
        }
        db.prepare("INSERT INTO archive_sources(path,sha256,imported_at) VALUES(?,?,?)").run(file, digest, Date.now());
        if (ownTransaction) db.exec("COMMIT");
        result.imported++;
      } catch (error) {
        if (ownTransaction && db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    };
    for (const group of groups) for (let offset = 0; offset < group.names.length; offset += 32) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const name of group.names.slice(offset, offset + 32)) {
          const file = join(group.dir, name);
          physicalArchivePath(file);
          const st = lstatSync(file);
          if (!st.isFile()) throw new Error("job archive entry must be a physical file");
          importSource(file, readFileSync(file));
        }
        db.exec("COMMIT");
        await yieldWriter(5);
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    }
    if (existsSync(path)) {
      physicalArchivePath(path);
      const before = lstatSync(path), jobs = records(readFileSync(path), path);
      if (fileSignature(lstatSync(path)) !== fileSignature(before)) throw new Error("active jobs changed during archive import; retry later");
      db.exec("BEGIN IMMEDIATE");
      try {
        putJobRecords(db, jobs, before.mtimeMs);
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
      markJobProjection(path, jobs, fileSignature(before));
    }
    db.prepare("INSERT INTO archive_migrations(version,state) VALUES(1,'imported') ON CONFLICT(version) DO UPDATE SET state='imported'").run();
    await refreshStorePeerIdentities(dirname(path));
    try {
      assertStoreUpgrade(dirname(path), "jobArchive", 0, 1);
    } catch (error) {
      if (error.code !== "STORE_UPGRADE_DEFERRED") throw error;
      result.deferred = true;
      return result;
    }
    const cold = join(dirname(path), "cold-storage", "jobs-v1");
    physicalArchivePath(cold);
    mkdirSync(cold, { recursive: true, mode: 448 });
    physicalArchivePath(join(cold, "archive"));
    for (const group of groups) {
      if (!group.names.length) continue;
      for (const manifest of bundleFilesBounded(group.dir, group.names, cold)) {
        result.manifests.push(manifest);
        for (const [name, raw] of extractBundle(manifest)) importSource(join(group.dir, name), raw);
        const originals = join(cold, group.dir === dirname(path) ? "root-originals" : "archive-originals");
        physicalArchivePath(originals);
        const moved = retireBundled(group.dir, manifest, originals);
        result.moved += moved.moved.length;
        result.kept += moved.kept.length;
      }
    }
    if (!result.kept) db.prepare("UPDATE archive_migrations SET state='complete' WHERE version=1").run();
    return result;
  } finally {
    try {
      close();
    } finally {
      release();
    }
  }
}

// src/core/job-archive-worker.ts
var stop = new AbortController();
var repackRequested = false;
parentPort?.on("message", (message) => {
  if (message?.stop) stop.abort();
  if (message?.repack) repackRequested = true;
});
async function packRuns(home2) {
  let packed = 0, failed = 0;
  try {
    while (!stop.signal.aborted) {
      let batchFailures = 0;
      const batch = packArchivedRuns(home2, void 0, 100, (failure) => {
        batchFailures++;
        parentPort?.postMessage({ warning: "archived run kept in place, not packed", failure });
      });
      packed += batch;
      failed += batchFailures;
      if (!batch && !batchFailures) break;
      await yieldTurn();
    }
  } finally {
    closeMetadataDbs();
  }
  return { packed, failed };
}
async function importRunners(home2) {
  const raw = process.env.AGENT_BRIDGE_RUNNER_IMPORT_DELAY_MS;
  if (raw === "off") return;
  const first = raw === void 0 || !/^\d+$/.test(raw) ? 3e4 : Number(raw);
  const interval = 6e4;
  await sleep(first, void 0, { signal: stop.signal });
  for (; ; ) {
    if (!runnerFilesImported(home2)) {
      try {
        const result = await importRunnerFiles(home2, { signal: stop.signal });
        if (result.imported || result.remaining) parentPort?.postMessage({ runnerImport: result });
      } catch (error) {
        if (stop.signal.aborted) return;
        parentPort?.postMessage({ runnerImportError: String(error) });
      }
    }
    if (repackRequested) {
      repackRequested = false;
      const runs = await packRuns(home2);
      if (runs.packed || runs.failed) parentPort?.postMessage({ packed: runs });
    }
    await sleep(interval, void 0, { signal: stop.signal });
  }
}
var home = dirname2(workerData.path);
try {
  if (!workerData.packOnly) parentPort?.postMessage({ result: await migrateJobArchives(workerData.path) });
} catch (error) {
  parentPort?.postMessage({ error: String(error) });
}
try {
  const runs = await packRuns(home);
  if (runs.packed || runs.failed) parentPort?.postMessage({ packed: runs });
} catch (error) {
  parentPort?.postMessage({ packError: String(error) });
}
try {
  if (!workerData.packOnly && !stop.signal.aborted) await importRunners(home);
} catch (error) {
  if (!stop.signal.aborted) parentPort?.postMessage({ runnerImportError: String(error) });
} finally {
  closeMetadataDbs();
  parentPort?.close();
}
