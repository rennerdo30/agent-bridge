import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * AB-460: a session that T3 Code started for a delegated task (`delegate_task`, a chat with a parent chat) is a
 * subagent, even though it loads the Bridge plugin and connects like any session. It must never become a
 * project's main or receive project-address mail.
 *
 * Which chat a session is: T3 records the provider's own session id (Claude's session id, Codex's thread id) in
 * `orchestration_v2_projection_provider_threads.payload_json` → `nativeThreadRef.nativeId`; the chat's
 * `lineage.parentThreadId` names its parent. Read from T3's local store read-only, in one short connection; only
 * those two tables are read. T3's auth tables, secrets and token files are never opened.
 */

const MAX_ID = 512;
/** First retry for a session T3 does not know (yet): T3 records the id once the provider has started. Doubles to the cap. */
export const T3_LINEAGE_RETRY_MS = 15_000;
const MAX_RETRY_MS = 10 * 60_000;
const MAX_ENTRIES = 4_096;

/** `child`: a T3 chat with a parent chat. `top`: a top-level T3 chat. `none`: no (single) T3 chat. Undefined: unreadable. */
export type T3Lineage = "child" | "top" | "none";

export function t3SessionLineage(t3Home: string, nativeId: string): T3Lineage | undefined {
  if (!nativeId || nativeId.length > MAX_ID || !isAbsolute(t3Home)) return "none";
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(realpathSync.native(join(t3Home, "userdata", "statev2.sqlite")), { readOnly: true, timeout: 25 });
    const rows = db.prepare(`SELECT DISTINCT p.thread_id AS thread_id,
        CASE WHEN json_valid(t.payload_json) THEN json_extract(t.payload_json, '$.lineage.parentThreadId') END AS parent
      FROM orchestration_v2_projection_provider_threads p
      JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
      WHERE CASE WHEN json_valid(p.payload_json) THEN json_extract(p.payload_json, '$.nativeThreadRef.nativeId') END = ?
        AND t.deleted_at IS NULL
      LIMIT 2`).all(nativeId) as { thread_id: unknown; parent: unknown }[];
    // A native session in two chats (a fork that kept its id) is not guessed.
    if (rows.length !== 1) return "none";
    return typeof rows[0]!.parent === "string" && rows[0]!.parent.length > 0 ? "child" : "top";
  } catch (error) {
    // No T3 store on this PC is a plain "none"; a busy or unreadable store is retried.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : undefined;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/** Cached answers per provider session. A chat's place in T3 never changes, so `child` and `top` are kept. */
export class T3Lineages {
  private readonly known = new Map<string, { lineage: T3Lineage | undefined; retryAt: number; wait: number }>();
  constructor(private readonly t3Home: string | undefined, private readonly now: () => number = Date.now,
    private readonly lookup: (t3Home: string, nativeId: string) => T3Lineage | undefined = t3SessionLineage) {}

  /** Whether this local session is a T3 delegated child. Sessions without a session id are not. */
  isChild(peer: { agent: string; sessionId?: string | null; host?: string }): boolean {
    if (this.t3Home === undefined || peer.host || !peer.sessionId) return false;
    const key = `${peer.agent}|${peer.sessionId}`, at = this.now(), hit = this.known.get(key);
    if (hit && (hit.lineage === "child" || hit.lineage === "top" || at < hit.retryAt)) return hit.lineage === "child";
    const lineage = this.lookup(this.t3Home, peer.sessionId);
    const wait = hit ? Math.min(hit.wait * 2, MAX_RETRY_MS) : T3_LINEAGE_RETRY_MS;
    this.known.delete(key);
    if (this.known.size >= MAX_ENTRIES) this.known.delete(this.known.keys().next().value!);
    this.known.set(key, { lineage, retryAt: at + wait, wait });
    return lineage === "child";
  }
}
