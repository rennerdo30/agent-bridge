import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/transcripts/common.ts
import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
var MAX_TRANSCRIPT_CHUNK_BYTES = 512 * 1024;
var MAX_TOOL_PREVIEW_CHARS = 1200;
var MAX_TEXT_CHARS = 16e3;
var MAX_TITLE_CHARS = 160;
var MAX_NATIVE_SUBAGENTS = 200;
var MAX_DISCOVERY_FILES = 2e4;
var MAX_DISCOVERY_BYTES = 8 * 1024 * 1024;
var MAX_CURSOR_CHARS = 256;
var SQLITE_READ_TIMEOUT_MS = 100;
var INITIAL_HEADER_BYTES = 8 * 1024;
var TRANSCRIPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function transcriptPaths(env = process.env, home = homedir()) {
  return {
    claude: resolve(env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude")),
    codex: resolve(env.CODEX_HOME?.trim() || join(home, ".codex")),
    opencode: resolve(join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "opencode")),
    antigravity: resolve(env.ANTIGRAVITY_CLI_HOME?.trim() || join(home, ".gemini", "antigravity-cli"))
  };
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function parse(value) {
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}
function time(value) {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : 0;
  return Number.isFinite(at) ? at : 0;
}
function preview(value, limit = MAX_TOOL_PREVIEW_CHARS) {
  let text = "";
  if (typeof value === "string") text = value;
  else if (value !== void 0 && value !== null) {
    try {
      text = JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return text.length > limit ? `${text.slice(0, limit)}\u2026` : text;
}
function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(object).filter((p) => ["text", "input_text", "output_text"].includes(p.type) && typeof p.text === "string").map((p) => p.text).join("\n");
}
function directory(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function fileStat(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}
function safeFile(root, file, canonicalRoot) {
  try {
    const actual = realpathSync.native(file), rel = relative(canonicalRoot ?? realpathSync.native(root), actual);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? actual : null;
  } catch {
    return null;
  }
}
function readJsonl(file, from = "0", maxBytes = MAX_TRANSCRIPT_CHUNK_BYTES) {
  const match = /^(?:j:)?(\d+)(?::([01]))?$/.exec(from);
  let offset = match ? Number(match[1]) : 0, discard = match?.[2] === "1";
  if (!Number.isSafeInteger(offset)) offset = 0;
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (offset > size) {
      offset = 0;
      discard = false;
    }
    if (offset > 0 && !discard) {
      const previous = Buffer.alloc(1);
      readSync(fd, previous, 0, 1, offset - 1);
      discard = previous[0] !== 10;
    }
    const buf = Buffer.alloc(Math.min(maxBytes, Math.max(0, size - offset)));
    const length = readSync(fd, buf, 0, buf.length, offset);
    const entries = [];
    let start = 0;
    for (let i = 0; i < length; i++) {
      if (buf[i] !== 10) continue;
      if (!discard) entries.push({ value: parse(buf.subarray(start, i).toString("utf8")), offset: offset + start });
      discard = false;
      start = i + 1;
    }
    if (start === 0 && length === maxBytes) {
      offset += length;
      discard = true;
    } else if (discard) offset += length;
    else offset += start;
    return { entries, next: `j:${offset}:${discard ? 1 : 0}` };
  } catch {
    return { entries: [], next: `j:${offset}:${discard ? 1 : 0}` };
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function readHead(file) {
  let fd;
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
  } catch {
    return {};
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function readTail(file) {
  const size = fileStat(file)?.size ?? 0;
  return readJsonl(file, String(Math.max(0, size - MAX_TRANSCRIPT_CHUNK_BYTES))).entries.map((e) => e.value);
}
function scanJsonl(file) {
  const entries = [];
  let from = "0";
  for (let bytes = 0; bytes < MAX_DISCOVERY_BYTES; bytes += MAX_TRANSCRIPT_CHUNK_BYTES) {
    const page = readJsonl(file, from);
    entries.push(...page.entries);
    if (page.next === from) break;
    from = page.next;
  }
  return entries;
}

export {
  MAX_TRANSCRIPT_CHUNK_BYTES,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_NATIVE_SUBAGENTS,
  MAX_DISCOVERY_FILES,
  MAX_CURSOR_CHARS,
  SQLITE_READ_TIMEOUT_MS,
  TRANSCRIPT_ID,
  transcriptPaths,
  object,
  parse,
  time,
  preview,
  contentText,
  directory,
  fileStat,
  safeFile,
  readJsonl,
  readHead,
  readTail,
  scanJsonl
};
