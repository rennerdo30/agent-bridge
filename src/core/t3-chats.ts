import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * AB-468: the T3 Code chats on this PC, read from T3's own local store
 * (`<T3CODE_HOME>/userdata/statev2.sqlite`) for the dashboard's "T3 Code" view.
 *
 * Read-only and short-lived: one connection per read, closed before returning; no writes,
 * migrations or checkpoints, no transaction held between reads. Only the allowlisted
 * tables and columns below are queried. T3's auth tables, secrets and token files are never
 * opened. A missing, busy or unknown store is reported as unavailable, never as "no chats".
 */

const MAX_TOP = 200, MAX_ROWS_PER_TOP = 30, MAX_THREADS = 20_000, MAX_PAYLOAD = 65_536;
export const T3_CHATS_CACHE_MS = 10_000;

const REQUIRED = {
  projection_projects: ["project_id", "title", "workspace_root", "deleted_at"],
  orchestration_v2_projection_threads: ["thread_id", "project_id", "title", "default_provider", "provider_instance_id",
    "created_at", "updated_at", "archived_at", "deleted_at", "payload_json"],
  orchestration_v2_projection_runs: ["thread_id", "ordinal", "status"],
  orchestration_v2_projection_runtime_requests: ["thread_id", "status"],
} as const;

export type T3ChatStatus = "running" | "queued" | "waiting" | "done" | "failed" | "interrupted" | "cancelled" | "idle";
export interface T3Chat {
  id: string; title: string; projectId: string;
  /** T3's provider instance (e.g. `claudeAgent`, `codex`) and the matching Bridge agent kind, or `other`. */
  provider: string; agent: string; model: string | null;
  status: T3ChatStatus; settled: boolean; archived: boolean;
  /** Subagent chats nest under their parent; forks are their own chats that name their source. */
  parentId: string | null; relation: "subagent" | "fork" | null;
  createdAt: number; updatedAt: number; branch: string | null;
  /** Depth below the top-level chat (1 = its direct subagent); 0 for a top-level chat. */
  depth: number;
}
export interface T3TopChat extends T3Chat {
  /** Newest descendants first (each followed by its own subagents), capped; counts cover all of them. */
  children: T3Chat[]; childCount: number; childRunning: number; childWaiting: number;
}
export interface T3Project { id: string; title: string; root: string }
export type T3ChatsResult =
  | { state: "ready"; environmentId: string; projects: T3Project[]; chats: T3TopChat[]; total: number; archivedHidden: number; truncated: boolean; readAt: number }
  | { state: "unavailable"; reason: string; readAt: number };

class Unavailable extends Error {}
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);
const text = (v: unknown, max: number): string => typeof v === "string" ? v.slice(0, max) : "";
const ms = (v: unknown): number => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : 0; };
const AGENTS: Record<string, string> = { claudeAgent: "claude", claude: "claude", codex: "codex", opencode: "opencode", antigravity: "antigravity", muse: "muse" };
const RUN_STATUS: Record<string, T3ChatStatus> = { running: "running", queued: "queued", completed: "done", failed: "failed", interrupted: "interrupted", cancelled: "cancelled" };

function environmentId(root: string): string {
  const fd = openSync(join(root, "userdata", "environment-id"), "r");
  try {
    const size = fstatSync(fd).size;
    if (size < 1 || size > 512) throw new Unavailable("unsupported T3 environment identity");
    const raw = Buffer.alloc(size);
    if (readSync(fd, raw, 0, size, 0) !== size) throw new Unavailable("incomplete T3 environment identity");
    const value = raw.toString("utf8").trim();
    if (!id(value)) throw new Unavailable("unsupported T3 environment identity");
    return value;
  } finally { closeSync(fd); }
}

function checkSchema(input: DatabaseSync): void {
  for (const [table, columns] of Object.entries(REQUIRED)) {
    const names = new Set((input.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]).map(c => c.name));
    if (!columns.every(c => names.has(c))) throw new Unavailable(`unsupported T3 store schema (${table})`);
  }
}

/** Reads the chat list once. `root` is the T3 home (the folder holding `userdata/`); undefined means "not configured". */
export function readT3Chats(root: string | undefined, opts: { includeArchived?: boolean; now?: number } = {}): T3ChatsResult {
  const readAt = opts.now ?? Date.now();
  if (root === undefined) return { state: "unavailable", reason: "T3 Code is not set up on this PC", readAt };
  let input: DatabaseSync | undefined;
  try {
    if (!isAbsolute(root) || /[\x00-\x1f]/.test(root)) throw new Unavailable("invalid T3 home");
    let file: string, environment: string;
    try {
      file = realpathSync.native(join(root, "userdata", "statev2.sqlite"));
      environment = environmentId(root);
      input = new DatabaseSync(file, { readOnly: true, timeout: 25 });
    } catch (error) { throw error instanceof Unavailable ? error : new Unavailable("T3 store missing, busy or unreadable"); }
    try { checkSchema(input); return { ...collect(input, environment, opts.includeArchived === true), readAt }; }
    catch (error) { throw error instanceof Unavailable ? error : new Unavailable("T3 store busy or unreadable"); }
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error;
    return { state: "unavailable", reason: error.message, readAt };
  } finally { input?.close(); }
}

function collect(input: DatabaseSync, environmentId: string, includeArchived: boolean) {
  const projects = (input.prepare(`SELECT substr(project_id,1,513) id,substr(title,1,301) title,substr(workspace_root,1,4097) root
    FROM projection_projects WHERE deleted_at IS NULL`).all() as Record<string, unknown>[])
    .filter(p => id(p.id)).map(p => ({ id: p.id as string, title: text(p.title, 300), root: text(p.root, 4096) }));
  // Lineage, model and settled state live in the thread payload; only small payloads are parsed.
  const rows = input.prepare(`SELECT substr(thread_id,1,513) id,substr(project_id,1,513) project_id,substr(title,1,301) title,
      substr(coalesce(provider_instance_id,default_provider),1,65) provider,created_at,updated_at,archived_at,
      CASE WHEN octet_length(payload_json)<=${MAX_PAYLOAD} AND json_valid(payload_json) THEN json_object(
        'parent',json_extract(payload_json,'$.lineage.parentThreadId'),
        'relation',json_extract(payload_json,'$.lineage.relationshipToParent'),
        'model',json_extract(payload_json,'$.modelSelection.model'),
        'settled',json_extract(payload_json,'$.settledAt'),
        'branch',json_extract(payload_json,'$.branch')) END meta
    FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ${MAX_THREADS + 1}`).all() as Record<string, unknown>[];
  const runs = new Map((input.prepare(`SELECT thread_id,status,max(ordinal) FROM orchestration_v2_projection_runs GROUP BY thread_id`)
    .all() as { thread_id: string; status: string }[]).map(r => [r.thread_id, r.status]));
  const waiting = new Set((input.prepare(`SELECT DISTINCT thread_id FROM orchestration_v2_projection_runtime_requests WHERE status='pending'`)
    .all() as { thread_id: string }[]).map(r => r.thread_id));

  const all = new Map<string, T3Chat>();
  for (const row of rows.slice(0, MAX_THREADS)) {
    if (!id(row.id) || !id(row.project_id)) continue;
    let meta: Record<string, unknown> = {};
    try { meta = typeof row.meta === "string" ? JSON.parse(row.meta) : {}; } catch { meta = {}; }
    const relation = meta.relation === "subagent" || meta.relation === "fork" ? meta.relation : null;
    const provider = text(row.provider, 64) || "unknown";
    all.set(row.id, {
      id: row.id, title: text(row.title, 300) || "Untitled chat", projectId: row.project_id,
      provider, agent: AGENTS[provider] ?? "other", model: typeof meta.model === "string" ? meta.model.slice(0, 120) : null,
      status: waiting.has(row.id) ? "waiting" : RUN_STATUS[runs.get(row.id) ?? ""] ?? "idle",
      settled: typeof meta.settled === "string" && meta.settled.length > 0, archived: row.archived_at !== null,
      parentId: id(meta.parent) && relation ? meta.parent : null, relation,
      createdAt: ms(row.created_at), updatedAt: ms(row.updated_at), branch: typeof meta.branch === "string" ? meta.branch.slice(0, 200) : null, depth: 0,
    });
  }
  // Subagent chats nest under their parent when it is known; forks and orphans are top-level.
  const kids = new Map<string, T3Chat[]>();
  for (const chat of all.values())
    if (chat.relation === "subagent" && chat.parentId && all.has(chat.parentId)) (kids.get(chat.parentId) ?? kids.set(chat.parentId, []).get(chat.parentId)!).push(chat);
  const nested = (chat: T3Chat) => chat.relation === "subagent" && chat.parentId !== null && all.has(chat.parentId);
  let archivedHidden = 0;
  const tops: T3TopChat[] = [];
  for (const chat of all.values()) {
    if (nested(chat)) continue;
    if (chat.archived && !includeArchived) { archivedHidden++; continue; }
    const descendants: T3Chat[] = [], seen = new Set([chat.id]);
    const walk = (parent: string, depth: number) => {
      for (const child of (kids.get(parent) ?? []).sort((a, b) => b.updatedAt - a.updatedAt)) {
        if (seen.has(child.id)) continue; // a corrupt lineage cycle never loops
        seen.add(child.id); descendants.push({ ...child, depth }); walk(child.id, depth + 1);
      }
    };
    walk(chat.id, 1);
    const updatedAt = Math.max(chat.updatedAt, ...descendants.map(d => d.updatedAt));
    tops.push({ ...chat, updatedAt, children: descendants.slice(0, MAX_ROWS_PER_TOP), childCount: descendants.length,
      childRunning: descendants.filter(d => d.status === "running" || d.status === "queued").length,
      childWaiting: descendants.filter(d => d.status === "waiting").length });
  }
  // Chats that need attention first, then the most recently active.
  const rank = (c: T3TopChat) => c.status === "waiting" || c.childWaiting ? 0 : c.status === "running" || c.status === "queued" || c.childRunning ? 1 : 2;
  tops.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  return { state: "ready" as const, environmentId, projects, chats: tops.slice(0, MAX_TOP), total: tops.length, archivedHidden,
    truncated: rows.length > MAX_THREADS || tops.length > MAX_TOP };
}

/** One shared read per T3 home and archive filter for a few seconds: the dashboard polls. */
const cache = new Map<string, T3ChatsResult>();
export function cachedT3Chats(root: string | undefined, includeArchived: boolean, now = Date.now()): T3ChatsResult {
  const key = `${root ?? ""}\0${includeArchived}`, hit = cache.get(key);
  if (hit && now - hit.readAt < T3_CHATS_CACHE_MS) return hit;
  const result = readT3Chats(root, { includeArchived, now });
  cache.set(key, result);
  return result;
}
