import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contentText, directory, fileStat, MAX_DISCOVERY_FILES, MAX_NATIVE_SUBAGENTS, MAX_TEXT_CHARS, MAX_TITLE_CHARS, object, parse, preview, readHead, readJsonl, readTail, safeFile, SQLITE_READ_TIMEOUT_MS, time, TRANSCRIPT_ID, type JsonObject, type NativeSubagent, type TranscriptItem, type TranscriptPage, type TranscriptPaths, type TranscriptSession } from "./common.js";

const ROLLOUT_NAME = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const DISCOVERY_CACHE_MS = 10_000;
const MAX_INDEX_PATH_CHARS = 4_096;
interface Rollout { file: string; id: string; meta: JsonObject }
const cache = new Map<string, { at: number; files: Rollout[] }>();

function rollout(file: string, id: string, known?: JsonObject): Rollout {
  const head = known && Object.keys(known).length ? known : object(readHead(file).payload);
  const data = head.id === id ? head : object(readJsonl(file).entries.find(({ value: r }) => r.type === "session_meta" && object(r.payload).id === id)?.value.payload);
  // Cache relationships, not large prompts or account metadata.
  return { file, id, meta: Object.fromEntries(["id", "source", "thread_source", "parent_thread_id", "timestamp", "agent_nickname", "agent_path", "subagent_history_start_ordinal"].filter((key) => data[key] !== undefined).map((key) => [key, data[key]])) };
}

/** The observed CLI index avoids opening every rollout on a dashboard request. Headers remain authoritative. */
function indexedRollouts(paths: TranscriptPaths, id?: string, parentId?: string): Rollout[] | null {
  const name = directory(paths.codex).filter((s) => /^state_\d+\.sqlite$/.test(s)).sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0];
  if (!name) return null;
  const file = safeFile(paths.codex, join(paths.codex, name));
  if (!file) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: SQLITE_READ_TIMEOUT_MS });
    const rows = id
      ? db.prepare("SELECT id, substr(rollout_path, 1, ?) AS path FROM threads WHERE id = ? LIMIT 1").all(MAX_INDEX_PATH_CHARS, id)
      : db.prepare(`SELECT id, substr(rollout_path, 1, ?) AS path FROM threads
          WHERE CASE WHEN json_valid(source) THEN json_extract(source, '$.subagent.thread_spawn.parent_thread_id') END = ? LIMIT ?`).all(MAX_INDEX_PATH_CHARS, parentId!, MAX_NATIVE_SUBAGENTS);
    const out: Rollout[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || !TRANSCRIPT_ID.test(row.id) || typeof row.path !== "string") continue;
      const target = safeFile(join(paths.codex, "sessions"), row.path);
      if (!target) continue;
      const entry = rollout(target, row.id);
      if (entry.meta.id === row.id && (!parentId || parent(entry.meta) === parentId)) out.push(entry);
    }
    // Missing or stale index entries fall back to bounded filesystem discovery.
    return out.length ? out : null;
  } catch { return null; }
  finally { db?.close(); }
}

/** Enumerate only YYYY/MM/DD directories, never arbitrary folders or symlink destinations. */
function rollouts(paths: TranscriptPaths): Rollout[] {
  const root = join(paths.codex, "sessions"), existing = cache.get(root);
  if (existing && Date.now() - existing.at < DISCOVERY_CACHE_MS) return existing.files;
  const files: Rollout[] = [];
  const knownFiles = new Map(existing?.files.map((r) => [r.file, r]));
  for (const year of directory(root).filter((s) => /^\d{4}$/.test(s)).sort().reverse()) {
    for (const month of directory(join(root, year)).filter((s) => /^\d{2}$/.test(s)).sort().reverse()) {
      for (const day of directory(join(root, year, month)).filter((s) => /^\d{2}$/.test(s)).sort().reverse()) {
        for (const name of directory(join(root, year, month, day)).sort().reverse()) {
          const id = ROLLOUT_NAME.exec(name)?.[1];
          if (!id) continue;
          const file = safeFile(root, join(root, year, month, day, name));
          if (!file) continue;
          const known = knownFiles.get(file);
          // Forked files can include ancestor metadata. Match payload.id to the filename.
          files.push(rollout(file, id, known?.meta));
          if (files.length >= MAX_DISCOVERY_FILES) { cache.set(root, { at: Date.now(), files }); return files; }
        }
      }
    }
  }
  cache.set(root, { at: Date.now(), files });
  return files;
}

function parent(meta: JsonObject): string | undefined {
  const spawn = object(object(object(meta.source).subagent).thread_spawn);
  if (!Object.keys(spawn).length && meta.thread_source !== "subagent") return undefined;
  return typeof meta.parent_thread_id === "string" ? meta.parent_thread_id : typeof spawn.parent_thread_id === "string" ? spawn.parent_thread_id : undefined;
}

export function codexItems(row: JsonObject): TranscriptItem[] {
  if (row.type !== "response_item") return [];
  const p = object(row.payload), at = time(row.timestamp);
  if (p.type === "message" && ["user", "assistant"].includes(p.role) && p.channel !== "analysis") {
    const text = contentText(p.content);
    return text ? [{ kind: p.role, at, text: preview(text, MAX_TEXT_CHARS) }] : [];
  }
  if (["function_call", "custom_tool_call"].includes(p.type) && typeof p.name === "string") return [{ kind: "tool", at, tool: p.name, summary: preview(p.arguments ?? p.input) }];
  if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
    const items: TranscriptItem[] = [{ kind: "tool", at, tool: typeof p.call_id === "string" ? p.call_id : "result", summary: preview(p.output) }];
    // SpawnAgentResult is serialized as { agent_id, nickname } by the native tool.
    const result = typeof p.output === "string" ? parse(p.output) : object(p.output);
    if (typeof result.agent_id === "string" && TRANSCRIPT_ID.test(result.agent_id)) items.push({ kind: "subagent", at, subagent: { id: result.agent_id, title: preview(result.nickname || "Native subagent", MAX_TITLE_CHARS), agent: "codex" } });
    return items;
  }
  return [];
}

export function readCodexChat(session: TranscriptSession, paths: TranscriptPaths, from = "0", child?: string): TranscriptPage | null {
  if (!session.sessionId || !TRANSCRIPT_ID.test(session.sessionId) || (child !== undefined && !TRANSCRIPT_ID.test(child))) return null;
  const id = child ?? session.sessionId;
  const entry = (indexedRollouts(paths, id) ?? rollouts(paths)).find((r) => r.id === id);
  if (!entry || (child && parent(entry.meta) !== session.sessionId)) return null;
  const page = readJsonl(entry.file, from);
  const start = entry.meta.subagent_history_start_ordinal;
  return { items: page.entries.filter(({ value: r }) => typeof start !== "number" || typeof r.ordinal !== "number" || r.ordinal >= start).flatMap(({ value }) => codexItems(value)), next: page.next };
}

export function listCodexSubagents(session: TranscriptSession, paths: TranscriptPaths): NativeSubagent[] {
  if (!session.sessionId || !TRANSCRIPT_ID.test(session.sessionId)) return [];
  return (indexedRollouts(paths, undefined, session.sessionId) ?? rollouts(paths)).filter((r) => parent(r.meta) === session.sessionId).slice(0, MAX_NATIVE_SUBAGENTS).map(({ file, id, meta }) => {
    const st = fileStat(file);
    const last = [...readTail(file)].reverse().find((r) => r.type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(object(r.payload).type));
    const state = object(last?.payload).type;
    const spawn = object(object(object(meta.source).subagent).thread_spawn);
    return { id, title: preview(meta.agent_nickname || spawn.agent_nickname || meta.agent_path || spawn.agent_path || `Subagent ${id}`, MAX_TITLE_CHARS), status: state === "task_complete" ? "done" : state === "turn_aborted" ? "interrupted" : "unknown", startedAt: time(meta.timestamp) || st?.birthtimeMs || 0, updatedAt: st?.mtimeMs || 0 };
  });
}
