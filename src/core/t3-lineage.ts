import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * AB-460: a session that T3 Code started for a delegated task (`delegate_task`: a chat whose lineage says
 * `relationshipToParent: "subagent"`) is a subagent, even though it loads the Bridge plugin and connects like any
 * session. It must never become a project's main, receive project-address mail or hold project-wide job control.
 * A fork the user made of a chat is an ordinary chat and stays a member.
 *
 * Which chat a session is: T3 records the provider's own session id (Claude's session id, Codex's thread id) in
 * `orchestration_v2_projection_provider_threads.payload_json` → `nativeThreadRef.nativeId`; the chat's
 * `lineage` names its parent and the relationship. Read from T3's local store read-only, in one short connection;
 * only those two tables are read. T3's auth tables, secrets and token files are never opened.
 */

const MAX_ID = 512;
/** A session T3 does not know (yet) is looked up again this often: T3 records the id once the provider started. */
export const T3_LINEAGE_RETRY_MS = 5_000;
/** How long an unknown session counts as pending; after that it is an ordinary session, rechecked with backoff. */
export const T3_LINEAGE_PENDING_MS = 2 * 60_000;
const MAX_RETRY_MS = 10 * 60_000;
const MAX_ENTRIES = 4_096;

/**
 * `child`: a T3 delegated task. `top`: a top-level chat or a fork. `none`: no (single) T3 chat with this id.
 * `absent`: no T3 store on this PC. Undefined: the store could not be read (busy, unknown schema).
 */
export type T3LineageAnswer = "child" | "top" | "none" | "absent";

export function t3SessionLineage(t3Home: string, nativeId: string): T3LineageAnswer | undefined {
  if (!nativeId || nativeId.length > MAX_ID || !isAbsolute(t3Home)) return "none";
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(realpathSync.native(join(t3Home, "userdata", "statev2.sqlite")), { readOnly: true, timeout: 25 });
    const rows = db.prepare(`SELECT DISTINCT p.thread_id AS thread_id,
        CASE WHEN json_valid(t.payload_json) THEN json_extract(t.payload_json, '$.lineage.relationshipToParent') END AS relation
      FROM orchestration_v2_projection_provider_threads p
      JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
      WHERE CASE WHEN json_valid(p.payload_json) THEN json_extract(p.payload_json, '$.nativeThreadRef.nativeId') END = ?
        AND t.deleted_at IS NULL
      LIMIT 2`).all(nativeId) as { thread_id: unknown; relation: unknown }[];
    // A native session in two chats (a fork that kept its id) is not guessed.
    if (rows.length !== 1) return "none";
    return rows[0]!.relation === "subagent" ? "child" : "top";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : undefined;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * The broker's view of a local session: `child` (a T3 delegated task, never a project member), `member`, or
 * `pending` (its T3 place is not known yet: no session id, or T3 has not recorded it within the pending window).
 * A pending session stays a member but is not elected main while a resolved member is available.
 */
export type T3Role = "child" | "member" | "pending";

/** Cached answers per provider session. A chat's place in T3 never changes, so `child` and `top` are kept. */
export class T3Lineages {
  private readonly known = new Map<string, { answer: T3LineageAnswer | undefined; firstAt: number; retryAt: number; wait: number }>();
  constructor(private readonly t3Home: string | undefined, private readonly now: () => number = Date.now,
    private readonly lookup: (t3Home: string, nativeId: string) => T3LineageAnswer | undefined = t3SessionLineage) {}
  private store: { present: boolean; at: number } | undefined;

  /** Whether this PC has a T3 store at all, checked at most once a minute: without one nobody is pending. */
  private storePresent(at: number): boolean {
    if (!this.store || at - this.store.at >= 60_000 || at < this.store.at) {
      this.store = { present: isAbsolute(this.t3Home!) && existsSync(join(this.t3Home!, "userdata", "statev2.sqlite")), at };
    }
    return this.store.present;
  }

  role(peer: { agent: string; sessionId?: string | null; startedAt?: number; host?: string; jobAgent?: unknown; subagent?: boolean }): T3Role {
    if (this.t3Home === undefined || peer.host || peer.jobAgent || peer.subagent) return "member";
    const at = this.now();
    if (!this.storePresent(at)) return "member";
    // Codex and Claude report their session id with the first hook; a session that never does is a member in time.
    if (!peer.sessionId) return typeof peer.startedAt === "number" && at - peer.startedAt < T3_LINEAGE_PENDING_MS ? "pending" : "member";
    const key = `${peer.agent}|${peer.sessionId}`;
    let hit = this.known.get(key);
    if (!hit || (hit.answer !== "child" && hit.answer !== "top" && at >= hit.retryAt)) {
      const answer = this.lookup(this.t3Home, peer.sessionId), firstAt = hit?.firstAt ?? at;
      // Inside the pending window: retry often. After it: back off, since most such sessions are plain CLIs.
      const wait = at - firstAt < T3_LINEAGE_PENDING_MS ? T3_LINEAGE_RETRY_MS : Math.min((hit?.wait ?? T3_LINEAGE_RETRY_MS) * 2, MAX_RETRY_MS);
      hit = { answer, firstAt, retryAt: at + wait, wait };
      this.known.delete(key);
      if (this.known.size >= MAX_ENTRIES) this.known.delete(this.known.keys().next().value!);
      this.known.set(key, hit);
    }
    if (hit.answer === "child") return "child";
    if (hit.answer === "top" || hit.answer === "absent") return "member";
    return at - hit.firstAt < T3_LINEAGE_PENDING_MS ? "pending" : "member";
  }

  isChild(peer: Parameters<T3Lineages["role"]>[0]): boolean { return this.role(peer) === "child"; }
}
