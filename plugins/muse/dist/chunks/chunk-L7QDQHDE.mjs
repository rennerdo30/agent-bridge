import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  CLAUDE_CHILD_FACTS_TABLE,
  antigravityItems,
  museItems,
  refreshClaudeChildFacts
} from "./chunk-EFJUYY5Q.mjs";
import {
  HISTORY_BATCH_MS,
  decodeHistoryRow,
  historyReadStatus,
  historySchema,
  openHistoryReader
} from "./chunk-LBNMQXNB.mjs";
import {
  conversationPageSchema
} from "./chunk-OVUI7CCQ.mjs";
import {
  observeAskToolRecord,
  readArchivedJobSnapshot
} from "./chunk-HSYLC53O.mjs";
import {
  canonicalProjectRoot,
  gitSafetyArgs,
  isPluginCacheCwd,
  physicalPath,
  projectKey
} from "./chunk-VUZ3I7UH.mjs";
import {
  localT3HistoryRoot,
  object,
  parse,
  safeFile,
  time
} from "./chunk-UEE6Z4PJ.mjs";
import {
  CONVERSATION_BYTES,
  decodeBytes,
  encodeBytes,
  encodeText,
  fileSignature,
  indexedConversationText,
  jobArchivePath,
  migrateSqlite,
  nullLogger,
  readJsonSnapshot,
  registerHistoryFunctions
} from "./chunk-6QSR4FTZ.mjs";
import {
  assertUnlinked
} from "./chunk-YEN6TM2D.mjs";
import {
  DEFAULT_HOME
} from "./chunk-FJ2TGOLZ.mjs";

// src/core/conversations.ts
import { createHash as createHash3 } from "node:crypto";
import {
  closeSync as closeSync2,
  existsSync as existsSync2,
  fstatSync as fstatSync2,
  openSync as openSync2,
  readSync as readSync2,
  statSync as statSync3,
  watch
} from "node:fs";
import { basename, join as join3 } from "node:path";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";

// src/core/project-store.ts
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// src/core/conversation-schema.ts
var CONVERSATION_SCHEMA = `
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
var CONVERSATION_MIGRATION = `${CONVERSATION_SCHEMA}
INSERT OR IGNORE INTO conversation_bindings(session,agent,cwd)
 SELECT session_id,json_extract(identity,'$[0]'),json_extract(identity,'$[3]')
 FROM session_bindings WHERE json_valid(identity) AND json_type(identity,'$[0]')='text'
 AND json_type(identity,'$[3]')='text';
PRAGMA user_version=8;`;

// src/core/project-store.ts
var roots = /* @__PURE__ */ new Map();
var excluded = /* @__PURE__ */ new Map();
function linkedParent(file) {
  try {
    assertUnlinked(dirname(resolve(file)));
    return false;
  } catch {
    return true;
  }
}
function conversationProject(cwd) {
  if (!cwd || isPluginCacheCwd(cwd)) return "";
  try {
    if (isPluginCacheCwd(realpathSync.native(cwd))) return "";
  } catch {
  }
  const known = roots.get(cwd);
  if (known !== void 0) return known;
  const canonical = canonicalProjectRoot(cwd);
  const root = canonical ? projectKey(canonical) : existsSync(cwd) ? "" : projectKey(resolve(cwd));
  if (roots.size >= 256) roots.delete(roots.keys().next().value);
  roots.set(cwd, root);
  return root;
}
function ensureProjectFolder(project) {
  if (!project || !existsSync(project)) return null;
  const folder = join(project, ".agent-bridge");
  if (existsSync(folder) && (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()))
    return null;
  const fresh = !existsSync(folder);
  mkdirSync(folder, { recursive: true, mode: 448 });
  const gitMarker = existsSync(join(project, ".git"));
  if (!fresh && excluded.get(project) === gitMarker) return folder;
  try {
    const exclude = execFileSync(
      "git",
      [
        ...gitSafetyArgs(),
        "-C",
        project,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "info/exclude"
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2e3
      }
    ).trim();
    if (linkedParent(exclude) || existsSync(exclude) && lstatSync(exclude).isSymbolicLink())
      return null;
    const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!text.split(/\r?\n/).includes("/.agent-bridge/")) {
      mkdirSync(dirname(exclude), { recursive: true });
      appendFileSync(
        exclude,
        `${text && !text.endsWith("\n") ? "\n" : ""}/.agent-bridge/
`
      );
    }
  } catch {
    if (existsSync(join(project, ".git"))) return null;
  }
  excluded.set(project, gitMarker);
  return folder;
}
function projectDatabasePath(project, home) {
  const id2 = createHash("sha256").update(project).digest("hex").slice(0, 16);
  return join(home && !ownsProjectMirrors(home) ? join(home, "project-mirrors") : join(project, ".agent-bridge"), `conversations-${id2}.db`);
}
var mirrorOwnership = /* @__PURE__ */ new Map();
function ownsProjectMirrors(home) {
  const cached = mirrorOwnership.get(home);
  if (cached !== void 0) return cached;
  let resolved = true;
  const physical = (path) => {
    try {
      return realpathSync.native(path);
    } catch {
      resolved = false;
      return resolve(path);
    }
  };
  const owns = projectKey(physical(home)) === projectKey(physical(DEFAULT_HOME));
  if (resolved) {
    if (mirrorOwnership.size >= 64) mirrorOwnership.clear();
    mirrorOwnership.set(home, owns);
  }
  return owns;
}
var MIRROR_RECYCLE_MS = 5 * 6e4;
var idleMirrors = /* @__PURE__ */ new Map();
var mirrorFiles = (path) => [path, `${path}-wal`].map((file) => {
  try {
    return fileSignature(statSync(file, { bigint: true }));
  } catch {
    return "missing";
  }
}).join("|");
var NEWER_PRIMARY = "SELECT 1 FROM conversation_records r JOIN conversations c ON c.id=r.conversation WHERE c.project=? AND r.id>? LIMIT 1";
var NEWER_ASSOCIATED = "SELECT 1 FROM conversation_memberships m JOIN conversation_records r ON r.conversation=m.conversation WHERE m.project=? AND r.id>? LIMIT 1";
function mirrorIdle(main, key) {
  const idle = idleMirrors.get(key);
  if (!idle) return false;
  const stale = Date.now() - idle.since >= MIRROR_RECYCLE_MS || mirrorFiles(idle.path) !== idle.signature || main.prepare(NEWER_PRIMARY).get(idle.project, idle.newest) !== void 0 || main.prepare(NEWER_ASSOCIATED).get(idle.project, idle.newest) !== void 0;
  if (stale) idleMirrors.delete(key);
  return !stale;
}
function syncProjectMirror(main, project, home) {
  const key = JSON.stringify([home, project]);
  if (mirrorIdle(main, key)) return 0;
  const path = projectDatabasePath(project, home);
  let folder;
  if (ownsProjectMirrors(home)) folder = ensureProjectFolder(project);
  else {
    assertUnlinked(home);
    assertUnlinked(dirname(path));
    mkdirSync(dirname(path), { recursive: true, mode: 448 });
    folder = dirname(path);
  }
  if (!folder) return 0;
  const archive = join(folder, "archive");
  if (linkedParent(path) || existsSync(archive) && lstatSync(archive).isSymbolicLink() || linkedParent(join(archive, "backup")))
    return 0;
  for (const file of [path, `${path}-wal`, `${path}-shm`])
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) return 0;
  const existed = existsSync(path), mirror = new DatabaseSync(path, { timeout: 50 });
  let idle = false;
  try {
    migrateSqlite(
      mirror,
      path,
      existed,
      1,
      [
        {
          version: 1,
          sql: `CREATE TABLE messages (id TEXT, body TEXT, from_agent TEXT, from_name TEXT, from_id TEXT, recipient TEXT, to_target TEXT, created_at INTEGER); ${historySchema()} ${CONVERSATION_SCHEMA} CREATE TABLE mirror_cursor (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL); INSERT INTO mirror_cursor VALUES(1,0); PRAGMA user_version=1;`
        }
      ],
      nullLogger
    );
    mirror.exec("PRAGMA journal_mode=WAL;");
    const after = Number(
      mirror.prepare("SELECT value FROM mirror_cursor WHERE id=1").get().value
    );
    const primary = main.prepare(
      `SELECT r.id,r.conversation FROM conversation_records r JOIN conversations c ON c.id=r.conversation WHERE c.project=? AND r.id>? ORDER BY r.id LIMIT 32`
    ).all(project, after);
    const associated = main.prepare(
      "SELECT r.id,r.conversation FROM conversation_memberships m JOIN conversation_records r ON r.conversation=m.conversation WHERE m.project=? AND r.id>? ORDER BY r.id LIMIT 32"
    ).all(project, after);
    const candidates = [
      ...new Map(
        [...primary, ...associated].map((row) => [Number(row.id), row])
      ).values()
    ].sort((a, b) => Number(a.id) - Number(b.id)).slice(0, 32);
    let copied = 0, last = after;
    mirror.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of candidates) {
        const conversation = main.prepare("SELECT * FROM conversations WHERE id=?").get(candidate.conversation);
        const previous = mirror.prepare("SELECT * FROM conversations WHERE id=?").get(candidate.conversation);
        if (!previous || previous.parent !== conversation.parent || previous.session !== conversation.session || previous.agent !== conversation.agent || previous.kind !== conversation.kind || previous.project !== conversation.project || previous.job !== conversation.job) {
          mirror.prepare(
            `INSERT INTO conversations VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent=excluded.parent,project=excluded.project,job=excluded.job,session=excluded.session,agent=excluded.agent,kind=excluded.kind`
          ).run(
            conversation.id,
            conversation.agent,
            conversation.session,
            conversation.parent,
            conversation.project,
            conversation.job,
            conversation.kind
          );
        }
        const documentId = `durable:${candidate.id}`;
        mirror.prepare("INSERT OR IGNORE INTO history_tags VALUES(?,?,?)").run(documentId, "project", project);
        for (const tag of main.prepare(
          "SELECT type,value FROM history_tags WHERE id=? AND type IN ('session','job')"
        ).all(documentId))
          mirror.prepare("INSERT OR IGNORE INTO history_tags VALUES(?,?,?)").run(documentId, tag.type, tag.value);
        const docMeta = main.prepare("SELECT session FROM history_documents WHERE id=?").get(documentId);
        const alias = docMeta?.session ? main.prepare("SELECT * FROM history_sessions WHERE alias=?").get(docMeta.session) : null;
        if (alias)
          mirror.prepare(
            "INSERT INTO history_sessions VALUES(?,?,?) ON CONFLICT(alias) DO UPDATE SET session=excluded.session,job=excluded.job WHERE history_sessions.session IS NOT excluded.session OR history_sessions.job IS NOT excluded.job"
          ).run(alias.alias, alias.session, alias.job);
        if (mirror.prepare("SELECT id FROM conversation_records WHERE id=?").get(candidate.id)) {
          last = Number(candidate.id);
          continue;
        }
        if (copied >= 8) break;
        const row = decodeHistoryRow("conversation_records", main.prepare("SELECT * FROM conversation_records WHERE id=?").get(candidate.id));
        mirror.prepare(
          "INSERT OR IGNORE INTO conversation_records VALUES(?,?,?,?,?,?,?,?,?)"
        ).run(
          row.id,
          row.source,
          row.generation,
          row.offset,
          row.conversation,
          row.at,
          row.raw,
          row.body,
          row.part
        );
        const stored = main.prepare("SELECT * FROM history_documents WHERE id=?").get(`durable:${row.id}`);
        const doc = stored ? decodeHistoryRow("history_documents", stored) : void 0;
        if (doc) {
          mirror.prepare(
            "INSERT OR IGNORE INTO history_documents(id,kind,agent,at,body,folded,link,message,job,run,session,cursor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
          ).run(
            doc.id,
            doc.kind,
            doc.agent,
            doc.at,
            doc.body,
            doc.folded,
            doc.link,
            doc.message,
            doc.job,
            doc.run,
            doc.session,
            doc.cursor
          );
        }
        copied++;
        last = Number(row.id);
      }
      mirror.prepare("UPDATE mirror_cursor SET value=? WHERE id=1").run(candidates.length ? last : 0);
      mirror.exec("COMMIT");
    } catch (err) {
      mirror.exec("ROLLBACK");
      throw err;
    }
    idle = !candidates.length && !copied;
    return copied;
  } finally {
    mirror.close();
    if (idle) {
      const newest = Number(main.prepare("SELECT coalesce(max(id),0) AS n FROM conversation_records").get().n);
      idleMirrors.set(key, { path, project, signature: mirrorFiles(path), newest, since: Date.now() });
    }
  }
}

// src/core/savepoint.ts
function cleanupSavepoint(db, name, rollback, original) {
  try {
    db.exec(`${rollback ? `ROLLBACK TO ${name}; ` : ""}RELEASE ${name}`);
  } catch {
  }
  throw original;
}

// src/core/t3-history.ts
import { createHash as createHash2 } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync as realpathSync2, statSync as statSync2 } from "node:fs";
import { isAbsolute, join as join2, resolve as resolve2 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var digest = (value) => createHash2("sha256").update(value).digest("hex");
function conversationKey(environment, thread) {
  const readable = `t3:${environment}:${thread}`;
  return readable.length <= 256 ? readable : `t3:${digest(JSON.stringify([environment, thread]))}`;
}
var id = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
var REFRESH_MS = 6e4;
var WINDOW = 32;
var STEPS = 8;
var MAX_MESSAGE_BYTES = 1024 * 1024;
var columns = {
  projection_projects: { project_id: "TEXT", title: "TEXT", workspace_root: "TEXT" },
  orchestration_v2_projection_threads: { thread_id: "TEXT", project_id: "TEXT", title: "TEXT", created_at: "TEXT", updated_at: "TEXT", archived_at: "TEXT", deleted_at: "TEXT", payload_json: "TEXT" },
  orchestration_events: { sequence: "INTEGER", event_id: "TEXT", aggregate_kind: "TEXT", stream_id: "TEXT", event_type: "TEXT", occurred_at: "TEXT", application_event_version: "INTEGER", payload_json: "TEXT" }
};
var SourceFault = class extends Error {
};
function query(input, sql, ...args) {
  try {
    return input.prepare(sql).all(...args);
  } catch {
    throw new SourceFault("source busy or unreadable");
  }
}
function fileIdentity(file) {
  const s = statSync2(file, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
function environmentId(root) {
  const fd = openSync(join2(root, "userdata", "environment-id"), "r");
  try {
    const size = fstatSync(fd).size;
    if (size < 1 || size > 512) throw new SourceFault("unsupported environment identity");
    const raw = Buffer.alloc(size);
    if (readSync(fd, raw, 0, size, 0) !== size) throw new SourceFault("incomplete environment identity");
    const value = raw.toString("utf8").trim();
    if (!id(value)) throw new SourceFault("unsupported environment identity");
    return value;
  } finally {
    closeSync(fd);
  }
}
var T3History = class {
  constructor(root, db, sink, messages = false) {
    this.root = root;
    this.db = db;
    this.sink = sink;
    this.messages = messages;
    const physical = (p) => {
      try {
        return physicalPath(p);
      } catch {
        return p;
      }
    };
    const path = root && isAbsolute(root) ? physical(resolve2(root)) : root ?? "disabled";
    this.key = `durable-t3:${digest(process.platform === "win32" ? path.toLowerCase() : path)}`;
    this.sink = {
      cursor: (key) => sink.cursor(key),
      advance: (key, value) => {
        if (key !== `${this.key}:status`) this.verifySource?.();
        sink.advance(key, value);
      },
      put: (...args) => {
        this.verifySource?.();
        sink.put(...args);
      }
    };
    this.discovering = root !== void 0;
    this.codec = db.prepare("SELECT 1 FROM pragma_table_info('conversation_records') WHERE name='raw_codec'").get() ? "raw_codec" : "0 AS raw_codec";
  }
  root;
  db;
  sink;
  messages;
  discovering;
  key;
  codec;
  verifySource;
  status(state, reason) {
    this.sink.advance(`${this.key}:status`, JSON.stringify({ state, reason }));
  }
  save(state) {
    this.sink.advance(this.key, JSON.stringify(state));
  }
  conversation(environment, thread) {
    this.verifySource?.();
    const name = conversationKey(environment, thread);
    this.db.prepare("INSERT OR IGNORE INTO conversations(id,agent,session) VALUES(?,'other',?)").run(name, name);
    return name;
  }
  schema(input) {
    for (const [table, required] of Object.entries(columns)) {
      const info = query(input, `PRAGMA table_info('${table}')`);
      if (!Object.entries(required).every(([name, type]) => info.some((c) => c.name === name && c.type === type)))
        throw new SourceFault(`unsupported ${table} schema`);
      const pk = table === "projection_projects" ? "project_id" : table === "orchestration_v2_projection_threads" ? "thread_id" : "sequence";
      if (!info.some((c) => c.name === pk && c.pk === 1)) throw new SourceFault(`unsupported ${table} key`);
    }
  }
  metadata(input, state) {
    const row = query(input, `SELECT substr(t.thread_id,1,513) thread_id,substr(t.project_id,1,513) project_id,
      substr(t.title,1,8193) title,substr(p.title,1,8193) project_title,substr(p.workspace_root,1,8193) workspace_root,
      substr(t.created_at,1,65) created_at,substr(t.updated_at,1,65) updated_at,
      substr(t.archived_at,1,65) archived_at,substr(t.deleted_at,1,65) deleted_at,
      CASE WHEN octet_length(t.payload_json)<=65536 AND json_valid(t.payload_json) THEN json_object(
        'parentThreadId',json_extract(t.payload_json,'$.lineage.parentThreadId'),
        'relationshipToParent',json_extract(t.payload_json,'$.lineage.relationshipToParent'),
        'forkType',json_extract(t.payload_json,'$.forkedFrom.type'),
        'forkThreadId',json_extract(t.payload_json,'$.forkedFrom.threadId'),
        'forkRunId',json_extract(t.payload_json,'$.forkedFrom.runId')) END relation
      FROM orchestration_v2_projection_threads t LEFT JOIN projection_projects p ON p.project_id=t.project_id
      WHERE t.thread_id>? ORDER BY t.thread_id LIMIT 1`, state.after)[0];
    if (!row) {
      state.after = "";
      state.refreshAt = Date.now() + REFRESH_MS;
      this.save(state);
      return 0;
    }
    if (!id(row.thread_id) || !id(row.project_id) || !row.relation || [row.title, row.project_title, row.workspace_root].some((v) => typeof v !== "string" || v.length > 8192) || [row.created_at, row.updated_at, row.archived_at, row.deleted_at].some((v) => v !== null && (typeof v !== "string" || v.length > 64)))
      throw new SourceFault("unsupported thread/project metadata");
    const relation = parse(row.relation);
    if ([relation.parentThreadId, relation.forkThreadId].some((v) => v !== null && !id(v)))
      throw new SourceFault("unsupported thread relation");
    const conversation = this.conversation(state.environment, row.thread_id), project = conversationProject(row.workspace_root);
    this.db.prepare("UPDATE conversations SET parent=?,project=? WHERE id=?").run(relation.parentThreadId ? conversationKey(state.environment, relation.parentThreadId) : null, project, conversation);
    if (project) this.db.prepare("INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)").run(project);
    const raw = Buffer.from(JSON.stringify({ source: "t3-local-metadata", environmentId: state.environment, ...row, relation }));
    if (raw.length > CONVERSATION_BYTES) throw new SourceFault("unsupported oversized metadata");
    this.sink.put(`${conversation}:metadata:${digest(raw.toString())}`, 0, 0, conversation, raw, time(row.updated_at), "t3:metadata");
    state.after = row.thread_id;
    this.save(state);
    return 1;
  }
  receipt(state, event, outcome) {
    const conversation = this.conversation(state.environment, event.stream_id);
    const source = `${conversation}:event:${event.sequence}:${event.event_id}`;
    this.sink.put(`${source}:receipt`, 0, 0, conversation, Buffer.from(JSON.stringify({
      source: "t3-local-event-receipt",
      environmentId: state.environment,
      threadId: event.stream_id,
      sequence: event.sequence,
      eventId: event.event_id,
      eventType: event.event_type,
      outcome,
      confirmedBytes: event.offset,
      expectedBytes: event.bytes ?? null,
      fragments: source
    })), time(event.occurred_at), `t3:${outcome}`);
  }
  copy(input, state) {
    const event = state.pending;
    const conversation = this.conversation(state.environment, event.stream_id);
    const source = `${conversation}:event:${event.sequence}:${event.event_id}`;
    const receipt = this.db.prepare(`SELECT raw,${this.codec},part FROM conversation_records WHERE source=? AND generation=0 AND offset=0`).get(`${source}:receipt`);
    if (receipt) {
      const raw = decodeBytes(receipt.raw, receipt.raw_codec);
      this.sink.put(`${source}:receipt`, 0, 0, conversation, raw, time(event.occurred_at), String(receipt.part));
      if (parse(raw.toString()).outcome !== "complete") state.incomplete = true;
      state.sequence = event.sequence;
      delete state.pending;
      this.save(state);
      return;
    }
    const admission = query(input, "SELECT octet_length(payload_json) bytes,substr(event_id,1,513) event_id FROM orchestration_events WHERE sequence=?", event.sequence)[0];
    if (admission) {
      if (admission.event_id !== event.event_id || !Number.isSafeInteger(admission.bytes) || admission.bytes < 0)
        throw new SourceFault("invalid message identity or size");
      if (admission.bytes > MAX_MESSAGE_BYTES) {
        event.bytes = admission.bytes;
        this.receipt(state, event, "unavailable-oversized-message");
        state.incomplete = true;
        state.sequence = event.sequence;
        delete state.pending;
        this.save(state);
        return;
      }
    }
    const row = admission ? query(input, `SELECT substr(event_id,1,513) event_id,substr(stream_id,1,513) stream_id,
      substr(event_type,1,129) event_type,application_event_version,substr(aggregate_kind,1,32) aggregate_kind,
      octet_length(payload_json) bytes,substr(CAST(payload_json AS BLOB),?,?) raw,
      CASE WHEN ?=0 AND json_valid(payload_json) THEN
        json_type(payload_json,'$.text')='text' AND json_type(payload_json,'$.id')='text'
        AND json_extract(payload_json,'$.threadId')=stream_id
        AND json_extract(payload_json,'$.role') IN ('user','assistant') END supported
      FROM orchestration_events WHERE sequence=? AND octet_length(payload_json)<=?`, event.offset + 1, CONVERSATION_BYTES, event.offset, event.sequence, MAX_MESSAGE_BYTES)[0] : void 0;
    if (!row) {
      const retained = this.db.prepare(`SELECT raw,${this.codec} FROM conversation_records WHERE source=? AND generation=0 AND offset=?`).get(source, event.offset);
      if (retained) {
        const raw = decodeBytes(retained.raw, retained.raw_codec);
        this.sink.put(source, 0, event.offset, conversation, raw, time(event.occurred_at), "t3:fragment");
        event.offset += raw.length;
        this.save(state);
        return;
      }
      this.receipt(state, event, "incomplete-compacted-source");
      state.incomplete = true;
      this.status("incomplete", "pending event compacted; retained fragments are not a complete revision");
    } else {
      if (row.event_id !== event.event_id || row.stream_id !== event.stream_id || row.event_type !== event.event_type || row.application_event_version !== 2 || row.aggregate_kind !== "thread" || event.bytes !== void 0 && event.bytes !== row.bytes)
        throw new SourceFault("event identity changed; source refused");
      if (event.offset === 0 && row.supported !== 1) {
        this.receipt(state, event, "unavailable-message-schema");
        state.incomplete = true;
        this.status("incomplete", "unsupported full message payload");
      } else {
        const raw = Buffer.from(row.raw), bytes = Number(row.bytes);
        if (!Number.isSafeInteger(bytes) || bytes < event.offset || raw.length !== Math.min(CONVERSATION_BYTES, bytes - event.offset))
          throw new SourceFault("invalid message byte range");
        const conversation2 = this.conversation(state.environment, event.stream_id);
        event.bytes = bytes;
        this.sink.put(
          `${conversation2}:event:${event.sequence}:${event.event_id}`,
          0,
          event.offset,
          conversation2,
          raw,
          time(event.occurred_at),
          "t3:fragment"
        );
        event.offset += raw.length;
        if (event.offset < bytes) {
          this.save(state);
          return;
        }
        this.receipt(state, event, "complete");
      }
    }
    state.sequence = event.sequence;
    delete state.pending;
    this.save(state);
  }
  tick(deadline) {
    if (this.root === void 0) {
      this.discovering = false;
      return 0;
    }
    let input, work = 0;
    try {
      if (!isAbsolute(this.root) || !this.root.trim() || /[\x00-\x1f]/.test(this.root)) throw new SourceFault("invalid explicit T3 home");
      let identity, environment, file;
      try {
        file = realpathSync2.native(join2(this.root, "userdata", "statev2.sqlite"));
        identity = fileIdentity(file);
        environment = environmentId(this.root);
        input = new DatabaseSync2(file, { readOnly: true, timeout: 25 });
        this.verifySource = () => {
          try {
            if (realpathSync2.native(join2(this.root, "userdata", "statev2.sqlite")) !== file || fileIdentity(file) !== identity || environmentId(this.root) !== environment) throw new Error();
          } catch {
            throw new SourceFault("source binding changed before publication; prior checkpoint preserved");
          }
        };
        this.verifySource();
      } catch (error) {
        throw error instanceof SourceFault ? error : new SourceFault("source missing, busy or unreadable");
      }
      this.schema(input);
      const tail = query(input, "SELECT sequence,substr(event_id,1,513) event_id FROM orchestration_events ORDER BY sequence DESC LIMIT 1")[0];
      const high = Number(tail?.sequence ?? 0), highId = String(tail?.event_id ?? "");
      const saved = this.sink.cursor(this.key);
      let state;
      try {
        state = saved === "0" ? { identity, environment, high, highId, sequence: 0, after: "", refreshAt: 0 } : JSON.parse(saved);
      } catch {
        throw new SourceFault("invalid retained T3 checkpoint");
      }
      if (!state || !Number.isSafeInteger(state.sequence) || !Number.isSafeInteger(state.high) || state.sequence < 0 || state.sequence > state.high || typeof state.after !== "string" || !Number.isFinite(state.refreshAt) || highId.length > 512)
        throw new SourceFault("invalid retained T3 checkpoint or source highwater");
      if (!Number.isSafeInteger(high) || state.identity !== identity || state.environment !== environment || high < state.high)
        throw new SourceFault("source replaced or highwater rolled back; prior checkpoint preserved");
      const anchor = query(input, "SELECT substr(event_id,1,513) event_id FROM orchestration_events WHERE sequence=?", state.high)[0];
      if (anchor && anchor.event_id !== state.highId) throw new SourceFault("source event identity replaced; prior checkpoint preserved");
      state.high = high;
      state.highId = highId;
      this.save(state);
      const backlog = () => this.messages && (!!state.pending || state.sequence < high);
      this.discovering = backlog() || Date.now() >= state.refreshAt;
      if (Date.now() < deadline && Date.now() >= state.refreshAt) work += this.metadata(input, state);
      for (let n = 0; this.messages && n < STEPS && Date.now() < deadline; n++) {
        if (state.pending) {
          this.copy(input, state);
          work++;
          continue;
        }
        const rows = query(input, `SELECT sequence,substr(event_id,1,513) event_id,substr(stream_id,1,513) stream_id,
          substr(event_type,1,129) event_type,application_event_version,substr(aggregate_kind,1,32) aggregate_kind,substr(occurred_at,1,65) occurred_at
          FROM orchestration_events WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ${WINDOW}`, state.sequence, high);
        if (!rows.length) {
          state.sequence = high;
          this.save(state);
          break;
        }
        for (const row of rows) {
          if (row.aggregate_kind === "thread" && String(row.event_type).startsWith("message.")) {
            if (!id(row.event_id) || !id(row.stream_id)) throw new SourceFault("unsupported event identity");
            const event = { ...row, offset: 0 };
            if (row.application_event_version === 2 && row.event_type === "message.updated") {
              state.pending = event;
              this.save(state);
              break;
            }
            this.receipt(state, event, "unavailable-event-schema");
            state.incomplete = true;
          }
          state.sequence = Number(row.sequence);
        }
        this.save(state);
        work++;
      }
      this.discovering = backlog() || Date.now() >= state.refreshAt;
      this.status(this.messages && state.incomplete ? "incomplete" : "ready", this.messages ? "coverage: metadata and surviving v2 message.updated events only" : "coverage: thread metadata only; message text comes from the provider transcripts");
      return work;
    } catch (error) {
      if (!(error instanceof SourceFault)) throw error;
      this.status("unavailable", error.message);
      this.discovering = false;
      return work;
    } finally {
      this.verifySource = void 0;
      input?.close();
    }
  }
};

// src/core/conversations.ts
var JOB_SNAPSHOTS_PER_TICK = 16;
var LATE_PROJECT_RETRY_MS = 10 * 6e4;
var LATE_PROJECT_IDLE_MS = 6e4;
var LATE_PROJECT_MAX_SKIPPED = 4096;
var DIRTY_SOURCES_PER_TICK = 16;
var DIRTY_CHUNKS_PER_SOURCE = 16;
function museRecords(row) {
  return typeof row.retained_frame === "string" && Array.isArray(row.children) ? row.children.map(object).flatMap((child) => typeof child.record_json === "string" ? [parse(child.record_json)] : []) : [row];
}
function museConversationText(raw) {
  return raw.toString("utf8").trim().split("\n").map((line) => {
    const row = parse(line);
    const records = museRecords(row);
    const text = typeof row.retained_frame === "string" && Array.isArray(row.children) ? records.map((record) => indexedConversationText(Buffer.from(JSON.stringify(record)))).join("\n") : indexedConversationText(Buffer.from(line));
    const details = records.flatMap(museItems).filter((item) => item.tool || item.subagent).map((item) => [item.tool, item.summary, item.subagent?.title].filter(Boolean).join("\n"));
    return [text, ...details].filter(Boolean).join("\n");
  }).join("\n").slice(0, CONVERSATION_BYTES);
}
var hash = (b) => createHash3("sha256").update(b).digest("hex");
var fold = (s) => s.normalize("NFKD").replace(new RegExp("\\p{M}", "gu"), "").toLowerCase();
var ConversationIngestor = class {
  constructor(db, home, paths, source = db, options = {}) {
    this.db = db;
    this.home = home;
    this.paths = paths;
    this.source = source;
    this.encoded = !!db.prepare("SELECT 1 FROM pragma_table_info('conversation_records') WHERE name='raw_codec'").get();
    this.fts = !!db.prepare("SELECT name FROM sqlite_master WHERE name='history_fts'").get();
    if (this.encoded) {
      registerHistoryFunctions(db);
      db.exec(CLAUDE_CHILD_FACTS_TABLE);
      db.prepare(`UPDATE conversation_sources SET format='jsonl',offset=0,generation=generation+1,identity='',anchor=''
        WHERE format='sqlite' AND path NOT LIKE 'opencode:%' AND conversation LIKE 'bridge:run:%'`).run();
    }
    this.checked = Number(
      db.prepare("SELECT coalesce(max(checked),0) n FROM (SELECT checked FROM conversation_sources UNION ALL SELECT checked FROM conversation_projects)").get().n
    );
    this.t3 = new T3History(Object.hasOwn(paths, "t3") ? paths.t3 : localT3HistoryRoot(), db, {
      cursor: (key) => this.cursor(key),
      advance: (key, value) => this.advance(key, value),
      put: (...args) => this.put(...args)
    }, options.t3Messages === true);
  }
  db;
  home;
  paths;
  source;
  checked = 0;
  jobsAt = 0;
  /** Stores seen by the last complete job pass; unchanged stores need no reread and rehash (AB-147). */
  jobsSignature = "";
  quietArchive = "";
  /** Conversations whose cwd resolved to no project (a removed worktree, a plain folder), by when to retry them. */
  noProject = /* @__PURE__ */ new Map();
  lateProjectsAt = 0;
  jobQueue = [];
  watchers = [];
  /** Called on a watched CLI transcript change, so an idle background worker can wake early (AB-147). */
  onChange;
  /** Changed files with no source yet: the index registers them now instead of at its next rescan (AB-383). */
  onUnknownPaths;
  watched = /* @__PURE__ */ new Set();
  dirty = /* @__PURE__ */ new Set();
  idleSources = 0;
  /** Changed sources are served round robin from here, so more than one batch of them never starves (AB-383). */
  dirtyAfter = "";
  /** Claude subagent facts are refreshed while a native source advanced or the last refresh still progressed. */
  claudeFacts = true;
  encoded;
  fts;
  t3;
  watchRoots() {
    for (const root of [
      join3(this.paths.claude, "projects"),
      join3(this.paths.codex, "sessions"),
      this.paths.opencode,
      ...this.paths.antigravity ? [join3(this.paths.antigravity, "brain")] : [],
      ...this.paths.muse ? [join3(this.paths.muse, "sessions")] : [],
      join3(this.home, "runs")
    ]) {
      if (this.watched.has(root)) continue;
      try {
        const watcher = watch(
          root,
          { recursive: true, persistent: false },
          (_, name) => {
            if (name && this.dirty.size < 2048)
              this.dirty.add(join3(root, String(name)));
            this.onChange?.();
          }
        );
        watcher.on("error", () => {
        });
        this.watchers.push(watcher);
        this.watched.add(root);
      } catch {
      }
    }
  }
  close() {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
  get discovering() {
    return this.jobQueue.length > 0 || this.t3.discovering || this.idleSources < Number(
      this.db.prepare("SELECT count(*) n FROM conversation_sources").get().n
    ) * 2;
  }
  cursor(key) {
    return String(
      this.db.prepare("SELECT cursor FROM history_cursors WHERE source=?").get(key)?.cursor ?? "0"
    );
  }
  advance(key, cursor) {
    this.db.prepare(
      // An unchanged cursor is no write: idle ticks otherwise kept the WAL (and every signature over it) changing.
      "INSERT INTO history_cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor WHERE cursor IS NOT excluded.cursor"
    ).run(key, cursor);
  }
  conversation(agent, session, cwd, child) {
    const id2 = `${agent}:${child ? `${session}:native:${child}` : session}`;
    const project = conversationProject(cwd);
    this.db.prepare(
      `INSERT INTO conversations(id,agent,session,parent,project) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project=CASE WHEN excluded.project<>'' THEN excluded.project ELSE conversations.project END`
    ).run(
      id2,
      agent,
      child ?? session,
      child ? `${agent}:${session}` : null,
      project
    );
    if (project)
      this.db.prepare(
        "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
      ).run(project);
    return id2;
  }
  register() {
    const key = "durable-files";
    const files = this.db.prepare(
      "SELECT rowid AS n,* FROM history_files WHERE rowid>? ORDER BY rowid LIMIT 32"
    ).all(Number(this.cursor(key)));
    for (const file of files) {
      const session = String(file.session), agent = String(file.agent), child = file.child ? String(file.child) : null;
      const kind = String(file.kind);
      const id2 = kind === "transcript" ? this.conversation(agent, session, String(file.cwd), child) : `bridge:${kind}:${kind === "run" ? basename(String(file.path)).replace(/\.(?:log|json)(?:-\d+-[\w-]+)?$/, "") : basename(String(file.path))}`;
      if (kind !== "transcript")
        this.db.prepare(
          "INSERT OR IGNORE INTO conversations(id,agent,session,kind) VALUES(?,?,?,?)"
        ).run(id2, agent, session, kind === "context" ? "progress" : kind);
      this.db.prepare(
        "INSERT OR IGNORE INTO conversation_sources(id,path,conversation,format) VALUES(?,?,?,?)"
      ).run(
        String(file.path),
        String(file.path),
        id2,
        kind === "context" ? "journal" : kind === "approval" ? "approval" : agent === "opencode" && kind === "transcript" ? "sqlite" : "jsonl"
      );
      this.advance(key, String(file.n));
    }
    for (const binding of this.db.prepare("SELECT * FROM conversation_bindings WHERE pending=1 LIMIT 32").all()) {
      const id2 = this.conversation(
        String(binding.agent),
        String(binding.session),
        String(binding.cwd),
        null
      );
      if (binding.job)
        this.db.prepare("UPDATE conversations SET job=? WHERE id=?").run(binding.job, id2);
      this.db.prepare(
        `UPDATE conversations SET project=?,job=coalesce(job,?) WHERE (session=? OR session IN(SELECT alias FROM history_sessions WHERE session=?)) AND (project='' OR job IS NULL)`
      ).run(
        conversationProject(String(binding.cwd)),
        binding.job,
        binding.session,
        binding.session
      );
      const project = conversationProject(String(binding.cwd));
      const docs = project ? this.db.prepare(
        `SELECT id FROM history_documents d WHERE (session=? OR session IN(SELECT alias FROM history_sessions WHERE session=?)) AND (NOT EXISTS(SELECT 1 FROM history_tags t WHERE t.id=d.id AND t.type='project' AND t.value=?) OR (? IS NOT NULL AND NOT EXISTS(SELECT 1 FROM history_tags t WHERE t.id=d.id AND t.type='job' AND t.value=?))) LIMIT 32`
      ).all(
        binding.session,
        binding.session,
        project,
        binding.job,
        binding.job
      ) : [];
      for (const doc of docs) {
        this.db.prepare("INSERT OR IGNORE INTO history_tags VALUES(?,?,?)").run(doc.id, "project", project);
        this.db.prepare(
          "UPDATE conversations SET project=? WHERE project='' AND id IN(SELECT conversation FROM conversation_records WHERE id=CAST(substr(?,9) AS INTEGER) AND ? LIKE 'durable:%')"
        ).run(project, doc.id, doc.id);
        this.db.prepare(
          "INSERT OR IGNORE INTO conversation_memberships SELECT ?,conversation FROM conversation_records WHERE id=CAST(substr(?,9) AS INTEGER) AND ? LIKE 'durable:%'"
        ).run(project, doc.id, doc.id);
        if (binding.job)
          this.db.prepare("INSERT OR IGNORE INTO history_tags VALUES(?,?,?)").run(doc.id, "job", binding.job);
      }
      this.db.prepare(
        "UPDATE conversation_bindings SET pending=? WHERE session=? AND agent=?"
      ).run(docs.length === 32 ? 1 : 0, binding.session, binding.agent);
    }
    const now = Date.now();
    if (!files.length && now < this.lateProjectsAt) return;
    for (const [id2, retryAt] of this.noProject) if (retryAt <= now) this.noProject.delete(id2);
    let resolved = 0;
    for (const file of this.db.prepare(
      `SELECT c.id,f.cwd FROM conversations c JOIN conversation_sources s ON s.conversation=c.id JOIN history_files f ON f.path=s.path WHERE c.project='' AND f.cwd<>'' AND c.id NOT IN (SELECT value FROM json_each(?)) LIMIT 32`
    ).all(JSON.stringify([...this.noProject.keys()]))) {
      const project = conversationProject(String(file.cwd));
      if (!project) {
        if (this.noProject.size < LATE_PROJECT_MAX_SKIPPED) this.noProject.set(String(file.id), now + LATE_PROJECT_RETRY_MS);
        continue;
      }
      resolved++;
      this.db.prepare("UPDATE conversations SET project=? WHERE id=?").run(project, file.id);
      this.db.prepare(
        "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
      ).run(project);
    }
    this.lateProjectsAt = resolved ? 0 : now + LATE_PROJECT_IDLE_MS;
  }
  jobs() {
    if (Date.now() - this.jobsAt < 3e4 && (this.jobsSignature || this.jobQueue.length)) return;
    this.jobsAt = Date.now();
    const path = join3(this.home, "jobs.json");
    const archive = jobArchivePath(path);
    const stores = [path, archive, `${archive}-wal`, join3(this.home, "archive")].map((file) => {
      try {
        return fileSignature(statSync3(file, { bigint: true }));
      } catch {
        return "missing";
      }
    }).join("|");
    if (stores === this.jobsSignature) return;
    let complete = true;
    let active = {};
    try {
      active = object(readJsonSnapshot(path).value);
    } catch {
    }
    const records = [
      ...readArchivedJobSnapshot(path).jobs,
      ...Array.isArray(active.jobs) ? active.jobs : []
    ];
    let queuedBytes = this.jobQueue.reduce((n, item) => n + item.raw.length, 0);
    for (const job of records) {
      if (this.jobQueue.length >= 100 || queuedBytes >= 8 * 1024 * 1024) {
        complete = false;
        break;
      }
      if (typeof job.name !== "string") continue;
      const raw = Buffer.from(JSON.stringify(job)), signature = hash(raw);
      if (this.cursor(`durable-job:${job.name}:${signature}`) === "1" || this.jobQueue.some(
        (s) => s.job.name === job.name && s.hash === signature
      ))
        continue;
      this.jobQueue.push({ job, raw, hash: signature, offset: 0 });
      queuedBytes += raw.length;
    }
    this.jobsSignature = complete ? stores : "";
  }
  jobSnapshot() {
    const next = this.jobQueue[0];
    if (!next) return 0;
    const { job } = next, session = job.sessionId ?? job.threadId;
    const project = conversationProject(
      typeof job.cwd === "string" ? job.cwd : typeof job.workdir === "string" ? job.workdir : ""
    );
    const id2 = `bridge:job:${job.name}`;
    this.db.prepare(
      "INSERT INTO conversations(id,agent,session,project,job,kind) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session=excluded.session,project=CASE WHEN excluded.project<>'' THEN excluded.project ELSE conversations.project END"
    ).run(
      id2,
      String(job.agent ?? "other"),
      String(session ?? ""),
      project,
      job.name,
      "report"
    );
    if (typeof session === "string")
      this.db.prepare(
        "UPDATE conversations SET job=?,project=CASE WHEN ?<>'' THEN ? ELSE project END WHERE session=?"
      ).run(job.name, project, project, session);
    if (project)
      this.db.prepare(
        "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
      ).run(project);
    const chunk = next.raw.subarray(
      next.offset,
      next.offset + CONVERSATION_BYTES
    );
    this.put(
      `job-snapshot:${job.name}:${next.hash}`,
      0,
      next.offset,
      id2,
      chunk,
      Number(job.finishedAt ?? job.startedAt ?? 0)
    );
    next.offset += chunk.length;
    if (next.offset >= next.raw.length) {
      this.advance(`durable-job:${job.name}:${next.hash}`, "1");
      this.jobQueue.shift();
    }
    return 1;
  }
  put(source, generation, offset, conversation, raw, at, part = null) {
    if (raw.length > CONVERSATION_BYTES) {
      for (let start = 0; start < raw.length; start += CONVERSATION_BYTES)
        this.put(
          source,
          generation,
          offset + start,
          conversation,
          raw.subarray(start, start + CONVERSATION_BYTES),
          at,
          part
        );
      return;
    }
    const native = this.db.prepare("SELECT kind,agent FROM conversations WHERE id=?").get(conversation);
    const body = native?.kind === "transcript" && native.agent === "muse" ? museConversationText(raw) : indexedConversationText(raw), stored = body === raw.toString("utf8") ? "" : body;
    const encoded = this.encoded ? encodeBytes(raw) : null;
    const result = encoded ? this.db.prepare("INSERT OR IGNORE INTO conversation_records(source,generation,offset,conversation,at,raw,raw_codec,body,part) VALUES(?,?,?,?,?,?,?,?,?)").run(source, generation, offset, conversation, at, encoded.value, encoded.codec, stored, part) : this.db.prepare("INSERT OR IGNORE INTO conversation_records(source,generation,offset,conversation,at,raw,body,part) VALUES(?,?,?,?,?,?,?,?)").run(source, generation, offset, conversation, at, raw, stored, part);
    const record = Number(result.changes) ? Number(result.lastInsertRowid) : Number(this.db.prepare("SELECT id FROM conversation_records WHERE source=? AND generation=? AND offset=?").get(source, generation, offset).id);
    const retained = this.db.prepare("SELECT * FROM conversation_records WHERE id=?").get(record);
    if (!decodeBytes(retained.raw, retained.raw_codec).equals(raw)) {
      throw Object.assign(new Error(`History import verification failed at ${source}:${generation}:${offset}; cursor not advanced, originals retained`), { code: "HISTORY_IMPORT_VERIFICATION_FAILED" });
    }
    if (part === null && native?.kind === "transcript" && native.agent === "claude") observeAskToolRecord(this.db, this.home, source, generation, raw, at, offset);
    this.indexRecord(
      record,
      conversation,
      body,
      at,
      offset
    );
  }
  indexRecord(record, conversation, body, at, offset) {
    const id2 = `durable:${record}`, c = this.db.prepare("SELECT * FROM conversations WHERE id=?").get(conversation);
    const recordInfo = this.db.prepare(
      "SELECT source,generation,part FROM conversation_records WHERE id=?"
    ).get(record);
    let recordAgent = c.agent, recordSession = c.session, recordJob = c.job, recordProject = c.project, recordKind = c.kind;
    if (c.kind === "message" || c.kind === "decision") {
      const firstRow = this.db.prepare("SELECT * FROM conversation_records WHERE source=? AND generation=? ORDER BY offset LIMIT 1").get(recordInfo.source, recordInfo.generation);
      const first = decodeBytes(firstRow.raw, firstRow.raw_codec).toString("utf8");
      const metadata = parse(first);
      for (const key of [
        "from_agent",
        "from_id",
        "from_name",
        "author_agent",
        "author_id"
      ])
        if (typeof metadata[key] !== "string") {
          const match = new RegExp(
            `"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`
          ).exec(first.slice(0, 8192));
          if (match) {
            try {
              metadata[key] = JSON.parse(match[1]);
            } catch {
            }
          }
        }
      recordAgent = metadata.from_agent ?? metadata.author_agent ?? recordAgent;
      recordSession = metadata.from_id ?? metadata.author_id ?? recordSession;
      const binding = this.db.prepare(
        "SELECT * FROM conversation_bindings WHERE session=? OR session IN(SELECT session FROM history_sessions WHERE alias=?) LIMIT 1"
      ).get(recordSession, recordSession);
      recordProject = binding ? conversationProject(String(binding.cwd)) : recordProject;
      if (recordProject) {
        this.db.prepare(
          "UPDATE conversations SET project=? WHERE id=? AND project=''"
        ).run(recordProject, conversation);
        this.db.prepare(
          "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
        ).run(recordProject);
      }
      recordJob = binding?.job ?? (/^(claude|codex|opencode|antigravity|muse)-job-/.test(String(metadata.from_name)) ? metadata.from_name : recordSession === c.session ? recordJob : null);
      const report = /"body"\s*:\s*"Subagent ([A-Za-z0-9][A-Za-z0-9_-]*) \(([a-z][a-z0-9_-]*)(?:, model [^"\r\n]*)?\) (?:done|failed|cancelled) after \d+s\./.exec(first.slice(0, 8192));
      if (c.kind === "message" && report) {
        recordKind = "report";
        recordJob = report[1];
        recordAgent = report[2];
      }
    }
    const eventKind = String(recordInfo.part ?? "").replace(/^event:/, "");
    const storedBody = this.encoded ? encodeText(body) : null;
    const foldedBody = storedBody && this.fts ? null : fold(body);
    this.db.prepare(
      storedBody ? "INSERT OR IGNORE INTO history_documents(id,kind,agent,at,body,body_codec,folded,link,message,job,run,session,cursor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)" : "INSERT OR IGNORE INTO history_documents(id,kind,agent,at,body,folded,link,message,job,run,session,cursor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      id2,
      ["approval", "progress", "report"].includes(eventKind) ? eventKind : ["approval", "progress", "report"].includes(parse(body).kind) ? parse(body).kind : recordKind,
      recordAgent,
      at,
      ...storedBody ? [storedBody.value, storedBody.codec] : [body],
      foldedBody,
      `/api/conversations/${encodeURIComponent(conversation)}`,
      null,
      recordJob,
      null,
      recordSession,
      String(offset)
    );
    for (const [type, value] of [
      ["project", recordProject],
      ["session", recordSession],
      ["job", recordJob]
    ])
      if (value)
        this.db.prepare("INSERT OR IGNORE INTO history_tags VALUES(?,?,?)").run(id2, type, value);
    if (recordProject)
      this.db.prepare("INSERT OR IGNORE INTO conversation_memberships VALUES(?,?)").run(recordProject, conversation);
  }
  events(input, table, key) {
    const saved = parse(this.cursor(key)), after = Number(saved.after ?? 0);
    const row = input.prepare(
      `SELECT rowid n,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 1`
    ).get(after);
    if (!row) return 0;
    const agent = String(row.from_agent ?? row.author_agent), session = String(row.from_id ?? row.author_id), kind = table === "messages" ? "message" : "decision";
    const id2 = `bridge:${table === "messages" ? row.conversation_id : `decision:${row.topic}`}`;
    const binding = this.db.prepare(
      "SELECT * FROM conversation_bindings WHERE session=? OR session IN (SELECT session FROM history_sessions WHERE alias=?) LIMIT 1"
    ).get(session, session);
    const project = binding ? conversationProject(String(binding.cwd)) : "";
    this.db.prepare(
      "INSERT OR IGNORE INTO conversations(id,agent,session,project,job,kind) VALUES(?,?,?,?,?,?)"
    ).run(id2, agent, session, project, binding?.job ?? null, kind);
    if (project)
      this.db.prepare(
        "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
      ).run(project);
    const { n: _cursorRowid, ...record } = row;
    const raw = Buffer.from(JSON.stringify(record)), fingerprint = createHash3("sha256").update(raw).digest("hex"), generation = 1 + Number.parseInt(fingerprint.slice(0, 12), 16), offset = saved.fingerprint && saved.fingerprint !== fingerprint ? 0 : Number(saved.offset ?? 0), chunk = raw.subarray(offset, offset + CONVERSATION_BYTES);
    this.put(
      `${table}:${row.id}:${row.recipient ?? row.revision}`,
      generation,
      offset,
      id2,
      chunk,
      Number(row.created_at),
      `${table}:${row.id}`
    );
    this.advance(
      key,
      JSON.stringify(
        offset + chunk.length >= raw.length ? { after: Number(row.n) } : { after, offset: offset + chunk.length, fingerprint }
      )
    );
    return 1;
  }
  envelopes() {
    if (!this.source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_envelopes'").get()) return 0;
    const key = "durable-envelope-keys", saved = parse(this.cursor(key)), after = Number(saved.after ?? 0);
    const envelope = this.source.prepare(
      "SELECT * FROM conversation_envelopes WHERE id>? ORDER BY id LIMIT 1"
    ).get(after);
    if (!envelope) return 0;
    let row = this.source.prepare(
      "SELECT * FROM messages WHERE id=? ORDER BY recipient=? DESC LIMIT 1"
    ).get(envelope.message, envelope.recipient);
    if (!row) {
      const path = join3(this.home, "archive.db");
      if (existsSync2(path)) {
        const archive = new DatabaseSync3(path, { readOnly: true, timeout: 50 });
        try {
          row = archive.prepare(
            "SELECT * FROM messages WHERE id=? ORDER BY recipient=? DESC LIMIT 1"
          ).get(envelope.message, envelope.recipient);
        } finally {
          archive.close();
        }
      }
    }
    if (!row) return 0;
    const id2 = `bridge:${row.conversation_id}`;
    const binding = this.db.prepare(
      "SELECT * FROM conversation_bindings WHERE session=? OR session IN (SELECT session FROM history_sessions WHERE alias=?) LIMIT 1"
    ).get(row.from_id, row.from_id);
    const project = binding ? conversationProject(String(binding.cwd)) : "";
    this.db.prepare(
      "INSERT OR IGNORE INTO conversations(id,agent,session,project,job,kind) VALUES(?,?,?,?,?,?)"
    ).run(
      id2,
      row.from_agent,
      row.from_id,
      project,
      binding?.job ?? null,
      "message"
    );
    if (project)
      this.db.prepare(
        "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
      ).run(project);
    const raw = Buffer.from(
      JSON.stringify({ ...row, recipient: envelope.recipient })
    ), fingerprint = createHash3("sha256").update(raw).digest("hex"), generation = 1 + Number.parseInt(fingerprint.slice(0, 12), 16), offset = saved.fingerprint && saved.fingerprint !== fingerprint ? 0 : Number(saved.offset ?? 0), chunk = raw.subarray(offset, offset + CONVERSATION_BYTES);
    this.put(
      `messages:${row.id}:${envelope.recipient}`,
      generation,
      offset,
      id2,
      chunk,
      Number(row.created_at),
      `messages:${row.id}`
    );
    this.advance(
      key,
      JSON.stringify(
        offset + chunk.length >= raw.length ? { after: Number(envelope.id) } : { after, offset: offset + chunk.length, fingerprint }
      )
    );
    return 1;
  }
  jsonl(source) {
    const agent = String(source.conversation).split(":")[0];
    const root = String(source.conversation).startsWith("bridge:") ? this.home : this.paths[agent];
    if (!root || !safeFile(root, source.path)) return 0;
    let fd;
    try {
      fd = openSync2(source.path, "r");
      const stat = fstatSync2(fd);
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let offset = Number(source.offset), generation = Number(source.generation);
      const anchor = Buffer.alloc(Math.min(64, offset));
      if (offset && offset <= stat.size)
        readSync2(fd, anchor, 0, anchor.length, offset - anchor.length);
      if (offset > stat.size || source.identity && source.identity !== identity || offset && source.anchor && source.anchor !== hash(anchor)) {
        offset = 0;
        generation++;
      }
      const data = Buffer.alloc(
        Math.min(CONVERSATION_BYTES, Math.max(0, stat.size - offset))
      );
      let bytes = readSync2(fd, data, 0, data.length, offset);
      if (source.format === "approval" && bytes && offset + bytes < stat.size && stat.size - offset - bytes < 1024)
        bytes = Math.max(1, bytes - 1024);
      if (bytes && offset + bytes < stat.size) {
        let start = bytes - 1;
        while (start > 0 && (data[start] & 192) === 128) start--;
        const first = data[start], need = first >= 240 ? 4 : first >= 224 ? 3 : first >= 192 ? 2 : 1;
        if (bytes - start < need) bytes = start;
      }
      if (bytes) {
        if (source.format === "approval" && offset + bytes === stat.size) {
          const text = data.subarray(0, bytes).toString("utf8");
          const capability = /,\s*"pid"\s*:\s*\d+,\s*"port"\s*:\s*\d+,\s*"token"\s*:\s*"(?:\\.|[^"\\])*"\s*}\s*$/.exec(
            text
          );
          if (capability) {
            const start = Buffer.byteLength(text.slice(0, capability.index));
            const replacement = Buffer.from(
              " ".repeat(Buffer.byteLength(capability[0]) - 1) + "}"
            );
            replacement.copy(data, start);
          }
        }
        if (offset === 0 && /\.json(?:-.*)?$/.test(source.path)) {
          const metadata = parse(data.subarray(0, bytes).toString("utf8"));
          if (typeof metadata.job === "string") {
            const project = conversationProject(
              String(metadata.workdir ?? metadata.byCwd ?? metadata.cwd ?? "")
            );
            this.db.prepare(
              "UPDATE conversations SET job=?,session=?,project=? WHERE id=?"
            ).run(
              metadata.job,
              String(metadata.session ?? ""),
              project,
              source.conversation
            );
            if (project)
              this.db.prepare(
                "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
              ).run(project);
          }
        }
        const newline = data.subarray(0, bytes).lastIndexOf(10);
        if (newline >= 0) bytes = newline + 1;
        let lineOffset = offset;
        const fragmentKey = `durable-fragment:${source.id}:${generation}`;
        let fragment = parse(this.cursor(fragmentKey));
        if (Number(fragment.offset) !== offset) fragment = {};
        const lines = data.subarray(0, bytes).toString("utf8").split("\n");
        for (let ordinal = 0; ordinal < lines.length; ordinal++) {
          const line = lines[ordinal];
          if (!line) continue;
          const newline2 = ordinal < lines.length - 1;
          let row = parse(line);
          if (!Object.keys(row).length && !fragment.id) {
            for (const key of [
              "kind",
              "agent",
              "job",
              "session",
              "project",
              "agentId",
              "cwd",
              "id",
              "rootSession",
              "owner"
            ]) {
              const match = new RegExp(
                `"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`
              ).exec(line.slice(0, 8192));
              if (match) {
                try {
                  row[key] = JSON.parse(match[1]);
                } catch {
                }
              }
            }
            if (/"isSidechain"\s*:\s*true/.test(line.slice(0, 8192)))
              row.isSidechain = true;
          }
          const meta = agent === "codex" ? object(row.payload) : row;
          const c = this.db.prepare("SELECT * FROM conversations WHERE id=?").get(source.conversation);
          if (c.kind === "run" && typeof row.job === "string") {
            const project = conversationProject(
              typeof row.workdir === "string" ? row.workdir : typeof row.cwd === "string" ? row.cwd : ""
            );
            this.db.prepare(
              "UPDATE conversations SET job=?,session=?,project=? WHERE id=?"
            ).run(
              row.job,
              String(row.session ?? row.sessionId ?? ""),
              project,
              source.conversation
            );
            if (project)
              this.db.prepare(
                "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
              ).run(project);
          }
          if (source.format === "journal" && ["progress", "report", "approval"].includes(row.kind) || source.format === "approval" && typeof row.id === "string") {
            const id2 = row.job ? `bridge:job:${row.job}` : source.conversation;
            const project = conversationProject(
              typeof row.project === "string" ? row.project : ""
            );
            this.db.prepare(
              "INSERT INTO conversations(id,agent,session,project,job,kind) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project=CASE WHEN excluded.project<>'' THEN excluded.project ELSE conversations.project END"
            ).run(
              id2,
              String(row.agent ?? "other"),
              String(row.session ?? row.rootSession ?? row.owner ?? ""),
              project,
              row.job ?? null,
              row.kind ?? "approval"
            );
            if (project)
              this.db.prepare(
                "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
              ).run(project);
            fragment = { id: id2, kind: row.kind ?? "approval" };
          }
          if ((agent !== "codex" || row.type === "session_meta" && meta.id === c.session) && typeof meta.cwd === "string") {
            const project = conversationProject(meta.cwd);
            this.db.prepare("UPDATE conversations SET project=? WHERE id=?").run(project, source.conversation);
            if (project)
              this.db.prepare(
                "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
              ).run(project);
          }
          if (agent === "codex" && row.type === "session_meta" && meta.id === c.session) {
            const spawn = object(object(meta.source).subagent).thread_spawn;
            const parent = object(spawn).parent_thread_id ?? (meta.thread_source === "subagent" ? meta.parent_thread_id : null);
            if (typeof parent === "string")
              this.db.prepare("UPDATE conversations SET parent=? WHERE id=?").run(`codex:${parent}`, source.conversation);
          }
          if (agent === "antigravity") {
            for (const item of antigravityItems(row)) {
              if (!item.subagent || item.subagent.id === c.session) continue;
              const child = this.conversation(agent, item.subagent.id, String(c.project), null);
              this.db.prepare("UPDATE conversations SET parent=? WHERE id=?").run(source.conversation, child);
            }
          }
          if (agent === "muse") {
            for (const record of museRecords(row)) {
              const stream = object(record.stream);
              if (stream.kind !== "session" || stream.id !== c.session) continue;
              for (const item of museItems(record)) {
                if (!item.subagent || item.subagent.id === c.session) continue;
                const child = this.conversation(agent, item.subagent.id, "", null);
                this.db.prepare(`UPDATE conversations SET parent=? WHERE id=? AND parent IS NULL AND NOT EXISTS(
                  WITH RECURSIVE ancestors(id) AS (SELECT ? UNION SELECT c.parent FROM conversations c JOIN ancestors a ON c.id=a.id WHERE c.parent IS NOT NULL)
                  SELECT 1 FROM ancestors WHERE id=?)`).run(source.conversation, child, source.conversation, child);
              }
            }
          }
          if (agent === "claude" && row.isSidechain === true && typeof row.agentId === "string") {
            const child = this.conversation(
              agent,
              String(c.session),
              String(c.project),
              row.agentId
            );
            fragment = { id: child };
          }
          if (fragment.id) {
            this.put(
              `${source.id}:${source.format === "journal" ? "event" : "inline"}:${fragment.id}`,
              generation,
              lineOffset,
              fragment.id,
              Buffer.from(line + (newline2 ? "\n" : "")),
              stat.mtimeMs,
              fragment.kind ? `event:${fragment.kind}` : null
            );
          }
          lineOffset += Buffer.byteLength(line) + (newline2 ? 1 : 0);
          if (newline2) fragment = {};
        }
        this.advance(
          fragmentKey,
          JSON.stringify({ ...fragment, offset: offset + bytes })
        );
      }
      const end = offset + bytes;
      const tail = Buffer.alloc(Math.min(64, end));
      if (end) readSync2(fd, tail, 0, tail.length, end - tail.length);
      this.db.exec("SAVEPOINT conversation_chunk");
      try {
        if (bytes)
          this.put(
            source.id,
            generation,
            offset,
            source.conversation,
            data.subarray(0, bytes),
            stat.mtimeMs
          );
        this.db.prepare(
          "UPDATE conversation_sources SET offset=?,generation=?,identity=?,anchor=? WHERE id=?"
        ).run(end, generation, identity, hash(tail), source.id);
        this.db.exec("RELEASE conversation_chunk");
      } catch (err) {
        cleanupSavepoint(this.db, "conversation_chunk", true, err);
      }
      return bytes ? 1 : 0;
    } finally {
      if (fd !== void 0) closeSync2(fd);
    }
  }
  journal(source) {
    return this.jsonl(source);
  }
  sqlite(source) {
    const path = safeFile(
      this.paths.opencode,
      join3(this.paths.opencode, "opencode.db")
    );
    if (!path) return 0;
    const input = new DatabaseSync3(path, { readOnly: true, timeout: 50 });
    try {
      const table = Number(source.offset) % 2 ? "message" : "part";
      this.db.prepare("UPDATE conversation_sources SET offset=offset+1 WHERE id=?").run(source.id);
      const session = String(source.path).slice("opencode:".length), key = `durable-${table}:${session}`, saved = parse(this.cursor(key));
      const meta = input.prepare("SELECT * FROM session WHERE id=?").get(session);
      if (meta) {
        const project = conversationProject(
          typeof meta.directory === "string" ? meta.directory : ""
        );
        this.db.prepare(
          "UPDATE conversations SET parent=?,project=CASE WHEN ?<>'' THEN ? ELSE project END WHERE id=?"
        ).run(
          meta.parent_id ? `opencode:${meta.parent_id}` : null,
          project,
          project,
          source.conversation
        );
        if (project)
          this.db.prepare(
            "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
          ).run(project);
        this.put(
          `${source.id}:session:${meta.time_updated}`,
          0,
          0,
          source.conversation,
          Buffer.from(JSON.stringify(meta)),
          Number(meta.time_created)
        );
      }
      let pending = object(saved.pending);
      if (!pending.id) {
        const row2 = input.prepare(
          `SELECT p.id,p.time_updated,p.time_created FROM ${table} p WHERE p.session_id=? AND (p.time_updated>? OR (p.time_updated=? AND p.id>?)) ORDER BY p.time_updated,p.id LIMIT 1`
        ).get(
          session,
          Number(saved.at ?? 0),
          Number(saved.at ?? 0),
          String(saved.id ?? "")
        );
        if (!row2) return 0;
        pending = { ...row2, offset: 0 };
      }
      const row = input.prepare(
        `SELECT time_updated,substr(CAST(data AS BLOB),?,?) raw FROM ${table} WHERE id=? AND session_id=?`
      ).get(
        Number(pending.offset) + 1,
        CONVERSATION_BYTES,
        pending.id,
        session
      );
      if (!row) {
        this.advance(
          key,
          JSON.stringify({ at: pending.time_updated, id: pending.id })
        );
        return 1;
      }
      if (Number(row.time_updated) !== Number(pending.time_updated)) {
        pending.offset = 0;
        pending.time_updated = row.time_updated;
        this.advance(key, JSON.stringify({ ...saved, pending }));
        return 1;
      }
      const raw = Buffer.from(row.raw);
      this.put(
        `${source.id}:${table}:${pending.id}:${pending.time_updated}`,
        0,
        Number(pending.offset),
        source.conversation,
        raw,
        Number(pending.time_created),
        String(pending.id)
      );
      pending.offset += raw.length;
      this.advance(
        key,
        JSON.stringify(
          raw.length < CONVERSATION_BYTES ? { at: pending.time_updated, id: pending.id } : { ...saved, pending }
        )
      );
      return 1;
    } finally {
      input.close();
    }
  }
  tick() {
    const deadline = Date.now() + HISTORY_BATCH_MS;
    this.watchRoots();
    const unknown = [];
    for (const path of [...this.dirty].slice(0, 32)) {
      this.dirty.delete(path);
      if (path.startsWith(this.paths.opencode))
        this.db.prepare(
          "UPDATE conversation_sources SET checked=-1 WHERE format='sqlite'"
        ).run();
      else if (!Number(this.db.prepare("UPDATE conversation_sources SET checked=-1 WHERE path=?").run(path).changes))
        unknown.push(path);
    }
    if (unknown.length) this.onUnknownPaths?.(unknown);
    this.register();
    this.jobs();
    const nextJob = this.jobQueue[0]?.job;
    if (nextJob)
      conversationProject(String(nextJob.cwd ?? nextJob.workdir ?? ""));
    let work = 0;
    work += this.t3.tick(deadline);
    {
      for (let i = 0; i < JOB_SNAPSHOTS_PER_TICK && this.jobQueue.length && Date.now() < deadline; i++) {
        if (i) {
          const next = this.jobQueue[0].job;
          conversationProject(String(next.cwd ?? next.workdir ?? ""));
        }
        work += this.jobSnapshot();
      }
      work += this.envelopes();
      work += this.events(this.source, "decisions", "durable-decisions");
      const archive = join3(this.home, "archive.db");
      const archiveSignature = [archive, `${archive}-wal`].map((file) => {
        try {
          return fileSignature(statSync3(file, { bigint: true }));
        } catch {
          return "missing";
        }
      }).join("|");
      if (existsSync2(archive) && archiveSignature !== this.quietArchive) {
        const input = new DatabaseSync3(archive, {
          readOnly: true,
          timeout: 50
        });
        try {
          const archived = this.events(input, "messages", "durable-archive");
          this.quietArchive = archived ? "" : archiveSignature;
          work += archived;
        } finally {
          input.close();
        }
      }
      for (const c of this.db.prepare(
        `SELECT c.id,p.id AS resolved FROM conversations c JOIN conversations p ON p.agent=c.agent AND p.session=substr(c.parent,length(c.agent)+2) WHERE c.parent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversations exact WHERE exact.id=c.parent) AND p.id<>c.id LIMIT 100`
      ).all()) {
        this.db.prepare("UPDATE conversations SET parent=? WHERE id=?").run(c.resolved, c.id);
      }
      for (const c of this.db.prepare(
        `SELECT c.id,c.agent,c.session,p.job,p.project FROM conversations c JOIN conversations p ON c.parent=p.id WHERE (c.job IS NULL AND p.job IS NOT NULL) OR (c.project='' AND p.project<>'') LIMIT 100`
      ).all()) {
        this.db.prepare(
          "UPDATE conversations SET job=coalesce(job,?),project=CASE WHEN project='' THEN ? ELSE project END WHERE id=?"
        ).run(c.job, c.project, c.id);
        if (c.agent === "muse") {
          const child = this.db.prepare("SELECT project,job FROM conversations WHERE id=?").get(c.id);
          this.db.prepare(`INSERT INTO conversation_bindings(session,agent,cwd,job) VALUES(?,'muse',?,?)
            ON CONFLICT(session,agent) DO UPDATE SET cwd=CASE WHEN conversation_bindings.cwd='' THEN excluded.cwd ELSE conversation_bindings.cwd END,
            job=coalesce(conversation_bindings.job,excluded.job),pending=1`).run(c.session, child.project, child.job);
        }
        if (c.project)
          this.db.prepare(
            "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
          ).run(c.project);
        work++;
      }
      const indexed = Number(this.cursor("durable-index-rows"));
      for (const row of this.db.prepare(
        "SELECT * FROM conversation_records WHERE id>? ORDER BY id LIMIT 8"
      ).all(indexed)) {
        if (Date.now() >= deadline) break;
        const record = decodeHistoryRow("conversation_records", row);
        this.indexRecord(
          Number(row.id),
          String(row.conversation),
          String(record.body) || (String(row.conversation).startsWith("muse:") ? museConversationText(record.raw) : indexedConversationText(record.raw)),
          Number(row.at),
          Number(row.offset)
        );
        this.advance("durable-index-rows", String(row.id));
        work++;
      }
      const sourceDeadline = Date.now() + HISTORY_BATCH_MS;
      const read = (source) => {
        try {
          const amount = source.format === "jsonl" ? this.jsonl(source) : source.format === "sqlite" ? this.sqlite(source) : this.journal(source);
          if (amount && /^claude:.*:native:/.test(String(source.conversation))) this.claudeFacts = true;
          return amount;
        } catch (err) {
          if (!["ENOENT", "EACCES", "EPERM"].includes(
            err.code ?? ""
          ))
            throw err;
          return 0;
        }
      };
      const dirtyNext = this.db.prepare("SELECT * FROM conversation_sources WHERE checked<0 AND format<>'sqlite' AND id>? ORDER BY id LIMIT ?");
      const dirtySources = dirtyNext.all(this.dirtyAfter, DIRTY_SOURCES_PER_TICK);
      if (dirtySources.length < DIRTY_SOURCES_PER_TICK)
        dirtySources.push(...dirtyNext.all("", DIRTY_SOURCES_PER_TICK - dirtySources.length).filter((row) => String(row.id) <= this.dirtyAfter));
      for (const source of dirtySources) {
        if (Date.now() >= sourceDeadline) break;
        this.dirtyAfter = String(source.id);
        let current = source, more = 0;
        for (let chunk = 0; current && chunk < DIRTY_CHUNKS_PER_SOURCE && Date.now() < sourceDeadline; chunk++) {
          more = read(current);
          work += more;
          if (!more) break;
          current = this.db.prepare("SELECT * FROM conversation_sources WHERE id=?").get(source.id);
        }
        if (more) continue;
        this.db.prepare("UPDATE conversation_sources SET checked=? WHERE id=?").run(++this.checked, source.id);
      }
      for (const source of this.db.prepare(
        "SELECT * FROM conversation_sources ORDER BY checked,id LIMIT 2"
      ).all()) {
        if (Date.now() >= sourceDeadline) break;
        const amount = read(source);
        work += amount;
        this.idleSources = amount ? 0 : this.idleSources + 1;
        this.db.prepare("UPDATE conversation_sources SET checked=? WHERE id=?").run(++this.checked, source.id);
      }
      if (this.encoded && this.claudeFacts) {
        const facts = refreshClaudeChildFacts(this.db);
        work += facts;
        this.claudeFacts = facts > 0;
      }
    }
    const project = this.db.prepare(
      "SELECT project FROM conversation_projects ORDER BY checked,project LIMIT 1"
    ).get();
    if (project) {
      work += syncProjectMirror(this.db, String(project.project), this.home);
      this.db.prepare("UPDATE conversation_projects SET checked=? WHERE project=?").run(++this.checked, project.project);
    }
    return work;
  }
};
function foreignMirrorRecord(source, text) {
  const sandboxHome = (path) => /(?:^|[\\/])\.agent-bridge-test[\\/][^\\/]+[\\/]home(?:[\\/]|$)/i.test(path);
  if (sandboxHome(source)) return true;
  const job = parse(text);
  if (job.from_name === "owner-smoke-main") return true;
  if (source.startsWith("messages:") && ["claude-e2e", "codex-e2e", "antigravity-e2e"].includes(String(job.from_name))) return true;
  if (!source.startsWith("job-snapshot:")) return false;
  return typeof job.workdir === "string" && sandboxHome(job.workdir);
}
function readConversation(db, input) {
  const args = conversationPageSchema.parse(input);
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='conversations'").get())
    return { conversation: null, records: [], next: null };
  const c = db.prepare("SELECT * FROM conversations WHERE id=?").get(args.id);
  if (!c) return { conversation: null, records: [], next: null };
  const rows = db.prepare(
    "SELECT * FROM conversation_records WHERE conversation=? AND id>? ORDER BY id LIMIT ?"
  ).all(args.id, args.after ?? 0, (args.limit ?? 20) + 1);
  const records = [];
  let bytes = 0;
  for (const row of rows) {
    const raw = decodeBytes(row.raw, row.raw_codec);
    if (records.length >= (args.limit ?? 20) || bytes + raw.length > 512 * 1024)
      break;
    records.push({
      id: Number(row.id),
      source: String(row.source),
      generation: Number(row.generation),
      offset: Number(row.offset),
      at: Number(row.at),
      text: raw.toString("utf8"),
      raw: raw.toString("base64"),
      part: row.part ? String(row.part) : null,
      ...foreignMirrorRecord(String(row.source), raw.toString("utf8")) ? { foreignHome: true } : {}
    });
    bytes += raw.length;
  }
  return {
    conversation: c,
    records,
    next: records.length < rows.length ? records.at(-1)?.id ?? null : null
  };
}
function readConversationFile(file, input) {
  const status = historyReadStatus(file), migration = status.migration ? { migration: status.migration } : {};
  file = status.path;
  if (!existsSync2(file)) return { conversation: null, records: [], next: null, ...migration };
  const db = openHistoryReader(file);
  try {
    return { ...readConversation(db, input), ...migration };
  } finally {
    db.close();
  }
}

export {
  CONVERSATION_MIGRATION,
  conversationProject,
  projectDatabasePath,
  ownsProjectMirrors,
  cleanupSavepoint,
  ConversationIngestor,
  foreignMirrorRecord,
  readConversation,
  readConversationFile
};
