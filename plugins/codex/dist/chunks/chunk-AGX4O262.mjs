import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/sqlite-policy.ts
import { setTimeout as delay } from "node:timers/promises";
var SQLITE_BUSY_TIMEOUT_MS = 3e3;
var SQLITE_REQUEST_BUSY_MS = 10;
function configureSqlite(db, busyTimeoutMs = SQLITE_BUSY_TIMEOUT_MS) {
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA journal_mode = WAL;`);
}
function isSqliteBusy(err) {
  const value = err;
  return value?.errcode === 5 || value?.errcode === 6 || /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(String(value?.code)) || /\bdatabase (?:is |table is |schema is )?locked\b|\bSQLITE_BUSY\b|\bSQLITE_LOCKED\b/i.test(String(value?.message));
}
async function retrySqlite(operation, timeoutMs = 8e3, signal) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (; ; ) {
    signal?.throwIfAborted();
    try {
      return operation();
    } catch (err) {
      if (!isSqliteBusy(err) || Date.now() >= deadline) throw err;
      await delay(Math.min(25 * 2 ** Math.min(attempt++, 4), Math.max(1, deadline - Date.now())), void 0, { signal });
    }
  }
}

export {
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_REQUEST_BUSY_MS,
  configureSqlite,
  isSqliteBusy,
  retrySqlite
};
