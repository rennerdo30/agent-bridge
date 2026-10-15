import { readClaudeChat, listClaudeSubagents, listClaudeSubagentsResponsive } from "./claude.js";
import { readCodexChat, listCodexSubagents } from "./codex.js";
import { readOpencodeChat, listOpencodeSubagents } from "./opencode.js";
import { readAntigravityChat, listAntigravitySubagents } from "./antigravity.js";
import { readMuseChat, listMuseSubagents } from "./muse.js";
import { MAX_CURSOR_CHARS, transcriptPaths, type NativeSubagent, type TranscriptPage, type TranscriptPaths, type TranscriptSession } from "./common.js";

export { transcriptPaths, TRANSCRIPT_ID, MAX_CURSOR_CHARS } from "./common.js";
export type { TranscriptItem, TranscriptPage, NativeSubagent, TranscriptPaths } from "./common.js";

export function validTranscriptCursor(from: string): boolean {
  const match = /^(?:(?:j:)?(\d+)(?::[01])?|o:(\d+):[A-Za-z0-9_-]*)$/.exec(from);
  if (from === "tail") return true;
  return from.length <= MAX_CURSOR_CHARS && !!match && Number.isSafeInteger(Number(match[1] ?? match[2]));
}

export function readTranscript(session: TranscriptSession, from = "0", child?: string, paths: TranscriptPaths = transcriptPaths()): TranscriptPage | null {
  switch (session.agent) {
    case "claude": return readClaudeChat(session, paths, from, child);
    case "codex": return readCodexChat(session, paths, from, child);
    case "opencode": return readOpencodeChat(session, paths, from, child);
    case "antigravity": return readAntigravityChat(session, paths, from, child);
    case "muse": return readMuseChat(session, paths, from, child);
    default: return null;
  }
}
export function listNativeSubagents(session: TranscriptSession, paths: TranscriptPaths = transcriptPaths()): NativeSubagent[] {
  switch (session.agent) {
    case "claude": return listClaudeSubagents(session, paths);
    case "codex": return listCodexSubagents(session, paths);
    case "opencode": return listOpencodeSubagents(session, paths);
    case "antigravity": return listAntigravitySubagents(session, paths);
    case "muse": return listMuseSubagents(session, paths);
    default: return [];
  }
}

/** Dashboard tabs poll the same lists: share one in-flight scan and reuse a just-finished one briefly (AB-382). */
export const NATIVE_SUBAGENT_FRESH_MS = 1_500;
const MAX_SHARED_LISTS = 256;
const sharedLists = new Map<string, { promise: Promise<NativeSubagent[]>; doneAt: number | null }>();
export function listNativeSubagentsShared(session: TranscriptSession, paths: TranscriptPaths = transcriptPaths(), freshMs = NATIVE_SUBAGENT_FRESH_MS): Promise<NativeSubagent[]> {
  const key = JSON.stringify([session.agent, session.sessionId ?? null, session.cwd ?? null, paths]);
  const now = Date.now(), saved = sharedLists.get(key);
  if (saved && (saved.doneAt === null || now - saved.doneAt < freshMs)) return saved.promise.then(copyList);
  const entry: { promise: Promise<NativeSubagent[]>; doneAt: number | null } = { promise: Promise.resolve([]), doneAt: null };
  entry.promise = (session.agent === "claude" ? listClaudeSubagentsResponsive(session, paths) : Promise.resolve().then(() => listNativeSubagents(session, paths)))
    .then((list) => { entry.doneAt = Date.now(); return list; }, (error) => { if (sharedLists.get(key) === entry) sharedLists.delete(key); throw error; });
  sharedLists.delete(key); sharedLists.set(key, entry);
  if (sharedLists.size > MAX_SHARED_LISTS) for (const [old, value] of sharedLists) {
    if (sharedLists.size <= MAX_SHARED_LISTS) break;
    if (value.doneAt !== null) sharedLists.delete(old);
  }
  return entry.promise.then(copyList);
}
const copyList = (list: NativeSubagent[]) => list.map((item) => ({ ...item }));
