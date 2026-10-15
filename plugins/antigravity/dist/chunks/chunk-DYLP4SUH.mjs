import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  decodeBytes
} from "./chunk-IS3KHBHN.mjs";
import {
  MAX_TITLE_CHARS,
  contentText,
  object,
  openFileSource,
  parse,
  preview,
  time
} from "./chunk-OX5J3NNH.mjs";

// src/core/history-sources.ts
import { statSync } from "node:fs";
var CLAUDE_CHILD_FACTS_TABLE = `CREATE TABLE IF NOT EXISTS dashboard_claude_children(
 source TEXT PRIMARY KEY, generation INTEGER NOT NULL, upto INTEGER NOT NULL DEFAULT 0,
 head_state INTEGER NOT NULL DEFAULT 0, title TEXT, head_at INTEGER NOT NULL DEFAULT 0,
 assistant_at INTEGER, assistant_done INTEGER NOT NULL DEFAULT 0, oversized_at INTEGER, open_from INTEGER)`;
var HEAD_NONE = 0;
var HEAD_PARSED = 1;
var HEAD_UNKNOWN = 2;
var FACT_RECORDS_PER_TICK = 32;
var CHUNK_CACHE = 64;
function foldClaudeChildChunk(facts, offset, chunk) {
  if (offset !== facts.upto) return facts;
  const next = { ...facts };
  let pos = 0;
  while (pos < chunk.length) {
    const newline = chunk.indexOf(10, pos), start = offset + pos;
    if (next.open_from !== null) {
      if (newline < 0) {
        pos = chunk.length;
        break;
      }
      next.oversized_at = next.open_from;
      if (next.open_from === 0) next.head_state = HEAD_UNKNOWN;
      next.open_from = null;
      pos = newline + 1;
      continue;
    }
    if (newline < 0) {
      next.open_from = start;
      if (start === 0) next.head_state = HEAD_UNKNOWN;
      break;
    }
    const line = chunk.subarray(pos, newline);
    if (start === 0) {
      const head = parse(line.toString("utf8")), text = contentText(object(head.message).content);
      next.head_state = HEAD_PARSED;
      next.title = text ? preview(text, MAX_TITLE_CHARS) : null;
      next.head_at = time(head.timestamp);
    }
    if (line.includes("assistant")) {
      const row = parse(line.toString("utf8"));
      if (row.type === "assistant") {
        next.assistant_at = start;
        next.assistant_done = object(row.message).stop_reason === "end_turn" ? 1 : 0;
      }
    }
    pos = newline + 1;
  }
  next.upto = offset + chunk.length;
  return next;
}
function refreshClaudeChildFacts(db) {
  let work = 0;
  const stale = db.prepare(`SELECT s.id,s.generation,s.offset FROM conversation_sources s LEFT JOIN dashboard_claude_children c ON c.source=s.id
    WHERE s.format='jsonl' AND s.conversation LIKE 'claude:%:native:%' AND (c.source IS NULL OR c.generation<>s.generation OR c.upto>=0 AND c.upto<s.offset) LIMIT 8`).all();
  for (const source of stale) {
    const id = String(source.id), generation = Number(source.generation);
    const saved = db.prepare("SELECT * FROM dashboard_claude_children WHERE source=?").get(id);
    let facts = saved && Number(saved.generation) === generation ? { ...saved } : {
      source: id,
      generation,
      upto: 0,
      head_state: HEAD_NONE,
      title: null,
      head_at: 0,
      assistant_at: null,
      assistant_done: 0,
      oversized_at: null,
      open_from: null
    };
    for (const row of db.prepare("SELECT offset,raw,raw_codec FROM conversation_records WHERE source=? AND generation=? AND offset>=? ORDER BY offset LIMIT ?").iterate(id, generation, facts.upto, FACT_RECORDS_PER_TICK)) {
      if (Number(row.offset) !== facts.upto) break;
      facts = foldClaudeChildChunk(facts, Number(row.offset), decodeBytes(row.raw, row.raw_codec));
      work++;
    }
    if (facts.upto < Number(source.offset) && !db.prepare("SELECT 1 FROM conversation_records WHERE source=? AND generation=? AND offset=?").get(id, generation, facts.upto)) facts = { ...facts, upto: -1 };
    db.prepare(`INSERT INTO dashboard_claude_children VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET generation=excluded.generation,
      upto=excluded.upto,head_state=excluded.head_state,title=excluded.title,head_at=excluded.head_at,assistant_at=excluded.assistant_at,
      assistant_done=excluded.assistant_done,oversized_at=excluded.oversized_at,open_from=excluded.open_from`).run(id, generation, facts.upto, facts.head_state, facts.title, facts.head_at, facts.assistant_at, facts.assistant_done, facts.oversized_at, facts.open_from);
  }
  return work;
}
var HistorySourceResolver = class {
  constructor(db) {
    this.db = db;
    this.facts = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dashboard_claude_children'").get();
  }
  db;
  /** A requested file had no usable retained copy: the answer came from the file (still importing). */
  fellBack = false;
  /** Bytes past the ingested offset were read from the file. */
  liveTail = false;
  facts;
  row(file) {
    const exact = this.db.prepare("SELECT id,path,generation,offset,identity FROM conversation_sources WHERE id=? AND format='jsonl'").get(file);
    const found = exact ?? (process.platform === "win32" ? this.db.prepare("SELECT id,path,generation,offset,identity FROM conversation_sources WHERE id=? COLLATE NOCASE AND format='jsonl' LIMIT 1").get(file) : void 0);
    return found ? { id: String(found.id), path: String(found.path), generation: Number(found.generation), offset: Number(found.offset), identity: String(found.identity) } : null;
  }
  /** The retained copy, if it still describes this file. */
  current(file) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return null;
    }
    const row = this.row(file);
    const empty = row?.offset === 0 && stat.size === 0;
    if (!row || !empty && (row.offset === 0 || row.identity !== `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` || stat.size < row.offset)) {
      this.fellBack = true;
      return null;
    }
    return { row, stat };
  }
  open(file) {
    const current = this.current(file);
    return current ? new RetainedSource(this.db, current.row, current.stat.size, file, () => {
      this.liveTail = true;
    }) : null;
  }
  claudeChild(file, tailBytes) {
    if (!this.facts) return null;
    const current = this.current(file);
    if (!current || current.stat.size !== current.row.offset) return null;
    const facts = this.db.prepare("SELECT * FROM dashboard_claude_children WHERE source=? AND generation=?").get(current.row.id, current.row.generation);
    if (!facts || Number(facts.upto) !== current.row.offset) return null;
    if (Number(facts.head_state) === HEAD_UNKNOWN || Number(facts.head_state) === HEAD_NONE && current.row.offset > 0) return null;
    const windowStart = Math.max(0, current.row.offset - tailBytes);
    const assistant = facts.assistant_at === null ? -1 : Number(facts.assistant_at);
    if (facts.oversized_at !== null && Number(facts.oversized_at) >= windowStart && Number(facts.oversized_at) > assistant) return null;
    return {
      title: facts.title === null ? null : String(facts.title),
      startedAt: Number(facts.head_at),
      status: assistant >= windowStart && Number(facts.assistant_done) ? "done" : "unknown"
    };
  }
  noInlineSidechains(file) {
    const current = this.current(file);
    if (!current || current.stat.size !== current.row.offset) return false;
    const prefix = `${current.row.id}:inline:`;
    return !this.db.prepare("SELECT 1 FROM conversation_records WHERE source>=? AND source<? AND generation=? LIMIT 1").get(prefix, `${current.row.id}:inline;`, current.row.generation);
  }
};
var RetainedSource = class {
  constructor(db, row, size, path, onLive) {
    this.db = db;
    this.row = row;
    this.size = size;
    this.path = path;
    this.onLive = onLive;
  }
  db;
  row;
  size;
  path;
  onLive;
  chunks = /* @__PURE__ */ new Map();
  file = null;
  fromFile(buffer, offset, length, position) {
    if (!this.file) {
      this.file = openFileSource(this.path);
      this.onLive();
    }
    return this.file.read(buffer, offset, length, position);
  }
  chunkAt(position, end) {
    for (const [offset, bytes2] of this.chunks) if (offset <= position && position < offset + bytes2.length) return { offset, bytes: bytes2 };
    const first = this.db.prepare("SELECT offset FROM conversation_records WHERE source=? AND generation=? AND offset<=? ORDER BY offset DESC LIMIT 1").get(this.row.id, this.row.generation, position);
    if (!first) return null;
    if (this.chunks.size > CHUNK_CACHE) this.chunks.clear();
    for (const record of this.db.prepare("SELECT offset,raw,raw_codec FROM conversation_records WHERE source=? AND generation=? AND offset>=? AND offset<? ORDER BY offset").iterate(this.row.id, this.row.generation, Number(first.offset), Math.max(end, position + 1))) {
      this.chunks.set(Number(record.offset), decodeBytes(record.raw, record.raw_codec));
    }
    const bytes = this.chunks.get(Number(first.offset));
    return bytes && position < Number(first.offset) + bytes.length ? { offset: Number(first.offset), bytes } : null;
  }
  read(buffer, offset, length, position) {
    let done = 0;
    const want = Math.min(length, Math.max(0, this.size - position));
    while (done < want) {
      const at = position + done, left = want - done;
      if (at >= this.row.offset) {
        const n2 = this.fromFile(buffer, offset + done, left, at);
        if (n2 <= 0) break;
        done += n2;
        continue;
      }
      let chunk = null;
      try {
        chunk = this.chunkAt(at, Math.min(this.row.offset, position + want));
      } catch {
      }
      if (!chunk) {
        const n2 = this.fromFile(buffer, offset + done, Math.min(left, this.row.offset - at), at);
        if (n2 <= 0) break;
        done += n2;
        continue;
      }
      const n = Math.min(left, chunk.offset + chunk.bytes.length - at, this.row.offset - at);
      chunk.bytes.copy(buffer, offset + done, at - chunk.offset, at - chunk.offset + n);
      done += n;
    }
    return done;
  }
  close() {
    this.file?.close();
    this.file = null;
    this.chunks.clear();
  }
};

export {
  CLAUDE_CHILD_FACTS_TABLE,
  refreshClaudeChildFacts,
  HistorySourceResolver
};
