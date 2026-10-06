import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import type { SiblingClient } from "../core/parent-link.js";
import { SIBLING_CONVERSATION_PREFIX, type BridgeMessage } from "../core/protocol.js";
import type { Job } from "./jobs.js";
import { formatSiblingMessages } from "./format.js";

/** A hidden job peer's chat, independent of its supervisor's control messages and approval requests. */
export class SiblingLink implements SiblingClient {
  constructor(
    private readonly node: BridgeNode,
    private readonly job: Job,
    private readonly maxHops: number,
    private readonly log: Logger,
  ) {
    node.on("message", this.receive);
    for (const message of node.unread()) this.receive(message);
  }

  peers() {
    return this.node.siblings();
  }

  send(to: string, body: string, replyTo?: string) {
    return this.node.sendSibling({ to, body, replyTo }, this.maxHops);
  }

  private readonly receive = (message: BridgeMessage): void => {
    if (!message.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX)) return;
    this.node.markRead([message.id]);
    if (message.hop >= this.maxHops) return;
    this.log.info("message from sibling", { from: message.from.name, to: this.job.name, hop: message.hop });
    // Never answer pendingApproval or mark the job as awaiting a reply to its supervisor.
    if (this.job.live) this.job.live.post(message.body, message);
    else this.job.queue.push(formatSiblingMessages([message]));
  };

  close(): void {
    this.node.off("message", this.receive);
  }
}
