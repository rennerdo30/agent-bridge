import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DB_FILE_NAME } from "./constants.js";
import { historyDbPath, historyReady, historyV1Readable, openHistoryReader } from "./history-store.js";
import { CODING_AGENTS } from "./protocol.js";

/**
 * AB-383: push for the dashboard. The history worker retains appended transcript and run-log lines within
 * milliseconds; this feed notices each committed batch through SQLite's data_version on one read-only
 * connection and tells subscribers which conversations moved. Subscribers then read the new lines through the
 * ordinary indexed dashboard reads, so the store stays the single source and an event carries no content.
 */
export type HistoryChange =
  | { kind: "chat"; agent: string; session: string; child: string | null }
  | { kind: "run"; run: string };

/** How often the held connection checks data_version: one shared-memory read, no file I/O. */
export const HISTORY_FEED_POLL_MS = 50;
/** While history.db is missing or not readable yet, and after a failed poll. */
export const HISTORY_FEED_RETRY_MS = 1_000;
/** Records read per poll: a rowid range, never a scan of the whole table. */
export const HISTORY_FEED_SCAN_ROWS = 4096;
/** At most this many open dashboard event streams per server; the browser holds one per visible tab. */
export const MAX_HISTORY_EVENT_STREAMS = 16;
/** A stream whose client stopped reading is ended rather than buffered without bound. */
export const MAX_HISTORY_EVENT_BACKLOG_BYTES = 256 * 1024;
/** New records after a rowid, read as an INTEGER PRIMARY KEY range (bounded per poll). */
export const HISTORY_FEED_SCAN_SQL = "SELECT id,conversation FROM conversation_records WHERE id>? ORDER BY id LIMIT ?";
const RUN = /^bridge:run:([\w.-]{1,256})$/;
const NATIVE = /^([a-z]+):([A-Za-z0-9_-]{1,128}):native:([A-Za-z0-9_-]{1,128})$/;
const SESSION = /^([a-z]+):([A-Za-z0-9_-]{1,128})$/;

export function historyChangeOf(conversation: string): HistoryChange | null {
  const run = RUN.exec(conversation);
  if (run) return { kind: "run", run: run[1]! };
  const native = NATIVE.exec(conversation);
  if (native && (CODING_AGENTS as readonly string[]).includes(native[1]!)) return { kind: "chat", agent: native[1]!, session: native[2]!, child: native[3]! };
  const session = SESSION.exec(conversation);
  if (session && (CODING_AGENTS as readonly string[]).includes(session[1]!)) return { kind: "chat", agent: session[1]!, session: session[2]!, child: null };
  return null;
}

type Statement = ReturnType<DatabaseSync["prepare"]>;

export class HistoryChangeFeed {
  private readonly listeners = new Set<(changes: HistoryChange[]) => void>();
  /** Open event-stream responses; close() ends them. */
  readonly streams = new Set<ServerResponse>();
  private db: DatabaseSync | null = null;
  private versionStatement: Statement | null = null;
  private scanStatement: Statement | null = null;
  private version = -1;
  private last = 0;
  private timer: NodeJS.Timeout | null = null;
  private retryAt = 0;
  constructor(private readonly home: string, private readonly intervalMs = HISTORY_FEED_POLL_MS) {}

  /** Starts the shared connection with the first subscriber and closes it with the last. */
  subscribe(listener: (changes: HistoryChange[]) => void): () => void {
    this.listeners.add(listener);
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), this.intervalMs);
      this.timer.unref();
      this.poll();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  }

  /** Whether the poll timer and the history.db connection are held. */
  get active(): { polling: boolean; connected: boolean } { return { polling: this.timer !== null, connected: this.db !== null }; }

  /** Ends every open event stream and stops the feed (server shutdown). */
  close(): void {
    for (const res of [...this.streams]) res.end();
    this.streams.clear();
    this.listeners.clear();
    this.stop();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.release();
  }

  private release(): void {
    this.versionStatement = null;
    this.scanStatement = null;
    this.db?.close();
    this.db = null;
    this.version = -1;
  }

  private open(): boolean {
    if (this.db) return true;
    if (Date.now() < this.retryAt) return false;
    this.retryAt = Date.now() + HISTORY_FEED_RETRY_MS;
    const path = historyDbPath(join(this.home, DB_FILE_NAME));
    if (!existsSync(path)) return false;
    let db: DatabaseSync | undefined;
    try {
      db = openHistoryReader(path, 50);
      if (!(historyReady(db) || historyV1Readable(db)) || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_records'").get()) { db.close(); return false; }
      // Changes from now on; earlier content is what the subscriber's snapshot read returns.
      this.last = Number(db.prepare("SELECT coalesce(max(id),0) n FROM conversation_records").get()!.n);
      this.versionStatement = db.prepare("PRAGMA data_version");
      this.scanStatement = db.prepare(HISTORY_FEED_SCAN_SQL);
      this.version = Number(this.versionStatement.get()!.data_version);
      this.db = db;
      return true;
    } catch {
      this.versionStatement = this.scanStatement = null;
      db?.close();
      return false;
    }
  }

  private poll(): void {
    if (!this.open()) return;
    try {
      const version = Number(this.versionStatement!.get()!.data_version);
      if (version === this.version) return;
      this.version = version;
      const rows = this.scanStatement!.all(this.last, HISTORY_FEED_SCAN_ROWS);
      if (!rows.length) return;
      // Continue after the highest rowid scanned.
      this.last = Number(rows.at(-1)!.id);
      if (rows.length === HISTORY_FEED_SCAN_ROWS) this.version = -1; // More are waiting: read them on the next poll.
      const conversations = new Set(rows.map(row => String(row.conversation)));
      const changes = [...conversations].flatMap(conversation => { const change = historyChangeOf(conversation); return change ? [change] : []; });
      if (!changes.length) return;
      for (const listener of this.listeners) {
        try { listener(changes); } catch { /* One subscriber never stops the others. */ }
      }
    } catch {
      // A busy or replaced store: back off, then reopen; the subscribers' interval polling is the safety net.
      this.release();
      this.retryAt = Date.now() + HISTORY_FEED_RETRY_MS;
    }
  }
}

/** GET /api/events for the dashboard: Server-Sent Events, one `data:` line per committed batch of changes. */
export function streamHistoryChanges(feed: HistoryChangeFeed, req: IncomingMessage, res: ServerResponse): void {
  if (feed.streams.size >= MAX_HISTORY_EVENT_STREAMS) {
    // The client keeps its interval poll; EventSource retries later.
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", "retry-after": "5" });
    res.end(JSON.stringify({ error: "too many dashboard event streams" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", connection: "keep-alive" });
  res.flushHeaders();
  feed.streams.add(res);
  // A dropped stream reconnects after one second; the client's interval poll covers the gap.
  res.write("retry: 1000\n\n");
  const send = (text: string) => {
    // A client that stopped reading: end its stream instead of buffering; it reconnects and reads again.
    if (res.writableLength > MAX_HISTORY_EVENT_BACKLOG_BYTES) { res.end(); return; }
    res.write(text);
  };
  const unsubscribe = feed.subscribe(changes => send(`data: ${JSON.stringify(changes)}\n\n`));
  const keepAlive = setInterval(() => send(": keep-alive\n\n"), 15_000);
  keepAlive.unref();
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(keepAlive);
    feed.streams.delete(res);
    unsubscribe();
  };
  req.once("close", end);
  res.once("close", end);
  res.once("finish", end);
}
