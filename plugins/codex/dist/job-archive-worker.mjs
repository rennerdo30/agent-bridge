import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  bundleFilesBounded,
  extractBundle,
  retireBundled
} from "./chunks/chunk-7OTBKMYM.mjs";
import {
  importRunnerFiles,
  packArchivedRuns,
  runnerFilesImported
} from "./chunks/chunk-IBXYWH6D.mjs";
import "./chunks/chunk-I32N5HZ3.mjs";
import "./chunks/chunk-HYOPFLLN.mjs";
import "./chunks/chunk-IYJ5P7ML.mjs";
import {
  JSON_STORE_VERSION,
  archivedRecordId,
  assertStoreUpgrade,
  closeMetadataDbs,
  estimatedJsonBytes,
  fileSignature,
  fileTimeMs,
  jobArchivePath,
  jobDigest,
  markJobProjection,
  migrationLock,
  openJobArchive,
  physicalArchivePath,
  putJobRecords,
  refreshStorePeerIdentities
} from "./chunks/chunk-J4YP2FBF.mjs";
import "./chunks/chunk-SDOF5BVV.mjs";
import "./chunks/chunk-4UEZB7GB.mjs";
import "./chunks/chunk-ARGAVNKJ.mjs";
import "./chunks/chunk-6RNADTH4.mjs";

// src/core/job-archive-worker.ts
import { parentPort, workerData } from "node:worker_threads";
import { dirname as dirname2 } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";

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
      const before = lstatSync(path, { bigint: true }), jobs = records(readFileSync(path), path);
      if (fileSignature(lstatSync(path, { bigint: true })) !== fileSignature(before)) throw new Error("active jobs changed during archive import; retry later");
      db.exec("BEGIN IMMEDIATE");
      try {
        putJobRecords(db, jobs, fileTimeMs(before.mtimeMs, before.mtimeNs));
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
var lifecycleQuiesced = false;
var lifecycleUnknown = false;
var operationActive = true;
var lifecycleRequest = null;
var lifecycleRevision = 0;
var idleWake = null;
var resumeWake = null;
function reportLifecycle() {
  if (lifecycleRevision >= Number.MAX_SAFE_INTEGER) lifecycleUnknown = true;
  else lifecycleRevision++;
  parentPort?.postMessage({ archiveLifecycle: {
    ownerInstance: workerData.lifecycleOwner,
    requestId: lifecycleRequest,
    revision: lifecycleRevision,
    quiesced: lifecycleQuiesced,
    pendingOperations: operationActive || repackRequested ? 1 : 0,
    unknown: lifecycleUnknown,
    settled: lifecycleQuiesced && !operationActive && !repackRequested && !lifecycleUnknown && !stop.signal.aborted
  } });
}
async function idleWait(milliseconds) {
  const due = performance.now() + milliseconds;
  while (!stop.signal.aborted) {
    await pauseBetweenOperations();
    const remaining = due - performance.now();
    if (remaining <= 0 || stop.signal.aborted) return;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        stop.signal.removeEventListener("abort", finish);
        if (idleWake === finish) idleWake = null;
        resolve();
      };
      const timer = setTimeout(finish, remaining);
      idleWake = finish;
      stop.signal.addEventListener("abort", finish, { once: true });
    });
  }
}
async function pauseBetweenOperations() {
  while (lifecycleQuiesced && !stop.signal.aborted) {
    if (repackRequested) {
      repackRequested = false;
      operationActive = true;
      reportLifecycle();
      try {
        const runs = await packRuns(home);
        if (runs.packed || runs.failed) parentPort?.postMessage({ packed: runs });
      } catch (error) {
        lifecycleUnknown = true;
        parentPort?.postMessage({ packError: String(error) });
      } finally {
        operationActive = false;
        reportLifecycle();
      }
      continue;
    }
    reportLifecycle();
    await new Promise((resolve) => {
      resumeWake = resolve;
    });
    resumeWake = null;
  }
}
parentPort?.on("message", (message) => {
  if (message?.stop) stop.abort();
  if (message?.stop) {
    idleWake?.();
    resumeWake?.();
    reportLifecycle();
  }
  if (message?.repack) {
    repackRequested = true;
    reportLifecycle();
    if (lifecycleQuiesced) idleWake?.();
    resumeWake?.();
  }
  const control = message?.archiveLifecycle;
  if (!control) return;
  if (control.ownerInstance !== workerData.lifecycleOwner || typeof control.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(control.requestId)) {
    lifecycleUnknown = true;
    reportLifecycle();
    return;
  }
  if (control.kind === "quiesce") {
    lifecycleQuiesced = true;
    lifecycleRequest = control.requestId;
    idleWake?.();
    reportLifecycle();
  } else if (control.kind === "resume" && control.requestId === lifecycleRequest) {
    lifecycleQuiesced = false;
    lifecycleRequest = null;
    resumeWake?.();
    reportLifecycle();
  } else {
    lifecycleUnknown = true;
    reportLifecycle();
  }
});
async function packRuns(home2) {
  let packed = 0, failed = 0;
  try {
    while (!stop.signal.aborted) {
      let batchFailures = 0;
      const batch = packArchivedRuns(home2, void 0, 100, (failure) => {
        batchFailures++;
        lifecycleUnknown = true;
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
  await idleWait(first);
  while (!stop.signal.aborted) {
    await pauseBetweenOperations();
    if (stop.signal.aborted) return;
    operationActive = true;
    reportLifecycle();
    try {
      if (!runnerFilesImported(home2)) {
        try {
          const result = await importRunnerFiles(home2, { signal: stop.signal });
          if (result.deferred || result.remaining) lifecycleUnknown = true;
          if (result.imported || result.remaining) parentPort?.postMessage({ runnerImport: result });
        } catch (error) {
          if (stop.signal.aborted) return;
          lifecycleUnknown = true;
          parentPort?.postMessage({ runnerImportError: String(error) });
        }
      }
      if (repackRequested) {
        repackRequested = false;
        const runs = await packRuns(home2);
        if (runs.packed || runs.failed) parentPort?.postMessage({ packed: runs });
      }
    } finally {
      operationActive = false;
      reportLifecycle();
    }
    await idleWait(interval);
  }
}
var home = dirname2(workerData.path);
try {
  if (!workerData.packOnly) {
    const result = await migrateJobArchives(workerData.path);
    if (result.deferred || result.kept) lifecycleUnknown = true;
    parentPort?.postMessage({ result });
  }
} catch (error) {
  lifecycleUnknown = true;
  parentPort?.postMessage({ error: String(error) });
}
try {
  const runs = await packRuns(home);
  if (runs.packed || runs.failed) parentPort?.postMessage({ packed: runs });
} catch (error) {
  lifecycleUnknown = true;
  parentPort?.postMessage({ packError: String(error) });
}
operationActive = false;
reportLifecycle();
await pauseBetweenOperations();
try {
  if (!workerData.packOnly && !stop.signal.aborted) await importRunners(home);
} catch (error) {
  if (!stop.signal.aborted) {
    lifecycleUnknown = true;
    parentPort?.postMessage({ runnerImportError: String(error) });
  }
} finally {
  closeMetadataDbs();
  parentPort?.close();
}
