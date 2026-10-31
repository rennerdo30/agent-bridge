import { closeSync, openSync, readSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { claudeSessionFile } from "./transcripts/claude.js";
import { codexStateFile } from "./transcripts/codex.js";
import { SQLITE_READ_TIMEOUT_MS, type TranscriptPaths, type TranscriptSession } from "./transcripts/common.js";

/**
 * AB-474: the chat title a plain CLI session shows on the dashboard's second line, like T3 chats do.
 * Claude Code writes `{"type":"ai-title","aiTitle":…}` records into its transcript; the newest one is the title its
 * own UI shows. Read from the end of the transcript (bounded) and re-read only when the file changed, at most every
 * 30 seconds per session: within that interval a poll costs nothing, after it one stat for an unchanged session.
 * Long tool output can push the newest title megabytes back, so a session without a known title is searched further
 * back once (up to 4 MB, in 256 KB windows); later reads only need the tail.
 */
const WINDOW_BYTES = 256 * 1024, FIRST_SCAN_BYTES = 4 * 1024 * 1024;
const REFRESH_MS = 30_000, MISSING_RETRY_MS = 5 * 60_000, MAX_TITLE_CHARS = 160, MAX_CACHED = 512;
interface Entry { file: string | null; size: number; mtime: number; at: number; retryAt: number; title: string | null }
const cache = new Map<string, Entry>();

function remember(key: string, entry: Entry): void {
  cache.delete(key); cache.set(key, entry);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
}

/** The newest ai-title in the last `scan` bytes, searched backwards one window at a time. */
function newestTitle(file: string, size: number, scan: number): string | null {
  const fd = openSync(file, "r");
  try {
    for (let end = size; end > 0 && size - end < scan; end -= WINDOW_BYTES) {
      const start = Math.max(0, end - WINDOW_BYTES), buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]!.includes('"ai-title"')) continue;
        try {
          const row = JSON.parse(lines[i]!);
          if (row?.type === "ai-title" && typeof row.aiTitle === "string" && row.aiTitle.trim()) return row.aiTitle.trim().slice(0, MAX_TITLE_CHARS);
        } catch { /* a line cut by the window edge */ }
      }
    }
    return null;
  } finally { closeSync(fd); }
}

/** The chat title of a local Claude session, or null when it has none (yet) or is not Claude. */
export function claudeChatTitle(session: TranscriptSession, paths: TranscriptPaths, now = Date.now()): string | null {
  if (session.agent !== "claude" || !session.sessionId) return null;
  const key = `${paths.claude}|${session.sessionId}`, hit = cache.get(key);
  if (hit && now < hit.retryAt) return hit.title;
  try {
    // Resolving the transcript can scan every project folder: keep a found file, retry a missing one only rarely.
    const file = hit?.file ?? claudeSessionFile(session, paths);
    if (!file) { remember(key, { file: null, size: 0, mtime: 0, at: now, retryAt: now + MISSING_RETRY_MS, title: hit?.title ?? null }); return hit?.title ?? null; }
    const { size, mtimeMs: mtime } = statSync(file);
    const changed = !hit || hit.file !== file || hit.size !== size || hit.mtime !== mtime;
    const previous = hit?.title ?? null;
    // Without a known title, look further back once; otherwise the tail decides, keeping the previous title.
    const title = changed ? newestTitle(file, size, previous === null ? FIRST_SCAN_BYTES : WINDOW_BYTES) ?? previous : previous;
    remember(key, { file, size, mtime, at: now, retryAt: now + REFRESH_MS, title });
    return title;
  } catch {
    // The file moved or vanished: resolve it again after the refresh interval, keeping the last title.
    remember(key, { file: null, size: 0, mtime: 0, at: now, retryAt: now + REFRESH_MS, title: hit?.title ?? null });
    return hit?.title ?? null;
  }
}

/**
 * The chat title of a local Codex session: the name the user gave the chat (`threads.name` in Codex's own state
 * database), else the first line of its first prompt (`threads.title`, which Codex fills with the whole prompt). One
 * primary-key lookup, read-only, at most every 30 seconds per session; only the first characters of the prompt are read.
 */
export function codexChatTitle(session: TranscriptSession, paths: TranscriptPaths, now = Date.now()): string | null {
  if (session.agent !== "codex" || !session.sessionId) return null;
  const key = `codex|${paths.codex}|${session.sessionId}`, hit = cache.get(key);
  if (hit && now < hit.retryAt) return hit.title;
  let title = hit?.title ?? null, db: DatabaseSync | undefined;
  try {
    const file = codexStateFile(paths);
    if (file) {
      db = new DatabaseSync(file, { readOnly: true, timeout: SQLITE_READ_TIMEOUT_MS });
      const row = db.prepare("SELECT substr(name, 1, ?) AS name, substr(title, 1, ?) AS title FROM threads WHERE id = ?")
        .get(MAX_TITLE_CHARS * 4, MAX_TITLE_CHARS * 4, session.sessionId);
      if (row) title = firstLine(row.name) ?? firstLine(row.title, true);
    }
  } catch { /* locked, older schema or gone: keep the last title */ }
  finally { db?.close(); }
  remember(key, { file: null, size: 0, mtime: 0, at: now, retryAt: now + REFRESH_MS, title });
  return title;
}

/** The first non-empty line, whitespace collapsed, shortened; injected context (a tag or AGENTS.md) is no title. */
function firstLine(value: unknown, prompt = false): string | null {
  if (typeof value !== "string") return null;
  const line = value.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean);
  if (!line || (prompt && /^(<|# AGENTS\.md)/.test(line))) return null;
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…` : line;
}

/** A plain local CLI session's chat title (Claude or Codex), or null. */
export function sessionChatTitle(session: TranscriptSession, paths: TranscriptPaths, now = Date.now()): string | null {
  return session.agent === "codex" ? codexChatTitle(session, paths, now) : claudeChatTitle(session, paths, now);
}
