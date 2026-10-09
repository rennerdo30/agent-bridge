import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RESOURCE_NAME_PATTERN
} from "./chunk-QI6BOSWF.mjs";
import {
  configureSqlite,
  isSqliteBusy
} from "./chunk-EVPBD2NK.mjs";

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
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
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
  prune() {
    this.db.prepare("DELETE FROM slots WHERE expiresAt <= ?").run(this.now());
    const pids = this.db.prepare("SELECT DISTINCT pid FROM slots").all();
    for (const row of pids) if (!this.isAlive(Number(row.pid))) this.db.prepare("DELETE FROM slots WHERE pid = ?").run(row.pid);
  }
  tryAcquire(resource, count, owner) {
    if (!RESOURCE_NAME_PATTERN.test(resource) || !Number.isInteger(count) || count < 1) throw new Error("Invalid resource name or capacity.");
    if (!owner.id || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !this.isAlive(owner.pid)) throw new Error("A resource slot needs a live owner process.");
    return this.transaction(() => {
      this.prune();
      this.db.prepare("INSERT INTO slots(resource, id, pid, held, expiresAt) VALUES (?, ?, ?, 0, ?) ON CONFLICT(resource, id) DO NOTHING").run(resource, owner.id, owner.pid, this.now() + SLOT_LEASE_MS);
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
    this.db.prepare(`DELETE FROM slots WHERE id = ? AND pid = ?${resource ? " AND resource = ?" : ""}`).run(...resource ? [owner.id, owner.pid, resource] : [owner.id, owner.pid]);
  }
  renew(owner, resource) {
    const args = [this.now() + SLOT_LEASE_MS, owner.id, owner.pid, this.now()];
    this.db.prepare(`UPDATE slots SET expiresAt = ? WHERE id = ? AND pid = ? AND expiresAt > ?${resource ? " AND resource = ?" : ""}`).run(...resource ? [...args, resource] : args);
  }
  list() {
    return this.transaction(() => {
      this.prune();
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

export {
  SLOT_OWNER_ENV,
  SLOT_PID_ENV,
  SLOT_RENEW_MS,
  ResourceSlots,
  slotOwner,
  resourceSlotHint
};
