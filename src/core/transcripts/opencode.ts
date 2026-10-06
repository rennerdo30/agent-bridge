import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_NATIVE_SUBAGENTS, MAX_TEXT_CHARS, MAX_TITLE_CHARS, MAX_TRANSCRIPT_CHUNK_BYTES, object, parse, preview, safeFile, SQLITE_READ_TIMEOUT_MS, time, TRANSCRIPT_ID, type NativeSubagent, type TranscriptItem, type TranscriptPage, type TranscriptPaths, type TranscriptSession } from "./common.js";

const MAX_SQLITE_PARTS = 200;
const SQLITE_CURSOR = /^o:(\d+):([A-Za-z0-9_-]*)$/;

function openDatabase(paths: TranscriptPaths): DatabaseSync | null {
  const file = safeFile(paths.opencode, join(paths.opencode, "opencode.db"));
  if (!file) return null;
  try { return new DatabaseSync(file, { readOnly: true, timeout: SQLITE_READ_TIMEOUT_MS }); } catch { return null; }
}

export function opencodeItems(data: unknown, role: unknown, at: number, id: string): TranscriptItem[] {
  const part = object(data), state = object(part.state);
  if (part.type === "text" && typeof part.text === "string" && ["user", "assistant"].includes(String(role))) return [{ kind: role as "user" | "assistant", at, text: preview(part.text, MAX_TEXT_CHARS), id }];
  if (part.type !== "tool" || typeof part.tool !== "string") return [];
  const items: TranscriptItem[] = [{ kind: "tool", at, tool: part.tool, summary: preview(state.output ?? state.error ?? state.input), id }];
  const child = object(state.metadata).sessionId;
  if (part.tool === "task" && typeof child === "string" && TRANSCRIPT_ID.test(child)) items.push({ kind: "subagent", at, id: `${id}-child`, subagent: { id: child, title: preview(state.title || "Native subagent", MAX_TITLE_CHARS), agent: "opencode" } });
  return items;
}

export function readOpencodeChat(session: TranscriptSession, paths: TranscriptPaths, from = "0", child?: string): TranscriptPage | null {
  if (!session.sessionId || !TRANSCRIPT_ID.test(session.sessionId) || (child !== undefined && !TRANSCRIPT_ID.test(child))) return null;
  const db = openDatabase(paths);
  if (!db) return null;
  const match = SQLITE_CURSOR.exec(from), after = Number(match?.[1] ?? 0), afterId = match?.[2] ?? "";
  let next = `o:${Number.isSafeInteger(after) ? after : 0}:${afterId}`;
  try {
    const id = child ?? session.sessionId;
    const exists = child ? db.prepare("SELECT id FROM session WHERE id = ? AND parent_id = ?").get(id, session.sessionId) : db.prepare("SELECT id FROM session WHERE id = ?").get(id);
    if (!exists) return null;
    const stmt = db.prepare(`SELECT p.id, p.time_created, p.time_updated, length(CAST(p.data AS BLOB)) AS bytes,
      substr(p.data, 1, ?) AS data, CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END AS role
      FROM part p JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
      WHERE p.session_id = ? AND (p.time_updated > ? OR (p.time_updated = ? AND p.id > ?))
      ORDER BY p.time_updated, p.id LIMIT ?`);
    const items: TranscriptItem[] = [];
    let bytes = 0;
    for (const row of stmt.iterate(MAX_TRANSCRIPT_CHUNK_BYTES, id, after, after, afterId, MAX_SQLITE_PARTS)) {
      const length = Number(row.bytes);
      if (bytes + Math.min(length, MAX_TRANSCRIPT_CHUNK_BYTES) > MAX_TRANSCRIPT_CHUNK_BYTES) break;
      next = `o:${Number(row.time_updated)}:${String(row.id)}`;
      bytes += Math.min(length, MAX_TRANSCRIPT_CHUNK_BYTES);
      // Oversized records and unknown parts advance the cursor without being rendered.
      if (length <= MAX_TRANSCRIPT_CHUNK_BYTES && typeof row.data === "string") items.push(...opencodeItems(parse(row.data), row.role, time(row.time_created), String(row.id)));
    }
    return { items, next };
  } catch { return { items: [], next }; }
  finally { db.close(); }
}

export function listOpencodeSubagents(session: TranscriptSession, paths: TranscriptPaths): NativeSubagent[] {
  if (!session.sessionId || !TRANSCRIPT_ID.test(session.sessionId)) return [];
  const db = openDatabase(paths);
  if (!db) return [];
  try {
    return db.prepare(`SELECT id, substr(title, 1, ?) AS title, time_created, time_updated FROM session
      WHERE parent_id = ? ORDER BY time_created LIMIT ?`).all(MAX_TITLE_CHARS, session.sessionId, MAX_NATIVE_SUBAGENTS).map((row) => ({
        id: String(row.id), title: String(row.title), status: "unknown" as const, startedAt: time(row.time_created), updatedAt: time(row.time_updated),
      })).filter((s) => TRANSCRIPT_ID.test(s.id));
  } catch { return []; }
  finally { db.close(); }
}
