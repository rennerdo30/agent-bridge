-- Synthetic schema captured from v0.29.10, commit 32614b6. No owner data.
CREATE TABLE messages (
  id              TEXT    NOT NULL,
  recipient       TEXT    NOT NULL,
  from_id         TEXT    NOT NULL,
  from_name       TEXT    NOT NULL,
  from_agent      TEXT    NOT NULL,
  to_target       TEXT    NOT NULL,
  conversation_id TEXT    NOT NULL,
  reply_to        TEXT,
  hop             INTEGER NOT NULL,
  body            TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  read_at         INTEGER,
  PRIMARY KEY (id, recipient)
);

CREATE TABLE archived_messages(
  id TEXT,
  recipient TEXT,
  from_id TEXT,
  from_name TEXT,
  from_agent TEXT,
  to_target TEXT,
  conversation_id TEXT,
  reply_to TEXT,
  hop INT,
  body TEXT,
  created_at INT,
  read_at INT,
  archive_reason,
  archived_at
);

CREATE TABLE decisions (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  body TEXT NOT NULL,
  scope TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_agent TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source_message_id TEXT,
  supersedes TEXT
);

CREATE TABLE decision_deliveries (
  decision_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (decision_id, session_key)
);

CREATE TABLE history_documents (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL,
  body TEXT NOT NULL, folded TEXT NOT NULL, link TEXT NOT NULL,
  message TEXT, job TEXT, run TEXT, session TEXT, cursor TEXT
);

CREATE TABLE history_cursors (source TEXT PRIMARY KEY, cursor TEXT NOT NULL);

CREATE TABLE history_files (path TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT NOT NULL, session TEXT, cwd TEXT NOT NULL, child TEXT, checked INTEGER NOT NULL DEFAULT 0);

CREATE TABLE history_tags (id TEXT NOT NULL, type TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,type,value));

CREATE TABLE history_sessions (alias TEXT PRIMARY KEY, session TEXT NOT NULL, job TEXT);

CREATE TABLE history_pending (id TEXT NOT NULL, body TEXT NOT NULL, from_agent TEXT NOT NULL, from_name TEXT NOT NULL, from_id TEXT NOT NULL, recipient TEXT NOT NULL, to_target TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(id,recipient));

CREATE VIRTUAL TABLE history_fts USING fts5(body, content='history_documents', content_rowid='rowid', tokenize='unicode61');

CREATE TABLE session_bindings (
      identity TEXT NOT NULL,
      session_id TEXT NOT NULL,
      learned_at INTEGER NOT NULL,
      PRIMARY KEY (identity, session_id)
    );

CREATE TABLE peer_names (
      identity TEXT NOT NULL, name TEXT NOT NULL, session_id TEXT, agent TEXT NOT NULL,
      learned_at INTEGER NOT NULL, PRIMARY KEY (identity, name)
    );

CREATE TABLE peer_name_owners (
      name TEXT PRIMARY KEY, identity TEXT NOT NULL
    );

CREATE INDEX idx_messages_unread ON messages (recipient, read_at, created_at);

CREATE INDEX idx_messages_id ON messages (id);

CREATE INDEX idx_decisions_topic ON decisions (topic, revision);

CREATE INDEX idx_decisions_supersedes ON decisions (supersedes);

CREATE INDEX idx_history_time ON history_documents(at);

CREATE INDEX idx_history_session ON history_documents(session);

CREATE INDEX idx_history_job ON history_documents(job);

CREATE INDEX idx_history_tags ON history_tags(type,value,id);

CREATE INDEX idx_history_sessions ON history_sessions(session,job);

CREATE TRIGGER history_message_insert AFTER INSERT ON messages BEGIN
  INSERT OR REPLACE INTO history_pending VALUES (new.id, new.body, new.from_agent, new.from_name, new.from_id, new.recipient, new.to_target, new.created_at);
END;

CREATE TRIGGER history_message_claim AFTER UPDATE OF recipient ON messages BEGIN
  INSERT OR REPLACE INTO history_pending VALUES (new.id, new.body, new.from_agent, new.from_name, new.from_id, new.recipient, new.to_target, new.created_at);
END;

CREATE TRIGGER history_insert AFTER INSERT ON history_documents BEGIN
  INSERT INTO history_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER history_delete AFTER DELETE ON history_documents BEGIN
  INSERT INTO history_fts(history_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;

CREATE TRIGGER history_update AFTER UPDATE ON history_documents BEGIN
  INSERT INTO history_fts(history_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO history_fts(rowid, body) VALUES (new.rowid, new.body);
END;
PRAGMA user_version = 6;
