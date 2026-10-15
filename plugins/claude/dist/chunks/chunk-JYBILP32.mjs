import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  SQLITE_STORE_VERSION
} from "./chunk-RQUYBZWF.mjs";
import {
  HistoryIndex
} from "./chunk-3WG4KJ4A.mjs";
import {
  CONVERSATION_MIGRATION,
  cleanupSavepoint
} from "./chunk-TTRPTYLF.mjs";
import {
  historyDbPath,
  historySchema,
  openHistoryStore
} from "./chunk-SOSAKSVH.mjs";
import {
  AUTO_BACKUP_ENV,
  BACKUP_INTERVAL_ENV,
  DEFAULT_BACKUP_INTERVAL_MS
} from "./chunk-MM32GUX3.mjs";
import {
  bundleDirectory
} from "./chunk-D5ZW6VFT.mjs";
import {
  DECISIONS_SCHEMA,
  DecisionStore
} from "./chunk-BOKHWZQ3.mjs";
import {
  isPluginCacheCwd
} from "./chunk-RE3I7AXX.mjs";
import {
  SIBLING_CONVERSATION_PREFIX,
  isQuietMessage
} from "./chunk-IYJ5P7ML.mjs";
import {
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_REQUEST_BUSY_MS,
  archiveDbPath,
  archiveMessages,
  configureSqlite,
  ensureMessageQuarantine,
  isSqliteBusy,
  migrateSqlite,
  openArchive,
  retentionLimit,
  retrySqlite,
  storageLease,
  unquarantined
} from "./chunk-JJ6UMMYX.mjs";

// src/core/store.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, realpathSync } from "node:fs";
import { dirname as dirname3, resolve } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

// src/core/backup-background.ts
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var BackupBackground = class {
  constructor(home, log) {
    this.home = home;
    this.log = log;
    if (this.enabled) this.schedule(3e4);
  }
  home;
  log;
  worker = null;
  timer = null;
  pending = false;
  pauseUntil = 0;
  stopped = false;
  failed = false;
  enabled = process.env[AUTO_BACKUP_ENV] === "1" && retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS) > 0;
  lastVerifiedAt = null;
  lastError = null;
  lifecycleQuiesced = false;
  lifecycleOwnerInstance = randomUUID();
  lifecycleUnknown = false;
  lifecycleGeneration = 0;
  timerDueAt = null;
  resumeDueAt = null;
  lifecycleWaiter = null;
  lifecycleCapture = null;
  lifecycleWitnesses = /* @__PURE__ */ new WeakMap();
  pressure(pending, lockError = false) {
    const changed = this.pending !== pending || lockError;
    this.pending = pending;
    if (lockError) this.pauseUntil = Date.now() + 5e3;
    if (changed && this.worker?.connected) this.worker.send({ type: "pressure", pending, pauseUntil: this.pauseUntil }, () => {
    });
  }
  status() {
    const paused = this.pending || Date.now() < this.pauseUntil;
    return {
      phase: !this.enabled ? "disabled" : this.stopped ? "stopped" : this.failed ? "failed" : paused ? "paused" : this.worker ? "running" : this.lastVerifiedAt ? "verified" : "scheduled",
      lastVerifiedAt: this.lastVerifiedAt,
      lastError: this.lastError
    };
  }
  schedule(delay2, dueAt = Date.now() + delay2) {
    if (!this.enabled || this.stopped || this.failed) return;
    if (this.lifecycleQuiesced) {
      this.resumeDueAt = Date.now() + delay2;
      return;
    }
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDueAt = null;
      this.start();
    }, delay2);
    this.timer.unref();
  }
  start() {
    if (!this.enabled || this.stopped || this.worker || this.failed || this.lifecycleQuiesced) return;
    if (this.pending || Date.now() < this.pauseUntil) {
      this.schedule(3e4);
      return;
    }
    let entry = pathToFileURL(join(bundleDirectory(import.meta.url), "backup-worker.mjs"));
    if (import.meta.url.endsWith(".ts")) {
      const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      const path = join(process.env.AGENT_BRIDGE_TEST_ROOT ?? join(root, ".agent-bridge-test"), "backup-worker.mjs");
      const inputs = ["backup-worker.ts", "message-backups.ts", "backups.ts", "storage-lock.ts", "json-store.ts"];
      if (!existsSync(path) || inputs.some((name) => statSync(join(root, "src/core", name)).mtimeMs > statSync(path).mtimeMs)) {
        mkdirSync(dirname(path), { recursive: true });
        createRequire(import.meta.url)("esbuild").buildSync({ entryPoints: [join(root, "src/core/backup-worker.ts")], outfile: path, bundle: true, platform: "node", format: "esm", target: "node22", external: ["node:*"], logLevel: "silent" });
      }
      entry = pathToFileURL(path);
    }
    const worker = this.worker = fork(fileURLToPath(entry), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], windowsHide: true });
    this.lifecycleCapture = worker;
    this.advanceLifecycleGeneration();
    let completed = false;
    worker.on("message", (message) => {
      if (this.lifecycleCapture !== worker) return;
      if (message.error) {
        this.lifecycleUnknown = true;
        this.advanceLifecycleGeneration();
        this.lastError = String(message.error).includes("sustained broker pressure") ? "broker_pressure" : "backup_failed";
        const pressureOnly = this.lastError === "broker_pressure";
        this.failed = !pressureOnly;
        if (!this.stopped) this.log.warn("automatic backup deferred; original and partial snapshots preserved", { err: message.error });
      } else if (message.path) {
        completed = typeof message.path === "string";
        this.lastVerifiedAt = Date.now();
        this.lastError = null;
        this.log.info("automatic backup verified", { backup: message.path });
      } else if (message.path === null && message.skipped === "not-due") {
        completed = true;
      } else {
        this.lifecycleUnknown = true;
        this.advanceLifecycleGeneration();
      }
    });
    worker.on("error", (error) => {
      if (this.lifecycleCapture !== worker) return;
      this.lifecycleUnknown = true;
      this.advanceLifecycleGeneration();
      this.failed = true;
      this.lastError = "worker_failed";
      this.log.warn("automatic backup process failed", { err: String(error) });
    });
    worker.on("exit", (code, signal) => {
      if (this.lifecycleCapture !== worker) return;
      if (this.worker !== worker) {
        this.lifecycleUnknown = true;
        this.advanceLifecycleGeneration();
        this.lifecycleWaiter?.finish(false);
        return;
      }
      if (code !== 0 || signal || !completed) this.lifecycleUnknown = true;
      this.advanceLifecycleGeneration();
      if (!this.stopped && (code !== 0 || signal)) {
        this.failed = true;
        this.lastError = "worker_failed";
      }
      if (this.worker === worker) this.worker = null;
      const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
      if (interval) this.schedule(Math.min(interval, 60 * 60 * 1e3));
      this.lifecycleWaiter?.finish(true);
    });
    worker.send({ type: "pressure", pending: this.pending, pauseUntil: this.pauseUntil }, () => {
    });
    worker.send({ type: "start", home: this.home }, () => {
    });
    worker.unref();
  }
  /** Inhibit future captures only. An accepted capture is never stopped or rejected here. */
  quiesceLifecycleMaintenance() {
    if (this.lifecycleQuiesced) return;
    this.lifecycleQuiesced = true;
    this.advanceLifecycleGeneration();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.resumeDueAt = this.timerDueAt;
    this.timerDueAt = null;
  }
  /** Pre-release abort restores the retained schedule; it never creates a second active worker. */
  resumeLifecycleMaintenance() {
    if (!this.lifecycleQuiesced) return;
    this.lifecycleQuiesced = false;
    this.advanceLifecycleGeneration();
    this.lifecycleWaiter?.finish(false);
    const due = this.resumeDueAt;
    this.resumeDueAt = null;
    if (due !== null && !this.worker) this.schedule(Math.max(0, due - Date.now()), due);
  }
  advanceLifecycleGeneration() {
    if (!Number.isSafeInteger(this.lifecycleGeneration) || this.lifecycleGeneration >= Number.MAX_SAFE_INTEGER) this.lifecycleUnknown = true;
    else this.lifecycleGeneration++;
  }
  lifecycleOwnerManifest() {
    const state = Object.freeze({
      ownerInstance: this.lifecycleOwnerInstance,
      quiesced: this.lifecycleQuiesced,
      generation: this.lifecycleGeneration,
      pendingWorkers: this.worker ? 1 : 0,
      unknown: this.lifecycleUnknown,
      stopped: this.stopped,
      settled: this.lifecycleQuiesced && !this.worker && !this.lifecycleUnknown && !this.stopped
    });
    this.lifecycleWitnesses.set(state, this.lifecycleCapture);
    return state;
  }
  /** Source-owned complete witness, rechecked immediately under the coordinator's producer seal.
   * A serialized/caller-forged snapshot, changed capture, close, error or resumed owner cannot qualify. */
  isCurrentLifecycleWitness(witness, isAdmissionSealed) {
    if (!this.lifecycleWitnesses.has(witness) || !witness.settled) return false;
    try {
      if (isAdmissionSealed() !== true || this.lifecycleWitnesses.get(witness) !== this.lifecycleCapture) return false;
      const current = this.lifecycleOwnerManifest();
      return current.settled && witness.ownerInstance === current.ownerInstance && witness.generation === current.generation && witness.quiesced === current.quiesced && witness.pendingWorkers === current.pendingWorkers && witness.unknown === current.unknown && witness.stopped === current.stopped;
    } catch {
      return false;
    }
  }
  /** One bounded observer. Timeout leaves the actual worker/capture and retained bytes untouched.
   * Actual successful backup outcome plus process exit proves this owner's settlement only;
   * it does not certify directory publication, other stores, or the core release witness. */
  settleLifecycleMaintenance(deadline) {
    const state = this.lifecycleOwnerManifest();
    const remaining = deadline - performance.now();
    if (!Number.isFinite(deadline) || remaining <= 0 || !state.quiesced || state.unknown || this.stopped || this.lifecycleWaiter) {
      return Promise.resolve({ ...state, settled: false });
    }
    if (!this.worker) return Promise.resolve(state);
    const capture = this.worker;
    return new Promise((resolve2) => {
      const finish = (settled) => {
        if (this.lifecycleWaiter !== waiter) return;
        clearTimeout(timer);
        this.lifecycleWaiter = null;
        const current = this.lifecycleOwnerManifest();
        resolve2(settled && performance.now() <= deadline && current.settled && this.lifecycleCapture === capture ? current : { ...current, settled: false });
      };
      const waiter = { finish };
      const timer = setTimeout(() => finish(false), remaining);
      this.lifecycleWaiter = waiter;
    });
  }
  async close() {
    this.stopped = true;
    this.advanceLifecycleGeneration();
    this.lifecycleWaiter?.finish(false);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const worker = this.worker;
    if (worker?.connected) worker.send({ type: "stop" }, () => {
    });
    if (worker) await new Promise((resolve2) => worker.once("exit", () => resolve2()));
  }
};

// src/core/store-compatibility-overlay.ts
import { existsSync as existsSync2 } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import { DatabaseSync } from "node:sqlite";
var TABLES = ["session_bindings", "peer_names", "peer_name_owners", "job_delivery_routes", "peer_last_seen"];
var SCHEMA = `
CREATE TABLE session_bindings(identity TEXT NOT NULL, session_id TEXT NOT NULL, learned_at INTEGER NOT NULL, PRIMARY KEY(identity,session_id));
CREATE TABLE peer_names(identity TEXT NOT NULL, name TEXT NOT NULL, session_id TEXT, agent TEXT NOT NULL, learned_at INTEGER NOT NULL, PRIMARY KEY(identity,name));
CREATE TABLE peer_name_owners(name TEXT PRIMARY KEY, identity TEXT NOT NULL);
CREATE TABLE job_delivery_routes(id TEXT PRIMARY KEY, recipient TEXT NOT NULL, consumed_at INTEGER);
CREATE TABLE peer_last_seen(name TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
PRAGMA user_version=1;`;
var overlayCaptures = /* @__PURE__ */ new WeakMap();
var retainedOverlayCaptures = /* @__PURE__ */ new Set();
function attachStoreCompatibility(db, file, log, create) {
  const path = join2(dirname2(file), "store-compatibility.db");
  const existed = existsSync2(path);
  if (!create && !existed) return;
  const capture = {
    identity: /* @__PURE__ */ Symbol("compatibility overlay admission"),
    main: db,
    file: path,
    open: "attempted",
    initialize: "not_attempted",
    close: "not_attempted",
    attach: "not_attempted",
    merge: "not_attempted"
  };
  const captures = overlayCaptures.get(db) ?? [];
  captures.push(capture);
  overlayCaptures.set(db, captures);
  retainedOverlayCaptures.add(capture);
  let overlay;
  try {
    overlay = new DatabaseSync(path);
    capture.overlay = overlay;
    capture.open = "returned";
  } catch (error) {
    capture.open = "unknown";
    throw error;
  }
  capture.initialize = "attempted";
  try {
    migrateSqlite(overlay, path, existed, 1, [{ version: 1, sql: SCHEMA }], log);
    capture.initialize = "returned";
  } catch (error) {
    capture.initialize = "unknown";
    throw error;
  } finally {
    capture.close = "attempted";
    try {
      overlay.close();
      capture.close = "returned";
    } catch (error) {
      capture.close = "unknown";
      throw error;
    }
  }
  capture.attach = "attempted";
  try {
    db.prepare("ATTACH DATABASE ? AS store_compatibility").run(path);
    capture.attach = "returned";
  } catch (error) {
    capture.attach = "unknown";
    throw error;
  }
  capture.merge = "attempted";
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    capture.merge = "unknown";
    throw error;
  }
  try {
    for (const table of TABLES) {
      if (!db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const merge = table === "peer_last_seen" ? "ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)" : table === "session_bindings" ? "ON CONFLICT(identity,session_id) DO UPDATE SET learned_at=MAX(session_bindings.learned_at,excluded.learned_at)" : "ON CONFLICT DO NOTHING";
      db.exec(`INSERT INTO main.${table} SELECT * FROM store_compatibility.${table} WHERE 1 ${merge}`);
    }
    if (!db.prepare("SELECT name FROM main.sqlite_master WHERE name='peer_last_seen'").get()) {
      db.exec(`INSERT INTO store_compatibility.peer_last_seen SELECT name, MAX(learned_at) FROM peer_names GROUP BY name
        ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)`);
    }
    db.exec("COMMIT");
    capture.merge = "returned";
    retainedOverlayCaptures.delete(capture);
  } catch (error) {
    capture.merge = "unknown";
    db.exec("ROLLBACK");
    throw error;
  }
}

// src/core/native-lifecycle-reader.ts
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import { Worker } from "node:worker_threads";
var NATIVE_LIFECYCLE_ROUTE_LIMIT = 128;
function nativeRouteDigest(routes) {
  return createHash("sha256").update(JSON.stringify(routes.map(({ address, parent }) => [address, parent]).sort((a, b) => a[0].localeCompare(b[0], "en")))).digest("hex");
}
var SOURCE = String.raw`
const { parentPort, workerData: w } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { lstatSync } = require('node:fs');
let db, result;
try {
  const before = lstatSync(w.path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw Error();
  db = new DatabaseSync(w.path, { readOnly: true, timeout: 25 });
  db.exec('PRAGMA query_only=ON');
  db.exec('BEGIN');
  let routes = [];
  const objects = db.prepare("SELECT type FROM sqlite_master WHERE name='native_child_routes' COLLATE NOCASE LIMIT 2").all();
  if (objects.length) {
    if (objects.length !== 1 || objects[0].type !== 'table') throw Error();
    const columns = db.prepare("SELECT name,type,[notnull],pk,hidden FROM pragma_table_xinfo('native_child_routes') LIMIT 4").all();
    if (columns.length !== 3 || columns.some(c => c.hidden !== 0) || columns[0].name !== 'address' || columns[0].type !== 'TEXT' || columns[0].pk !== 1 ||
        columns[1].name !== 'parent' || columns[1].type !== 'TEXT' || columns[1].notnull !== 1 || columns[1].pk !== 0 ||
        columns[2].name !== 'active' || columns[2].type !== 'INTEGER' || columns[2].notnull !== 1 || columns[2].pk !== 0) throw Error();
    // Canonical old DDL has no CHECK constraint. Ignoring unsupported retained
    // values would fabricate zero activity; absence and inactive INTEGER0 differ.
    if (db.prepare("SELECT 1 FROM native_child_routes WHERE typeof(active)!='integer' OR active NOT IN(0,1) OR typeof(address)!='text' OR typeof(parent)!='text' LIMIT 1").get()) throw Error();
    const count = db.prepare('SELECT COUNT(*) n, MAX(length(address)) a, MAX(length(parent)) p FROM native_child_routes WHERE active=1').get();
    if (!Number.isSafeInteger(count.n) || count.n < 0 || count.n > 128 || count.a > 256 || count.p > 64) throw Error();
    routes = db.prepare('SELECT address,parent FROM native_child_routes WHERE active=1 LIMIT 129').all();
    if (routes.length !== count.n || routes.some(r => typeof r.address !== 'string' || typeof r.parent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/sub:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(r.address) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.parent))) throw Error();
  }
  const digest = createHash('sha256').update(JSON.stringify(routes.map(r => [r.address, r.parent]).sort((a, b) => a[0].localeCompare(b[0], 'en')))).digest('hex');
  db.exec('COMMIT');
  const after = lstatSync(w.path, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino) throw Error();
  result = { ownerInstance: w.ownerInstance, generation: w.generation, requestNonce: w.requestNonce, active: routes.length, digest };
} catch { result = { unavailable: true }; }
finally { try { if (db?.isTransaction === true) db.exec('ROLLBACK'); db?.close(); } catch { result = { unavailable: true }; } }
parentPort.postMessage(result);
`;
var NativeLifecycleReader = class {
  worker = null;
  pending() {
    return this.worker ? 1 : 0;
  }
  read(path, ownerInstance, generation, deadline) {
    if (this.worker || !Number.isFinite(deadline) || performance.now() >= deadline || !Number.isSafeInteger(generation)) return Promise.reject(new Error("native_state_unknown"));
    const requestNonce = randomUUID2();
    const worker = new Worker(SOURCE, { eval: true, execArgv: [], workerData: { path, ownerInstance, generation, requestNonce } });
    this.worker = worker;
    return new Promise((resolve2, reject) => {
      let result, settled = false;
      const refuse = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("native_state_unknown"));
        }
      };
      const timer = setTimeout(refuse, Math.max(0, deadline - performance.now()));
      worker.on("message", (value) => {
        if (!value || value.ownerInstance !== ownerInstance || value.generation !== generation || value.requestNonce !== requestNonce || !Number.isSafeInteger(value.active) || value.active < 0 || value.active > NATIVE_LIFECYCLE_ROUTE_LIMIT || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) return refuse();
        result = value;
      });
      worker.on("error", refuse);
      worker.once("exit", (code) => {
        if (this.worker === worker) this.worker = null;
        if (settled) return;
        if (code !== 0 || !result || performance.now() >= deadline) return refuse();
        settled = true;
        clearTimeout(timer);
        resolve2(result);
      });
      worker.unref();
    });
  }
};

// src/core/store.ts
var BROADCAST_RECENT_MS = 24 * 60 * 60 * 1e3;
function agentQueueKey(agent) {
  return `agent:${agent}`;
}
var SCHEMA2 = `
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT    NOT NULL,
  recipient       TEXT    NOT NULL,
  from_id         TEXT    NOT NULL,
  from_name       TEXT    NOT NULL,
  from_agent      TEXT    NOT NULL,
  to_target       TEXT    NOT NULL,
  conversation_id TEXT    NOT NULL,
  reply_to        TEXT,
  hop             INTEGER NOT NULL,
  body            TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  read_at         INTEGER,
  PRIMARY KEY (id, recipient)
);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages (recipient, read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_id ON messages (id);
`;
var MIGRATIONS = [
  { version: 1, sql: `${SCHEMA2} PRAGMA user_version = 1;` },
  { version: 2, sql: `
    CREATE TABLE IF NOT EXISTS archived_messages AS
      SELECT *, '' AS archive_reason, 0 AS archived_at FROM messages WHERE 0;
    PRAGMA user_version = 2;
  ` },
  { version: 3, sql: `${DECISIONS_SCHEMA} PRAGMA user_version = 3;` },
  { version: 4, sql: historySchema() },
  { version: 5, sql: `
    CREATE TABLE IF NOT EXISTS session_bindings (
      identity TEXT NOT NULL,
      session_id TEXT NOT NULL,
      learned_at INTEGER NOT NULL,
      PRIMARY KEY (identity, session_id)
    );
    PRAGMA user_version = 5;
  ` },
  { version: 6, sql: `
    CREATE TABLE IF NOT EXISTS peer_names (
      identity TEXT NOT NULL, name TEXT NOT NULL, session_id TEXT, agent TEXT NOT NULL,
      learned_at INTEGER NOT NULL, PRIMARY KEY (identity, name)
    );
    CREATE TABLE IF NOT EXISTS peer_name_owners (
      name TEXT PRIMARY KEY, identity TEXT NOT NULL
    );
    INSERT INTO peer_names
      SELECT binding.identity, json_extract(binding.identity, '$[4]'), binding.session_id, json_extract(binding.identity, '$[0]'), binding.learned_at
      FROM session_bindings binding WHERE json_valid(binding.identity)
        AND json_type(binding.identity, '$[4]')='text' AND json_type(binding.identity, '$[0]')='text'
        AND NOT EXISTS (
          SELECT 1 FROM session_bindings other WHERE json_valid(other.identity)
            AND other.identity<>binding.identity
            AND json_extract(other.identity, '$[4]')=json_extract(binding.identity, '$[4]')
        )
      ORDER BY binding.learned_at ASC
      ON CONFLICT(identity, name) DO UPDATE SET session_id=excluded.session_id, learned_at=excluded.learned_at;
    INSERT INTO peer_name_owners SELECT name, identity FROM peer_names WHERE 1 ORDER BY learned_at ASC
      ON CONFLICT(name) DO UPDATE SET identity=excluded.identity;
    PRAGMA user_version = 6;
  ` },
  { version: 7, sql: `
    CREATE TABLE IF NOT EXISTS job_delivery_routes (
      id TEXT PRIMARY KEY, recipient TEXT NOT NULL, consumed_at INTEGER
    );
    PRAGMA user_version = 7;
  ` },
  { version: 8, sql: CONVERSATION_MIGRATION },
  { version: 9, backupTables: ["peer_names"], sql: `
    CREATE TABLE IF NOT EXISTS peer_last_seen (
      name TEXT PRIMARY KEY, seen_at INTEGER NOT NULL
    );
    INSERT INTO peer_last_seen SELECT name, MAX(learned_at) FROM peer_names GROUP BY name;
    PRAGMA user_version = 9;
  ` }
];
function migrateMessageSchema(db, file, existed, log) {
  migrateSqlite(db, file, existed, SQLITE_STORE_VERSION, MIGRATIONS, log);
}
function registrationIdentity(peer) {
  if (peer.jobAgent || !Number.isSafeInteger(peer.agentPid) || !peer.agentPid || peer.agentPid <= 0 || !peer.agentStartedAt) return null;
  let cwd = resolve(peer.cwd);
  try {
    cwd = realpathSync.native(cwd);
  } catch {
  }
  if (process.platform === "win32") cwd = cwd.toLowerCase();
  return JSON.stringify([peer.agent, peer.agentPid, peer.agentStartedAt, cwd, peer.name.replace(/-\d+$/, "")]);
}
function toMessage(r) {
  return {
    id: r.id,
    recipient: r.recipient,
    from: { id: r.from_id, name: r.from_name, agent: r.from_agent },
    to: r.to_target,
    conversationId: r.conversation_id,
    replyTo: r.reply_to,
    hop: r.hop,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at
  };
}
var storeHandleCaptures = /* @__PURE__ */ new WeakMap();
var retainedStoreConstructions = /* @__PURE__ */ new Set();
function messageStoreHandleObservation(db) {
  const owner = storeHandleCaptures.get(db), handle = owner?.handles.get(db);
  return Object.freeze({
    captured: handle !== void 0,
    construction: owner?.construction ?? "unavailable",
    main: handle?.kinds.has("main") ?? false,
    archive: handle?.kinds.has("archive") ?? false,
    history: handle?.kinds.has("history") ?? false,
    close: handle?.close ?? "not_attempted",
    handles: owner?.handles.size ?? 0,
    statements: owner?.statements.size ?? 0,
    consumers: owner?.consumers.size ?? 0,
    unknown: owner?.unknown ?? true,
    ordinaryClose: owner?.ordinaryClose ?? "not_attempted",
    retained: owner !== void 0 && retainedStoreConstructions.has(owner),
    ownerBound: false,
    settled: false,
    ownershipReleased: false
  });
}
var MessageStore = class {
  constructor(file, log) {
    this.log = log;
    retainedStoreConstructions.add(this.lifecycleConstruction);
    try {
      this.file = file;
      const existed = file !== ":memory:" && existsSync3(file);
      this.home = file === ":memory:" ? null : dirname3(file);
      if (file !== ":memory:") mkdirSync2(dirname3(file), { recursive: true, mode: 448 });
      this.release = file === ":memory:" ? () => {
      } : storageLease(dirname3(file));
      this.lifecycleConstruction.lease = this.release;
      try {
        this.db = new DatabaseSync2(file);
        this.captureHandle("main", this.db);
      } catch (err) {
        this.release();
        throw err;
      }
      try {
        let deferred = false;
        try {
          migrateMessageSchema(this.db, file, existed, log);
        } catch (error) {
          const version = Number(this.db.prepare("PRAGMA user_version").get().user_version);
          if (error.code !== "STORE_UPGRADE_DEFERRED" || version < 4) throw error;
          deferred = true;
          log.info("hosting broker on compatible existing schema while upgrade waits for retained readers", { file, version, target: SQLITE_STORE_VERSION });
        }
        if (file !== ":memory:") attachStoreCompatibility(this.db, file, log, deferred);
        configureSqlite(this.db);
        ensureMessageQuarantine(this.db);
      } catch (err) {
        this.closeCapturedHandle(this.db);
        this.release();
        throw err;
      }
      try {
        this.archiveDb = openArchive(archiveDbPath(file));
        this.captureHandle("archive", this.archiveDb);
      } catch (err) {
        this.closeCapturedHandle(this.db);
        this.release();
        throw err;
      }
      this.decisions = new DecisionStore(this.db);
      this.#decisionConsumer = this.decisions;
      this.lifecycleConstruction.consumers.add(this.decisions);
      this.historyFile = historyDbPath(file);
      let historyDb;
      try {
        this.historyDb = historyDb = file === ":memory:" ? this.db : openHistoryStore(this.historyFile);
        this.captureHandle("history", this.historyDb);
        this.history = new HistoryIndex(
          this.historyDb,
          this.home,
          void 0,
          this.db,
          file === ":memory:" ? void 0 : (peer) => this.historyPeerSink?.(peer)
        );
        this.#historyConsumer = this.history;
        this.lifecycleConstruction.consumers.add(this.history);
      } catch (err) {
        if (historyDb && historyDb !== this.db) this.closeCapturedHandle(historyDb);
        this.closeCapturedHandle(this.archiveDb);
        this.closeCapturedHandle(this.db);
        this.release();
        throw err;
      }
      this.stmt = {
        insert: this.captureStatement(this.db.prepare(
          `INSERT INTO messages (id, recipient, from_id, from_name, from_agent, to_target, conversation_id, reply_to, hop, body, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        )),
        unread: this.captureStatement(this.db.prepare(
          `SELECT * FROM deliverable_messages WHERE recipient = ? AND read_at IS NULL
         ORDER BY CASE WHEN (conversation_id LIKE '%:note' OR conversation_id LIKE '%:ack' OR conversation_id LIKE 'files-progress-%') THEN 1 ELSE 0 END,
                  created_at ASC, id ASC LIMIT ?`
        )),
        markRead: this.captureStatement(this.db.prepare(`UPDATE messages SET read_at = ? WHERE id = ? AND recipient = ? AND read_at IS NULL AND ${unquarantined("messages")}`)),
        claim: this.captureStatement(this.db.prepare(`UPDATE OR IGNORE messages SET recipient = ? WHERE recipient = ? AND read_at IS NULL AND ${unquarantined("messages")}`)),
        byId: this.captureStatement(this.db.prepare(`SELECT * FROM messages WHERE id = ? ORDER BY created_at ASC LIMIT 1`)),
        replyConflicts: this.captureStatement(this.db.prepare(`SELECT id, from_name, conversation_id FROM deliverable_messages WHERE recipient = ? AND read_at IS NULL
        AND (conversation_id = ? OR from_name IN (SELECT value FROM json_each(?)))
        AND (? IS NULL OR created_at >= ?) AND id != ?
        AND conversation_id NOT LIKE '%:note' AND conversation_id NOT LIKE '%:ack'
        AND conversation_id NOT LIKE 'files-progress-%' ORDER BY created_at, id LIMIT 50`))
      };
      log.debug("message store opened", { file });
      this.lifecycleConstruction.construction = "returned";
      retainedStoreConstructions.delete(this.lifecycleConstruction);
    } catch (error) {
      this.lifecycleConstruction.construction = "unknown";
      this.lifecycleConstruction.unknown = true;
      throw error;
    }
  }
  log;
  #producerSealed = false;
  // No setter/retirement entry is exposed: actual committed-intent/joint-owner
  // permission remains a separate, currently unsupported source boundary.
  #writeAuthorityRetired = false;
  #producerGeneration = 0;
  #producerUnknown = false;
  #callbackUnknown = false;
  #nativeBorrowerUnknown = false;
  #operationContext = new AsyncLocalStorage();
  #operations = /* @__PURE__ */ new Set();
  #maintenanceOperation = null;
  #operationWaiter = null;
  #decisionConsumer = null;
  #historyConsumer = null;
  #consumersSealed = false;
  producerChanged() {
    this.#producerGeneration++;
    if (!Number.isSafeInteger(this.#producerGeneration)) this.#producerUnknown = true;
  }
  currentAcceptedOperation() {
    const operation = this.#operationContext.getStore();
    return operation !== void 0 && operation.active && this.#operations.has(operation);
  }
  assertProducerAdmission() {
    if (this.#writeAuthorityRetired || this.#producerSealed && !this.currentAcceptedOperation())
      throw Object.assign(new Error("store producer is quiesced"), { code: "OWNER_QUIESCED" });
  }
  beginOperation(kind) {
    this.assertProducerAdmission();
    const operation = { identity: /* @__PURE__ */ Symbol("actual accepted Store operation"), kind, active: true };
    this.#operations.add(operation);
    this.producerChanged();
    if (this.#operations.size > 128) this.#producerUnknown = true;
    return operation;
  }
  finishOperation(operation, failed = false) {
    if (!operation.active || !this.#operations.has(operation)) {
      this.#producerUnknown = true;
      this.producerChanged();
      return;
    }
    if (failed) this.#producerUnknown = true;
    operation.active = false;
    this.#operations.delete(operation);
    this.producerChanged();
    this.sealCapturedConsumersIfReady();
    this.#operationWaiter?.();
  }
  acceptedOperation(kind, action) {
    const operation = this.beginOperation(kind);
    let result;
    try {
      result = this.#operationContext.run(operation, action);
    } catch (error) {
      this.finishOperation(operation, !isSqliteBusy(error));
      throw error;
    }
    if (result instanceof Promise) {
      void result.then(() => this.finishOperation(operation), () => this.finishOperation(operation, true));
    } else this.finishOperation(operation);
    return result;
  }
  guardNative(db) {
    this.assertProducerAdmission();
    if (!this.lifecycleConstruction.handles.has(db)) this.#nativeBorrowerUnknown = true;
    if (this.lifecycleConstruction.construction === "returned" && !this.currentAcceptedOperation()) this.#nativeBorrowerUnknown = true;
    this.producerChanged();
  }
  native(db, action) {
    this.guardNative(db);
    try {
      return action();
    } catch (error) {
      if (!isSqliteBusy(error)) this.#producerUnknown = true;
      this.producerChanged();
      throw error;
    }
  }
  exec(db, sql) {
    this.native(db, () => db.exec(sql));
  }
  statementFrame(db, statement) {
    return Object.freeze({
      get: (...args) => this.native(db, () => statement.get(...args)),
      all: (...args) => this.native(db, () => statement.all(...args)),
      run: (...args) => this.native(db, () => statement.run(...args)),
      setReadBigInts: (value) => this.native(db, () => statement.setReadBigInts(value))
    });
  }
  statement(db, sql) {
    return this.statementFrame(db, this.native(db, () => db.prepare(sql)));
  }
  sealCapturedConsumersIfReady() {
    if (!this.#producerSealed || this.#operations.size || this.#consumersSealed) return;
    if (!this.#decisionConsumer || !this.#historyConsumer || this.decisions !== this.#decisionConsumer || this.history !== this.#historyConsumer) {
      this.#producerUnknown = true;
      this.producerChanged();
      return;
    }
    this.#decisionConsumer.sealLifecycleConsumer();
    this.#historyConsumer.sealLifecycleConsumer();
    this.#consumersSealed = true;
    this.producerChanged();
  }
  sealLifecycleProducers() {
    this.#producerSealed = true;
    this.producerChanged();
    this.sealCapturedConsumersIfReady();
    return this.lifecycleProducerObservation();
  }
  resumeLifecycleProducers() {
    if (this.#writeAuthorityRetired || this.closed) throw Object.assign(new Error("store ownership cannot resume"), { code: "OWNER_UNAVAILABLE" });
    if (this.#consumersSealed) {
      this.#decisionConsumer.resumeLifecycleConsumer();
      this.#historyConsumer.resumeLifecycleConsumer();
      this.#consumersSealed = false;
    }
    this.#producerSealed = false;
    this.producerChanged();
    return this.lifecycleProducerObservation();
  }
  lifecycleProducerObservation() {
    return Object.freeze({
      generation: this.#producerGeneration,
      sealed: this.#producerSealed,
      retired: this.#writeAuthorityRetired,
      pendingOperations: this.#operations.size,
      unknown: this.#producerUnknown,
      callbackUnknown: this.#callbackUnknown,
      nativeBorrowerUnknown: this.#nativeBorrowerUnknown,
      pendingMaintenance: this.#maintenanceOperation?.active === true,
      consumersSealed: this.#consumersSealed,
      legacyArchivePending: this.legacyArchivePending,
      purgePending: this.purgeCutoff !== null || this.nextPurgeCutoff !== null,
      purgeCursorPending: this.purgeCursor !== null || this.purgeHighWater !== null,
      pendingReaders: this.nativeLifecycleReader.pending(),
      coldPreparation: "unverified",
      nativeCompositeCoverage: "unverified",
      blocker: "owner_unsupported",
      ownerBound: false,
      settled: false,
      ownershipReleased: false
    });
  }
  async observeLifecycleProducers(deadline) {
    const remaining = deadline - performance.now();
    if (this.#operationWaiter || !Number.isFinite(deadline) || remaining <= 0 || remaining > 2e3) return this.lifecycleProducerObservation();
    while (this.#operations.size && performance.now() < deadline) {
      let timer, waiter;
      try {
        await new Promise((resolve2) => {
          waiter = resolve2;
          this.#operationWaiter = waiter;
          timer = setTimeout(resolve2, Math.max(0, deadline - performance.now()));
        });
      } finally {
        if (timer) clearTimeout(timer);
        if (this.#operationWaiter === waiter) this.#operationWaiter = null;
      }
    }
    return this.lifecycleProducerObservation();
  }
  lifecycleConstruction = {
    identity: /* @__PURE__ */ Symbol("actual MessageStore constructor"),
    handles: /* @__PURE__ */ new Map(),
    statements: /* @__PURE__ */ new Set(),
    consumers: /* @__PURE__ */ new Set(),
    lease: null,
    construction: "attempted",
    ordinaryClose: "not_attempted",
    unknown: false
  };
  captureHandle(kind, db) {
    let capture = this.lifecycleConstruction.handles.get(db);
    if (!capture) {
      capture = { identity: /* @__PURE__ */ Symbol("actual Store native handle"), db, kinds: /* @__PURE__ */ new Set(), close: "not_attempted" };
      this.lifecycleConstruction.handles.set(db, capture);
    }
    capture.kinds.add(kind);
    storeHandleCaptures.set(db, this.lifecycleConstruction);
  }
  captureStatement(statement) {
    this.lifecycleConstruction.statements.add(statement);
    return this.statementFrame(this.db, statement);
  }
  closeCapturedHandle(db) {
    const capture = this.lifecycleConstruction.handles.get(db);
    if (capture) capture.close = "attempted";
    else this.lifecycleConstruction.unknown = true;
    retainedStoreConstructions.add(this.lifecycleConstruction);
    try {
      db.close();
      if (capture) capture.close = "returned";
    } catch (error) {
      if (capture) capture.close = "unknown";
      this.lifecycleConstruction.unknown = true;
      throw error;
    }
  }
  db;
  archiveDb;
  historyDb;
  release;
  home;
  writeAbort = new AbortController();
  backups = null;
  archiveTimer = null;
  legacyArchivePending = true;
  purgeCutoff = null;
  purgeCursor = null;
  purgeHighWater = null;
  nextPurgeCutoff = null;
  archiveMaintenanceFailed = false;
  closed = false;
  nativeLifecycleReader = new NativeLifecycleReader();
  lifecycleMaintenanceQuiesced = false;
  lifecycleResumeArchive = false;
  lifecycleWriteGeneration = 0;
  lifecycleWriteUnknown = false;
  lifecyclePendingWriteCount = 0;
  lifecycleDrainWaiter = null;
  decisions;
  history;
  historyFile;
  historyPeerSink;
  /** Told about every stored or claimed message, so a backed-off history worker indexes it promptly. */
  historyMessageSink;
  file;
  stmt;
  startBackups() {
    return this.acceptedOperation("direct", () => {
      this.scheduleArchiveMaintenance();
      if (process.env.AGENT_BRIDGE_AUTO_BACKUP === "1" && this.home && !this.backups) this.backups = new BackupBackground(this.home, this.log);
    });
  }
  backupPressure(pending, lockError = false) {
    this.acceptedOperation("direct", () => this.backups?.pressure(pending, lockError));
  }
  backupStatus() {
    return this.backups?.status() ?? null;
  }
  async closeBackups() {
    if (this.#producerSealed || this.#writeAuthorityRetired) throw Object.assign(new Error("accepted backup work is retained"), { code: "OWNER_QUIESCED" });
    await this.acceptedOperation("direct", async () => {
      await this.backups?.close();
      this.backups = null;
    });
  }
  /** Append identities learned from hooks; previous session bindings remain retained. */
  rememberSession(peer, at) {
    return this.acceptedOperation("direct", () => {
      const identity = registrationIdentity(peer);
      if (!identity || !peer.sessionId) return;
      this.statement(this.db, `INSERT INTO session_bindings VALUES (?,?,?) ON CONFLICT(identity,session_id)
      DO UPDATE SET learned_at=excluded.learned_at`).run(identity, peer.sessionId, at);
    });
  }
  recoverSession(peer) {
    return this.acceptedOperation("direct", () => {
      const identity = registrationIdentity(peer);
      if (!identity) return null;
      const row = this.statement(this.db, "SELECT session_id FROM session_bindings WHERE identity=? ORDER BY learned_at DESC, rowid DESC LIMIT 1").get(identity);
      return row ? String(row.session_id) : null;
    });
  }
  /** Retain names only with CLI or hook identity; a similar spelling is never an alias. */
  rememberName(peer, at) {
    return this.acceptedOperation("direct", () => {
      const identity = registrationIdentity(peer) ?? (!peer.jobAgent && peer.sessionId ? JSON.stringify(["session", peer.agent, peer.sessionId]) : null);
      this.exec(this.db, "BEGIN IMMEDIATE");
      try {
        if (identity) this.statement(this.db, `INSERT INTO peer_names VALUES (?,?,?,?,?) ON CONFLICT(identity,name)
        DO UPDATE SET session_id=COALESCE(excluded.session_id,peer_names.session_id), learned_at=MIN(peer_names.learned_at,excluded.learned_at)`).run(identity, peer.name, peer.sessionId, peer.agent, at);
        this.statement(this.db, `INSERT INTO peer_name_owners VALUES (?,?) ON CONFLICT(name)
        DO UPDATE SET identity=excluded.identity`).run(peer.name, identity ?? `unidentified:${peer.id}`);
        if (!peer.jobAgent && !peer.subagent) this.markPeerSeen(peer.name, at);
        this.exec(this.db, "COMMIT");
      } catch (err) {
        this.exec(this.db, "ROLLBACK");
        throw err;
      }
    });
  }
  /** Presence updates never change the identity that currently owns a name. */
  markPeerSeen(name, at) {
    return this.acceptedOperation("direct", () => {
      this.statement(this.db, `INSERT INTO peer_last_seen VALUES (?,?)
      ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)`).run(name, at);
    });
  }
  namesFor(peer) {
    return this.acceptedOperation("direct", () => {
      const identity = registrationIdentity(peer);
      if (peer.jobAgent || !identity && !peer.sessionId) return [];
      return this.statement(this.db, `SELECT name FROM peer_names JOIN peer_name_owners USING(name,identity)
      WHERE identity=? OR (session_id=? AND agent=?) GROUP BY name ORDER BY MIN(learned_at) ASC, MIN(peer_names.rowid) ASC`).all(identity, peer.sessionId, peer.agent).map((r) => String(r.name));
    });
  }
  /** Retained registrations include offline sessions, but never worker runners or agent queue keys. */
  broadcastNames() {
    return this.acceptedOperation("direct", () => {
      return this.statement(this.db, `SELECT name,identity FROM peer_name_owners
      WHERE identity NOT LIKE 'unidentified:job:%' ORDER BY name`).all().filter((row) => {
        const identity = String(row.identity);
        let session;
        try {
          const parts = JSON.parse(identity);
          if (Array.isArray(parts)) {
            if (parts[0] === "session" && typeof parts[2] === "string") session = parts[2];
            else if (typeof parts[1] === "number" && typeof parts[3] === "string") return !isPluginCacheCwd(parts[3]);
          }
        } catch {
        }
        const cwds = this.history.sessionProjectPaths(identity.startsWith("unidentified:") ? identity.slice(13) : String(row.name), session);
        return !cwds.length || cwds.some((cwd) => !isPluginCacheCwd(cwd));
      }).map((row) => String(row.name));
    });
  }
  /** Eligibility never removes history or old queued messages. Unknown old names are skipped. */
  recentProjectSenders(address, previous, since) {
    return this.acceptedOperation("direct", () => {
      return this.statement(this.db, `SELECT from_name FROM deliverable_messages WHERE to_target=? AND recipient=? AND created_at>=?
      AND from_id NOT LIKE 'job:%' GROUP BY from_name ORDER BY MAX(created_at) DESC LIMIT 64`).all(address, previous, since).map((row) => String(row.from_name));
    });
  }
  broadcastRecipients(now, masters) {
    return this.acceptedOperation("direct", () => {
      const seen = this.statement(this.db, "SELECT seen_at FROM peer_last_seen WHERE name=?");
      const queued = [], skipped = [];
      for (const name of this.broadcastNames()) {
        const at = Number(seen.get(name)?.seen_at ?? 0);
        (masters.has(name) || at > 0 && at >= now - BROADCAST_RECENT_MS ? queued : skipped).push(name);
      }
      for (const name of masters) if (!queued.includes(name) && !skipped.includes(name)) queued.push(name);
      return { queued, skipped };
    });
  }
  /** Keep lock waits out of the broker event loop. Callbacks must be synchronous atomic steps. */
  retryWrite(operation) {
    return this.acceptedOperation("retry", () => {
      this.#callbackUnknown = true;
      this.producerChanged();
      let resolve2, reject;
      const tracked = new Promise((yes, no) => {
        resolve2 = yes;
        reject = no;
      });
      this.lifecyclePendingWriteCount++;
      this.lifecycleWriteGeneration++;
      if (!Number.isSafeInteger(this.lifecyclePendingWriteCount) || !Number.isSafeInteger(this.lifecycleWriteGeneration)) this.lifecycleWriteUnknown = true;
      const settled = () => {
        this.lifecyclePendingWriteCount--;
        this.lifecycleWriteGeneration++;
        if (!Number.isSafeInteger(this.lifecycleWriteGeneration)) this.lifecycleWriteUnknown = true;
        if (!this.lifecyclePendingWriteCount) this.lifecycleDrainWaiter?.();
      };
      void tracked.then(settled, () => {
        this.lifecycleWriteUnknown = true;
        settled();
      });
      void retrySqlite(() => {
        this.exec(this.db, `PRAGMA busy_timeout = ${SQLITE_REQUEST_BUSY_MS}`);
        try {
          return operation();
        } finally {
          this.exec(this.db, `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
        }
      }, Infinity, this.writeAbort.signal).then(resolve2, reject);
      return tracked;
    });
  }
  /** Inhibits this maintenance producer only. Dispatch and all other owners need their own gates. */
  quiesceLifecycleMaintenance() {
    this.lifecycleMaintenanceQuiesced = true;
    this.lifecycleResumeArchive ||= !!this.archiveTimer;
    if (this.archiveTimer) clearTimeout(this.archiveTimer);
    this.archiveTimer = null;
  }
  resumeLifecycleMaintenance() {
    if (this.#writeAuthorityRetired) throw Object.assign(new Error("store ownership cannot resume"), { code: "OWNER_UNAVAILABLE" });
    this.lifecycleMaintenanceQuiesced = false;
    const resume = this.lifecycleResumeArchive;
    this.lifecycleResumeArchive = false;
    if (!this.closed && resume) this.scheduleArchiveMaintenance();
  }
  lifecycleWriteManifest() {
    return {
      generation: this.lifecycleWriteGeneration,
      pending: this.lifecyclePendingWriteCount,
      unknown: this.lifecycleWriteUnknown,
      maintenanceQuiesced: this.lifecycleMaintenanceQuiesced,
      pendingReaders: this.nativeLifecycleReader.pending(),
      transactionsSettled: !this.closed && [this.db, this.archiveDb, this.historyDb].every((db) => db.isTransaction === false),
      legacyArchivePending: this.legacyArchivePending,
      purgePending: this.purgeCutoff !== null || this.nextPurgeCutoff !== null
    };
  }
  /** Queue settlement observation, not a file flush/checkpoint or release witness. */
  async settleLifecycleWrites(deadline) {
    if (this.lifecycleDrainWaiter) return { ...this.lifecycleWriteManifest(), settled: false };
    if (Number.isFinite(deadline) && performance.now() < deadline && this.lifecyclePendingWriteCount) {
      let timer;
      let waiter;
      try {
        await new Promise((resolve2) => {
          waiter = resolve2;
          this.lifecycleDrainWaiter = waiter;
          timer = setTimeout(resolve2, Math.max(0, deadline - performance.now()));
        });
      } finally {
        if (timer) clearTimeout(timer);
        if (this.lifecycleDrainWaiter === waiter) this.lifecycleDrainWaiter = null;
      }
    }
    const manifest = this.lifecycleWriteManifest();
    return { ...manifest, settled: Number.isFinite(deadline) && performance.now() < deadline && manifest.maintenanceQuiesced && !manifest.pending && !manifest.unknown && !manifest.pendingReaders && manifest.transactionsSettled };
  }
  insert(m) {
    return this.acceptedOperation("direct", () => {
      this.stmt.insert.run(
        m.id,
        m.recipient,
        m.from.id,
        m.from.name,
        m.from.agent,
        m.to,
        m.conversationId,
        m.replyTo,
        m.hop,
        m.body,
        m.createdAt
      );
      this.notifyHistoryChanged();
    });
  }
  unread(recipient, limit) {
    return this.acceptedOperation("direct", () => {
      return this.stmt.unread.all(recipient, limit).map(toMessage);
    });
  }
  /** A guarded fan-out is one transaction; lock retries cannot leave half a send persisted. */
  insertBatch(messages, before = () => {
  }) {
    return this.acceptedOperation("direct", () => {
      this.#callbackUnknown = true;
      this.producerChanged();
      this.exec(this.db, "BEGIN IMMEDIATE");
      try {
        before();
        for (const message of messages) this.insert(message);
        this.exec(this.db, "COMMIT");
      } catch (err) {
        this.exec(this.db, "ROLLBACK");
        throw err;
      }
    });
  }
  /** Query the whole inbox before a reply, independent of the hook batch limit. */
  replyConflicts(recipient, from, conversationId, anchor) {
    return this.acceptedOperation("direct", () => {
      const rows = this.stmt.replyConflicts.all(recipient, conversationId, JSON.stringify(from), anchor?.id ?? null, anchor?.createdAt ?? 0, anchor?.id ?? "");
      return rows.map((row) => ({ id: String(row.id), from: { name: String(row.from_name) }, conversationId: String(row.conversation_id) }));
    });
  }
  /** Copy pending job mail to its new supervisor, retaining the old row as history. Replay is idempotent. */
  handoffMail(from, to, job, at, fallback = false) {
    return this.acceptedOperation("direct", () => {
      if (from === to) return [];
      this.exec(this.db, "BEGIN IMMEDIATE");
      try {
        const rows = this.statement(this.db, "SELECT * FROM deliverable_messages WHERE recipient=? AND from_id=? AND read_at IS NULL AND conversation_id NOT LIKE ?").all(from, `job:${job}`, `${SIBLING_CONVERSATION_PREFIX}%`);
        const copied = [];
        for (const row of rows) {
          const route = this.statement(this.db, "SELECT recipient, consumed_at FROM job_delivery_routes WHERE id=?").get(row.id);
          if (route && (route.consumed_at !== null || route.recipient !== from)) continue;
          const m = { ...toMessage(row), recipient: to, to, readAt: null };
          if (this.statement(this.db, "SELECT 1 FROM message_archive_conflicts WHERE source_table='messages' AND id=? AND recipient=?").get(m.id, to)) continue;
          if (fallback && !isQuietMessage(m)) m.conversationId = m.conversationId.replace(/:note$/, "") + (m.conversationId.endsWith(":fallback") ? "" : ":fallback");
          const existing = this.statement(this.db, "SELECT read_at FROM messages WHERE id=? AND recipient=?").get(m.id, to);
          if (!existing) this.insert(m);
          else this.statement(this.db, "UPDATE messages SET read_at=NULL, to_target=?, conversation_id=? WHERE id=? AND recipient=?").run(to, m.conversationId, m.id, to);
          copied.push(m);
          this.statement(this.db, "INSERT INTO job_delivery_routes(id,recipient,consumed_at) VALUES (?,?,NULL) ON CONFLICT(id) DO UPDATE SET recipient=excluded.recipient").run(m.id, to);
          this.stmt.markRead.run(at, m.id, from);
        }
        this.exec(this.db, "COMMIT");
        return copied;
      } catch (err) {
        this.exec(this.db, "ROLLBACK");
        throw err;
      }
    });
  }
  pendingJobRecipients(job) {
    return this.acceptedOperation("direct", () => {
      return this.statement(this.db, "SELECT DISTINCT recipient FROM deliverable_messages WHERE from_id=? AND read_at IS NULL AND conversation_id NOT LIKE ?").all(`job:${job}`, `${SIBLING_CONVERSATION_PREFIX}%`).map((row) => String(row.recipient));
    });
  }
  pendingJobSenders() {
    return this.acceptedOperation("direct", () => {
      return new Set(this.statement(this.db, "SELECT DISTINCT from_id FROM deliverable_messages WHERE read_at IS NULL AND from_id LIKE 'job:%' AND conversation_id NOT LIKE ?").all(`${SIBLING_CONVERSATION_PREFIX}%`).map((row) => String(row.from_id)));
    });
  }
  insertOnce(m) {
    return this.acceptedOperation("direct", () => {
      if (this.statement(this.db, "SELECT 1 FROM messages WHERE id=? AND recipient=?").get(m.id, m.recipient)) return false;
      this.insert(m);
      return true;
    });
  }
  /** A recovered inline envelope must never replay after a recipient consumed it or it was forwarded. */
  insertJobDelivery(m) {
    return this.acceptedOperation("direct", () => {
      if (this.statement(this.db, "SELECT 1 FROM message_archive_conflicts WHERE source_table='messages' AND id=? AND recipient=?").get(m.id, m.recipient)) return false;
      if (this.statement(this.db, "SELECT 1 FROM job_delivery_routes WHERE id=?").get(m.id)) return false;
      this.exec(this.db, "BEGIN IMMEDIATE");
      try {
        const inserted = this.insertOnce(m);
        const row = this.statement(this.db, "SELECT read_at FROM messages WHERE id=? AND recipient=?").get(m.id, m.recipient);
        this.statement(this.db, "INSERT INTO job_delivery_routes(id,recipient,consumed_at) VALUES (?,?,?)").run(m.id, m.recipient, row?.read_at ?? null);
        this.exec(this.db, "COMMIT");
        return inserted;
      } catch (err) {
        this.exec(this.db, "ROLLBACK");
        throw err;
      }
    });
  }
  markRead(recipient, ids, at = Date.now()) {
    return this.acceptedOperation("direct", () => {
      let changed = 0;
      const route = this.statement(this.db, "UPDATE job_delivery_routes SET consumed_at=? WHERE id=? AND recipient=? AND consumed_at IS NULL");
      for (let offset = 0; offset < ids.length; offset += 100) {
        this.exec(this.db, "SAVEPOINT message_ack");
        try {
          for (const id of ids.slice(offset, offset + 100)) {
            changed += Number(this.stmt.markRead.run(at, id, recipient).changes);
            route.run(at, id, recipient);
          }
          this.exec(this.db, "RELEASE message_ack");
        } catch (err) {
          cleanupSavepoint(this.db, "message_ack", true, err);
        }
      }
      return changed;
    });
  }
  /** Move messages waiting for "any <agent>" to a concrete peer name. */
  nativeChildRoutes() {
    return this.acceptedOperation("direct", () => {
      if (!this.statement(this.db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_child_routes'").get()) return [];
      return this.statement(this.db, "SELECT address,parent FROM native_child_routes WHERE active=1").all();
    });
  }
  /** Lifecycle observation only: no migration, lease, repair or route retirement. */
  committedNativeChildRoutes(ownerInstance, generation, deadline) {
    return this.acceptedOperation("direct", () => {
      if (this.db.isTransaction !== false || typeof this.db.location !== "function") return Promise.reject(new Error("native_state_unknown"));
      const path = this.db.location("main");
      if (!path || path === ":memory:") return Promise.reject(new Error("native_state_unknown"));
      return this.nativeLifecycleReader.read(path, ownerInstance, generation, deadline);
    });
  }
  nativeLifecyclePendingReaders() {
    return this.nativeLifecycleReader.pending();
  }
  retainNativeChild(address, parent) {
    return this.acceptedOperation("direct", () => {
      this.exec(this.db, "CREATE TABLE IF NOT EXISTS native_child_routes (address TEXT PRIMARY KEY, parent TEXT NOT NULL, active INTEGER NOT NULL)");
      this.statement(this.db, "INSERT INTO native_child_routes(address,parent,active) VALUES (?,?,1) ON CONFLICT(address) DO UPDATE SET parent=excluded.parent,active=1").run(address, parent);
    });
  }
  /** Return unread child mail and retire its route atomically; retained rows are never removed. */
  returnNativeChild(address, parent) {
    return this.acceptedOperation("direct", () => {
      this.exec(this.db, "BEGIN IMMEDIATE");
      try {
        this.stmt.claim.run(parent, address);
        this.statement(this.db, `UPDATE messages SET read_at=? WHERE recipient=? AND read_at IS NULL AND ${unquarantined("messages")} AND id IN (SELECT id FROM deliverable_messages WHERE recipient=?)`).run(Date.now(), address, parent);
        this.statement(this.db, "UPDATE native_child_routes SET active=0 WHERE address=?").run(address);
        this.exec(this.db, "COMMIT");
        this.notifyHistoryChanged();
      } catch (err) {
        this.exec(this.db, "ROLLBACK");
        throw err;
      }
    });
  }
  claim(fromKey, toName) {
    return this.acceptedOperation("direct", () => {
      if (fromKey === toName) return 0;
      this.exec(this.db, "BEGIN IMMEDIATE");
      try {
        const moved = Number(this.stmt.claim.run(toName, fromKey).changes);
        const duplicates = Number(this.statement(this.db, `UPDATE messages SET read_at = ?
        WHERE recipient = ? AND read_at IS NULL AND ${unquarantined("messages")} AND id IN (SELECT id FROM deliverable_messages WHERE recipient = ?)`).run(Date.now(), fromKey, toName).changes);
        this.exec(this.db, "COMMIT");
        if (moved) this.notifyHistoryChanged();
        return moved + duplicates;
      } catch (err) {
        this.exec(this.db, "ROLLBACK");
        throw err;
      }
    });
  }
  /** Archive unread mail waiting for a queue key or name that is older than the cutoff. */
  expireQueued(recipient, cutoff) {
    return this.acceptedOperation("direct", () => {
      if (!this.statement(this.db, "SELECT 1 FROM deliverable_messages WHERE recipient = ? AND read_at IS NULL AND created_at < ? LIMIT 1").get(recipient, cutoff)) return 0;
      const n = archiveMessages(this.db, this.archiveDb, "recipient = ? AND read_at IS NULL AND created_at < ?", [recipient, cutoff], "stale queue", "messages", this.log);
      if (n > 0) this.log.info("archived stale queued messages", { recipient, count: n });
      return n;
    });
  }
  /** Finish TTL archival before a broker claims/replays a reused queue name. */
  async expireQueuedAsync(recipient, cutoff) {
    return this.acceptedOperation("direct", async () => {
      let count = 0;
      for (; ; ) {
        const result = await this.retryWrite(() => {
          this.exec(this.archiveDb, `PRAGMA busy_timeout = ${SQLITE_REQUEST_BUSY_MS}`);
          try {
            const moved = this.archiveChunk("messages", "recipient = ? AND read_at IS NULL AND created_at < ?", [recipient, cutoff], "stale queue");
            const remaining = Boolean(this.statement(this.db, "SELECT 1 FROM deliverable_messages WHERE recipient = ? AND read_at IS NULL AND created_at < ? LIMIT 1").get(recipient, cutoff));
            return { moved, remaining };
          } finally {
            this.exec(this.archiveDb, `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
          }
        });
        count += result.moved;
        if (!result.remaining) break;
        await delay(50, void 0, { signal: this.writeAbort.signal });
      }
      if (count) this.log.info("archived stale queued messages", { recipient, count });
      return count;
    });
  }
  receipts(id) {
    return this.acceptedOperation("direct", () => {
      const merged = /* @__PURE__ */ new Map();
      for (const [db, table] of [[this.archiveDb, "messages"], [this.db, "archived_messages"], [this.db, "messages"]]) {
        const rows = this.statement(db, `SELECT recipient, read_at AS readAt FROM ${table} WHERE id = ?`).all(id);
        for (const row of rows) merged.set(row.recipient, row);
      }
      return [...merged.values()];
    });
  }
  byId(id) {
    return this.acceptedOperation("direct", () => {
      const row = this.stmt.byId.get(id) ?? this.statement(this.archiveDb, "SELECT * FROM messages WHERE id = ? LIMIT 1").get(id) ?? this.statement(this.db, "SELECT * FROM archived_messages WHERE id = ? LIMIT 1").get(id);
      return row ? toMessage(row) : null;
    });
  }
  /** Retained recipient copies for a durable retry; active rows take precedence. */
  messagesById(id) {
    return this.acceptedOperation("direct", () => {
      const merged = /* @__PURE__ */ new Map();
      for (const [db, table] of [[this.archiveDb, "messages"], [this.db, "archived_messages"], [this.db, "messages"]]) {
        for (const row of this.statement(db, `SELECT * FROM ${table} WHERE id = ? ORDER BY rowid`).all(id)) {
          const message = toMessage(row);
          merged.set(message.recipient, message);
        }
      }
      return [...merged.values()];
    });
  }
  purgeOlderThan(cutoff) {
    return this.acceptedOperation("direct", () => {
      if (!this.statement(this.db, "SELECT 1 FROM deliverable_messages WHERE created_at < ? LIMIT 1").get(cutoff)) return 0;
      const n = archiveMessages(this.db, this.archiveDb, "created_at < ?", [cutoff], "expired", "messages", this.log);
      if (n > 0) this.log.info("archived expired messages", { count: n });
      return n;
    });
  }
  /** Broker retention queues bounded work; direct/offline purge remains synchronous. */
  schedulePurgeOlderThan(cutoff) {
    return this.acceptedOperation("direct", () => {
      if (this.purgeCutoff === null) this.purgeCutoff = cutoff;
      else if (cutoff > this.purgeCutoff) this.nextPurgeCutoff = Math.max(this.nextPurgeCutoff ?? cutoff, cutoff);
      this.scheduleArchiveMaintenance();
    });
  }
  scheduleArchiveMaintenance(delayMs = 50) {
    if (this.lifecycleMaintenanceQuiesced) {
      this.lifecycleResumeArchive = true;
      return;
    }
    if (this.closed || this.archiveMaintenanceFailed || this.archiveTimer) return;
    const operation = this.#maintenanceOperation?.active ? this.#maintenanceOperation : this.beginOperation("maintenance");
    this.#maintenanceOperation = operation;
    this.archiveTimer = setTimeout(() => {
      try {
        this.#operationContext.run(operation, () => {
          this.archiveTimer = null;
          if (this.closed || this.lifecycleMaintenanceQuiesced) return;
          let more = false;
          let retryDelay = 50;
          try {
            this.exec(this.db, `PRAGMA busy_timeout = ${SQLITE_REQUEST_BUSY_MS}`);
            this.exec(this.archiveDb, `PRAGMA busy_timeout = ${SQLITE_REQUEST_BUSY_MS}`);
            if (this.legacyArchivePending) {
              this.legacyArchivePending = this.archiveChunk("archived_messages", "1", [], "legacy") > 0;
              more = this.legacyArchivePending;
            } else if (this.purgeCutoff !== null) {
              more = this.archivePurgeChunk(this.purgeCutoff);
              if (!more) {
                this.purgeCutoff = this.nextPurgeCutoff;
                this.nextPurgeCutoff = null;
                this.purgeCursor = this.purgeHighWater = null;
              }
            }
            more ||= this.purgeCutoff !== null;
          } catch (error) {
            if (isSqliteBusy(error)) {
              more = true;
              retryDelay = 250;
            } else {
              this.#producerUnknown = true;
              this.producerChanged();
              this.archiveMaintenanceFailed = true;
              this.log.warn("message archive maintenance stopped; original rows preserved", { err: String(error) });
            }
          } finally {
            this.exec(this.db, `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
            this.exec(this.archiveDb, `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
          }
          if (more) this.scheduleArchiveMaintenance(retryDelay);
          else if (!this.archiveMaintenanceFailed && !this.legacyArchivePending && this.purgeCutoff === null && this.nextPurgeCutoff === null) {
            this.finishOperation(operation);
            if (this.#maintenanceOperation === operation) this.#maintenanceOperation = null;
          }
        });
      } catch (error) {
        this.#producerUnknown = true;
        this.producerChanged();
        throw error;
      }
    }, delayMs);
    this.archiveTimer.unref();
  }
  archiveChunk(table, where, args, reason) {
    const rows = this.statement(this.db, `SELECT rowid AS id, octet_length(body) AS bytes FROM ${table} WHERE (${where}) AND ${unquarantined(table)} ORDER BY ${table === "messages" ? "created_at" : "rowid"} LIMIT 16`).all(...args);
    const ids = [];
    let bytes = 0;
    for (const row of rows) {
      if (ids.length && bytes + Number(row.bytes) > 256 * 1024) break;
      ids.push(String(row.id));
      bytes += Number(row.bytes);
    }
    if (!ids.length) return 0;
    return archiveMessages(this.db, this.archiveDb, `rowid IN (${ids.map(() => "?").join(",")}) AND (${where})`, [...ids, ...args], reason, table, this.log);
  }
  archivePurgeChunk(cutoff) {
    if (this.purgeHighWater === null) {
      const high = this.statement(this.db, "SELECT MAX(rowid) AS id FROM messages");
      high.setReadBigInts(true);
      const id = high.get().id;
      if (id === null) return false;
      this.purgeHighWater = String(id);
    }
    const select = this.statement(this.db, `SELECT rowid AS id, created_at AS at, octet_length(body) AS bytes FROM messages WHERE ${this.purgeCursor === null ? "" : "rowid > ? AND "}rowid <= ? ORDER BY rowid LIMIT 16`);
    select.setReadBigInts(true);
    const rows = select.all(...this.purgeCursor === null ? [this.purgeHighWater] : [this.purgeCursor, this.purgeHighWater]);
    const ids = [];
    let bytes = 0;
    let next = this.purgeCursor;
    for (const row of rows) {
      if (Number(row.at) < cutoff) {
        if (ids.length && bytes + Number(row.bytes) > 256 * 1024) break;
        ids.push(String(row.id));
        bytes += Number(row.bytes);
      }
      next = String(row.id);
    }
    if (ids.length) archiveMessages(this.db, this.archiveDb, `rowid IN (${ids.map(() => "?").join(",")}) AND created_at < ?`, [...ids, cutoff], "expired", "messages", this.log);
    this.purgeCursor = next;
    return rows.length > 0;
  }
  notifyHistoryChanged() {
    if (this.historyMessageSink) {
      this.#callbackUnknown = true;
      this.producerChanged();
      this.historyMessageSink();
    }
  }
  stopWrites() {
    if (this.#producerSealed || this.#writeAuthorityRetired) throw Object.assign(new Error("accepted store work is retained"), { code: "OWNER_QUIESCED" });
    this.writeAbort.abort();
  }
  close() {
    if (this.closed) return;
    if (this.#producerSealed || this.#writeAuthorityRetired) throw Object.assign(new Error("store ownership is retained"), { code: "OWNER_QUIESCED" });
    this.lifecycleConstruction.ordinaryClose = "attempted";
    retainedStoreConstructions.add(this.lifecycleConstruction);
    try {
      this.closed = true;
      if (this.archiveTimer) clearTimeout(this.archiveTimer);
      this.archiveTimer = null;
      this.stopWrites();
      this.history.close();
      if (this.historyDb !== this.db) this.closeCapturedHandle(this.historyDb);
      void this.closeBackups();
      try {
        this.closeCapturedHandle(this.db);
        this.closeCapturedHandle(this.archiveDb);
      } catch (err) {
        this.log.warn("error closing message store", { err });
      } finally {
        this.release();
        if (!this.lifecycleConstruction.unknown && [...this.lifecycleConstruction.handles.values()].every((handle) => handle.close === "returned"))
          retainedStoreConstructions.delete(this.lifecycleConstruction);
      }
      this.lifecycleConstruction.ordinaryClose = "returned";
    } catch (error) {
      this.lifecycleConstruction.ordinaryClose = "unknown";
      this.lifecycleConstruction.unknown = true;
      throw error;
    }
  }
};

export {
  NATIVE_LIFECYCLE_ROUTE_LIMIT,
  nativeRouteDigest,
  BROADCAST_RECENT_MS,
  agentQueueKey,
  migrateMessageSchema,
  registrationIdentity,
  messageStoreHandleObservation,
  MessageStore
};
