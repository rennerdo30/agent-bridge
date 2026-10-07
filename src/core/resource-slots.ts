import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { RESOURCE_NAME_PATTERN } from "./config.js";

export const SLOT_OWNER_ENV = "AGENT_BRIDGE_SLOT_OWNER";
export const SLOT_PID_ENV = "AGENT_BRIDGE_SLOT_PID";
export const SLOT_LEASE_MS = 6 * 60 * 60_000;
export const SLOT_RENEW_MS = 60_000;
const SLOT_POLL_MS = 250;
const SLOT_DB_NAME = "resource-slots.sqlite";
const LOCK_WAIT_MS = 3_000;

export interface SlotOwner { id: string; pid: number }
export interface SlotEntry extends SlotOwner { resource: string; ticket: number; held: boolean; expiresAt: number }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** SQLite's file locks serialize FIFO tickets and leases across processes and recover after crashes. */
export class ResourceSlots {
  private readonly db: DatabaseSync;
  constructor(home: string, private readonly isAlive = alive, private readonly now = Date.now) {
    mkdirSync(home, { recursive: true });
    this.db = new DatabaseSync(join(home, SLOT_DB_NAME));
    this.db.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS};
      CREATE TABLE IF NOT EXISTS slots (
        ticket INTEGER PRIMARY KEY AUTOINCREMENT, resource TEXT NOT NULL, id TEXT NOT NULL,
        pid INTEGER NOT NULL, held INTEGER NOT NULL, expiresAt INTEGER NOT NULL, UNIQUE(resource, id)
      );`);
  }

  private transaction<T>(fn: () => T): T {
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

  private prune(): void {
    this.db.prepare("DELETE FROM slots WHERE expiresAt <= ?").run(this.now());
    const pids = this.db.prepare("SELECT DISTINCT pid FROM slots").all();
    for (const row of pids) if (!this.isAlive(Number(row.pid))) this.db.prepare("DELETE FROM slots WHERE pid = ?").run(row.pid!);
  }

  tryAcquire(resource: string, count: number, owner: SlotOwner): boolean {
    if (!RESOURCE_NAME_PATTERN.test(resource) || !Number.isInteger(count) || count < 1) throw new Error("Invalid resource name or capacity.");
    if (!owner.id || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !this.isAlive(owner.pid)) throw new Error("A resource slot needs a live owner process.");
    return this.transaction(() => {
      this.prune();
      this.db.prepare("INSERT INTO slots(resource, id, pid, held, expiresAt) VALUES (?, ?, ?, 0, ?) ON CONFLICT(resource, id) DO NOTHING").run(resource, owner.id, owner.pid, this.now() + SLOT_LEASE_MS);
      const own = this.db.prepare("SELECT ticket, pid, held FROM slots WHERE resource = ? AND id = ?").get(resource, owner.id)!;
      if (Number(own.pid) !== owner.pid) throw new Error("Resource slot owner does not match.");
      this.db.prepare("UPDATE slots SET expiresAt = ? WHERE resource = ? AND id = ?").run(this.now() + SLOT_LEASE_MS, resource, owner.id);
      if (own.held) return true;
      const held = Number(this.db.prepare("SELECT COUNT(*) AS n FROM slots WHERE resource = ? AND held = 1").get(resource)!.n);
      const ahead = Number(this.db.prepare("SELECT COUNT(*) AS n FROM slots WHERE resource = ? AND held = 0 AND ticket < ?").get(resource, own.ticket!)!.n);
      if (held + ahead >= count) return false;
      this.db.prepare("UPDATE slots SET held = 1 WHERE ticket = ?").run(own.ticket!);
      return true;
    });
  }

  async acquire(resource: string, count: number, owner: SlotOwner, signal?: AbortSignal): Promise<void> {
    try {
      for (;;) {
        signal?.throwIfAborted();
        if (this.tryAcquire(resource, count, owner)) return;
        await delay(SLOT_POLL_MS, undefined, { signal });
      }
    } catch (err) {
      this.release(owner, resource);
      throw err;
    }
  }

  release(owner: SlotOwner, resource?: string): void {
    this.db.prepare(`DELETE FROM slots WHERE id = ? AND pid = ?${resource ? " AND resource = ?" : ""}`).run(...(resource ? [owner.id, owner.pid, resource] : [owner.id, owner.pid]));
  }

  renew(owner: SlotOwner, resource?: string): void {
    const args = [this.now() + SLOT_LEASE_MS, owner.id, owner.pid, this.now()];
    this.db.prepare(`UPDATE slots SET expiresAt = ? WHERE id = ? AND pid = ? AND expiresAt > ?${resource ? " AND resource = ?" : ""}`).run(...(resource ? [...args, resource] : args));
  }

  list(): SlotEntry[] {
    return this.transaction(() => {
      this.prune();
      return this.db.prepare("SELECT * FROM slots ORDER BY ticket").all().map((row) => ({ resource: String(row.resource), id: String(row.id), pid: Number(row.pid), ticket: Number(row.ticket), held: Boolean(row.held), expiresAt: Number(row.expiresAt) }));
    });
  }

  close(): void { this.db.close(); }

  /** Move live root leases without enforcing capacity: inherited work must keep running. */
  moveJobs(resource: string, names: string[]): void {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT ticket, id, resource FROM slots WHERE resource LIKE 'root-%'").all()) {
        if (row.resource !== resource && names.some((name) => String(row.id).startsWith(`${name}-`))) {
          this.db.prepare("UPDATE slots SET resource=? WHERE ticket=?").run(resource, row.ticket!);
        }
      }
    });
  }
}

export function slotOwner(env: NodeJS.ProcessEnv = process.env): SlotOwner {
  const pid = Number(env[SLOT_PID_ENV] || process.ppid);
  return { id: env[SLOT_OWNER_ENV] || `process-${pid}`, pid };
}

export function resourceSlotHint(counts: Record<string, number>, cli: string | null): string | null {
  if (!Object.keys(counts).length) return null;
  const command = cli ? `node "${cli}"` : "agent-bridge";
  return `(agent-bridge: shared resource slots are enabled: ${JSON.stringify(counts)}. Before a heavy command, run ${command} slot acquire <resource>; it waits in FIFO order. Always run ${command} slot release <resource> afterward, including on failure (use try/finally or a shell trap). ${command} slot status shows holders and waiters. Slots are shared across jobs and released when your run ends or its owner process dies. Acquiring twice is idempotent; hold one slot per resource per job.)`;
}
