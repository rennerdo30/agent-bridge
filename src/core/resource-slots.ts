import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { RESOURCE_NAME_PATTERN } from "./config.js";
import { configureSqlite, isSqliteBusy } from "./sqlite-policy.js";
import { processIdentity, recordedOwnerAlive } from "./process-identity.js";

export const SLOT_OWNER_ENV = "AGENT_BRIDGE_SLOT_OWNER";
export const SLOT_PID_ENV = "AGENT_BRIDGE_SLOT_PID";
export const SLOT_LEASE_MS = 6 * 60 * 60_000;
export const SLOT_RENEW_MS = 60_000;
const SLOT_POLL_MS = 250;
const SLOT_DB_NAME = "resource-slots.sqlite";
const LOCK_WAIT_MS = 3_000;

export interface SlotOwner { id: string; pid: number }
export interface SlotEntry extends SlotOwner { resource: string; ticket: number; held: boolean; expiresAt: number }

/** Identity probes are slow (PowerShell on Windows): verdicts and own identities are reused for a minute. */
const PROBE_CACHE_MS = 60_000;
const verdicts = new Map<string, { alive: boolean; at: number }>();
const identities = new Map<number, { identity: string | undefined; at: number }>();

/**
 * A slot owner is alive while its PID exists and (AB-218) still belongs to the same process: its recorded identity
 * matches, or, for rows without one, the process using the PID started before the row was last renewed.
 */
function alive(pid: number, identity?: string | null, recordedAt?: number): boolean {
  try { process.kill(pid, 0); }
  catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
  if (recordedAt === undefined) return true;
  const key = `${pid}|${identity ?? ""}|${identity ? "" : recordedAt}`, cached = verdicts.get(key);
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.alive;
  const verdict = recordedOwnerAlive(pid, identity ?? undefined, recordedAt);
  verdicts.set(key, { alive: verdict, at: Date.now() });
  return verdict;
}

function ownerIdentity(pid: number): string | null {
  const cached = identities.get(pid);
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.identity ?? null;
  const identity = processIdentity(pid);
  identities.set(pid, { identity, at: Date.now() });
  return identity ?? null;
}

/** SQLite's file locks serialize FIFO tickets and leases across processes and recover after crashes. */
export class ResourceSlots {
  private readonly db: DatabaseSync;
  constructor(home: string, private readonly isAlive: (pid: number, identity?: string | null, recordedAt?: number) => boolean = alive, private readonly now = Date.now) {
    mkdirSync(home, { recursive: true });
    this.db = new DatabaseSync(join(home, SLOT_DB_NAME));
    configureSqlite(this.db);
    this.db.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS};
      CREATE TABLE IF NOT EXISTS slots (
        ticket INTEGER PRIMARY KEY AUTOINCREMENT, resource TEXT NOT NULL, id TEXT NOT NULL,
        pid INTEGER NOT NULL, held INTEGER NOT NULL, expiresAt INTEGER NOT NULL, UNIQUE(resource, id)
      );`);
    // Additive: the owner's process identity, so a reused PID does not keep a dead owner's slot (AB-218).
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('slots') WHERE name = 'identity'").get()) {
      try { this.db.exec("ALTER TABLE slots ADD COLUMN identity TEXT"); }
      catch (err) { if (!/duplicate column/i.test(String(err))) throw err; }
    }
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
    const owners = this.db.prepare("SELECT pid, identity, MAX(expiresAt) AS expiresAt FROM slots GROUP BY pid, identity").all();
    for (const row of owners) {
      // Without an identity, the last renewal is when the owner was last seen alive.
      if (!this.isAlive(Number(row.pid), row.identity as string | null, Number(row.expiresAt) - SLOT_LEASE_MS)) {
        this.db.prepare("DELETE FROM slots WHERE pid = ? AND identity IS ?").run(row.pid!, row.identity ?? null);
      }
    }
  }

  tryAcquire(resource: string, count: number, owner: SlotOwner): boolean {
    if (!RESOURCE_NAME_PATTERN.test(resource) || !Number.isInteger(count) || count < 1) throw new Error("Invalid resource name or capacity.");
    if (!owner.id || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !this.isAlive(owner.pid)) throw new Error("A resource slot needs a live owner process.");
    // Probe outside the write transaction: it can take a moment on Windows.
    const identity = ownerIdentity(owner.pid);
    return this.transaction(() => {
      this.prune();
      this.db.prepare("INSERT INTO slots(resource, id, pid, held, expiresAt, identity) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(resource, id) DO NOTHING").run(resource, owner.id, owner.pid, this.now() + SLOT_LEASE_MS, identity);
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
        try { if (this.tryAcquire(resource, count, owner)) return; }
        catch (err) { if (!isSqliteBusy(err)) throw err; }
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

/** Holders first, then the queue in ticket order: shown by peers, the resource_slots tool and the dashboard (AB-40). */
export function describeResourceSlots(entries: SlotEntry[], capacities: Record<string, number> = {}): { resource: string; capacity: number | null; held: SlotEntry[]; waiting: SlotEntry[] }[] {
  const resources = [...new Set([...Object.keys(capacities), ...entries.map(e => e.resource)])].sort();
  return resources.map(resource => {
    const mine = entries.filter(e => e.resource === resource).sort((a, b) => a.ticket - b.ticket);
    return { resource, capacity: capacities[resource] ?? null, held: mine.filter(e => e.held), waiting: mine.filter(e => !e.held) };
  });
}
export function formatResourceSlots(entries: SlotEntry[], capacities: Record<string, number> = {}): string[] {
  return describeResourceSlots(entries, capacities).filter(r => r.held.length || r.waiting.length).map(r =>
    `- ${r.resource}${r.capacity !== null ? ` (${r.held.length}/${r.capacity})` : ""}: held by ${r.held.map(e => `${e.id} [pid ${e.pid}]`).join(", ") || "nobody"}` +
    (r.waiting.length ? `; waiting: ${r.waiting.map(e => e.id).join(", ")}` : ""));
}
