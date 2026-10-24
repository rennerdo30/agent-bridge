import type { BridgeConfig } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import { T3HostError, type T3Host } from "../core/t3-host.js";
import { T3WakeJournal, T3WakeJournalError, type T3WakeOutcome } from "../core/t3-wake-journal.js";
import { shouldWakeClaudeMessage } from "./rewake.js";

/** Pointer-only delivery: only a later authenticated inbox read can consume Bridge mail. */
export class T3Waker {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running = false;
  private readonly journal?: T3WakeJournal;
  private blocked = false;
  private readonly schedule = () => {
    if (this.stopped || this.blocked || this.timer || this.running) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.debounceMs);
    this.timer.unref();
  };
  constructor(private readonly host: T3Host, private readonly node: BridgeNode,
    private readonly cfg: BridgeConfig, private readonly log: Logger, private readonly debounceMs = 1500, home?: string) {
    // No default storage fallback: a missing explicit session home must never dispatch without a journal.
    if (home) this.journal = new T3WakeJournal(home, host.binding,()=>host.wakeRequestNamespace());
    node.on("message", this.schedule);
    node.on("notification_waits_changed", this.schedule);
    node.on("connected", this.schedule);
    node.on("reclaimed", this.schedule);
  }
  async flush(): Promise<void> {
    if (this.stopped || this.blocked || this.running || !this.node.isConnected || this.node.wasReplaced) return;
    this.running = true;
    let admitted = false;
    try {
      if (!this.journal) throw new T3WakeJournalError("unavailable");
      const pending = this.node.unread().filter(m => shouldWakeClaudeMessage(this.node, this.cfg, m)).map(m => m.id);
      const operation = this.journal.admit(pending);
      if (!operation) return;
      admitted = true;
      let outcome: T3WakeOutcome;
      try {
        if(this.stopped)throw new T3WakeJournalError('unavailable');
        this.journal.assertDispatch(operation);
        const result = await this.host.send({ clientRequestId: operation.clientRequestId, mode: operation.mode, message: operation.message });
        outcome = { state: "accepted", receipt: result.receipt };
      } catch (error) {
        outcome = { state: "unknown", failureStage: error instanceof T3HostError ? error.stage : "unknown" };
      }
      this.journal.complete(operation, outcome);
      if (outcome.state === "accepted") this.log.info("T3 wake accepted; inbox consumption unconfirmed", { clientRequestId: operation.clientRequestId, delivery: outcome.receipt.delivery, count: operation.messageIds.length });
      else this.log.warn("T3 wake unavailable or outcome unknown; mail stays unread; no retry or native fallback", { clientRequestId: operation.clientRequestId });
    } catch (error) {
      this.blocked = true;
      this.log.warn("T3 wake journal blocked; no further automatic dispatch; retained operations preserved", { reason: error instanceof T3WakeJournalError ? error.reason : "unavailable" });
    } finally {
      this.running = false;
      // One follow-up debounce catches arrivals during the request; the journal filters admitted IDs.
      if (admitted) this.schedule();
    }
  }
  readonly stop = (): void => {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.node.off("message", this.schedule);
    this.node.off("notification_waits_changed", this.schedule);
    this.node.off("connected", this.schedule);
    this.node.off("reclaimed", this.schedule);
  };
}
