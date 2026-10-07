import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PeerInfo } from "../protocol.js";

export const MAX_TRANSCRIPT_CHUNK_BYTES = 512 * 1024;
export const MAX_TOOL_PREVIEW_CHARS = 1_200;
export const MAX_TEXT_CHARS = 16_000;
export const MAX_TITLE_CHARS = 160;
export const MAX_NATIVE_SUBAGENTS = 200;
export const MAX_DISCOVERY_FILES = 20_000;
export const MAX_DISCOVERY_BYTES = 8 * 1024 * 1024;
export const MAX_CURSOR_CHARS = 256;
export const SQLITE_READ_TIMEOUT_MS = 100;
const INITIAL_HEADER_BYTES = 8 * 1024;
export const TRANSCRIPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface TranscriptItem {
  kind: "user" | "assistant" | "tool" | "subagent";
  /** Milliseconds since the Unix epoch. */
  at: number;
  text?: string;
  tool?: string;
  summary?: string;
  subagent?: { id: string; title: string; agent: string };
  /** Stable identity, so mutable SQLite parts can replace an earlier preview. */
  id?: string;
}
export interface TranscriptPage { items: TranscriptItem[]; next: string }
export interface NativeSubagent {
  id: string;
  title: string;
  status: "unknown" | "running" | "done" | "failed" | "interrupted";
  startedAt: number;
  updatedAt: number;
}
export type TranscriptSession = Pick<PeerInfo, "agent" | "cwd" | "sessionId">;
export interface TranscriptPaths { claude: string; codex: string; opencode: string; antigravity?: string }

export function transcriptPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): TranscriptPaths {
  return {
    claude: resolve(env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude")),
    codex: resolve(env.CODEX_HOME?.trim() || join(home, ".codex")),
    opencode: resolve(join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "opencode")),
    antigravity: resolve(env.ANTIGRAVITY_CLI_HOME?.trim() || join(home, ".gemini", "antigravity-cli")),
  };
}

// CLI files are untrusted input. Every nested value is checked at its use site.
export type JsonObject = Record<string, any>;
export function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
export function parse(value: string): JsonObject {
  try { return object(JSON.parse(value)); } catch { return {}; }
}
export function time(value: unknown): number {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : 0;
  return Number.isFinite(at) ? at : 0;
}
export function preview(value: unknown, limit = MAX_TOOL_PREVIEW_CHARS): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (value !== undefined && value !== null) {
    try { text = JSON.stringify(value); } catch { return ""; }
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(object).filter((p) => ["text", "input_text", "output_text"].includes(p.type) && typeof p.text === "string").map((p) => p.text).join("\n");
}
export function directory(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
export function fileStat(file: string): Stats | null {
  try { return statSync(file); } catch { return null; }
}
/** Refuse symlinks that escape the CLI's storage root, including child-folder junctions. */
export function safeFile(root: string, file: string, canonicalRoot?: string): string | null {
  try {
    const actual = realpathSync.native(file), rel = relative(canonicalRoot ?? realpathSync.native(root), actual);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? actual : null;
  } catch { return null; }
}

interface JsonlEntry { value: JsonObject; offset: number }
export interface JsonlPage { entries: JsonlEntry[]; next: string }

/** Byte cursors keep an oversized-line discard flag; incomplete final lines are retried. */
export function readJsonl(file: string, from = "0", maxBytes = MAX_TRANSCRIPT_CHUNK_BYTES): JsonlPage {
  const match = /^(?:j:)?(\d+)(?::([01]))?$/.exec(from);
  let offset = match ? Number(match[1]) : 0, discard = match?.[2] === "1";
  if (!Number.isSafeInteger(offset)) offset = 0;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (offset > size) { offset = 0; discard = false; }
    // Check a manually supplied offset too: never parse the middle of a record.
    if (offset > 0 && !discard) {
      const previous = Buffer.alloc(1);
      readSync(fd, previous, 0, 1, offset - 1);
      discard = previous[0] !== 10;
    }
    const buf = Buffer.alloc(Math.min(maxBytes, Math.max(0, size - offset)));
    const length = readSync(fd, buf, 0, buf.length, offset);
    const entries: JsonlEntry[] = [];
    let start = 0;
    for (let i = 0; i < length; i++) {
      if (buf[i] !== 10) continue;
      if (!discard) entries.push({ value: parse(buf.subarray(start, i).toString("utf8")), offset: offset + start });
      discard = false;
      start = i + 1;
    }
    // A line larger than the cap is skipped over successive bounded reads.
    if (start === 0 && length === maxBytes) { offset += length; discard = true; }
    else if (discard) offset += length;
    else offset += start;
    return { entries, next: `j:${offset}:${discard ? 1 : 0}` };
  } catch { return { entries: [], next: `j:${offset}:${discard ? 1 : 0}` }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readHead(file: string): JsonObject {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    for (let limit = INITIAL_HEADER_BYTES; limit <= MAX_TRANSCRIPT_CHUNK_BYTES; limit *= 2) {
      const buf = Buffer.alloc(Math.min(size, limit));
      const length = readSync(fd, buf, 0, buf.length, 0), newline = buf.indexOf(10);
      if (newline >= 0) return parse(buf.subarray(0, newline).toString("utf8"));
      if (length < limit) break;
    }
    return {};
  } catch { return {}; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function readTail(file: string): JsonObject[] {
  const size = fileStat(file)?.size ?? 0;
  return readJsonl(file, String(Math.max(0, size - MAX_TRANSCRIPT_CHUNK_BYTES))).entries.map((e) => e.value);
}

/** Bounded metadata scan for legacy inline sidechains; modern children have separate files. */
export function scanJsonl(file: string): JsonlEntry[] {
  const entries: JsonlEntry[] = [];
  let from = "0";
  for (let bytes = 0; bytes < MAX_DISCOVERY_BYTES; bytes += MAX_TRANSCRIPT_CHUNK_BYTES) {
    const page = readJsonl(file, from);
    entries.push(...page.entries);
    if (page.next === from) break;
    from = page.next;
  }
  return entries;
}
