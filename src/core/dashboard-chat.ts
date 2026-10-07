import type { Logger } from "./logger.js";
import { DelegateError, runProcess } from "./delegate.js";
import type { PeerInfo, SendResult } from "./protocol.js";

export interface ChatDelivery {
  state: "delivered" | "queued" | "not-supported" | "unconfirmed";
  transport: "native-prompt" | "bridge" | "parent";
  text: string;
  id?: string;
  receipt?: string;
}
export type QueuePrompt = (thread: string, text: string, cwd: string) => Promise<"accepted" | "unsupported" | "unconfirmed">;

/** Only the authenticated local HTTP handler calls this; no MCP or peer control command is added. */
export function codexQueue(bin: string, log: Logger): QueuePrompt {
  return async (thread, text, cwd) => {
    try {
      const result = await runProcess({ bin, args: ["queue", "--thread", thread, "--message", text], stdin: "", cwd,
        timeoutMs: 10_000, env: process.env, log, what: "Queue dashboard message" });
      return result.code === 0 ? "accepted" : "unsupported";
    } catch (error) {
      // An interrupted request may already have reached the server. Never send a second copy.
      if (error instanceof DelegateError && error.kind === "not_found") return "unsupported";
      log.warn("dashboard queue delivery unconfirmed", { err: String(error) });
      return "unconfirmed";
    }
  };
}

export function childNote(id: string, title: string, body: string): string {
  return `Owner message about your native subagent ${id} (${title.slice(0, 160)}).\nPlease relay this to that subagent using your native messaging tools if available; otherwise handle it yourself.\n\n${body}`;
}

export async function deliverDashboardChat(peer: PeerInfo, body: string, options: {
  child?: { id: string; title: string };
  parent?: boolean;
  queue: QueuePrompt;
  send: (body: string) => Promise<SendResult>;
}): Promise<ChatDelivery> {
  const nativeChild = options.child && !options.parent;
  const ownerText = `Owner message from the local dashboard:\n\n${body}`;
  if (peer.agent === "codex" && peer.sessionId && !options.parent) {
    const queued = await options.queue(options.child?.id ?? peer.sessionId, ownerText, peer.cwd);
    if (queued === "accepted") return { state: "queued", transport: "native-prompt", text: "Queued until idle as a native user prompt. The CLI accepted it; this is not a read receipt." };
    if (queued === "unconfirmed") return { state: "unconfirmed", transport: "native-prompt", text: "Delivery unconfirmed. Check the CLI chat before retrying; no second copy was sent." };
  }
  if (nativeChild) return { state: "not-supported", transport: "parent", text: "Direct input to this native subagent is not supported by its live transport. Send to its parent with a note about this subagent." };
  const text = options.child ? childNote(options.child.id, options.child.title, body) : ownerText;
  const sent = await options.send(text);
  const id = sent.messages[0]?.id;
  const live = sent.deliveredTo.includes(peer.name);
  const receiver = sent.recipientStates?.find((p) => p.name === peer.name) ?? peer;
  const wake = receiver.wakeAvailable && (receiver.autoWake || receiver.wakeOnDirect);
  const hint = !live ? "Session disconnected; retained for reconnection."
    : receiver.activity === "busy" ? "Queued for the next hook or idle turn; the current turn is not interrupted."
      : wake ? "Wake requested; awaiting CLI consumption."
        : "Idle wake is unavailable or disabled; waiting for the session's next turn or inbox read.";
  return { state: "queued", transport: options.child ? "parent" : "bridge", id, receipt: id,
    text: `Queued in ${options.child ? "parent's" : "session's"} bridge inbox as you (owner). ${hint} Inbox delivery is not a read receipt.` };
}
