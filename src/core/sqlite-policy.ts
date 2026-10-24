import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { admissionSqliteBusy, storageAdmissionRemaining } from "./storage-admission.js";

export const SQLITE_BUSY_TIMEOUT_MS = 3_000;
export const SQLITE_REQUEST_BUSY_MS = 10;

/** Only bridge-owned writable databases change journal mode; external transcripts stay read-only. */
export function configureSqlite(db: DatabaseSync, busyTimeoutMs = SQLITE_BUSY_TIMEOUT_MS): void {
  admissionSqliteBusy(db, busyTimeoutMs, true);
  storageAdmissionRemaining(); db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  storageAdmissionRemaining(); assertSqliteAuthority(db);
}

/** Connection-local readback: another handle's FULL setting supplies no proof. */
export function assertSqliteAuthority(db: DatabaseSync): void {
  const mode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
  if (mode !== "wal" && !(mode === "memory" && db.location("main") === null) || db.prepare("PRAGMA synchronous").get()?.synchronous !== 2)
    throw new Error("Accepted authority requires verified SQLite WAL/FULL; writer not admitted");
}

export function isSqliteBusy(err: unknown): boolean {
  const value = err as { code?: unknown; errcode?: unknown; message?: unknown };
  return value?.errcode === 5 || value?.errcode === 6 ||
    /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(String(value?.code)) ||
    /\bdatabase (?:is |table is |schema is )?locked\b|\bSQLITE_BUSY\b|\bSQLITE_LOCKED\b/i.test(String(value?.message));
}

/** Retry a single atomic/idempotent storage step, yielding so peers and pings remain responsive. */
export async function retrySqlite<T>(operation: () => T, timeoutMs = 8_000, signal?: AbortSignal): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    signal?.throwIfAborted();
    try { return operation(); }
    catch (err) {
      if (!isSqliteBusy(err) || Date.now() >= deadline) throw err;
      await delay(Math.min(25 * 2 ** Math.min(attempt++, 4), Math.max(1, deadline - Date.now())), undefined, { signal });
    }
  }
}
