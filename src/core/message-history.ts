import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ARCHIVE_DB_NAME } from "./sqlite-maintenance.js";

export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_HISTORY_LIMIT = 1_000;
export interface MessageHistoryRow {
  id: string; from_name: string; from_agent: string; to_target: string; recipients: string;
  body: string; created_at: number; hop: number; reply_to: string | null;
}

/** Read primary, legacy archive and cold database together, including archived conversation replies. */
export function searchMessages(file: string, opts: { query?: string; before?: number; limit?: number } = {}): MessageHistoryRow[] {
  const limit = Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_HISTORY_LIMIT)));
  const query = `%${(opts.query ?? "").replace(/[\\%_]/g, "\\$&")}%`;
  const rows: MessageHistoryRow[] = [];
  for (const path of [file, join(dirname(file), ARCHIVE_DB_NAME)]) {
    if (!existsSync(path)) continue;
    const db = new DatabaseSync(path, { readOnly: true, timeout: 50 });
    try {
      for (const table of ["messages", "archived_messages"]) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        rows.push(...db.prepare(`SELECT id, from_name, from_agent, to_target, group_concat(recipient, ', ') AS recipients, body, created_at, hop, reply_to
          FROM ${table} WHERE conversation_id NOT LIKE 'jobctl-%' AND body LIKE ? ESCAPE '\\' AND created_at < ?
          GROUP BY id ORDER BY created_at DESC, id DESC LIMIT ?`).all(query, opts.before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as MessageHistoryRow[]);
      }
    } finally { db.close(); }
  }
  const merged = new Map<string, MessageHistoryRow>();
  for (const row of rows) {
    const existing = merged.get(row.id);
    if (existing) existing.recipients = [...new Set([...existing.recipients.split(", "), ...row.recipients.split(", ")])].join(", ");
    else merged.set(row.id, row);
  }
  return [...merged.values()].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id)).slice(0, limit);
}
