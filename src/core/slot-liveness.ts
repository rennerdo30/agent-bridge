import { identityStartedAfter, readProcessIdentities } from "./process-identity.js";
import { ownerGone, writtenBeforeBoot } from "./boot-time.js";

const VALID_MS = 1_000;
type Observation = { pid: number; identity?: string; at: number };

/** Slot polls never wait for process queries. Unknown evidence keeps capacity occupied.
 * Keys include the recorded creation identity (or legacy renewal time), so a result
 * for an earlier PID generation cannot evict a newly recorded owner.
 */
export class SlotLiveness {
  private readonly cache = new Map<string, Observation>();
  private readonly pending = new Map<string, Observation>();
  private querying = false;
  private refreshed: Promise<void> = Promise.resolve();
  private readonly captures = new Map<string, (identity: string) => void>();
  private nextCapture = 0;

  private observe(pid: number, key: string): string | undefined {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < VALID_MS) return cached.identity;
    if (!this.pending.has(key)) this.pending.set(key, { pid, at: 0 });
    if (!this.querying) {
      this.querying = true;
      // All owners encountered by this poll join one query, including owner capture.
      this.refreshed = Promise.resolve().then(() => this.refresh());
    }
    return undefined;
  }

  /** Optional completion barrier for offline inspections; hot-path callers never await it. */
  settled(): Promise<void> { return this.refreshed; }

  private async refresh(): Promise<void> {
    const batch = new Map(this.pending);
    this.pending.clear();
    let identities: Map<number, string> | undefined;
    try { identities = await readProcessIdentities([...new Set([...batch.values()].map(row => row.pid))]); }
    catch { /* Failed queries are unknown, never evidence of exit. */ }
    const at = Date.now();
    for (const [key, row] of batch) {
      this.cache.set(key, { pid: row.pid, identity: identities?.get(row.pid) || undefined, at });
      // Polls during the query must not immediately repeat the same slow lookup.
      this.pending.delete(key);
    }
    for (const [key, row] of this.cache) if (at - row.at > VALID_MS) this.cache.delete(key);
    this.querying = false;
    for (const [key, row] of batch) {
      const listener = this.captures.get(key);
      this.captures.delete(key);
      const identity = identities?.get(row.pid);
      if (identity && listener) listener(identity);
    }
    // New owners seen during the batch are picked up by the next poll.
  }

  alive = (pid: number, identity?: string | null, recordedAt?: number): boolean => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try { process.kill(pid, 0); }
    catch (error) { return !ownerGone({ alive: (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined, recordedAt }); }
    if (recordedAt === undefined) return true;
    const key = `${pid}|${identity ?? ""}|${identity ? writtenBeforeBoot(recordedAt) : recordedAt}`;
    const current = this.observe(pid, key);
    const alive = current === undefined ? undefined : identity ? current === identity : !identityStartedAfter(current, recordedAt + 1_000);
    return !ownerGone({ alive, recordedAt });
  };

  /** Capturing an owner identity is also asynchronous; legacy null rows remain safe. */
  identity(pid: number): string | null {
    if (pid !== process.pid) return null;
    return this.observe(pid, `${pid}|capture`) ?? null;
  }

  capture(pid: number, listener: (identity: string) => void): void {
    const key = `${pid}|capture-record|${++this.nextCapture}`;
    this.captures.set(key, listener);
    this.observe(pid, key);
  }
}

// Share cache and in-flight batching across root, startup and resource stores.
export const slotLiveness = new SlotLiveness();
