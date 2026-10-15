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
export const HISTORY_FEED_POLL_MS = 20;
/** While history.db is missing or not readable yet. */
const HISTORY_FEED_RETRY_MS = 1_000;
const MAX_CHANGES_PER_BATCH = 256;
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

export class HistoryChangeFeed {
  private readonly listeners = new Set<(changes: HistoryChange[]) => void>();
  private db: DatabaseSync | null = null;
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
      if (!this.listeners.size) this.close();
    };
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
      this.version = Number(db.prepare("PRAGMA data_version").get()!.data_version);
      this.db = db;
      return true;
    } catch { db?.close(); return false; }
  }

  private poll(): void {
    if (!this.open()) return;
    try {
      const version = Number(this.db!.prepare("PRAGMA data_version").get()!.data_version);
      if (version === this.version) return;
      this.version = version;
      const rows = this.db!.prepare("SELECT conversation,max(id) AS id FROM conversation_records WHERE id>? GROUP BY conversation ORDER BY id LIMIT ?")
        .all(this.last, MAX_CHANGES_PER_BATCH);
      if (!rows.length) return;
      this.last = Math.max(this.last, ...rows.map(row => Number(row.id)));
      const changes = rows.flatMap(row => { const change = historyChangeOf(String(row.conversation)); return change ? [change] : []; });
      if (rows.length === MAX_CHANGES_PER_BATCH) this.version = -1; // More are waiting: read them on the next poll.
      if (!changes.length) return;
      for (const listener of this.listeners) {
        try { listener(changes); } catch { /* One subscriber never stops the others. */ }
      }
    } catch {
      // A busy or replaced store: reopen on the next poll; subscribers' polling remains the safety net.
      this.db?.close(); this.db = null; this.retryAt = 0;
    }
  }
}

/** GET /api/events for the dashboard: Server-Sent Events, one `data:` line per committed batch of changes. */
export function streamHistoryChanges(feed: HistoryChangeFeed, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", connection: "keep-alive" });
  res.flushHeaders();
  // A dropped stream reconnects after one second; the client's interval poll covers the gap.
  res.write("retry: 1000\n\n");
  const unsubscribe = feed.subscribe(changes => { res.write(`data: ${JSON.stringify(changes)}\n\n`); });
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  keepAlive.unref();
  const end = () => { clearInterval(keepAlive); unsubscribe(); };
  req.once("close", end);
  res.once("close", end);
}
