import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResourceSlots, type SlotOwner } from "./resource-slots.js";
import { configureSqlite } from "./sqlite-policy.js";
import { isSqliteBusy } from "./sqlite-policy.js";
import { setTimeout as delay } from "node:timers/promises";
import { storageAdmissionRemaining, storageAdmissionTimeout, admissionSqliteBusy } from "./storage-admission.js";
import { assertSqliteFamily } from "./mailbox-layout.js";

const ROOT_LIMIT_DB = "root-limits.sqlite";
const LOCK_WAIT_MS = 3_000;

/** Every generation shares one root budget. Live-process leases also cover detached runners. */
export class RootConcurrency {
  private readonly slots: ResourceSlots;
  private readonly db: DatabaseSync;
  private readonly resource: string;

  constructor(home: string, private readonly rootSession: string) {
    assertSqliteFamily(join(home,ROOT_LIMIT_DB));
    this.resource = `root-${createHash("sha256").update(rootSession).digest("hex").slice(0, 40)}`;
    this.slots = new ResourceSlots(home);
    let owned:DatabaseSync|undefined;
    try {
      const left=storageAdmissionRemaining();this.db=owned=left===undefined?new DatabaseSync(join(home,ROOT_LIMIT_DB)):new DatabaseSync(join(home,ROOT_LIMIT_DB),{timeout:storageAdmissionTimeout(LOCK_WAIT_MS)});
      configureSqlite(this.db);admissionSqliteBusy(this.db,LOCK_WAIT_MS,true);
      storageAdmissionRemaining();this.db.exec('CREATE TABLE IF NOT EXISTS root_limits (root TEXT PRIMARY KEY, capacity INTEGER NOT NULL);');storageAdmissionRemaining();
    }catch(error){try{owned?.close();}finally{this.slots.close();}throw error;}
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

  /** Keep a FIFO ticket while another coordinator is using the same root's capacity. */
  async acquireWhenAvailable(owner: SlotOwner, signal: AbortSignal): Promise<void> {
    try {
      for (;;) {
        signal.throwIfAborted();
        try {
          const limit = this.limit();
          if (limit > 0 && this.slots.tryAcquire(this.resource, limit, owner)) return;
        } catch (err) { if (!isSqliteBusy(err)) throw err; }
        await delay(250, undefined, { signal });
      }
    } catch (err) { this.release(owner); throw err; }
  }

  moveJobs(names: string[]): void { this.slots.moveJobs(this.resource, names); }
  // Lease ids are unique per turn. A handoff may have moved their resource since acquisition.
  release(owner: SlotOwner): void { this.slots.release(owner); }
  renew(owner: SlotOwner): void { this.slots.renew(owner); }
  close(): void { this.slots.close(); this.db.close(); }
}
