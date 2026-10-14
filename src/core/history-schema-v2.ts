import { supportsHistoryFts } from "./history-schema.js";

/** Viewer convenience view. body NULL (migration) and body '' (live writer) both resolve through ab_body(). */
export const CONVERSATION_RECORDS_VIEW = `CREATE VIEW v_conversation_records AS SELECT id, source, generation, offset, conversation, at, part,
 ab_text(raw, raw_codec) AS raw_text, ab_body(body, raw, raw_codec) AS body_text, length(raw) AS stored_bytes, raw_codec FROM conversation_records;`;

/** History store v2: the v1 tables, with large text stored once and compressed.
 * - conversation_records.raw holds encoded bytes (raw_codec); body NULL means "the raw bytes as UTF-8".
 * - history_documents.body holds encoded text (body_codec); folded NULL means "folded(body)".
 * - FTS5 reads decoded text through history_documents_text, so every connection that writes documents
 *   or asks FTS for snippets registers ab_text() (history-codec.ts).
 * Rows are never updated or removed by the store itself; the append-only guards stay. */
export function historyStoreV2Schema(fts = supportsHistoryFts()): string {
  return `
CREATE TABLE history_documents (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL,
  body NOT NULL, body_codec INTEGER NOT NULL DEFAULT 0, folded TEXT, link TEXT NOT NULL,
  message TEXT, job TEXT, run TEXT, session TEXT, cursor TEXT
);
CREATE INDEX idx_history_time ON history_documents(at);
CREATE INDEX idx_history_session ON history_documents(session);
CREATE INDEX idx_history_job ON history_documents(job);
CREATE VIEW history_documents_text AS SELECT rowid AS doc_rowid, ab_text(body, body_codec) AS body FROM history_documents;
CREATE TABLE history_cursors (source TEXT PRIMARY KEY, cursor TEXT NOT NULL);
CREATE TABLE history_files (path TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT NOT NULL, session TEXT, cwd TEXT NOT NULL, child TEXT, checked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE history_tags (id TEXT NOT NULL, type TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,type,value));
CREATE INDEX idx_history_tags ON history_tags(type,value,id);
CREATE TABLE history_sessions (alias TEXT PRIMARY KEY, session TEXT NOT NULL, job TEXT);
CREATE INDEX idx_history_sessions ON history_sessions(session,job);
CREATE TABLE history_pending (id TEXT NOT NULL, body TEXT NOT NULL, from_agent TEXT NOT NULL, from_name TEXT NOT NULL, from_id TEXT NOT NULL, recipient TEXT NOT NULL, to_target TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(id,recipient));
${fts ? `CREATE VIRTUAL TABLE history_fts USING fts5(body, content='history_documents_text', content_rowid='doc_rowid', tokenize='unicode61');
CREATE TRIGGER history_insert AFTER INSERT ON history_documents BEGIN
  INSERT INTO history_fts(rowid, body) VALUES (new.rowid, ab_text(new.body, new.body_codec));
END;
CREATE TRIGGER history_delete AFTER DELETE ON history_documents BEGIN
  INSERT INTO history_fts(history_fts, rowid, body) VALUES ('delete', old.rowid, ab_text(old.body, old.body_codec));
END;
CREATE TRIGGER history_update AFTER UPDATE ON history_documents BEGIN
  INSERT INTO history_fts(history_fts, rowid, body) VALUES ('delete', old.rowid, ab_text(old.body, old.body_codec));
  INSERT INTO history_fts(rowid, body) VALUES (new.rowid, ab_text(new.body, new.body_codec));
END;` : ""}
CREATE TABLE conversations (
 id TEXT PRIMARY KEY, agent TEXT NOT NULL, session TEXT NOT NULL, parent TEXT,
 project TEXT NOT NULL DEFAULT '', job TEXT, kind TEXT NOT NULL DEFAULT 'transcript'
);
CREATE INDEX idx_conversations_project ON conversations(project);
CREATE INDEX idx_conversations_parent ON conversations(parent);
CREATE TABLE conversation_sources (
 id TEXT PRIMARY KEY, path TEXT NOT NULL, conversation TEXT NOT NULL, format TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0, offset INTEGER NOT NULL DEFAULT 0,
 identity TEXT NOT NULL DEFAULT '', anchor TEXT NOT NULL DEFAULT '', checked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE conversation_records (
 id INTEGER PRIMARY KEY, source TEXT NOT NULL, generation INTEGER NOT NULL,
 offset INTEGER NOT NULL, conversation TEXT NOT NULL, at INTEGER NOT NULL,
 raw BLOB NOT NULL, raw_codec INTEGER NOT NULL DEFAULT 0, body TEXT, part TEXT,
 UNIQUE(source,generation,offset)
);
CREATE INDEX idx_conversation_records ON conversation_records(conversation,id);
CREATE INDEX idx_conversation_parts ON conversation_records(part);
CREATE TRIGGER conversation_records_no_delete BEFORE DELETE ON conversation_records BEGIN
 SELECT RAISE(ABORT,'conversation records are append-only'); END;
CREATE TRIGGER conversation_records_no_update BEFORE UPDATE ON conversation_records BEGIN
 SELECT RAISE(ABORT,'conversation records are append-only'); END;
CREATE TABLE conversation_parts (
 source TEXT NOT NULL, part TEXT NOT NULL, revision TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(source,part)
);
CREATE TABLE conversation_projects (project TEXT PRIMARY KEY, checked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE conversation_memberships (project TEXT NOT NULL, conversation TEXT NOT NULL, PRIMARY KEY(project,conversation));
CREATE TABLE conversation_bindings (
 session TEXT NOT NULL, agent TEXT NOT NULL, cwd TEXT NOT NULL, job TEXT,
 pending INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(session,agent)
);
CREATE TABLE conversation_envelopes (id INTEGER PRIMARY KEY, message TEXT NOT NULL, recipient TEXT NOT NULL, UNIQUE(message,recipient));
${CONVERSATION_RECORDS_VIEW}
CREATE VIEW v_history_documents AS SELECT id, kind, agent, at, ab_text(body, body_codec) AS body_text, link, message, job, run, session, length(body) AS stored_bytes, body_codec FROM history_documents;
CREATE TABLE history_migration(version INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, status TEXT NOT NULL, manifest TEXT, source TEXT);
CREATE TABLE history_copy_state(table_name TEXT PRIMARY KEY, source_rows INTEGER NOT NULL, after_rowid INTEGER, copied_rows INTEGER NOT NULL DEFAULT 0,
 copy_sha256 TEXT NOT NULL DEFAULT '', verify_after INTEGER, verified_rows INTEGER NOT NULL DEFAULT 0, verify_sha256 TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0);
CREATE TABLE history_legacy_tail(source_id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL);
`;
}

/** Tables copied from the legacy store (bridge.db v9 or history.db v1) into v2, in order. */
export const HISTORY_V2_COPY_TABLES = ["conversations", "conversation_sources", "conversation_parts", "conversation_projects", "conversation_memberships", "conversation_bindings", "conversation_envelopes", "history_cursors", "history_files", "history_tags", "history_sessions", "history_pending", "conversation_records", "history_documents"] as const;
