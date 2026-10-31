import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * AB-468: which Bridge sessions are T3 Code chats. T3 gives most chats a folder of their own
 * (`worktreePath`); a Bridge session running in exactly that folder, with the same agent, is that
 * chat. The dashboard then shows the chat's title and T3 status on the normal session entry.
 *
 * Read from T3's local store (`<T3CODE_HOME>/userdata/statev2.sqlite`): read-only, one short
 * connection per read, closed before returning; no writes, migrations or checkpoints. Only the
 * columns named below are read; T3's auth tables, secrets and token files are never opened.
 * T3 is a wrapper: the same chat is a Claude, Codex, ... session underneath, and T3 can switch its
 * provider. A session in the chat's folder is linked when its agent is the current provider or one
 * the chat ran on before (`harness: "earlier"`), so a switch never makes a second, unlinked entry.
 * Chats in a shared folder (usually the project root) and folders claimed by several chats are
 * not matched: a session is never guessed to be a chat. Any store problem means "no T3 data".
 */

export interface T3SessionInfo {
  id: string; title: string; provider: string; model: string | null;
  status: "running" | "queued" | "waiting" | "done" | "failed" | "interrupted" | "cancelled" | "idle";
  parentTitle: string | null;
  /** T3 can switch a chat between providers: `current` runs the chat now, `earlier` ran it before the switch. */
  harness: "current" | "earlier";
}
interface FolderChat { id: string; title: string; provider: string; agent: string; agents: Set<string>; model: string | null; parentId: string | null }

/** The folder → chat index is rebuilt at most this often, or sooner for a folder it does not know yet. */
export const T3_INDEX_MS = 60_000, T3_INDEX_MISS_MS = 10_000;
const MAX_PAYLOAD = 65_536;
const AGENTS: Record<string, string> = { claudeAgent: "claude", claude: "claude", codex: "codex", opencode: "opencode", antigravity: "antigravity", muse: "muse" };
const RUN_STATUS: Record<string, T3SessionInfo["status"]> = { running: "running", queued: "queued", completed: "done", failed: "failed", interrupted: "interrupted", cancelled: "cancelled" };
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);

/** Same location, same key: separators, case and the E:/D: alias of one drive do not matter. */
export function t3FolderKey(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^d:/i, "E:");
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function open(root: string): DatabaseSync | undefined {
  if (!isAbsolute(root) || /[\x00-\x1f]/.test(root)) return undefined;
  try { return new DatabaseSync(realpathSync.native(join(root, "userdata", "statev2.sqlite")), { readOnly: true, timeout: 25 }); }
  catch { return undefined; }
}

/**
 * Per folder: the chats a connected session there could be. `owners` own the folder (top-level, or a
 * child with a folder of its own) and are always candidates. `shared` are T3 delegated tasks that ran
 * in their parent's folder as separate sessions; they count only while they have an active run.
 * Provider-native subagents in the parent's folder run inside the parent's process and are skipped.
 */
interface FolderEntry { owners: FolderChat[]; shared: FolderChat[] }
function buildIndex(input: DatabaseSync): Map<string, FolderEntry> {
  const rows = input.prepare(`SELECT substr(thread_id,1,513) id,substr(title,1,301) title,
      substr(coalesce(provider_instance_id,default_provider),1,65) provider,
      json_extract(payload_json,'$.worktreePath') folder,json_extract(payload_json,'$.modelSelection.model') model,
      json_extract(payload_json,'$.lineage.parentThreadId') parent
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND octet_length(payload_json)<=${MAX_PAYLOAD} AND json_valid(payload_json)
      AND json_type(payload_json,'$.worktreePath')='text'`).all() as Record<string, unknown>[];
  const chats = new Map<string, FolderChat & { folder: string }>();
  for (const row of rows) {
    if (!id(row.id) || typeof row.folder !== "string" || !row.folder || row.folder.length > 4096) continue;
    const provider = typeof row.provider === "string" ? row.provider : "", agent = AGENTS[provider] ?? "other";
    chats.set(row.id, { id: row.id, title: (typeof row.title === "string" && row.title) || "Untitled chat", provider, agent, agents: new Set([agent]),
      model: typeof row.model === "string" ? row.model.slice(0, 120) : null, parentId: id(row.parent) ? row.parent : null, folder: t3FolderKey(row.folder) });
  }
  // Every provider a chat has run on (one row per provider harness the chat used).
  for (const r of input.prepare(`SELECT DISTINCT thread_id,provider FROM orchestration_v2_projection_provider_threads`).all() as { thread_id: unknown; provider: unknown }[])
    if (typeof r.thread_id === "string" && typeof r.provider === "string") chats.get(r.thread_id)?.agents.add(AGENTS[r.provider] ?? "other");
  const origin = new Map((input.prepare(`SELECT child_thread_id,origin FROM orchestration_v2_projection_subagents`).all() as { child_thread_id: unknown; origin: unknown }[])
    .map(r => [String(r.child_thread_id), String(r.origin)]));
  const index = new Map<string, FolderEntry>();
  for (const chat of chats.values()) {
    const entry = index.get(chat.folder) ?? index.set(chat.folder, { owners: [], shared: [] }).get(chat.folder)!;
    const inParentFolder = chat.parentId !== null && chats.get(chat.parentId)?.folder === chat.folder;
    if (!inParentFolder) entry.owners.push(chat);
    else if (origin.get(chat.id) === "app_owned") entry.shared.push(chat);
  }
  return index;
}

/** Per T3 home: the folder index, when it was read, and the session folders it was built for. */
const indexes = new Map<string, { at: number; index: Map<string, FolderEntry>; seen: Set<string> }>();

/**
 * T3 chat details for the given sessions (folder + agent), keyed like the input. A session is linked
 * only when exactly one candidate chat in its folder ran on its agent, and no other session with the
 * same agent links to that chat; everything else is left unlinked.
 */
export function t3SessionInfo(root: string | undefined, sessions: { key: string; cwd: string; agent: string }[], now = Date.now()): Map<string, T3SessionInfo> {
  const out = new Map<string, T3SessionInfo>();
  if (root === undefined || !sessions.length) return out;
  const input = open(root);
  if (!input) return out;
  try {
    let cached = indexes.get(root);
    // A folder first seen after the index was built (a new chat) may rebuild it early, once; folders
    // that are simply not T3 chats (the main checkout, other sessions) never keep forcing rebuilds.
    const fresh = sessions.some(s => { const k = t3FolderKey(s.cwd); return !cached?.index.has(k) && !cached?.seen.has(k); });
    if (!cached || now - cached.at >= T3_INDEX_MS || (fresh && now - cached.at >= T3_INDEX_MISS_MS)) {
      cached = { at: now, index: buildIndex(input), seen: new Set(sessions.map(s => t3FolderKey(s.cwd))) };
      indexes.set(root, cached);
    }
    const waiting = input.prepare(`SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id=? AND status='pending' LIMIT 1`);
    const latest = input.prepare(`SELECT status FROM orchestration_v2_projection_runs WHERE thread_id=? ORDER BY ordinal DESC LIMIT 1`);
    const title = input.prepare(`SELECT substr(title,1,301) title FROM orchestration_v2_projection_threads WHERE thread_id=? AND deleted_at IS NULL`);
    const statusOf = (chat: FolderChat): T3SessionInfo["status"] =>
      waiting.get(chat.id) ? "waiting" : RUN_STATUS[String((latest.get(chat.id) as { status?: unknown } | undefined)?.status ?? "")] ?? "idle";
    const fits = (chat: FolderChat, agent: string) => chat.agents.has(agent) || chat.agent === "other";
    const linked = new Map<string, { chat: FolderChat; status: T3SessionInfo["status"] }>();
    for (const s of sessions) {
      const entry = cached.index.get(t3FolderKey(s.cwd));
      if (!entry) continue;
      const candidates = [...entry.owners.filter(c => fits(c, s.agent)),
        ...entry.shared.filter(c => fits(c, s.agent)).filter(c => ["running", "queued", "waiting"].includes(statusOf(c)))];
      if (candidates.length === 1) linked.set(s.key, { chat: candidates[0]!, status: statusOf(candidates[0]!) });
    }
    // Two sessions of the same agent claiming one chat cannot both be it: link neither.
    const claims = new Map<string, number>();
    for (const s of sessions) { const l = linked.get(s.key); if (l) claims.set(`${l.chat.id}|${s.agent}`, (claims.get(`${l.chat.id}|${s.agent}`) ?? 0) + 1); }
    for (const s of sessions) {
      const l = linked.get(s.key);
      if (!l || claims.get(`${l.chat.id}|${s.agent}`)! > 1) continue;
      const chat = l.chat;
      const parent = chat.parentId ? title.get(chat.parentId) as { title?: unknown } | undefined : undefined;
      out.set(s.key, { id: chat.id, title: chat.title, provider: chat.provider, model: chat.model,
        status: l.status,
        parentTitle: typeof parent?.title === "string" ? parent.title : null, harness: chat.agent === s.agent || chat.agent === "other" ? "current" : "earlier" });
    }
    return out;
  } catch {
    return new Map(); // busy, locked or an unknown schema: show sessions without T3 details
  } finally { input.close(); }
}
