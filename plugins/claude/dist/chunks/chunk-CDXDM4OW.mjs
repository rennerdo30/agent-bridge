import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  decodeHistoryRow,
  historySchema
} from "./chunk-BSNWCPDJ.mjs";
import {
  canonicalProjectRoot,
  projectKey
} from "./chunk-3G4ZOXSN.mjs";
import {
  isPluginCacheCwd
} from "./chunk-JNVJDIQM.mjs";
import {
  MAX_NATIVE_SUBAGENTS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  TRANSCRIPT_ID,
  fileStat,
  object,
  preview,
  readJsonl,
  safeFile,
  scanJsonl,
  time
} from "./chunk-TFQZM67X.mjs";
import {
  fileSignature,
  migrateSqlite,
  nullLogger
} from "./chunk-DAGAKEUM.mjs";
import {
  assertUnlinked
} from "./chunk-4EDVJNL7.mjs";
import {
  DEFAULT_HOME
} from "./chunk-7EOIPV3B.mjs";

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
  const id = createHash("sha256").update(project).digest("hex").slice(0, 16);
  return join(home && !ownsProjectMirrors(home) ? join(home, "project-mirrors") : join(project, ".agent-bridge"), `conversations-${id}.db`);
}
function ownsProjectMirrors(home) {
  const physical = (path) => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  return projectKey(physical(home)) === projectKey(physical(DEFAULT_HOME));
}
var MIRROR_RECYCLE_MS = 5 * 6e4;
var idleMirrors = /* @__PURE__ */ new Map();
var mirrorFiles = (path) => [path, `${path}-wal`].map((file) => {
  try {
    return fileSignature(statSync(file));
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

// src/core/transcripts/antigravity.ts
import { join as join2 } from "node:path";
function antigravitySessionFile(session, paths) {
  return paths.antigravity && session.sessionId && TRANSCRIPT_ID.test(session.sessionId) ? safeFile(paths.antigravity, join2(paths.antigravity, "brain", session.sessionId, ".system_generated", "logs", "transcript.jsonl")) : null;
}
function antigravityItems(row) {
  const at = time(row.created_at), items = [];
  const id = Number.isSafeInteger(row.step_index) ? String(row.step_index) : void 0;
  const toolResult = row.type === "GENERIC" && typeof row.content === "string" && /^Created At: [^\n]*\nCompleted At: /.test(row.content);
  if (toolResult) items.push({ kind: "tool", at, tool: "result", summary: preview(row.content), id });
  else if (typeof row.content === "string" && row.content && (["USER_INPUT", "PLANNER_RESPONSE", "AGENT_RESPONSE"].includes(row.type) || row.type === "GENERIC" && row.source === "MODEL")) items.push({ kind: row.type === "USER_INPUT" ? "user" : "assistant", at, text: preview(row.content, MAX_TEXT_CHARS), id });
  for (const call of (Array.isArray(row.tool_calls) ? row.tool_calls : []).map(object)) {
    items.push({ kind: "tool", at, tool: String(call.name ?? call.tool_name ?? "tool"), summary: preview(call.arguments ?? call.args ?? call.parameters), id: `${id ?? ""}:${items.length}` });
  }
  const subagents = object(row.subagent_info).subagents ?? row.subagents;
  for (const child of (Array.isArray(subagents) ? subagents : []).map(object)) {
    if (typeof child.conversation_id !== "string" || !TRANSCRIPT_ID.test(child.conversation_id)) continue;
    items.push({ kind: "subagent", at, subagent: { id: child.conversation_id, title: preview(child.role ?? child.type_name ?? "Native subagent", MAX_TITLE_CHARS), agent: "antigravity" } });
  }
  return items;
}
function listAntigravitySubagents(session, paths) {
  const file = antigravitySessionFile(session, paths);
  if (!file) return [];
  const children = /* @__PURE__ */ new Map();
  for (const { value } of scanJsonl(file)) for (const item of antigravityItems(value)) {
    const child = item.subagent;
    if (!child || children.size >= MAX_NATIVE_SUBAGENTS) continue;
    const nested = antigravitySessionFile({ ...session, sessionId: child.id }, paths), stat = nested ? fileStat(nested) : null;
    children.set(child.id, { id: child.id, title: child.title, status: "unknown", startedAt: item.at, updatedAt: stat?.mtimeMs ?? item.at });
  }
  return [...children.values()];
}
function readAntigravityChat(session, paths, from = "0", child) {
  if (child && (!TRANSCRIPT_ID.test(child) || !listAntigravitySubagents(session, paths).some((entry) => entry.id === child))) return null;
  const file = antigravitySessionFile(child ? { ...session, sessionId: child } : session, paths);
  if (!file) return null;
  const page = readJsonl(file, from);
  return { items: page.entries.flatMap(({ value }) => antigravityItems(value)), next: page.next };
}

export {
  CONVERSATION_MIGRATION,
  conversationProject,
  projectDatabasePath,
  ownsProjectMirrors,
  syncProjectMirror,
  antigravityItems,
  listAntigravitySubagents,
  readAntigravityChat
};
