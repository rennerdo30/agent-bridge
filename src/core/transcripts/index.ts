import { readClaudeChat, listClaudeSubagents } from "./claude.js";
import { readCodexChat, listCodexSubagents } from "./codex.js";
import { readOpencodeChat, listOpencodeSubagents } from "./opencode.js";
import { readAntigravityChat, listAntigravitySubagents } from "./antigravity.js";
import { MAX_CURSOR_CHARS, transcriptPaths, type NativeSubagent, type TranscriptPage, type TranscriptPaths, type TranscriptSession } from "./common.js";

export { transcriptPaths, TRANSCRIPT_ID, MAX_CURSOR_CHARS } from "./common.js";
export type { TranscriptItem, TranscriptPage, NativeSubagent, TranscriptPaths } from "./common.js";

export function validTranscriptCursor(from: string): boolean {
  const match = /^(?:(?:j:)?(\d+)(?::[01])?|o:(\d+):[A-Za-z0-9_-]*)$/.exec(from);
  return from.length <= MAX_CURSOR_CHARS && !!match && Number.isSafeInteger(Number(match[1] ?? match[2]));
}

export function readTranscript(session: TranscriptSession, from = "0", child?: string, paths: TranscriptPaths = transcriptPaths()): TranscriptPage | null {
  switch (session.agent) {
    case "claude": return readClaudeChat(session, paths, from, child);
    case "codex": return readCodexChat(session, paths, from, child);
    case "opencode": return readOpencodeChat(session, paths, from, child);
    case "antigravity": return readAntigravityChat(session, paths, from, child);
    default: return null;
  }
}
export function listNativeSubagents(session: TranscriptSession, paths: TranscriptPaths = transcriptPaths()): NativeSubagent[] {
  switch (session.agent) {
    case "claude": return listClaudeSubagents(session, paths);
    case "codex": return listCodexSubagents(session, paths);
    case "opencode": return listOpencodeSubagents(session, paths);
    case "antigravity": return listAntigravitySubagents(session, paths);
    default: return [];
  }
}
