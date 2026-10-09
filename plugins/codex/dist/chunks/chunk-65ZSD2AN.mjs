import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RESOURCE_NAME_PATTERN
} from "./chunk-ENIEXOVX.mjs";
import {
  configureSqlite,
  isSqliteBusy,
  ownerGone,
  writtenBeforeBoot
} from "./chunk-2BBQZ46F.mjs";
import {
  processIdentity,
  recordedOwnerLiveness
} from "./chunk-P6KUA2PD.mjs";

// src/core/resource-slots.ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
var SLOT_OWNER_ENV = "AGENT_BRIDGE_SLOT_OWNER";
var SLOT_PID_ENV = "AGENT_BRIDGE_SLOT_PID";
var SLOT_LEASE_MS = 6 * 60 * 6e4;
var SLOT_RENEW_MS = 6e4;
var SLOT_POLL_MS = 250;
var SLOT_DB_NAME = "resource-slots.sqlite";
var LOCK_WAIT_MS = 3e3;
var RELEASE_ATTEMPTS = 10;
var PROBE_CACHE_MS = 6e4;
var verdicts = /* @__PURE__ */ new Map();
var identities = /* @__PURE__ */ new Map();
function alive(pid, identity, recordedAt) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return !ownerGone({ alive: err.code === "ESRCH" ? false : void 0, recordedAt });
  }
  if (recordedAt === void 0) return true;
  const key = `${pid}|${identity ?? ""}|${identity ? writtenBeforeBoot(recordedAt) : recordedAt}`, cached = verdicts.get(key);
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.alive;
  const verdict = !ownerGone({ alive: recordedOwnerLiveness(pid, identity ?? void 0, recordedAt), recordedAt });
  verdicts.set(key, { alive: verdict, at: Date.now() });
  return verdict;
}
function ownerIdentity(pid) {
  const cached = identities.get(pid);
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.identity ?? null;
  const identity = processIdentity(pid);
  identities.set(pid, { identity, at: Date.now() });
  return identity ?? null;
}
var ResourceSlots = class {
  constructor(home, isAlive = alive, now = Date.now) {
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
   * Owner liveness probes can take seconds (PowerShell on Windows). They run before the write
   * transaction: holding the slot database lock during them made other processes' writes, including
   * a startup lease release, fail with SQLITE_BUSY after the busy timeout.
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
    const identity = ownerIdentity(owner.pid), dead = this.deadOwners();
    return this.transaction(() => {
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
  close() {
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
