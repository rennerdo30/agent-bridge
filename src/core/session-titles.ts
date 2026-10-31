import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { claudeSessionFile } from "./transcripts/claude.js";
import type { TranscriptPaths, TranscriptSession } from "./transcripts/common.js";

/**
 * AB-474: the chat title a plain CLI session shows on the dashboard's second line, like T3 chats do.
 * Claude Code writes `{"type":"ai-title","aiTitle":…}` records into its transcript; the newest one is the title its
 * own UI shows. Read from the end of the transcript only (bounded), re-read only when the file changed and at most
 * every 30 seconds per session, so a dashboard poll costs a stat for an unchanged session.
 */
const TAIL_BYTES = 256 * 1024, REFRESH_MS = 30_000, MAX_TITLE_CHARS = 160, MAX_CACHED = 512;
interface Entry { file: string | null; size: number; mtime: number; at: number; title: string | null }
const cache = new Map<string, Entry>();

function newestTitle(file: string, size: number, previous: string | null): string | null {
  const fd = openSync(file, "r");
  try {
    const length = Math.min(size, TAIL_BYTES), buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('"ai-title"')) continue;
      try {
        const row = JSON.parse(lines[i]!);
        if (row?.type === "ai-title" && typeof row.aiTitle === "string" && row.aiTitle.trim()) return row.aiTitle.trim().slice(0, MAX_TITLE_CHARS);
      } catch { /* a partial first line in the window */ }
    }
    return previous; // none in this window: keep the last one seen
  } finally { closeSync(fd); }
}

/** The chat title of a local Claude session, or null when it has none (yet) or is not Claude. */
export function claudeChatTitle(session: TranscriptSession, paths: TranscriptPaths, now = Date.now()): string | null {
  if (session.agent !== "claude" || !session.sessionId) return null;
  const key = `${paths.claude}|${session.sessionId}`, hit = cache.get(key);
  if (hit && now - hit.at < REFRESH_MS) return hit.title;
  try {
    // Resolving the transcript can scan every project folder: keep a found file for this session.
    const file = hit?.file ?? claudeSessionFile(session, paths);
    let entry: Entry = { file, size: 0, mtime: 0, at: now, title: hit?.title ?? null };
    if (file) {
      const fd = openSync(file, "r");
      let size: number, mtime: number;
      try { const st = fstatSync(fd); size = st.size; mtime = st.mtimeMs; } finally { closeSync(fd); }
      const changed = !hit || hit.size !== size || hit.mtime !== mtime;
      entry = { file, size, mtime, at: now, title: changed ? newestTitle(file, size, hit?.title ?? null) : hit!.title };
    }
    cache.delete(key); cache.set(key, entry);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
    return entry.title;
  } catch {
    cache.set(key, { file: null, size: 0, mtime: 0, at: now, title: hit?.title ?? null });
    return hit?.title ?? null;
  }
}
