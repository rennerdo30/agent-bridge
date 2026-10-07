import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResourceSlots, type SlotOwner } from "./resource-slots.js";
import { configureSqlite } from "./sqlite-policy.js";

const ROOT_LIMIT_DB = "root-limits.sqlite";
const LOCK_WAIT_MS = 3_000;

/** Every generation shares one root budget. Live-process leases also cover detached runners. */
export class RootConcurrency {
  private readonly slots: ResourceSlots;
  private readonly db: DatabaseSync;
  private readonly resource: string;

  constructor(home: string, private readonly rootSession: string) {
    this.resource = `root-${createHash("sha256").update(rootSession).digest("hex").slice(0, 40)}`;
    this.slots = new ResourceSlots(home);
    this.db = new DatabaseSync(join(home, ROOT_LIMIT_DB));
    configureSqlite(this.db);
    this.db.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}; CREATE TABLE IF NOT EXISTS root_limits (root TEXT PRIMARY KEY, capacity INTEGER NOT NULL);`);
  }

  setLimit(capacity: number): void {
    this.db.prepare("INSERT INTO root_limits(root, capacity) VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET capacity = excluded.capacity").run(this.rootSession, capacity);
  }

  ensureLimit(capacity: number): void {
    this.db.prepare("INSERT INTO root_limits(root, capacity) VALUES (?, ?) ON CONFLICT(root) DO NOTHING").run(this.rootSession, capacity);
  }

  private limit(): number {
    // Missing authority fails closed; a child cannot invent or raise its root budget.
    return Number(this.db.prepare("SELECT capacity FROM root_limits WHERE root = ?").get(this.rootSession)?.capacity ?? 0);
  }

  available(): boolean {
    return this.slots.list().filter((s) => s.resource === this.resource && s.held).length < this.limit();
  }

  acquire(owner: SlotOwner): boolean {
    const limit = this.limit();
    if (limit < 1) return false;
    if (this.slots.tryAcquire(this.resource, limit, owner)) return true;
    this.slots.release(owner, this.resource);
    return false;
  }

  moveJobs(names: string[]): void { this.slots.moveJobs(this.resource, names); }
  // Lease ids are unique per turn. A handoff may have moved their resource since acquisition.
  release(owner: SlotOwner): void { this.slots.release(owner); }
  renew(owner: SlotOwner): void { this.slots.renew(owner); }
  close(): void { this.slots.close(); this.db.close(); }
}
