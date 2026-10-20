import { createHash } from "node:crypto";
import type { BridgeConfig } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import type { T3Host } from "../core/t3-host.js";
import { shouldWakeClaudeMessage } from "./rewake.js";

/** Pointer-only delivery: only a later authenticated inbox read can consume Bridge mail. */
export class T3Waker {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running = false;
  private readonly attempted = new Set<string>();
  private readonly schedule = () => {
    if (this.stopped || this.timer || this.running) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.debounceMs);
    this.timer.unref();
  };
  constructor(private readonly host: T3Host, private readonly node: BridgeNode,
    private readonly cfg: BridgeConfig, private readonly log: Logger, private readonly debounceMs = 1500) {
    node.on("message", this.schedule);
    node.on("notification_waits_changed", this.schedule);
    node.on("connected", this.schedule);
    node.on("reclaimed", this.schedule);
  }
  async flush(): Promise<void> {
    if (this.stopped || this.running || !this.node.isConnected || this.node.wasReplaced) return;
    const unread = this.node.unread(), live = new Set(unread.map(m => m.id));
    for (const id of this.attempted) if (!live.has(id)) this.attempted.delete(id);
    const messages = unread.filter(m => !this.attempted.has(m.id) && shouldWakeClaudeMessage(this.node, this.cfg, m)).slice(0, Math.max(0, Math.min(100, 2000 - this.attempted.size)));
    if (!messages.length) return;
    this.running = true;
    const ids = messages.map(m => m.id).sort();
    for (const id of ids) this.attempted.add(id);
    const clientRequestId = `bridge-wake-${createHash("sha256").update(JSON.stringify([this.host.binding, ids])).digest("hex")}`;
    try {
      const result = await this.host.send({ clientRequestId, mode: "queue", message:
        `agent-bridge: unread mail is waiting in your existing Bridge inbox. Call agent-bridge inbox to read it and use send to answer where needed. Bridge message IDs: ${ids.join(", ")}. This pointer is a wake request, not the message contents or a read receipt.` });
      this.log.info("T3 wake accepted; inbox consumption unconfirmed", { clientRequestId, delivery: result.receipt.delivery, count: ids.length });
    } catch {
      this.log.warn("T3 wake unavailable or outcome unknown; mail stays unread; no retry or native fallback", { clientRequestId });
    } finally {
      this.running = false;
      if (this.attempted.size < 2000 && this.node.unread().some(m => !this.attempted.has(m.id) && shouldWakeClaudeMessage(this.node, this.cfg, m))) this.schedule();
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
