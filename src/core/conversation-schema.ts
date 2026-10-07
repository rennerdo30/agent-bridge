/** Additive durable storage; records are never updated or removed, even by reindex. */
export const CONVERSATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY, agent TEXT NOT NULL, session TEXT NOT NULL, parent TEXT,
 project TEXT NOT NULL DEFAULT '', job TEXT, kind TEXT NOT NULL DEFAULT 'transcript'
);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project);
CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent);
CREATE TABLE IF NOT EXISTS conversation_sources (
 id TEXT PRIMARY KEY, path TEXT NOT NULL, conversation TEXT NOT NULL, format TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0, offset INTEGER NOT NULL DEFAULT 0,
 identity TEXT NOT NULL DEFAULT '', anchor TEXT NOT NULL DEFAULT '', checked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conversation_records (
 id INTEGER PRIMARY KEY, source TEXT NOT NULL, generation INTEGER NOT NULL,
 offset INTEGER NOT NULL, conversation TEXT NOT NULL, at INTEGER NOT NULL,
 raw BLOB NOT NULL, body TEXT NOT NULL, part TEXT,
 UNIQUE(source,generation,offset)
);
CREATE INDEX IF NOT EXISTS idx_conversation_records ON conversation_records(conversation,id);
CREATE INDEX IF NOT EXISTS idx_conversation_parts ON conversation_records(part);
CREATE TRIGGER IF NOT EXISTS conversation_records_no_delete BEFORE DELETE ON conversation_records BEGIN
 SELECT RAISE(ABORT,'conversation records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS conversation_records_no_update BEFORE UPDATE ON conversation_records BEGIN
 SELECT RAISE(ABORT,'conversation records are append-only'); END;
CREATE TABLE IF NOT EXISTS conversation_parts (
 source TEXT NOT NULL, part TEXT NOT NULL, revision TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(source,part)
);
CREATE TABLE IF NOT EXISTS conversation_projects (project TEXT PRIMARY KEY, checked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS conversation_memberships (
 project TEXT NOT NULL, conversation TEXT NOT NULL, PRIMARY KEY(project,conversation)
);
CREATE TABLE IF NOT EXISTS conversation_bindings (
 session TEXT NOT NULL, agent TEXT NOT NULL, cwd TEXT NOT NULL, job TEXT,
 pending INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(session,agent)
);
CREATE TABLE IF NOT EXISTS conversation_envelopes (
 id INTEGER PRIMARY KEY, message TEXT NOT NULL, recipient TEXT NOT NULL,
 UNIQUE(message,recipient)
);
INSERT OR IGNORE INTO conversation_envelopes(message,recipient) SELECT id,recipient FROM messages;
CREATE TRIGGER IF NOT EXISTS conversation_envelope_insert AFTER INSERT ON messages BEGIN
 INSERT OR IGNORE INTO conversation_envelopes(message,recipient) VALUES(new.id,new.recipient); END;
CREATE TRIGGER IF NOT EXISTS conversation_envelope_claim AFTER UPDATE OF recipient ON messages BEGIN
 INSERT OR IGNORE INTO conversation_envelopes(message,recipient) VALUES(new.id,new.recipient); END;
`;

export const CONVERSATION_MIGRATION = `${CONVERSATION_SCHEMA}
INSERT OR IGNORE INTO conversation_bindings(session,agent,cwd)
 SELECT session_id,json_extract(identity,'$[0]'),json_extract(identity,'$[3]')
 FROM session_bindings WHERE json_valid(identity) AND json_type(identity,'$[0]')='text'
 AND json_type(identity,'$[3]')='text';
PRAGMA user_version=7;`;
