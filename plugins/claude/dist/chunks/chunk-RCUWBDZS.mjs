import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  conversationProject
} from "./chunk-QZVVT2LZ.mjs";
import {
  HISTORY_BATCH_MS,
  clearHistoryDocuments,
  decodeText,
  encodeText,
  historyReadPath,
  historyReadStatus,
  historyReady,
  historyV1Readable,
  legacyReadNotice,
  openHistoryReader,
  registerHistoryFunctions
} from "./chunk-JARSXSHL.mjs";
import {
  claudeItems,
  codexItems,
  readTranscript
} from "./chunk-AJ3G2ZXC.mjs";
import {
  antigravityItems
} from "./chunk-KQJ5KQYW.mjs";
import {
  historySearchSchema
} from "./chunk-CNEMWRSZ.mjs";
import {
  QUESTIONS_FILE
} from "./chunk-R7V7GLO5.mjs";
import {
  TRANSCRIPT_ID,
  object,
  parse,
  readHead,
  readJsonl,
  safeFile,
  transcriptPaths
} from "./chunk-WM3QOXKL.mjs";
import {
  ARCHIVE_DB_NAME,
  fileSignature
} from "./chunk-6TVBIBIR.mjs";
import {
  MAX_BODY_CHARS
} from "./chunk-AH7X4KST.mjs";

// src/core/savepoint.ts
function cleanupSavepoint(db, name, rollback, original) {
  try {
    db.exec(`${rollback ? `ROLLBACK TO ${name}; ` : ""}RELEASE ${name}`);
  } catch {
  }
  throw original;
}

// src/core/history.ts
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, opendirSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var HISTORY_TICK_MS = 2e3;
var HISTORY_ROWS_PER_SOURCE = 100;
var HISTORY_FILES_PER_TICK = 2;
var HISTORY_DISCOVERY_PER_TICK = 32;
var HISTORY_CHUNK_BYTES = 64 * 1024;
var HISTORY_SNIPPET_CHARS = 320;
var HISTORY_MAX_QUERY_CHARS = 1e3;
var HISTORY_MAX_LIMIT = 50;
var HISTORY_DEFAULT_LIMIT = 10;
var HISTORY_MAX_BODY_CHARS = MAX_BODY_CHARS;
var HISTORY_MAX_METADATA_BYTES = 64 * 1024;
var HISTORY_MAX_TERMS = 32;
var HISTORY_SNIPPET_CONTEXT_CHARS = HISTORY_SNIPPET_CHARS / 4;
var HISTORY_RESCAN_MS = 3e4;
var HISTORY_RESCAN_MAX_MS = 2 * 6e4;
var HISTORY_STAT_FILES_PER_TICK = 64;
var HISTORY_READ_TIMEOUT_MS = 100;
var HISTORY_BATCH_BODY_BYTES = 512 * 1024;
function folded(text) {
  return text.normalize("NFKD").replace(new RegExp("\\p{M}", "gu"), "").toLowerCase();
}
function terms(query) {
  return folded(query).match(/[\p{L}\p{N}_]+/gu)?.slice(0, HISTORY_MAX_TERMS) ?? [];
}
var enc = encodeURIComponent;
var RUN_FILE = /\.log(?:-\d+-[\w-]+)?$/;
var HistoryIndex = class _HistoryIndex {
  constructor(db, home, paths, source = db, peerSink) {
    this.db = db;
    this.home = home;
    this.source = source;
    this.peerSink = peerSink;
    this.paths = paths ?? transcriptPaths();
    this.engine = db.prepare("SELECT name FROM sqlite_master WHERE name = 'history_fts'").get() ? "fts5" : "plain";
    registerHistoryFunctions(db);
    this.checked = Number(db.prepare("SELECT coalesce(max(checked),0) AS n FROM history_files").get().n);
  }
  db;
  home;
  source;
  peerSink;
  engine;
  queue = [];
  walk = null;
  lastDiscovery = 0;
  rescanMs = HISTORY_RESCAN_MS;
  sweepWork = 0;
  quietSources = /* @__PURE__ */ new Map();
  checked = 0;
  idleFiles = 0;
  opencodeComplete = false;
  packedComplete = false;
  heads = /* @__PURE__ */ new Map();
  paths;
  /** History store v2 keeps document bodies compressed (body_codec) and folded only where it differs. */
  encodedSchema = -1;
  encodedValue = false;
  /** Re-read when the schema changes: a store deferred at v1 (AB-225) can be upgraded in place under this connection. */
  get encoded() {
    const schema = Number(this.db.prepare("PRAGMA schema_version").get().schema_version);
    if (schema !== this.encodedSchema) {
      this.encodedSchema = schema;
      this.encodedValue = !!this.db.prepare("SELECT 1 FROM pragma_table_info('history_documents') WHERE name='body_codec'").get();
    }
    return this.encodedValue;
  }
  deadline = Infinity;
  get database() {
    return this.source !== this.db && !historyReady(this.db) && !historyV1Readable(this.db) ? this.source : this.db;
  }
  /** Why reads currently come from the legacy store, if they do (AB-224). */
  get legacyReadNotice() {
    return this.database !== this.db ? legacyReadNotice(this.db) : void 0;
  }
  /** Writable isolated storage for explicit offline maintenance, regardless of read fallback. */
  get storageDatabase() {
    return this.db;
  }
  rememberPeer(peer) {
    if (this.peerSink) {
      this.peerSink(peer);
      return;
    }
    if (!peer.sessionId) return;
    const job = /^(claude|codex|opencode|antigravity)-job-/.test(peer.name) ? peer.name : null;
    for (const alias of [peer.id, peer.name, peer.sessionId]) this.rememberSession(alias, peer.sessionId, job);
    if (peer.cwd && peer.agent && this.db.prepare("SELECT name FROM sqlite_master WHERE name='conversation_bindings'").get()) {
      this.db.prepare(`INSERT INTO conversation_bindings(session,agent,cwd,job) VALUES(?,?,?,?) ON CONFLICT(session,agent) DO UPDATE SET cwd=excluded.cwd,job=coalesce(excluded.job,conversation_bindings.job),pending=1`).run(peer.sessionId, peer.agent, peer.cwd, job);
    }
  }
  rememberSession(alias, session, job) {
    this.db.prepare(`INSERT INTO history_sessions VALUES (?,?,?) ON CONFLICT(alias) DO UPDATE SET
      session=excluded.session,job=coalesce(excluded.job,history_sessions.job)`).run(alias, session, job);
  }
  cursor(source) {
    return String(this.db.prepare("SELECT cursor FROM history_cursors WHERE source = ?").get(source)?.cursor ?? "0");
  }
  advance(source, cursor) {
    this.db.prepare("INSERT INTO history_cursors VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(source, cursor);
  }
  put(doc, sessions = [], jobs = []) {
    const body = doc.body.slice(0, HISTORY_MAX_BODY_CHARS), searchable = folded(body);
    const stored = this.encoded ? encodeText(body) : { value: body, codec: 0 };
    const foldedValue = this.encoded && this.engine === "fts5" ? null : searchable;
    this.db.exec("SAVEPOINT history_document");
    try {
      if (this.encoded) this.db.prepare(`INSERT INTO history_documents (id,kind,agent,at,body,body_codec,folded,link,message,job,run,session,cursor)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,body_codec=excluded.body_codec,folded=excluded.folded,
        agent=excluded.agent,at=excluded.at,job=excluded.job,session=excluded.session,link=excluded.link,cursor=excluded.cursor`).run(doc.id, doc.kind, doc.agent, doc.at, stored.value, stored.codec, foldedValue, doc.link, doc.message, doc.job, doc.run, doc.session, doc.cursor);
      else this.db.prepare(`INSERT INTO history_documents (id,kind,agent,at,body,folded,link,message,job,run,session,cursor)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,folded=excluded.folded,
        agent=excluded.agent,at=excluded.at,job=excluded.job,session=excluded.session,link=excluded.link,cursor=excluded.cursor`).run(doc.id, doc.kind, doc.agent, doc.at, body, searchable, doc.link, doc.message, doc.job, doc.run, doc.session, doc.cursor);
      for (const [type, values] of [["session", [...sessions, doc.session]], ["job", [...jobs, doc.job]]]) {
        for (const value of values) if (value) this.db.prepare("INSERT OR IGNORE INTO history_tags VALUES (?,?,?)").run(doc.id, type, value);
      }
      this.db.exec("RELEASE history_document");
    } catch (err) {
      cleanupSavepoint(this.db, "history_document", true, err);
    }
  }
  message(row) {
    const sessions = [row.from_id, row.from_name, row.recipient, row.to_target].filter((s) => typeof s === "string");
    const jobs = sessions.filter((s) => /^(claude|codex|opencode|antigravity)-job-/.test(s));
    this.put({
      id: `message:${row.id}`,
      kind: "message",
      agent: row.from_agent,
      at: Number(row.created_at),
      body: row.body,
      link: `/?message=${enc(row.id)}`,
      message: row.id,
      job: jobs[0] ?? null,
      run: null,
      session: row.from_id,
      cursor: null
    }, sessions, jobs);
  }
  rows(source, db, table, consume) {
    const after = Number(this.cursor(source));
    let count = 0, bytes = 0, cursor = after;
    const batch = ["messages", "history_pending", "decisions"].includes(table);
    let failed = false;
    if (batch) this.db.exec("SAVEPOINT history_rows");
    try {
      for (const row of db.prepare(`SELECT rowid AS history_rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`).iterate(after, HISTORY_ROWS_PER_SOURCE)) {
        consume(row);
        cursor = Number(row.history_rowid);
        count++;
        bytes += Buffer.byteLength(typeof row.body === "string" ? row.body : "");
        if (bytes >= HISTORY_BATCH_BODY_BYTES || Date.now() >= this.deadline) break;
      }
      if (count) this.advance(source, String(cursor));
      return count;
    } catch (err) {
      failed = true;
      if (batch) cleanupSavepoint(this.db, "history_rows", false, err);
      throw err;
    } finally {
      if (batch && !failed) this.db.exec("RELEASE history_rows");
    }
  }
  /** Fixed budgets; idempotent documents are written before advancing their cursors. */
  tick(idleAware = false) {
    this.deadline = Date.now() + HISTORY_BATCH_MS;
    const fileCount = Number(this.db.prepare("SELECT count(*) AS n FROM history_files").get().n);
    if (!idleAware && this.idleFiles >= fileCount) this.idleFiles = 0;
    let work = 0, walked = 0;
    {
      work += this.rows("messages", this.source, "messages", (row) => this.message(row));
      if (this.source !== this.db) work += this.rows("broker-pending", this.source, "history_pending", (row) => this.message(row));
      let pendingCount = 0, pendingBytes = 0;
      let pendingFailed = false;
      this.db.exec("SAVEPOINT history_pending_batch");
      try {
        for (const row of this.db.prepare("SELECT * FROM history_pending LIMIT ?").iterate(HISTORY_ROWS_PER_SOURCE)) {
          this.message(row);
          this.db.prepare("DELETE FROM history_pending WHERE id=? AND recipient=?").run(String(row.id), String(row.recipient));
          pendingCount++;
          pendingBytes += Buffer.byteLength(String(row.body));
          if (pendingBytes >= HISTORY_BATCH_BODY_BYTES || Date.now() >= this.deadline) break;
        }
      } catch (err) {
        pendingFailed = true;
        cleanupSavepoint(this.db, "history_pending_batch", false, err);
      } finally {
        if (!pendingFailed) this.db.exec("RELEASE history_pending_batch");
      }
      work += pendingCount;
      work += this.rows("decisions", this.source, "decisions", (row) => {
        const scope = parse(row.scope), sessions = Array.isArray(scope.sessions) ? scope.sessions.filter((s) => typeof s === "string") : [];
        this.put({
          id: `decision:${row.id}`,
          kind: "decision",
          agent: row.author_agent,
          at: Number(row.created_at),
          body: `${row.topic}
${row.body}`,
          link: `/api/decisions/${enc(row.topic)}/history`,
          message: row.source_message_id,
          job: null,
          run: null,
          session: row.author_id,
          cursor: String(row.revision)
        }, [row.author_id, row.author_name, ...sessions]);
      });
      if (this.home) {
        const questionFile = join(this.home, QUESTIONS_FILE);
        if (existsSync(questionFile)) work += this.unlessQuiet(questionFile, () => {
          const questions = new DatabaseSync(questionFile, { readOnly: true, timeout: HISTORY_READ_TIMEOUT_MS });
          try {
            return this.rows("questions", questions, "question_events", (row) => {
              const q = JSON.parse(String(row.record));
              this.put(
                {
                  id: `question:${q.id}`,
                  kind: "question",
                  agent: q.askers[0]?.agent ?? "other",
                  at: q.answer?.at ?? q.askedAt,
                  body: [q.title, q.context, q.topic, ...q.options.map((o) => `${o.label}: ${o.consequence}`), q.answer?.text, q.dismissal?.reason].filter(Boolean).join("\n"),
                  link: `/#/approvals?question=${q.id}`,
                  message: null,
                  job: q.job ?? null,
                  run: null,
                  session: q.askers[0]?.session ?? null,
                  cursor: String(row.history_rowid)
                },
                q.askers.map((a) => a.session),
                q.askers.flatMap((a) => a.job ? [a.job] : [])
              );
              for (const project of q.affectedProjects) this.db.prepare("INSERT OR IGNORE INTO history_tags VALUES (?, 'project', ?)").run(`question:${q.id}`, conversationProject(project));
            });
          } finally {
            questions.close();
          }
        });
        const archivePath = join(this.home, ARCHIVE_DB_NAME);
        if (existsSync(archivePath)) work += this.unlessQuiet(archivePath, () => {
          const archive = new DatabaseSync(archivePath, { readOnly: true, timeout: HISTORY_READ_TIMEOUT_MS });
          try {
            return this.rows("archive", archive, "messages", (row) => this.message(row));
          } finally {
            archive.close();
          }
        });
        walked = this.discover(idleAware);
        work += walked;
        const files = idleAware && this.idleFiles >= fileCount ? [] : this.db.prepare("SELECT * FROM history_files ORDER BY checked,path LIMIT ?").all(idleAware ? HISTORY_STAT_FILES_PER_TICK : HISTORY_FILES_PER_TICK);
        let opened = 0;
        for (const file of files) {
          if (Date.now() >= this.deadline || opened >= HISTORY_FILES_PER_TICK) break;
          if (idleAware && this.unchangedTranscript(file)) {
            this.idleFiles++;
            this.db.prepare("UPDATE history_files SET checked=? WHERE path=?").run(++this.checked, file.path);
            continue;
          }
          opened++;
          const indexed = this.indexFile(file);
          work += indexed;
          this.idleFiles = indexed ? 0 : this.idleFiles + 1;
          this.db.prepare("UPDATE history_files SET checked=? WHERE path=?").run(++this.checked, file.path);
        }
      }
    }
    const registered = Number(this.db.prepare("SELECT count(*) AS n FROM history_files").get().n);
    this.sweepWork += work - walked + Math.max(0, registered - fileCount);
    return { work, discovering: this.walk !== null || this.queue.length > 0 || this.idleFiles < registered };
  }
  head(path, session) {
    const stat = statSync(path), identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const cached = this.heads.get(path);
    if (cached?.identity === identity && (!session || cached.value.ownerChecked || object(cached.value.payload).id === session)) return cached.value;
    let raw = cached?.identity === identity ? cached.value : readHead(path);
    if (session && object(raw.payload).id !== session) {
      const own = readJsonl(path).entries.find(({ value: value2 }) => value2.type === "session_meta" && object(value2.payload).id === session)?.value;
      if (own) raw = own;
    }
    const fields = (v) => Object.fromEntries(["id", "sessionId", "cwd", "subagent_history_start_ordinal"].filter((k) => v[k] !== void 0).map((k) => [k, v[k]]));
    const value = { ...fields(raw), payload: fields(object(raw.payload)), ownerChecked: Boolean(session) };
    if (this.heads.size >= 2048) this.heads.delete(this.heads.keys().next().value);
    this.heads.set(path, { identity, value });
    return value;
  }
  register(file) {
    if (!this.db.prepare("SELECT 1 FROM history_files WHERE path=?").get(file.path)) this.idleFiles = 0;
    this.db.prepare(`INSERT INTO history_files(path,kind,agent,session,cwd,child) VALUES (?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET session=excluded.session,cwd=excluded.cwd,child=excluded.child`).run(file.path, file.kind, file.agent, file.session, file.cwd, file.child);
  }
  /** Side databases are opened again only after they change, once a read found nothing new (AB-147). */
  unlessQuiet(file, read) {
    const signature = [file, `${file}-wal`].map((p) => {
      try {
        return fileSignature(statSync(p));
      } catch {
        return "missing";
      }
    }).join("|");
    if (this.quietSources.get(file) === signature) return 0;
    const work = read();
    if (work) this.quietSources.delete(file);
    else this.quietSources.set(file, signature);
    return work;
  }
  /** A watched transcript changed: rescan at the normal cadence again instead of the idle one. */
  wake() {
    this.rescanMs = HISTORY_RESCAN_MS;
    this.sweepWork++;
  }
  /** A transcript whose size is its cursor has nothing new; indexFile would read nothing from it either. */
  unchangedTranscript(file) {
    if (file.kind !== "transcript" || file.agent === "opencode") return false;
    const cursor = /^j:(\d+):0$/.exec(this.cursor(file.path));
    if (!cursor) return false;
    try {
      return statSync(file.path).size === Number(cursor[1]);
    } catch {
      return false;
    }
  }
  discover(idleAware = false) {
    const interval = idleAware ? this.rescanMs : HISTORY_RESCAN_MS;
    if (!this.walk && !this.queue.length && Date.now() - this.lastDiscovery >= interval) {
      this.rescanMs = this.lastDiscovery && !this.sweepWork ? Math.min(HISTORY_RESCAN_MAX_MS, this.rescanMs * 2) : HISTORY_RESCAN_MS;
      this.sweepWork = 0;
      this.lastDiscovery = Date.now();
      this.idleFiles = 0;
      this.opencodeComplete = false;
      this.packedComplete = false;
      this.queue = [
        { path: join(this.home, "context-events"), root: this.home, kind: "context", agent: "other" },
        { path: join(this.home, "approvals"), root: this.home, kind: "approval", agent: "other" },
        { path: join(this.home, "archive"), root: this.home, kind: "approval", agent: "other" },
        { path: join(this.home, "runs"), root: join(this.home, "runs"), kind: "run", agent: "other" },
        { path: join(this.paths.claude, "projects"), root: this.paths.claude, kind: "transcript", agent: "claude" },
        ...this.paths.antigravity ? [{ path: join(this.paths.antigravity, "brain"), root: this.paths.antigravity, kind: "transcript", agent: "antigravity" }] : [],
        ...["sessions", "archived_sessions"].map((dir) => ({ path: join(this.paths.codex, dir), root: this.paths.codex, kind: "transcript", agent: "codex" }))
      ];
    }
    let work = 0;
    while (work < HISTORY_DISCOVERY_PER_TICK && Date.now() < this.deadline && (this.walk || this.queue.length)) {
      work++;
      if (!this.walk) {
        const entry2 = this.queue.shift();
        try {
          this.walk = { entry: entry2, dir: opendirSync(entry2.path) };
        } catch {
          continue;
        }
      }
      const item = this.walk.dir.readSync(), entry = this.walk.entry;
      if (!item) {
        this.walk.dir.closeSync();
        this.walk = null;
        continue;
      }
      const path2 = join(entry.path, item.name);
      if (item.isDirectory()) {
        this.queue.push({ ...entry, path: path2 });
        continue;
      }
      if (!item.isFile() || !safeFile(entry.root, path2)) continue;
      if (entry.kind === "context" && item.name.endsWith(".jsonl") || entry.kind === "approval" && /^.*\.json(?:-.*)?$/.test(item.name) && (entry.path.includes("approvals") || /^.*approval/.test(item.name))) {
        this.register({ path: path2, kind: entry.kind, agent: "other", session: null, cwd: "", child: null });
      } else if (entry.kind === "run" && /\.(?:log|json)(?:-\d+-[\w-]+)?$/.test(item.name)) {
        this.register({ path: path2, kind: "run", agent: /-(claude|codex|opencode|antigravity)-/.exec(item.name)?.[1] ?? "other", session: null, cwd: "", child: null });
      } else if (entry.kind === "transcript" && item.name.endsWith(".jsonl")) {
        if (entry.agent === "antigravity" && item.name !== "transcript.jsonl") continue;
        const head = this.head(path2), meta = entry.agent === "codex" ? object(head.payload) : head;
        const rolloutId = entry.agent === "codex" ? /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(item.name)?.[1] : void 0;
        const id = entry.agent === "antigravity" ? basename(dirname(dirname(entry.path))) : rolloutId ?? (typeof meta.id === "string" ? meta.id : typeof meta.sessionId === "string" ? meta.sessionId : basename(path2, ".jsonl"));
        if (!TRANSCRIPT_ID.test(id)) continue;
        const child = entry.agent === "claude" && basename(entry.path) === "subagents" ? basename(path2, ".jsonl").replace(/^agent-/, "") : null;
        this.register({ path: path2, kind: "transcript", agent: entry.agent, session: child ? basename(dirname(entry.path)) : id, cwd: typeof meta.cwd === "string" ? meta.cwd : "", child });
      }
    }
    work += this.discoverPackedRuns();
    const path = safeFile(this.paths.opencode, join(this.paths.opencode, "opencode.db"));
    if (path && !this.opencodeComplete) {
      const db = new DatabaseSync(path, { readOnly: true, timeout: HISTORY_READ_TIMEOUT_MS });
      try {
        const after = this.cursor("opencode-discovery");
        const rows = db.prepare("SELECT * FROM session WHERE id > ? ORDER BY id LIMIT ?").all(after === "0" ? "" : after, HISTORY_DISCOVERY_PER_TICK);
        for (const row of rows) if (TRANSCRIPT_ID.test(String(row.id))) this.register({ path: `opencode:${row.id}`, kind: "transcript", agent: "opencode", session: String(row.id), cwd: String(row.directory ?? ""), child: null });
        this.advance("opencode-discovery", rows.length ? String(rows.at(-1).id) : "0");
        if (!rows.length) this.opencodeComplete = true;
        work += rows.length;
      } finally {
        db.close();
      }
    }
    return work;
  }
  /** Packed finished runs live in cold storage, outside runs/ (AB-208). Their index rows in bridge.db name the
   * retained originals, so a reindex finds them without walking cold storage (AB-227). */
  discoverPackedRuns() {
    if (this.packedComplete || !this.home || this.source === this.db) return 0;
    if (!this.source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bridge_metadata'").get()) {
      this.packedComplete = true;
      return 0;
    }
    const after = this.cursor("packed-run-discovery");
    const rows = this.source.prepare("SELECT key,json_extract(value,'$.file') AS file FROM bridge_metadata WHERE domain='finished-runs' AND key>? ORDER BY key LIMIT ?").all(after === "0" ? "" : after, HISTORY_DISCOVERY_PER_TICK);
    const cold = join(this.home, "cold", "originals");
    for (const row of rows) {
      const file = typeof row.file === "string" ? row.file : "";
      if (!RUN_FILE.test(file) || !safeFile(cold, file)) continue;
      this.register({ path: file, kind: "run", agent: /-(claude|codex|opencode|antigravity)-/.exec(String(row.key))?.[1] ?? "other", session: null, cwd: "", child: null });
    }
    this.advance("packed-run-discovery", rows.length ? String(rows.at(-1).key) : "0");
    if (!rows.length) this.packedComplete = true;
    return rows.length;
  }
  runRoot(path) {
    const cold = join(this.home, "cold", "originals");
    return safeFile(cold, path) ? cold : join(this.home, "runs");
  }
  transcript(doc, item, cursor, ordinal) {
    const body = item.text ?? [item.tool, item.summary, item.subagent?.title].filter(Boolean).join("\n");
    if (!body) return;
    const id = `transcript:${doc.agent}:${doc.child ?? doc.session}:${item.id ?? `${cursor}:${ordinal}`}`;
    this.put({
      id,
      kind: "transcript",
      agent: doc.agent,
      at: item.at,
      body,
      message: null,
      job: null,
      run: null,
      session: doc.session,
      cursor,
      link: `/?session=${enc(doc.session)}&agent=${doc.agent}&from=${enc(cursor)}${doc.child ? `&child=${enc(doc.child)}` : ""}`
    });
  }
  indexFile(file) {
    if (file.kind === "context" || file.kind === "approval" || file.kind === "run" && /\.json(?:-.*)?$/.test(file.path)) return 0;
    if (file.agent !== "opencode") {
      const root = file.kind === "run" ? this.runRoot(file.path) : this.paths[file.agent];
      if (!root) return 0;
      if (!safeFile(root, file.path)) return 0;
    }
    const from = this.cursor(file.path);
    if (file.agent === "opencode") {
      const page = readTranscript({ agent: "opencode", sessionId: file.session, cwd: file.cwd }, from, void 0, this.paths);
      if (!page) return 0;
      page.items.forEach((item, i) => this.transcript(file, item, from, i));
      this.advance(file.path, page.next);
      return page.items.length || (page.next !== from ? 1 : 0);
    }
    if (file.kind === "transcript") {
      const page = readJsonl(file.path, from, HISTORY_CHUNK_BYTES);
      const head = file.agent === "codex" ? object(this.head(file.path, file.session ?? void 0).payload) : {};
      const metadata = head.id === file.session ? head : {};
      const start = metadata.subagent_history_start_ordinal;
      for (const row of page.entries) {
        const target = file.agent === "claude" && row.value.isSidechain === true && typeof row.value.agentId === "string" && TRANSCRIPT_ID.test(row.value.agentId) ? { ...file, child: row.value.agentId } : file;
        if (typeof start === "number" && typeof row.value.ordinal === "number" && row.value.ordinal < start) continue;
        const items = file.agent === "antigravity" ? antigravityItems(row.value) : file.agent === "claude" ? claudeItems(row.value) : codexItems(row.value);
        items.forEach((item, i) => this.transcript(target, item, `j:${row.offset}:0`, i));
      }
      this.advance(file.path, page.next);
      return page.entries.length || (page.next !== from ? 1 : 0);
    }
    let fd;
    try {
      fd = openSync(file.path, "r");
      const stat = fstatSync(fd), offset = Number(from) > stat.size ? 0 : Number(from);
      const buffer = Buffer.alloc(HISTORY_CHUNK_BYTES);
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      const end = buffer.subarray(0, bytes).lastIndexOf(10);
      const length = end >= 0 ? end + 1 : bytes === HISTORY_CHUNK_BYTES ? bytes : 0;
      let meta = {};
      let metaText = "";
      const metaPath = file.path.replace(/\.log(?:-\d+-[\w-]+)?$/, ".json");
      const safeMeta = safeFile(this.runRoot(file.path), metaPath);
      if (safeMeta) {
        const metaFd = openSync(safeMeta, "r");
        try {
          const size = fstatSync(metaFd).size;
          if (size <= HISTORY_MAX_METADATA_BYTES) {
            const buffer2 = Buffer.alloc(size), length2 = readSync(metaFd, buffer2, 0, size, 0);
            metaText = buffer2.subarray(0, length2).toString("utf8");
            meta = parse(metaText);
          }
        } finally {
          closeSync(metaFd);
        }
      }
      const run = basename(file.path).replace(/(\.log)-\d+-[\w-]+$/, "$1");
      const start = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(run);
      const at = Number(meta.jobStartedAt) || (start ? Date.UTC(+start[1], +start[2] - 1, +start[3], +start[4], +start[5], +start[6]) : stat.birthtimeMs);
      const job = typeof meta.job === "string" ? meta.job : null, session = typeof meta.session === "string" ? meta.session : null;
      if (session) this.rememberSession(session, session, job);
      let metadataChanged = 0;
      if (Object.keys(meta).length) {
        const hash = createHash("sha256").update(metaText).digest("hex"), source = `metadata:${metaPath}`;
        if (hash !== this.cursor(source)) {
          this.put({
            id: `run:${run}:metadata`,
            kind: "run",
            agent: file.agent,
            at,
            body: metaText,
            link: `/api/runs/${enc(basename(run, ".log"))}?from=0`,
            message: null,
            job,
            run,
            session,
            cursor: "0"
          }, [meta.by].filter((s) => typeof s === "string"));
          this.advance(source, hash);
          metadataChanged = 1;
        }
      }
      const changed = this.db.prepare(`UPDATE history_documents SET session=?,job=? WHERE rowid IN
        (SELECT rowid FROM history_documents WHERE run=? AND (session IS NOT ? OR job IS NOT ?) LIMIT ?) RETURNING id`).all(session, job, run, session, job, HISTORY_ROWS_PER_SOURCE);
      for (const row of changed) if (session) this.db.prepare("INSERT OR IGNORE INTO history_tags VALUES (?, 'session', ?)").run(row.id, session);
      if (!length) return changed.length + metadataChanged;
      this.put({
        id: `run:${run}:${offset}`,
        kind: "run",
        agent: file.agent,
        at,
        body: `${typeof meta.title === "string" ? meta.title : ""}
${buffer.subarray(0, length).toString("utf8")}`,
        link: `/api/runs/${enc(basename(run, ".log"))}?from=${offset}`,
        message: null,
        job,
        run,
        session,
        cursor: String(offset)
      }, [meta.by].filter((s) => typeof s === "string"));
      this.advance(file.path, String(offset + length));
      return 1;
    } catch (err) {
      if (["ENOENT", "EACCES", "EPERM"].includes(err.code ?? "")) return 0;
      throw err;
    } finally {
      if (fd !== void 0) closeSync(fd);
    }
  }
  search(input) {
    if (this.database !== this.db) {
      const result = new _HistoryIndex(this.database, null).search(input), migration = legacyReadNotice(this.db);
      return migration ? { ...result, migration } : result;
    }
    const args = historySearchSchema.parse(input), tokens = terms(args.query);
    if (!tokens.length) return { engine: this.engine, hits: [] };
    const durable = this.db.prepare("SELECT name FROM sqlite_master WHERE name='conversation_records'").get();
    const where = [], values = [];
    if (this.engine === "fts5") {
      where.push("history_fts MATCH ?");
      values.push(tokens.map((t) => `"${t}"`).join(" AND "));
    } else for (const token of tokens) {
      where.push("instr(d.folded,?)>0");
      values.push(token);
    }
    for (const [key, value] of Object.entries(args.filters ?? {})) {
      if (key === "project") {
        where.push(durable ? "(EXISTS (SELECT 1 FROM conversation_records r JOIN conversations c ON c.id=r.conversation WHERE r.id=CAST(substr(d.id,9) AS INTEGER) AND d.id LIKE 'durable:%' AND c.project=?) OR EXISTS(SELECT 1 FROM history_tags t WHERE t.id=d.id AND t.type='project' AND t.value=?))" : "EXISTS (SELECT 1 FROM history_tags t WHERE t.id=d.id AND t.type='project' AND t.value=?)");
        values.push(value);
        if (durable) values.push(value);
      } else if (["session", "job"].includes(key)) {
        where.push(`(EXISTS (SELECT 1 FROM history_tags t WHERE t.id=d.id AND
          ((t.type=? AND t.value=?) OR (t.type='session' AND EXISTS (SELECT 1 FROM history_sessions s WHERE s.alias=t.value AND s.${key === "session" ? "session" : "job"}=?))))${durable ? ` OR EXISTS(SELECT 1 FROM conversation_records r JOIN conversations c ON c.id=r.conversation WHERE r.id=CAST(substr(d.id,9) AS INTEGER) AND d.id LIKE 'durable:%' AND c.${key}=?)` : ""})`);
        values.push(key, value, value);
        if (durable) values.push(value);
      } else if (key === "since" || key === "until") {
        where.push(`d.at ${key === "since" ? ">=" : "<="} ?`);
        values.push(value);
      } else {
        where.push(`d.${key}=?`);
        values.push(value);
      }
    }
    const joinFts = this.engine === "fts5" ? "JOIN history_fts ON history_fts.rowid=d.rowid" : "";
    const snippet = this.engine === "fts5" ? "snippet(history_fts,0,'','',' \u2026 ',40)" : this.encoded ? "ab_text(d.body,d.body_codec)" : "d.body";
    const order = this.engine === "fts5" ? "bm25(history_fts),d.at DESC,d.id" : "d.at DESC,d.id";
    const retained = durable ? ", (SELECT r.conversation FROM conversation_records r WHERE r.id=CAST(substr(d.id,9) AS INTEGER) AND d.id LIKE 'durable:%') AS conversation, (SELECT c.project FROM conversation_records r JOIN conversations c ON c.id=r.conversation WHERE r.id=CAST(substr(d.id,9) AS INTEGER) AND d.id LIKE 'durable:%') AS project" : "";
    const rows = this.db.prepare(`SELECT d.id,d.kind,d.agent,d.at,d.link,d.message,coalesce(d.job,${durable ? "(SELECT c.job FROM conversation_records r JOIN conversations c ON c.id=r.conversation WHERE r.id=CAST(substr(d.id,9) AS INTEGER) AND d.id LIKE 'durable:%')," : ""}(SELECT job FROM history_sessions s WHERE (s.session=d.session OR s.alias=d.session) AND s.job IS NOT NULL LIMIT 1)) AS job,d.run,coalesce((SELECT session FROM history_sessions s WHERE s.alias=d.session),d.session) AS session,d.cursor${retained},${snippet} AS snippet
      FROM history_documents d ${joinFts} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`).all(...values, (args.limit ?? HISTORY_DEFAULT_LIMIT) * 2 + 8);
    const seen = /* @__PURE__ */ new Set();
    return { engine: this.engine, hits: rows.flatMap((r) => {
      if (durable && r.kind === "message") {
        const record = String(r.id).startsWith("durable:") ? this.db.prepare("SELECT r.part,r.conversation,c.project FROM conversation_records r JOIN conversations c ON c.id=r.conversation WHERE r.id=?").get(Number(String(r.id).slice(8))) : this.db.prepare("SELECT r.part,r.conversation,c.project FROM conversation_records r JOIN conversations c ON c.id=r.conversation WHERE r.part=? LIMIT 1").get(`messages:${r.message}`);
        if (record) {
          r.message = String(record.part).slice("messages:".length);
          r.conversation = record.conversation;
          r.project = record.project;
        }
      }
      const identity = r.message && r.kind === "message" ? `message:${r.message}` : String(r.id);
      if (seen.has(identity)) return [];
      seen.add(identity);
      let snippet2 = String(r.snippet).replace(/\s+/g, " ");
      if (this.engine === "plain") {
        const position = folded(snippet2).indexOf(tokens[0]);
        snippet2 = snippet2.slice(Math.max(0, position - HISTORY_SNIPPET_CONTEXT_CHARS));
      }
      return [{ ...r, sourceLink: `/api/history/${enc(String(r.id))}`, snippet: snippet2.slice(0, HISTORY_SNIPPET_CHARS) }];
    }).slice(0, args.limit ?? HISTORY_DEFAULT_LIMIT) };
  }
  reset() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      clearHistoryDocuments(this.db);
      this.db.exec("DELETE FROM history_tags; DELETE FROM history_cursors WHERE source<>'legacy-record-tail'; DELETE FROM history_files;");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.close();
    this.queue = [];
    this.lastDiscovery = 0;
    this.opencodeComplete = false;
    this.packedComplete = false;
    this.idleFiles = 0;
    this.quietSources.clear();
    this.rescanMs = HISTORY_RESCAN_MS;
  }
  close() {
    this.walk?.dir.closeSync();
    this.walk = null;
  }
};
function readHistory(file, input) {
  const status = historyReadStatus(file), migration = status.migration ? { migration: status.migration } : {};
  file = status.path;
  historySearchSchema.parse(input);
  if (!existsSync(file)) return { engine: "plain", hits: [], ...migration };
  const db = openHistoryReader(file, HISTORY_READ_TIMEOUT_MS);
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='history_documents'").get()) return { engine: "plain", hits: [], ...migration };
    return { ...new HistoryIndex(db, null).search(input), ...migration };
  } finally {
    db.close();
  }
}
function readHistorySource(file, id) {
  file = historyReadPath(file);
  if (!existsSync(file)) return null;
  const db = openHistoryReader(file, HISTORY_READ_TIMEOUT_MS);
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='history_documents'").get()) return null;
    const row = db.prepare("SELECT * FROM history_documents WHERE id=?").get(id);
    if (!row) return null;
    const { body, body_codec: codec, folded: _folded, ...rest } = row;
    return { ...rest, body: decodeText(body, codec) };
  } finally {
    db.close();
  }
}

export {
  cleanupSavepoint,
  HISTORY_TICK_MS,
  HISTORY_ROWS_PER_SOURCE,
  HISTORY_FILES_PER_TICK,
  HISTORY_DISCOVERY_PER_TICK,
  HISTORY_CHUNK_BYTES,
  HISTORY_SNIPPET_CHARS,
  HISTORY_MAX_QUERY_CHARS,
  HISTORY_MAX_LIMIT,
  HISTORY_DEFAULT_LIMIT,
  HistoryIndex,
  readHistory,
  readHistorySource
};
