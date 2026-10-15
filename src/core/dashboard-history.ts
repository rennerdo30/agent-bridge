import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { withByteSources } from "./byte-source.js";
import { DB_FILE_NAME } from "./constants.js";
import { HistorySourceResolver } from "./history-sources.js";
import { historyDbPath, historyReady, historyV1Readable, openHistoryReader } from "./history-store.js";

const READ_TIMEOUT_MS = 100;

/** A read-only history.db connection for one dashboard request, or null while the store cannot serve reads. */
function openStore(home: string): DatabaseSync | null {
  const path = historyDbPath(join(home, DB_FILE_NAME));
  if (!existsSync(path)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = openHistoryReader(path, READ_TIMEOUT_MS);
    if ((historyReady(db) || historyV1Readable(db)) && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_sources'").get()
      && db.prepare("SELECT 1 FROM pragma_table_info('conversation_sources') WHERE name='identity'").get()) return db;
  } catch { /* A busy or unreadable store: the files answer. */ }
  db?.close();
  return null;
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
export function readWithHistory<T>(home: string, read: () => T): HistoryRead<T> {
  const reader = historyReader(home);
  try { return reader.read(read); } finally { reader.close(); }
}

/** One history.db connection for several reads (a run listing), opened on first use. Each read gets its own resolver. */
export function historyReader(home: string): { read<T>(read: () => T): HistoryRead<T>; close(): void } {
  let db: DatabaseSync | null | undefined;
  return {
    read<T>(read: () => T): HistoryRead<T> {
      if (db === undefined) db = openStore(home);
      if (!db) return { value: read(), importing: true };
      try {
        const resolver = new HistorySourceResolver(db);
        const value = withByteSources(resolver, read);
        return { value, importing: resolver.fellBack };
      } catch {
        return { value: read(), importing: true };
      }
    },
    close(): void { db?.close(); db = null; },
  };
}

/** The dashboard response with the importing flag added only when it applies, so existing shapes stay unchanged. */
export function withImporting<T extends object>(body: T, importing: boolean): T & { importing?: true } {
  return importing ? { ...body, importing: true as const } : body;
}
