import { closeSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openFileSource, type ByteSource, type ByteSourceResolver, type ClaudeChildFacts } from "./byte-source.js";
import { CONVERSATION_BYTES } from "./conversation-text.js";
import { decodeBytes } from "./history-codec.js";
import { contentText, MAX_TITLE_CHARS, object, parse, preview, time } from "./transcripts/common.js";

/**
 * AB-383: the dashboard reads transcripts and run logs from their retained copies in history.db
 * (conversation_records, written by ConversationIngestor) instead of reparsing the files on every request.
 * The files stay authoritative: a copy is used only while the file still has the identity and at least the
 * size the ingester recorded, and bytes past the ingested offset are read from the file itself.
 */

/** Derived facts about Claude native subagent files; rebuilt from conversation_records, never authoritative.
 * Also the case-insensitive source index the dashboard's path lookup uses on Windows (no full scan for unknown files). */
export const CLAUDE_CHILD_FACTS_TABLE = `CREATE TABLE IF NOT EXISTS dashboard_claude_children(
 source TEXT PRIMARY KEY, generation INTEGER NOT NULL, upto INTEGER NOT NULL DEFAULT 0,
 head_state INTEGER NOT NULL DEFAULT 0, title TEXT, head_at INTEGER NOT NULL DEFAULT 0,
 assistant_at INTEGER, assistant_done INTEGER NOT NULL DEFAULT 0, oversized_at INTEGER, open_from INTEGER);
CREATE INDEX IF NOT EXISTS idx_conversation_sources_nocase ON conversation_sources(id COLLATE NOCASE)`;
const HEAD_NONE = 0, HEAD_PARSED = 1, HEAD_UNKNOWN = 2;
const FACT_RECORDS_PER_TICK = 32;
const CHUNK_CACHE = 64;

interface ChildFacts {
  source: string; generation: number; upto: number; head_state: number; title: string | null; head_at: number;
  assistant_at: number | null; assistant_done: number; oversized_at: number | null; open_from: number | null;
}

/** Fold one contiguous retained chunk (starting at `offset`) into a subagent file's facts. Pure. */
export function foldClaudeChildChunk(facts: ChildFacts, offset: number, chunk: Buffer): ChildFacts {
  if (offset !== facts.upto) return facts;
  const next = { ...facts };
  let pos = 0;
  while (pos < chunk.length) {
    const newline = chunk.indexOf(10, pos), start = offset + pos;
    if (next.open_from !== null) {
      // The rest of a record longer than one retained chunk: the bytes are kept, its facts are not derived.
      if (newline < 0) { pos = chunk.length; break; }
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
      if (row.type === "assistant") { next.assistant_at = start; next.assistant_done = object(row.message).stop_reason === "end_turn" ? 1 : 0; }
    }
    pos = newline + 1;
  }
  next.upto = offset + chunk.length;
  return next;
}

/** Worker-only: keep subagent facts current from records already retained. Bounded per call; nonzero while it made progress. */
export function refreshClaudeChildFacts(db: DatabaseSync): number {
  let work = 0;
  const stale = db.prepare(`SELECT s.id,s.generation,s.offset FROM conversation_sources s LEFT JOIN dashboard_claude_children c ON c.source=s.id
    WHERE s.format='jsonl' AND s.conversation LIKE 'claude:%:native:%' AND (c.source IS NULL OR c.generation<>s.generation OR c.upto>=0 AND c.upto<s.offset) LIMIT 8`).all();
  for (const source of stale) {
    const id = String(source.id), generation = Number(source.generation);
    const saved = db.prepare("SELECT * FROM dashboard_claude_children WHERE source=?").get(id) as unknown as ChildFacts | undefined;
    let facts: ChildFacts = saved && Number(saved.generation) === generation ? { ...saved } : { source: id, generation, upto: 0, head_state: HEAD_NONE,
      title: null, head_at: 0, assistant_at: null, assistant_done: 0, oversized_at: null, open_from: null };
    for (const row of db.prepare("SELECT offset,raw,raw_codec FROM conversation_records WHERE source=? AND generation=? AND offset>=? ORDER BY offset LIMIT ?")
      .iterate(id, generation, facts.upto, FACT_RECORDS_PER_TICK)) {
      if (Number(row.offset) !== facts.upto) break; // Not contiguous: readers compute from the bytes instead.
      facts = foldClaudeChildChunk(facts, Number(row.offset), decodeBytes(row.raw, row.raw_codec));
      work++;
    }
    // No contiguous record continues these facts: readers compute them from the bytes (upto -1) until a new generation.
    if (facts.upto < Number(source.offset) && !db.prepare("SELECT 1 FROM conversation_records WHERE source=? AND generation=? AND offset=?").get(id, generation, facts.upto)) facts = { ...facts, upto: -1 };
    db.prepare(`INSERT INTO dashboard_claude_children VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET generation=excluded.generation,
      upto=excluded.upto,head_state=excluded.head_state,title=excluded.title,head_at=excluded.head_at,assistant_at=excluded.assistant_at,
      assistant_done=excluded.assistant_done,oversized_at=excluded.oversized_at,open_from=excluded.open_from`)
      .run(id, generation, facts.upto, facts.head_state, facts.title, facts.head_at, facts.assistant_at, facts.assistant_done, facts.oversized_at, facts.open_from);
  }
  // Every stale source updated counts, so a caller that runs this only while it progresses drains the backlog.
  return Math.max(work, stale.length);
}

interface SourceRow { id: string; path: string; generation: number; offset: number; identity: string; anchor: string }
const ANCHOR_BYTES = 64;
const SOURCE_COLUMNS = "id,path,generation,offset,identity,anchor";

/** Read side: serves retained bytes for one dashboard request. Read-only connection. */
export class HistorySourceResolver implements ByteSourceResolver {
  /** A requested file had no usable retained copy: the answer came from the file (still importing). */
  fellBack = false;
  /** Bytes past the ingested offset were read from the file. */
  liveTail = false;
  private readonly facts: boolean;
  private readonly verified = new Map<string, { row: SourceRow; stat: Stats } | null>();
  constructor(private readonly db: DatabaseSync) {
    this.facts = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dashboard_claude_children'").get();
  }

  private row(file: string): SourceRow | null {
    const exact = this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM conversation_sources WHERE id=? AND format='jsonl'`).get(file);
    const found = exact ?? (process.platform === "win32"
      ? this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM conversation_sources WHERE id=? COLLATE NOCASE AND format='jsonl' LIMIT 1`).get(file) : undefined);
    return found ? { id: String(found.id), path: String(found.path), generation: Number(found.generation), offset: Number(found.offset),
      identity: String(found.identity), anchor: String(found.anchor ?? "") } : null;
  }

  /** The retained copy, if it still describes this file. Checked once per request and file. */
  private current(file: string): { row: SourceRow; stat: Stats } | null {
    if (this.verified.has(file)) return this.verified.get(file)!;
    const current = this.verify(file);
    this.verified.set(file, current);
    return current;
  }

  private verify(file: string): { row: SourceRow; stat: Stats } | null {
    let stat: Stats;
    try { stat = statSync(file); } catch { return null; }
    const row = this.row(file);
    if (row?.offset === 0 && stat.size === 0) return { row, stat };
    if (!row || row.offset === 0 || row.identity !== `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` || stat.size < row.offset
      || !this.unchangedBefore(file, row, stat)) {
      this.fellBack = true;
      return null;
    }
    return { row, stat };
  }

  /**
   * The ingester also treats a changed 64-byte anchor before its offset as a rewrite (ConversationIngestor.jsonl), and
   * identity alone cannot see an in-place rewrite (nor any rewrite where ino is 0). Without reading the file, only an
   * untouched file qualifies: the ingested size and the mtime its last retained chunk was read at. Otherwise the anchor
   * is compared with one small read.
   */
  private unchangedBefore(file: string, row: SourceRow, stat: Stats): boolean {
    if (stat.size === row.offset) {
      const last = this.db.prepare("SELECT at FROM conversation_records WHERE source=? AND generation=? ORDER BY offset DESC LIMIT 1").get(row.id, row.generation);
      if (last && Number(last.at) === stat.mtimeMs) return true;
    }
    if (!row.anchor) return false;
    const anchor = Buffer.alloc(Math.min(ANCHOR_BYTES, row.offset));
    const fd = openSync(file, "r");
    try {
      if (readSync(fd, anchor, 0, anchor.length, row.offset - anchor.length) !== anchor.length) return false;
    } finally { closeSync(fd); }
    return createHash("sha256").update(anchor).digest("hex") === row.anchor;
  }

  /** A store that fails to answer (busy, damaged) never makes an empty page: the file answers, flagged as importing. */
  private guarded<T>(fallback: T, read: () => T): T {
    try { return read(); } catch { this.fellBack = true; return fallback; }
  }

  open(file: string): ByteSource | null {
    return this.guarded(null, () => {
      const current = this.current(file);
      return current ? new RetainedSource(this.db, current.row, current.stat.size, file, () => { this.liveTail = true; }, () => { this.fellBack = true; }) : null;
    });
  }

  claudeChild(file: string, tailBytes: number): ClaudeChildFacts | null {
    return this.guarded(null, () => this.childFacts(file, tailBytes));
  }

  private childFacts(file: string, tailBytes: number): ClaudeChildFacts | null {
    if (!this.facts) return null;
    const current = this.current(file);
    if (!current || current.stat.size !== current.row.offset) return null;
    const facts = this.db.prepare("SELECT * FROM dashboard_claude_children WHERE source=? AND generation=?").get(current.row.id, current.row.generation) as unknown as ChildFacts | undefined;
    if (!facts || Number(facts.upto) !== current.row.offset) return null;
    if (Number(facts.head_state) === HEAD_UNKNOWN || Number(facts.head_state) === HEAD_NONE && current.row.offset > 0) return null;
    const windowStart = Math.max(0, current.row.offset - tailBytes);
    const assistant = facts.assistant_at === null ? -1 : Number(facts.assistant_at);
    // A record too long to derive facts from may be the last assistant turn the file reader would see.
    if (facts.oversized_at !== null && Number(facts.oversized_at) >= windowStart && Number(facts.oversized_at) > assistant) return null;
    return {
      title: facts.title === null ? null : String(facts.title), startedAt: Number(facts.head_at),
      status: assistant >= windowStart && Number(facts.assistant_done) ? "done" : "unknown",
    };
  }

  noInlineSidechains(file: string): boolean {
    return this.guarded(false, () => {
      const current = this.current(file);
      if (!current || current.stat.size !== current.row.offset) return false;
      const { id, generation, offset } = current.row;
      // The ingester inspects only the head of a record longer than one retained chunk: let the legacy scan decide.
      // A chunk ends at a record boundary whenever it holds one, so only a chunk of (nearly) full size can split a record.
      const split = this.db.prepare(`SELECT 1 FROM (SELECT coalesce(lead(offset) OVER (ORDER BY offset), ?) - offset size
        FROM conversation_records WHERE source=? AND generation=?) WHERE size>=? LIMIT 1`).get(offset, id, generation, CONVERSATION_BYTES - 4);
      if (split) return false;
      return !this.db.prepare("SELECT 1 FROM conversation_records WHERE source>=? AND source<? AND generation=? LIMIT 1")
        .get(`${id}:inline:`, `${id}:inline;`, generation);
    });
  }
}

/** Bytes [0, ingested) from conversation_records, the rest from the file. */
class RetainedSource implements ByteSource {
  private readonly chunks = new Map<number, Buffer>();
  private file: ByteSource | null = null;
  constructor(private readonly db: DatabaseSync, private readonly row: SourceRow, readonly size: number,
    private readonly path: string, private readonly onLive: () => void, private readonly onStoreError: () => void) {}

  private fromFile(buffer: Buffer, offset: number, length: number, position: number): number {
    if (!this.file) { this.file = openFileSource(this.path); this.onLive(); }
    return this.file.read(buffer, offset, length, position);
  }

  private chunkAt(position: number, end: number): { offset: number; bytes: Buffer } | null {
    for (const [offset, bytes] of this.chunks) if (offset <= position && position < offset + bytes.length) return { offset, bytes };
    const first = this.db.prepare("SELECT offset FROM conversation_records WHERE source=? AND generation=? AND offset<=? ORDER BY offset DESC LIMIT 1")
      .get(this.row.id, this.row.generation, position);
    if (!first) return null;
    if (this.chunks.size > CHUNK_CACHE) this.chunks.clear();
    for (const record of this.db.prepare("SELECT offset,raw,raw_codec FROM conversation_records WHERE source=? AND generation=? AND offset>=? AND offset<? ORDER BY offset")
      .iterate(this.row.id, this.row.generation, Number(first.offset), Math.max(end, position + 1))) {
      this.chunks.set(Number(record.offset), decodeBytes(record.raw, record.raw_codec));
    }
    const bytes = this.chunks.get(Number(first.offset));
    return bytes && position < Number(first.offset) + bytes.length ? { offset: Number(first.offset), bytes } : null;
  }

  read(buffer: Buffer, offset: number, length: number, position: number): number {
    let done = 0;
    const want = Math.min(length, Math.max(0, this.size - position));
    while (done < want) {
      const at = position + done, left = want - done;
      if (at >= this.row.offset) {
        const n = this.fromFile(buffer, offset + done, left, at);
        if (n <= 0) break;
        done += n; continue;
      }
      let chunk: { offset: number; bytes: Buffer } | null = null;
      try { chunk = this.chunkAt(at, Math.min(this.row.offset, position + want)); } catch { this.onStoreError(); /* busy or damaged copy: the file answers */ }
      if (!chunk) {
        // A gap in the retained copy: the file answers for it.
        const n = this.fromFile(buffer, offset + done, Math.min(left, this.row.offset - at), at);
        if (n <= 0) break;
        done += n; continue;
      }
      const n = Math.min(left, chunk.offset + chunk.bytes.length - at, this.row.offset - at);
      chunk.bytes.copy(buffer, offset + done, at - chunk.offset, at - chunk.offset + n);
      done += n;
    }
    return done;
  }

  close(): void { this.file?.close(); this.file = null; this.chunks.clear(); }
}
