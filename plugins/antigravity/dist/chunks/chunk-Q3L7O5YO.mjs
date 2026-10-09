import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  readHistoryJson
} from "./chunk-DUH4Q2PF.mjs";
import {
  JSON_STORE_VERSION,
  isRecord,
  metadataDb,
  physicalMetadataPath,
  readJsonStore,
  readMetadataLeaseOwner,
  writeJsonStore
} from "./chunk-NWPQJULH.mjs";
import {
  isProcessIdentityAlive,
  processIdentity
} from "./chunk-4EDVJNL7.mjs";

// src/core/worktree-state.ts
import { createHash } from "node:crypto";
import { lstatSync as lstatSync2 } from "node:fs";
import { join as join2, resolve } from "node:path";

// src/core/worktree-row-lease.ts
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
var PREFIX = "Worktree is running, closing, or has an unreconciled lease; kept unchanged.";
function importLegacy(home) {
  const db = metadataDb(home);
  if (db.prepare("SELECT 1 FROM bridge_components WHERE name='legacy-worktree-leases'").get()) return;
  const dir = join(home, "worktree-leases");
  physicalMetadataPath(dir);
  const entries = existsSync(dir) ? readdirSync(dir).filter((name) => /^[a-f0-9]{64}$/.test(name)) : [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const key2 of entries) {
      const path = join(dir, key2);
      physicalMetadataPath(path);
      const stat = lstatSync(path);
      const owner = stat.isFile() ? readMetadataLeaseOwner(path) : null;
      db.prepare(`INSERT INTO worktree_leases(key,pid,identity,nonce,acquired_at,heartbeat_at,legacy_path)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO NOTHING`).run(key2, owner?.pid ?? null, owner?.identity ?? null, randomUUID(), stat.birthtimeMs, stat.mtimeMs, path);
    }
    db.prepare("INSERT INTO bridge_components VALUES ('legacy-worktree-leases',1) ON CONFLICT(name) DO NOTHING").run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function archive(db, row, reason) {
  db.prepare(`INSERT INTO worktree_lease_archive
  SELECT nonce,key,path,pid,identity,job_id,acquired_at,heartbeat_at,?,?,legacy_path
  FROM worktree_leases WHERE key=? AND nonce=? ON CONFLICT(nonce) DO NOTHING`).run(Date.now(), reason, row.key, row.nonce);
}
function worktreeRowLease(home, key2, path, jobId = null) {
  importLegacy(home);
  const db = metadataDb(home), identity = processIdentity(process.pid);
  if (!identity) throw new Error(`${PREFIX} Cannot verify acquiring process ${process.pid}.`);
  const nonce = randomUUID(), now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM worktree_leases WHERE key=?").get(key2);
    if (row && row.archived_at === null) {
      const alive = row.pid && row.identity ? isProcessIdentityAlive(row.pid, row.identity) : void 0;
      if (alive !== false) throw new Error(`${PREFIX} Holder: ${row.pid ? `pid ${row.pid}` : "unknown legacy owner"}, job ${row.job_id ?? "unknown"}; identity ${alive === true ? "live" : "unverifiable"}.`);
      archive(db, row, "owner identity proved gone");
    }
    db.prepare(`INSERT INTO worktree_leases(key,path,pid,identity,job_id,nonce,acquired_at,heartbeat_at)
   VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
   path=excluded.path,pid=excluded.pid,identity=excluded.identity,job_id=excluded.job_id,
   nonce=excluded.nonce,acquired_at=excluded.acquired_at,heartbeat_at=excluded.heartbeat_at,
   archived_at=NULL,archive_reason=NULL,legacy_path=NULL`).run(key2, path, process.pid, identity, jobId, nonce, now, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  let released = false;
  const timer = setInterval(() => {
    try {
      metadataDb(home).prepare("UPDATE worktree_leases SET heartbeat_at=? WHERE key=? AND nonce=? AND archived_at IS NULL").run(Date.now(), key2, nonce);
    } catch {
    }
  }, 1e4);
  timer.unref();
  return () => {
    if (released) return;
    clearInterval(timer);
    const db2 = metadataDb(home);
    db2.exec("BEGIN IMMEDIATE");
    try {
      const row = db2.prepare("SELECT * FROM worktree_leases WHERE key=? AND nonce=? AND archived_at IS NULL").get(key2, nonce);
      if (row) {
        archive(db2, row, "owner released");
        db2.prepare("UPDATE worktree_leases SET archived_at=?,archive_reason='owner released' WHERE key=? AND nonce=?").run(Date.now(), key2, nonce);
      }
      db2.exec("COMMIT");
      released = true;
    } catch (error) {
      db2.exec("ROLLBACK");
      throw error;
    }
  };
}

// src/core/worktree-state.ts
var WORKTREE_STATE_CONTRACT = 1;
var key = (wt) => createHash("sha256").update(resolve(wt.path).toLowerCase()).digest("hex");
var statePath = (home, wt) => join2(home, "worktree-state", `${key(wt)}.json`);
var rootId = (path) => {
  const stat = lstatSync2(path);
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
};
function readWorktreeState(home, wt) {
  const value = readHistoryJson(statePath(home, wt));
  if (!isRecord(value) || typeof value.version === "number" && value.version > JSON_STORE_VERSION || value.contractVersion !== WORKTREE_STATE_CONTRACT || value.path !== wt.path || value.repoRoot !== wt.repoRoot || value.base !== wt.base || typeof value.rootId !== "string" || !Array.isArray(value.libraries) || !value.libraries.every((p) => typeof p === "string") || typeof value.lastContinuation !== "number") return null;
  return value;
}
function saveWorktreeState(home, wt, value) {
  const path = statePath(home, wt);
  writeJsonStore(path, { ...value }, readJsonStore(path));
}
function recordWorktreeProcessProof(home, wt, stopped) {
  const state = readWorktreeState(home, wt);
  if (state) saveWorktreeState(home, wt, { ...state, processesStopped: stopped });
}
function invalidateWorktreePathProof(home, path) {
  const value = readHistoryJson(statePath(home, { path }));
  if (!isRecord(value) || typeof value.repoRoot !== "string" || typeof value.base !== "string") return;
  const wt = { path, cwd: path, repoRoot: value.repoRoot, base: value.base, branch: "" };
  const state = readWorktreeState(home, wt);
  if (state) saveWorktreeState(home, wt, { ...state, processesStopped: false, lastContinuation: Date.now() });
}
var LEASE_BUSY = "Worktree is running, closing, or has an unreconciled lease; kept unchanged.";
function worktreeLease(home, wt, jobId) {
  try {
    return worktreeRowLease(home, key(wt), wt.path, jobId);
  } catch (error) {
    throw new Error(`${LEASE_BUSY} ${error.message}`);
  }
}

export {
  rootId,
  readWorktreeState,
  saveWorktreeState,
  recordWorktreeProcessProof,
  invalidateWorktreePathProof,
  worktreeLease
};
