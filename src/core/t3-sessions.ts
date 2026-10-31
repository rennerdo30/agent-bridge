import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TranscriptPaths, TranscriptSession } from "./transcripts/common.js";
import { readTranscript } from "./transcripts/index.js";

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
 * AB-470: where the folder alone is not enough (the project root that main chats share, or a worktree
 * several chats could be), the session's own first prompts are compared with the T3 user messages of the
 * candidate chats: T3 stores the same prompt text at about the same time. Exactly one matching chat links;
 * otherwise the session stays unlinked, so a session is never guessed to be a chat. Any store problem
 * means "no T3 data".
 */

export interface T3SessionInfo {
  id: string; title: string; provider: string; model: string | null;
  /** The T3 project's folder (its workspace root): the project a worktree chat belongs to. */
  projectRoot: string | null;
  status: "running" | "queued" | "waiting" | "done" | "failed" | "interrupted" | "cancelled" | "idle";
  parentTitle: string | null;
  /** T3 can switch a chat between providers: `current` runs the chat now, `earlier` ran it before the switch. */
  harness: "current" | "earlier";
}
interface FolderChat { id: string; title: string; provider: string; agent: string; agents: Set<string>; model: string | null; parentId: string | null; projectRoot: string | null }
/** The session's first prompts (oldest first), from its own CLI transcript. */
export type PromptReader = (session: { agent: string; cwd: string; sessionId: string }) => { text: string; at: number }[];

/** The folder → chat index is rebuilt at most this often, or sooner for a folder it does not know yet. */
export const T3_INDEX_MS = 60_000, T3_INDEX_MISS_MS = 10_000;
/** Prompt matching: compared prefix, shortest prompt that counts, prompts read, time window, retry for no match. */
const PROMPT_CHARS = 300, MIN_PROMPT_CHARS = 12, MAX_PROMPTS = 8, PROMPT_WINDOW_MS = 10 * 60_000, MAX_POOL = 500;
export const T3_PROMPT_RETRY_MS = 60_000;
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
/** `folders`: chats with a folder of their own. `roots`: per project root, the chats working there (no folder of
 * their own), except provider-native subagents, which never are a session of their own. */
interface T3Index { folders: Map<string, FolderEntry>; roots: Map<string, FolderChat[]> }
function buildIndex(input: DatabaseSync): T3Index {
  const roots = new Map((input.prepare(`SELECT project_id,substr(workspace_root,1,4097) root FROM projection_projects`).all() as { project_id: unknown; root: unknown }[])
    .filter(r => typeof r.root === "string" && r.root.length > 0 && r.root.length <= 4096).map(r => [String(r.project_id), r.root as string]));
  const rows = input.prepare(`SELECT substr(thread_id,1,513) id,substr(project_id,1,513) project_id,substr(title,1,301) title,
      substr(coalesce(provider_instance_id,default_provider),1,65) provider,substr(default_provider,1,65) driver,
      json_extract(payload_json,'$.worktreePath') folder,json_extract(payload_json,'$.modelSelection.model') model,
      json_extract(payload_json,'$.lineage.parentThreadId') parent
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND octet_length(payload_json)<=${MAX_PAYLOAD} AND json_valid(payload_json)`).all() as Record<string, unknown>[];
  // Every readable chat's own folder (null: none, it works in the project root), for parent lookups.
  const folderOf = new Map<string, string | null>();
  for (const row of rows) if (id(row.id)) folderOf.set(row.id, typeof row.folder === "string" && row.folder && row.folder.length <= 4096 ? t3FolderKey(row.folder) : null);
  const chats = new Map<string, FolderChat & { folder: string | null }>();
  for (const row of rows) {
    if (!id(row.id)) continue;
    // The agent comes from T3's driver kind (an instance can have any name); an unknown driver never links.
    const provider = typeof row.provider === "string" ? row.provider : "", agent = AGENTS[String(row.driver)] ?? "other";
    chats.set(row.id, { id: row.id, title: (typeof row.title === "string" && row.title) || "Untitled chat", provider, agent, agents: new Set(agent === "other" ? [] : [agent]),
      model: typeof row.model === "string" ? row.model.slice(0, 120) : null, parentId: id(row.parent) ? row.parent : null,
      projectRoot: roots.get(String(row.project_id)) ?? null, folder: folderOf.get(row.id) ?? null });
  }
  // Every provider a chat has run on (one row per provider harness the chat used).
  for (const r of input.prepare(`SELECT DISTINCT thread_id,coalesce(driver,provider) driver FROM orchestration_v2_projection_provider_threads`).all() as { thread_id: unknown; driver: unknown }[]) {
    const agent = AGENTS[String(r.driver)];
    if (typeof r.thread_id === "string" && agent) chats.get(r.thread_id)?.agents.add(agent);
  }
  const origin = new Map((input.prepare(`SELECT child_thread_id,origin FROM orchestration_v2_projection_subagents`).all() as { child_thread_id: unknown; origin: unknown }[])
    .map(r => [String(r.child_thread_id), String(r.origin)]));
  const index: T3Index = { folders: new Map(), roots: new Map() };
  for (const chat of chats.values()) {
    if (chat.folder === null) {
      if (chat.projectRoot === null || origin.get(chat.id) === "provider_native") continue;
      const key = t3FolderKey(chat.projectRoot);
      (index.roots.get(key) ?? index.roots.set(key, []).get(key)!).push(chat);
      continue;
    }
    const entry = index.folders.get(chat.folder) ?? index.folders.set(chat.folder, { owners: [], shared: [] }).get(chat.folder)!;
    // Owner: a top-level chat, or a child whose (known) parent works in another folder or the project root.
    // A child whose parent is unknown here (deleted, unreadable) never owns a folder on missing information.
    const parentKnown = chat.parentId !== null && folderOf.has(chat.parentId);
    if (chat.parentId === null || (parentKnown && folderOf.get(chat.parentId) !== chat.folder)) entry.owners.push(chat);
    else if (origin.get(chat.id) === "app_owned") entry.shared.push(chat);
  }
  return index;
}

/** Per T3 home: the folder index, when it was read, and the session folders it was built for. */
const indexes = new Map<string, { at: number; index: T3Index; seen: Set<string>; failed: boolean }>();
/** Prompt matches per T3 home, agent and session ID: a transcript's beginning never changes, so a match is kept. */
const promptLinks = new Map<string, { chat: string | null; at: number }>();
const normalize = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, PROMPT_CHARS);

/** The default reader: the first page of the session's own transcript, through Bridge's transcript readers. */
export function transcriptPrompts(paths: TranscriptPaths): PromptReader {
  return (session) => (readTranscript(session as TranscriptSession, "0", undefined, paths)?.items ?? [])
    .filter((item) => item.kind === "user" && typeof item.text === "string").map((item) => ({ text: item.text!, at: item.at }));
}

/**
 * T3 chat details for the given sessions (folder + agent), keyed like the input. A session is linked
 * only when exactly one candidate chat in its folder ran on its agent, and no other session with the
 * same agent links to that chat; everything else is left unlinked.
 */
export function t3SessionInfo(root: string | undefined, sessions: { key: string; cwd: string; agent: string; sessionId?: string | null }[], now = Date.now(),
  prompts?: PromptReader): Map<string, T3SessionInfo> {
  const out = new Map<string, T3SessionInfo>();
  if (root === undefined || !sessions.length) return out;
  const input = open(root);
  if (!input) return out;
  try {
    let cached = indexes.get(root);
    // A folder first seen after the index was built (a new chat) may rebuild it early, once; folders
    // that are simply not T3 chats (the main checkout, other sessions) never keep forcing rebuilds.
    const fresh = sessions.some(s => { const k = t3FolderKey(s.cwd); return !cached?.index.folders.has(k) && !cached?.index.roots.has(k) && !cached?.seen.has(k); });
    const age = cached ? now - cached.at : Infinity;
    if (!cached || (cached.failed ? age >= T3_INDEX_MISS_MS : age >= T3_INDEX_MS || (fresh && age >= T3_INDEX_MISS_MS))) {
      const seen = new Set(sessions.map(s => t3FolderKey(s.cwd)));
      // A store that cannot be indexed (busy, unknown schema) is retried after the short window, not every poll.
      try { cached = { at: now, index: buildIndex(input), seen, failed: false }; }
      catch { cached = { at: now, index: { folders: new Map(), roots: new Map() }, seen, failed: true }; }
      indexes.set(root, cached);
    }
    if (cached.failed) return out;
    const waiting = input.prepare(`SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id=? AND status='pending' LIMIT 1`);
    const latest = input.prepare(`SELECT status FROM orchestration_v2_projection_runs WHERE thread_id=? ORDER BY ordinal DESC LIMIT 1`);
    const title = input.prepare(`SELECT substr(title,1,301) title FROM orchestration_v2_projection_threads WHERE thread_id=? AND deleted_at IS NULL`);
    const statusOf = (chat: FolderChat): T3SessionInfo["status"] =>
      waiting.get(chat.id) ? "waiting" : RUN_STATUS[String((latest.get(chat.id) as { status?: unknown } | undefined)?.status ?? "")] ?? "idle";
    const fits = (chat: FolderChat, agent: string) => chat.agents.has(agent);
    // AB-470: which one of several candidate chats this session is, by its first prompts.
    const userMessages = (pool: FolderChat[], from: string, to: string) => input.prepare(`SELECT thread_id,
        CASE WHEN octet_length(payload_json)<=${MAX_PAYLOAD} AND json_valid(payload_json) THEN substr(json_extract(payload_json,'$.text'),1,${PROMPT_CHARS * 4}) END text
      FROM orchestration_v2_projection_messages WHERE role='user' AND created_at BETWEEN ? AND ?
        AND thread_id IN (${pool.map(() => "?").join(",")})`).all(from, to, ...pool.map(c => c.id)) as { thread_id: unknown; text: unknown }[];
    const byPrompt = (pool: FolderChat[], s: { agent: string; cwd: string; sessionId?: string | null }): FolderChat | undefined => {
      if (!prompts || !s.sessionId || !pool.length || pool.length > MAX_POOL) return undefined;
      const key = `${root}|${s.agent}|${s.sessionId}`, hit = promptLinks.get(key);
      if (hit && (hit.chat !== null || now - hit.at < T3_PROMPT_RETRY_MS)) return hit.chat === null ? undefined : pool.find(c => c.id === hit.chat);
      let first: { text: string; at: number }[] = [];
      try { first = prompts({ agent: s.agent, cwd: s.cwd, sessionId: s.sessionId }); } catch { first = []; }
      const wanted = first.map(p => ({ text: normalize(p.text), at: p.at })).filter(p => p.text.length >= MIN_PROMPT_CHARS && Number.isFinite(p.at) && p.at > 0).slice(0, MAX_PROMPTS);
      let chat: FolderChat | undefined;
      if (wanted.length) {
        const ats = wanted.map(p => p.at), texts = new Set(wanted.map(p => p.text));
        const rows = userMessages(pool, new Date(Math.min(...ats) - PROMPT_WINDOW_MS).toISOString(), new Date(Math.max(...ats) + PROMPT_WINDOW_MS).toISOString());
        const matched = new Set(rows.filter(r => typeof r.text === "string" && texts.has(normalize(r.text))).map(r => String(r.thread_id)));
        if (matched.size === 1) chat = pool.find(c => matched.has(c.id));
      }
      promptLinks.set(key, { chat: chat?.id ?? null, at: now });
      return chat;
    };
    const linked = new Map<string, { chat: FolderChat; status: T3SessionInfo["status"] }>();
    for (const s of sessions) {
      const key = t3FolderKey(s.cwd), entry = cached.index.folders.get(key);
      let chat: FolderChat | undefined;
      if (entry) {
        const candidates = [...entry.owners.filter(c => fits(c, s.agent)),
          ...entry.shared.filter(c => fits(c, s.agent)).filter(c => ["running", "queued", "waiting"].includes(statusOf(c)))];
        chat = candidates.length === 1 ? candidates[0] : byPrompt(candidates, s);
      } else {
        // A project root: plenty of sessions there are not T3 chats, so only a prompt match links.
        chat = byPrompt((cached.index.roots.get(key) ?? []).filter(c => fits(c, s.agent)), s);
      }
      if (chat) linked.set(s.key, { chat, status: statusOf(chat) });
    }
    // Two sessions of the same agent claiming one chat cannot both be it: link neither.
    const claims = new Map<string, number>();
    for (const s of sessions) { const l = linked.get(s.key); if (l) claims.set(`${l.chat.id}|${s.agent}`, (claims.get(`${l.chat.id}|${s.agent}`) ?? 0) + 1); }
    for (const s of sessions) {
      const l = linked.get(s.key);
      if (!l || claims.get(`${l.chat.id}|${s.agent}`)! > 1) continue;
      const chat = l.chat;
      const parent = chat.parentId ? title.get(chat.parentId) as { title?: unknown } | undefined : undefined;
      out.set(s.key, { id: chat.id, title: chat.title, provider: chat.provider, model: chat.model, projectRoot: chat.projectRoot,
        status: l.status,
        parentTitle: typeof parent?.title === "string" ? parent.title : null, harness: chat.agent === s.agent ? "current" : "earlier" });
    }
    return out;
  } catch {
    return new Map(); // busy, locked or an unknown schema: show sessions without T3 details
  } finally { input.close(); }
}
