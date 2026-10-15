import { identityStartedAfter, readProcessIdentities } from "./process-identity.js";
import { ownerGone, writtenBeforeBoot } from "./boot-time.js";
import type { Logger } from "./logger.js";

const VALID_MS = 60_000;
const MAX_BATCH_PIDS = 256;
// On macOS the existing reader starts one ps process per PID. Bound those too.
const MAX_PS_CONCURRENCY = 8;
type RecordIdentity = { expected?: string | null; recordedAt?: number; permanent?: boolean };
type Observation = RecordIdentity & { pid: number; identity?: string; at: number; dead?: boolean };
const stderrLogger = { warn: (message: string) => { process.stderr.write(`[slot-liveness] ${message}\n`); } };

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

  constructor(private readonly log: Pick<Logger, "warn"> = stderrLogger, private readonly platform = process.platform) {}

  private warn(message: string, error: unknown): void {
    try { this.log.warn(message, { error }); } catch { /* Diagnostics must not break slot accounting. */ }
  }

  private valid(row: Observation): boolean {
    return row.dead === true || (row.permanent === true && !!row.identity) || Date.now() - row.at < VALID_MS;
  }

  private observe(pid: number, key: string, record: RecordIdentity = {}): Observation | undefined {
    const cached = this.cache.get(key);
    if (cached && this.valid(cached)) return cached;
    // Legacy renewals change recordedAt each poll. Reuse a recent raw observation,
    // then compare it with the new renewal rather than launching again for that key.
    // Our own creation identity is immutable for the lifetime of this helper.
    const raw = this.cache.get(pid === process.pid ? `${pid}|capture` : `${pid}|legacy-current`);
    if (record.recordedAt !== undefined && (pid === process.pid || !record.expected) && raw && this.valid(raw)) {
      const dead = raw.identity !== undefined && (record.expected ? raw.identity !== record.expected
        : identityStartedAfter(raw.identity, record.recordedAt + 1_000));
      const observed = { ...raw, ...record, dead };
      if (dead) this.cache.set(key, observed);
      return observed;
    }
    if (!this.pending.has(key)) this.pending.set(key, { pid, at: 0, ...record });
    if (!this.querying) {
      this.querying = true;
      // All owners encountered by this poll join one query, including owner capture.
      this.refreshed = Promise.resolve().then(() => this.refresh());
    }
    return undefined;
  }

  /** Includes keys queued during a query and their follow-up batches; hot paths never await it. */
  settled(): Promise<void> { return this.refreshed; }

  private notify(listener: (identity: string) => void, identity: string): void {
    try { listener(identity); }
    catch (error) { this.warn("slot identity capture listener failed", error); }
  }

  private async refresh(): Promise<void> {
    try {
      // Drain new keys even in a quiet host with no subsequent poll. Keep one
      // promise for the whole drain so settled() includes every follow-up query.
      while (this.pending.size) await this.refreshBatch();
    } catch (error) { this.warn("slot identity refresh failed", error); }
    finally { this.querying = false; }
  }

  private async refreshBatch(): Promise<void> {
    const batch = new Map(this.pending);
    this.pending.clear();
    const pids = [...new Set([...batch.values()].map(row => row.pid))];
    const size = this.platform === "darwin" ? MAX_PS_CONCURRENCY : MAX_BATCH_PIDS;
    for (let offset = 0; offset < pids.length; offset += size) {
      const chunk = pids.slice(offset, offset + size), included = new Set(chunk);
      let identities: Map<number, string> | undefined;
      try { identities = await readProcessIdentities(chunk); }
      catch { /* Failed queries are unknown, never evidence of exit. */ }
      const at = Date.now();
      for (const [key, row] of batch) {
        if (!included.has(row.pid)) continue;
        const identity = identities?.get(row.pid) || undefined;
        const dead = identity !== undefined && row.recordedAt !== undefined && (row.expected
          ? identity !== row.expected : identityStartedAfter(identity, row.recordedAt + 1_000));
        // Classify now, so even a poll much later than the positive TTL can reclaim.
        this.cache.set(key, { ...row, identity, dead, at });
        if (row.recordedAt !== undefined && !row.expected) this.cache.set(`${row.pid}|legacy-current`, { pid: row.pid, identity, at });
        this.pending.delete(key);
        const listener = this.captures.get(key);
        this.captures.delete(key);
        if (identity && listener) this.notify(listener, identity);
      }
    }
    for (const [key, row] of this.cache) if (!this.valid(row)) this.cache.delete(key);
  }

  alive = (pid: number, identity?: string | null, recordedAt?: number): boolean => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    const key = recordedAt === undefined ? undefined : `${pid}|${identity ?? ""}|${identity ? writtenBeforeBoot(recordedAt) : recordedAt}`;
    // Verified death of this recorded creation identity cannot be undone by a later
    // protected process reusing the PID and making kill(0) fail with EPERM.
    if (key && this.cache.get(key)?.dead) return false;
    try { process.kill(pid, 0); }
    catch (error) { return !ownerGone({ alive: (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined, recordedAt }); }
    if (recordedAt === undefined) return true;
    const observed = this.observe(pid, key!, { expected: identity, recordedAt });
    if (observed?.dead) return false;
    const current = observed?.identity;
    const alive = current === undefined ? undefined : identity ? current === identity : !identityStartedAfter(current, recordedAt + 1_000);
    return !ownerGone({ alive, recordedAt });
  };

  /** This process cannot change its creation identity; successful capture lasts for its lifetime. */
  identity(pid: number): string | null {
    if (pid !== process.pid) return null;
    return this.observe(pid, `${pid}|capture`, { permanent: true })?.identity ?? null;
  }

  capture(pid: number, record: string, listener: (identity: string) => void): void {
    const key = `${pid}|capture-record|${record}`;
    const observed = this.observe(pid, key);
    if (observed) {
      if (observed.identity) this.notify(listener, observed.identity);
      return;
    }
    this.captures.set(key, listener);
  }
}

// Share cache and in-flight batching across root, startup and resource stores.
export const slotLiveness = new SlotLiveness();
