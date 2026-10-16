import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { withByteSources, type ByteSourceResolver } from "./byte-source.js";
import { DB_FILE_NAME } from "./constants.js";
import { HistorySourceResolver } from "./history-sources.js";
import { historyDbPath, historyReady, historyV1Readable, openHistoryReader } from "./history-store.js";

const READ_TIMEOUT_MS = 100;

/** Whether this connection's store can serve dashboard reads now (checked on every request). */
function servesReads(db: DatabaseSync): boolean {
  return (historyReady(db) || historyV1Readable(db)) && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_sources'").get()
    && !!db.prepare("SELECT 1 FROM pragma_table_info('conversation_sources') WHERE name='identity'").get();
}

/** A read-only history.db connection for one dashboard request, or null while the store cannot serve reads. */
function openStore(home: string): DatabaseSync | null {
  const path = historyDbPath(join(home, DB_FILE_NAME));
  if (!existsSync(path)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = openHistoryReader(path, READ_TIMEOUT_MS);
    if (servesReads(db)) return db;
  } catch { /* A busy or unreadable store: the files answer. */ }
  db?.close();
  return null;
}

/**
 * AB-397: a read-only history.db connection someone else already holds open on this thread (the dashboard's
 * HistoryChangeFeed while an event stream is open), or null. Opening and closing a connection per request
 * (three file handles, the shared-memory map and the schema) is the stage that stalls for hundreds of ms on a
 * loaded host, right on the path from a pushed event to its read; a held connection answers in about a millisecond.
 * The holder owns its lifetime: a read borrows it and never closes it.
 */
export type HeldHistoryConnection = () => DatabaseSync | null;

function borrow(held: HeldHistoryConnection | undefined): DatabaseSync | null {
  try {
    const db = held?.() ?? null;
    return db && servesReads(db) ? db : null;
  } catch { return null; /* Busy or released: open a connection for this request as before. */ }
}

/**
 * Without a usable store every existing source is read from its file, so the answer is importing exactly when the
 * reader asked for a file that exists. A request that touches no existing file (a job whose transcript is gone) has
 * nothing to import, matching HistorySourceResolver, which does not flag a missing file either. The check runs only
 * when a caller reads the flag, so a run listing that ignores it costs no extra file-system call per log.
 */
function readFiles<T>(read: () => T): HistoryRead<T> {
  const requested = new Set<string>();
  const files: ByteSourceResolver = { open(file) { requested.add(file); return null; } };
  const value = withByteSources(files, read);
  let importing: boolean | undefined;
  return { value, get importing() { return importing ??= [...requested].some((file) => existsSync(file)); } };
}

export interface HistoryRead<T> {
  value: T;
  /** Some requested source is not in the history store yet; its answer came from the file. */
  importing: boolean;
}

/**
 * AB-383: run a synchronous transcript/run-log reader against retained copies in history.db.
 * Fully ingested sources are served from the store without reading the file; anything else is read from
 * the file as before and reported as importing. Results equal the file read either way.
 */
export function readWithHistory<T>(home: string, read: () => T, held?: HeldHistoryConnection): HistoryRead<T> {
  const reader = historyReader(home, held);
  try { return reader.read(read); } finally { reader.close(); }
}

/** One history.db connection for several reads (a run listing), borrowed or opened on first use. Each read gets its own resolver. */
export function historyReader(home: string, held?: HeldHistoryConnection): { read<T>(read: () => T): HistoryRead<T>; close(): void } {
  let db: DatabaseSync | null | undefined, borrowed = false;
  return {
    read<T>(read: () => T): HistoryRead<T> {
      if (db === undefined) {
        db = borrow(held);
        borrowed = db !== null;
        if (!borrowed) db = openStore(home);
      }
      if (!db) return readFiles(read);
      try {
        const resolver = new HistorySourceResolver(db);
        const value = withByteSources(resolver, read);
        return { value, importing: resolver.fellBack };
      } catch {
        return readFiles(read);
      }
    },
    close(): void { if (!borrowed) db?.close(); db = null; },
  };
}

/** The dashboard response with the importing flag added only when it applies, so existing shapes stay unchanged. */
export function withImporting<T extends object>(body: T, importing: boolean): T & { importing?: true } {
  return importing ? { ...body, importing: true as const } : body;
}
