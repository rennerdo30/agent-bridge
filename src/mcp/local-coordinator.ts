import { EventEmitter } from "node:events";
import type { BridgeMessage } from "../core/protocol.js";
import type { JobCoordinator } from "./jobs.js";

/** A nested supervisor has a private inbox, never the privileges of an independent bridge session. */
export class LocalCoordinator extends EventEmitter implements JobCoordinator {
  readonly id: string;
  readonly currentSessionId: string;
  private messages: BridgeMessage[] = [];

  constructor(readonly name: string, rootSession: string) {
    super();
    this.id = `nested:${name}`;
    this.currentSessionId = rootSession;
  }

  deliverLocal(message: BridgeMessage): void {
    this.messages.push(message);
    this.emit("message", message);
  }

  take(): BridgeMessage[] { return this.messages.splice(0); }
  unread(): BridgeMessage[] { return [...this.messages]; }
  markRead(ids: string[]): void { const read = new Set(ids); this.messages = this.messages.filter((m) => !read.has(m.id)); }

  async wait(timeoutMs: number, signal?: AbortSignal, match: (m: BridgeMessage) => boolean = () => true): Promise<void> {
    if (this.messages.some(match) || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const arrived = (message: BridgeMessage) => { if (match(message)) done(); };
      const done = () => { clearTimeout(timer); this.off("message", arrived); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, timeoutMs);
      this.on("message", arrived);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
