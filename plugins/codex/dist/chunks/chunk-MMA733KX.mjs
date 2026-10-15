import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RESOURCE_NAME_PATTERN
} from "./chunk-2NHSQ4EH.mjs";
import {
  configureSqlite,
  isSqliteBusy,
  ownerGone,
  writtenBeforeBoot
} from "./chunk-BQPZDGG6.mjs";
import {
  identityStartedAfter,
  readProcessIdentities
} from "./chunk-W6KF56AK.mjs";

// src/core/resource-slots.ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

// src/core/slot-liveness.ts
var VALID_MS = 6e4;
var MAX_BATCH_PIDS = 256;
var MAX_PS_CONCURRENCY = 8;
var stderrLogger = { warn: (message) => {
  process.stderr.write(`[slot-liveness] ${message}
`);
} };
var SlotLiveness = class {
  constructor(log = stderrLogger, platform = process.platform) {
    this.log = log;
    this.platform = platform;
  }
  log;
  platform;
  cache = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  querying = false;
  refreshed = Promise.resolve();
  captures = /* @__PURE__ */ new Map();
  warn(message, error) {
    try {
      this.log.warn(message, { error });
    } catch {
    }
  }
  valid(row) {
    return row.dead === true || row.permanent === true && !!row.identity || Date.now() - row.at < VALID_MS;
  }
  observe(pid, key, record = {}) {
    const cached = this.cache.get(key);
    if (cached && this.valid(cached)) return cached;
    const raw = this.cache.get(pid === process.pid ? `${pid}|capture` : `${pid}|legacy-current`);
    if (record.recordedAt !== void 0 && (pid === process.pid || !record.expected) && raw && this.valid(raw)) {
      const dead = raw.identity !== void 0 && (record.expected ? raw.identity !== record.expected : identityStartedAfter(raw.identity, record.recordedAt + 1e3));
      const observed = { ...raw, ...record, dead };
      if (dead) this.cache.set(key, observed);
      return observed;
    }
    if (!this.pending.has(key)) this.pending.set(key, { pid, at: 0, ...record });
    if (!this.querying) {
      this.querying = true;
      this.refreshed = Promise.resolve().then(() => this.refresh());
    }
    return void 0;
  }
  /** Includes keys queued during a query and their follow-up batches; hot paths never await it. */
  settled() {
    return this.refreshed;
  }
  notify(listener, identity) {
    try {
      listener(identity);
    } catch (error) {
      this.warn("slot identity capture listener failed", error);
    }
  }
  async refresh() {
    try {
      while (this.pending.size) await this.refreshBatch();
    } catch (error) {
      this.warn("slot identity refresh failed", error);
    } finally {
      this.querying = false;
    }
  }
  async refreshBatch() {
    const batch = new Map(this.pending);
    this.pending.clear();
    const pids = [...new Set([...batch.values()].map((row) => row.pid))];
    const size = this.platform === "darwin" ? MAX_PS_CONCURRENCY : MAX_BATCH_PIDS;
    for (let offset = 0; offset < pids.length; offset += size) {
      const chunk = pids.slice(offset, offset + size), included = new Set(chunk);
      let identities;
      try {
        identities = await readProcessIdentities(chunk);
      } catch {
      }
      const at = Date.now();
      for (const [key, row] of batch) {
        if (!included.has(row.pid)) continue;
        const identity = identities?.get(row.pid) || void 0;
        const dead = identity !== void 0 && row.recordedAt !== void 0 && (row.expected ? identity !== row.expected : identityStartedAfter(identity, row.recordedAt + 1e3));
        this.cache.set(key, { ...row, identity, dead, at });
        if (row.recordedAt !== void 0 && !row.expected) this.cache.set(`${row.pid}|legacy-current`, { pid: row.pid, identity, at });
        this.pending.delete(key);
        const listener = this.captures.get(key);
        this.captures.delete(key);
        if (identity && listener) this.notify(listener, identity);
      }
    }
    for (const [key, row] of this.cache) if (!this.valid(row)) this.cache.delete(key);
  }
  alive = (pid, identity, recordedAt) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    const key = recordedAt === void 0 ? void 0 : `${pid}|${identity ?? ""}|${identity ? writtenBeforeBoot(recordedAt) : recordedAt}`;
    if (key && this.cache.get(key)?.dead) return false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      return !ownerGone({ alive: error.code === "ESRCH" ? false : void 0, recordedAt });
    }
    if (recordedAt === void 0) return true;
    const observed = this.observe(pid, key, { expected: identity, recordedAt });
    if (observed?.dead) return false;
    const current = observed?.identity;
    const alive = current === void 0 ? void 0 : identity ? current === identity : !identityStartedAfter(current, recordedAt + 1e3);
    return !ownerGone({ alive, recordedAt });
  };
  /** This process cannot change its creation identity; successful capture lasts for its lifetime. */
  identity(pid) {
    if (pid !== process.pid) return null;
    return this.observe(pid, `${pid}|capture`, { permanent: true })?.identity ?? null;
  }
  capture(pid, record, listener) {
    const key = `${pid}|capture-record|${record}`;
    const observed = this.observe(pid, key);
    if (observed) {
      if (observed.identity) this.notify(listener, observed.identity);
      return;
    }
    this.captures.set(key, listener);
  }
};
var slotLiveness = new SlotLiveness();

// src/core/resource-slots.ts
var SLOT_OWNER_ENV = "AGENT_BRIDGE_SLOT_OWNER";
var SLOT_PID_ENV = "AGENT_BRIDGE_SLOT_PID";
var SLOT_LEASE_MS = 6 * 60 * 6e4;
var SLOT_RENEW_MS = 6e4;
var SLOT_POLL_MS = 250;
var SLOT_DB_NAME = "resource-slots.sqlite";
var LOCK_WAIT_MS = 3e3;
var RELEASE_ATTEMPTS = 10;
var nextStoreId = 0;
var ResourceSlots = class {
  constructor(home, isAlive = slotLiveness.alive, now = Date.now) {
    this.isAlive = isAlive;
    this.now = now;
    mkdirSync(home, { recursive: true });
    this.db = new DatabaseSync(join(home, SLOT_DB_NAME));
    configureSqlite(this.db);
    this.db.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS};
      CREATE TABLE IF NOT EXISTS slots (
        ticket INTEGER PRIMARY KEY AUTOINCREMENT, resource TEXT NOT NULL, id TEXT NOT NULL,
        pid INTEGER NOT NULL, held INTEGER NOT NULL, expiresAt INTEGER NOT NULL, UNIQUE(resource, id)
      );`);
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('slots') WHERE name = 'identity'").get()) {
      try {
        this.db.exec("ALTER TABLE slots ADD COLUMN identity TEXT");
      } catch (err) {
        if (!/duplicate column/i.test(String(err))) throw err;
      }
    }
  }
  isAlive;
  now;
  db;
  captureId = ++nextStoreId;
  closed = false;
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  /**
   * Liveness uses immediate PID checks and cached asynchronous identity evidence.
   * Observe before the transaction; no process query holds the slot database lock.
   */
  deadOwners() {
    const owners = this.db.prepare("SELECT pid, identity, MAX(expiresAt) AS expiresAt FROM slots GROUP BY pid, identity").all();
    return owners.map((row) => ({ pid: Number(row.pid), identity: row.identity, expiresAt: Number(row.expiresAt) })).filter((row) => !this.isAlive(row.pid, row.identity, row.expiresAt - SLOT_LEASE_MS));
  }
  prune(dead) {
    this.db.prepare("DELETE FROM slots WHERE expiresAt <= ?").run(this.now());
    for (const row of dead) this.db.prepare("DELETE FROM slots WHERE pid = ? AND identity IS ? AND expiresAt <= ?").run(row.pid, row.identity ?? null, row.expiresAt);
  }
  tryAcquire(resource, count, owner) {
    if (!RESOURCE_NAME_PATTERN.test(resource) || !Number.isInteger(count) || count < 1) throw new Error("Invalid resource name or capacity.");
    if (!owner.id || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !this.isAlive(owner.pid)) throw new Error("A resource slot needs a live owner process.");
    const identity = slotLiveness.identity(owner.pid), dead = this.deadOwners();
    const acquired = this.transaction(() => {
      this.prune(dead);
      this.db.prepare("INSERT INTO slots(resource, id, pid, held, expiresAt, identity) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(resource, id) DO NOTHING").run(resource, owner.id, owner.pid, this.now() + SLOT_LEASE_MS, identity);
      const own = this.db.prepare("SELECT ticket, pid, held FROM slots WHERE resource = ? AND id = ?").get(resource, owner.id);
      if (Number(own.pid) !== owner.pid) throw new Error("Resource slot owner does not match.");
      this.db.prepare("UPDATE slots SET expiresAt = ? WHERE resource = ? AND id = ?").run(this.now() + SLOT_LEASE_MS, resource, owner.id);
      if (own.held) return true;
      const held = Number(this.db.prepare("SELECT COUNT(*) AS n FROM slots WHERE resource = ? AND held = 1").get(resource).n);
      const ahead = Number(this.db.prepare("SELECT COUNT(*) AS n FROM slots WHERE resource = ? AND held = 0 AND ticket < ?").get(resource, own.ticket).n);
      if (held + ahead >= count) return false;
      this.db.prepare("UPDATE slots SET held = 1 WHERE ticket = ?").run(own.ticket);
      return true;
    });
    if (!identity) {
      const row = this.db.prepare("SELECT ticket, expiresAt, identity FROM slots WHERE resource = ? AND id = ? AND pid = ?").get(resource, owner.id, owner.pid);
      if (row.identity !== null) return acquired;
      const recordedAt = Number(row.expiresAt) - SLOT_LEASE_MS;
      slotLiveness.capture(owner.pid, `${this.captureId}|${row.ticket}`, (observed) => {
        if (this.closed || identityStartedAfter(observed, recordedAt + 1e3)) return;
        try {
          this.db.prepare("UPDATE slots SET identity = ? WHERE ticket = ? AND pid = ? AND expiresAt = ? AND identity IS NULL").run(observed, row.ticket, owner.pid, row.expiresAt);
        } catch (error) {
          if (!isSqliteBusy(error)) throw error;
        }
      });
    }
    return acquired;
  }
  async acquire(resource, count, owner, signal) {
    try {
      for (; ; ) {
        signal?.throwIfAborted();
        try {
          if (this.tryAcquire(resource, count, owner)) return;
        } catch (err) {
          if (!isSqliteBusy(err)) throw err;
        }
        await delay(SLOT_POLL_MS, void 0, { signal });
      }
    } catch (err) {
      this.release(owner, resource);
      throw err;
    }
  }
  release(owner, resource) {
    for (let attempt = 1; ; attempt++) {
      try {
        this.db.prepare(`DELETE FROM slots WHERE id = ? AND pid = ?${resource ? " AND resource = ?" : ""}`).run(...resource ? [owner.id, owner.pid, resource] : [owner.id, owner.pid]);
        return;
      } catch (err) {
        if (!isSqliteBusy(err) || attempt >= RELEASE_ATTEMPTS) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SLOT_POLL_MS);
      }
    }
  }
  renew(owner, resource) {
    const args = [this.now() + SLOT_LEASE_MS, owner.id, owner.pid, this.now()];
    this.db.prepare(`UPDATE slots SET expiresAt = ? WHERE id = ? AND pid = ? AND expiresAt > ?${resource ? " AND resource = ?" : ""}`).run(...resource ? [...args, resource] : args);
  }
  list() {
    const dead = this.deadOwners();
    return this.transaction(() => {
      this.prune(dead);
      return this.db.prepare("SELECT * FROM slots ORDER BY ticket").all().map((row) => ({ resource: String(row.resource), id: String(row.id), pid: Number(row.pid), ticket: Number(row.ticket), held: Boolean(row.held), expiresAt: Number(row.expiresAt) }));
    });
  }
  /**
   * For display (dashboard, peers): unexpired rows without probes or writes.
   * Pruning stays with list and acquisition.
   */
  snapshot() {
    const now = this.now();
    return this.db.prepare("SELECT * FROM slots WHERE expiresAt > ? ORDER BY ticket").all(now).flatMap((row) => {
      const pid = Number(row.pid);
      return [{ resource: String(row.resource), id: String(row.id), pid, ticket: Number(row.ticket), held: Boolean(row.held), expiresAt: Number(row.expiresAt) }];
    });
  }
  close() {
    this.closed = true;
    this.db.close();
  }
  /** Move live root leases without enforcing capacity: inherited work must keep running. */
  moveJobs(resource, names) {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT ticket, id, resource FROM slots WHERE resource LIKE 'root-%'").all()) {
        if (row.resource !== resource && names.some((name) => String(row.id).startsWith(`${name}-`))) {
          this.db.prepare("UPDATE slots SET resource=? WHERE ticket=?").run(resource, row.ticket);
        }
      }
    });
  }
};
function slotOwner(env = process.env) {
  const pid = Number(env[SLOT_PID_ENV] || process.ppid);
  return { id: env[SLOT_OWNER_ENV] || `process-${pid}`, pid };
}
function resourceSlotHint(counts, cli) {
  if (!Object.keys(counts).length) return null;
  const command = cli ? `node "${cli}"` : "agent-bridge";
  return `(agent-bridge: shared resource slots are enabled: ${JSON.stringify(counts)}. Before a heavy command, run ${command} slot acquire <resource>; it waits in FIFO order. Always run ${command} slot release <resource> afterward, including on failure (use try/finally or a shell trap). ${command} slot status shows holders and waiters. Slots are shared across jobs and released when your run ends or its owner process dies. Acquiring twice is idempotent; hold one slot per resource per job.)`;
}
function describeResourceSlots(entries, capacities = {}) {
  const resources = [.../* @__PURE__ */ new Set([...Object.keys(capacities), ...entries.map((e) => e.resource)])].sort();
  return resources.map((resource) => {
    const mine = entries.filter((e) => e.resource === resource).sort((a, b) => a.ticket - b.ticket);
    return { resource, capacity: capacities[resource] ?? null, held: mine.filter((e) => e.held), waiting: mine.filter((e) => !e.held) };
  });
}
function formatResourceSlots(entries, capacities = {}) {
  return describeResourceSlots(entries, capacities).filter((r) => r.held.length || r.waiting.length).map((r) => `- ${r.resource}${r.capacity !== null ? ` (${r.held.length}/${r.capacity})` : ""}: held by ${r.held.map((e) => `${e.id} [pid ${e.pid}]`).join(", ") || "nobody"}` + (r.waiting.length ? `; waiting: ${r.waiting.map((e) => e.id).join(", ")}` : ""));
}

export {
  SLOT_OWNER_ENV,
  SLOT_PID_ENV,
  SLOT_RENEW_MS,
  ResourceSlots,
  slotOwner,
  resourceSlotHint,
  describeResourceSlots,
  formatResourceSlots
};
