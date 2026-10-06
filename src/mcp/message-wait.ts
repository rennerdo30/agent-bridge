import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_WAIT_SEC } from "../core/constants.js";
import type { BridgeNode } from "../core/node.js";
import { archiveFile, writeJsonStore } from "../core/json-store.js";
import { isQuietMessage, type BridgeMessage } from "../core/protocol.js";

/** Below Claude Code's default 120-second automatic background threshold. */
export const SINGLE_WAIT_SEC = DEFAULT_WAIT_SEC;
const RECEIPT_POLL_MS = 1_000;

export function singleWaitTimeoutMs(requestedSec: number): number {
  return Math.min(requestedSec, SINGLE_WAIT_SEC) * 1000;
}
const waitSchema = z.object({
  id: z.uuid(), owner: z.string(), sessionId: z.string().nullable(),
  mode: z.enum(["block", "notify"]).default("block"),
  filters: z.object({
    from: z.string().optional(), reply_to: z.string().optional(),
    conversation_id: z.string().optional(), read_receipt_of: z.string().optional(),
  }),
});
export type WaitFilters = z.infer<typeof waitSchema>["filters"];
export type SavedWait = z.infer<typeof waitSchema>;

export function matchesWait(filters: WaitFilters, m: BridgeMessage): boolean {
  return !filters.read_receipt_of &&
    (!isQuietMessage(m) || Boolean(filters.from || filters.conversation_id || filters.reply_to)) &&
    (!filters.from || m.from.name === filters.from || m.from.agent === filters.from) &&
    (!filters.reply_to || m.replyTo === filters.reply_to) &&
    (!filters.conversation_id || m.conversationId === filters.conversation_id);
}

/** Retained status/observer mail must not complete a wait for the eventual reply. */
export function matchesNotificationWait(filters: WaitFilters, m: BridgeMessage): boolean {
  return !isQuietMessage(m) && !m.conversationId.endsWith(":note") && matchesWait(filters, m);
}

/** Individual atomic records avoid losing concurrent waits when a stdio server is replaced. */
export class MessageWaitStore {
  private readonly dir: string;
  constructor(home: string) { this.dir = join(home, "message-waits"); }
  private path(id: string): string { return join(this.dir, `${z.uuid().parse(id)}.json`); }
  private owns(node: BridgeNode, record: SavedWait): boolean {
    return record.sessionId && node.currentSessionId
      ? record.sessionId === node.currentSessionId : record.owner === node.name;
  }
  save(node: BridgeNode, filters: WaitFilters, mode: SavedWait["mode"] = "block"): SavedWait {
    // Re-arming the same notification does not create another subscription or wake-up.
    const existing = mode === "notify" ? this.pending(node).find((r) => r.mode === mode &&
      ["from", "reply_to", "conversation_id", "read_receipt_of"].every((k) => r.filters[k as keyof WaitFilters] === filters[k as keyof WaitFilters])) : undefined;
    if (existing) return existing;
    const record = { id: randomUUID(), owner: node.name, sessionId: node.currentSessionId, filters, mode };
    writeJsonStore(this.path(record.id), record, null);
    return record;
  }
  get(node: BridgeNode, id: string): SavedWait {
    const record = waitSchema.parse(JSON.parse(readFileSync(this.path(id), "utf8")));
    if (!this.owns(node, record)) throw new Error("This wait belongs to another session.");
    return record;
  }
  pending(node: BridgeNode): SavedWait[] {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).flatMap((f) => {
      try {
        const record = waitSchema.parse(JSON.parse(readFileSync(join(this.dir, f), "utf8")));
        return this.owns(node, record) ? [record] : [];
      } catch { return []; }
    });
  }
  remove(id: string): void { archiveFile(this.path(id)); }

  setMode(node: BridgeNode, id: string, mode: SavedWait["mode"]): SavedWait {
    const record = this.get(node, id);
    const previous = JSON.parse(readFileSync(this.path(id), "utf8"));
    writeJsonStore(this.path(id), { ...previous, mode }, previous);
    return { ...record, mode };
  }

  /** No timers or per-subscription listeners: existing delivery asks whether unread mail is awaited. */
  attach(node: BridgeNode): void {
    node.setNotificationWaitHandlers(
      (m) => this.pending(node).some((r) => r.mode === "notify" && matchesNotificationWait(r.filters, m)),
      (messages) => {
        for (const r of this.pending(node)) {
          if (r.mode === "notify" && messages.some((m) => matchesNotificationWait(r.filters, m))) this.remove(r.id);
        }
      },
    );
  }
}

export function resumeWaitHint(record: SavedWait): string {
  if (record.mode === "notify") return `Notification wait ${record.id} is armed (${JSON.stringify(record.filters)}). It survives /reload-plugins; do not repeat it. Matching mail stays queued until delivered. Use wait_for_message(${JSON.stringify({ resume_id: record.id, mode: "notify" })}) to inspect or re-arm it.`;
  return `If the wait was interrupted by /reload-plugins or Connection closed, resume with wait_for_message(${JSON.stringify({ resume_id: record.id, ...record.filters })}). Unconsumed messages remain queued.`;
}

/** A receipt means bridge consumption by a hook/tool/channel, not that the agent finished responding. */
export async function waitForReadReceipt(node: BridgeNode, id: string, timeoutMs: number, signal: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && !node.wasReplaced) {
    // Broker election or a slow paired link must not extend this call past the single-wait cap.
    const receipts = await new Promise<Awaited<ReturnType<BridgeNode["messageReceipt"]>> | null>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
      const onAbort = () => { cleanup(); resolve(null); };
      const timer = setTimeout(onAbort, Math.max(0, deadline - Date.now()));
      signal.addEventListener("abort", onAbort, { once: true });
      node.messageReceipt(id).then((value) => { cleanup(); resolve(value); }, (err) => { cleanup(); reject(err); });
      if (signal.aborted) onAbort();
    });
    if (!receipts) return null;
    if (receipts.length && receipts.every((r) => r.readAt !== null)) return receipts;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, Math.min(RECEIPT_POLL_MS, remaining));
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  return null;
}
