import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  antigravityItems,
  conversationProject,
  syncProjectMirror
} from "./chunk-KU5RB22T.mjs";
import {
  CONVERSATION_BYTES,
  HISTORY_BATCH_MS,
  decodeBytes,
  decodeHistoryRow,
  encodeBytes,
  encodeText,
  historyReadStatus,
  indexedConversationText,
  openHistoryReader,
  registerHistoryFunctions
} from "./chunk-7QKZLAYZ.mjs";
import {
  conversationPageSchema
} from "./chunk-3CXCL26P.mjs";
import {
  observeAskToolRecord,
  readArchivedJobSnapshot
} from "./chunk-VFF2QDC7.mjs";
import {
  object,
  parse,
  safeFile
} from "./chunk-TFQZM67X.mjs";
import {
  fileSignature,
  jobArchivePath,
  readJsonSnapshot
} from "./chunk-NWPQJULH.mjs";

// src/core/conversations.ts
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
  watch
} from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var JOB_SNAPSHOTS_PER_TICK = 16;
var hash = (b) => createHash("sha256").update(b).digest("hex");
var fold = (s) => s.normalize("NFKD").replace(new RegExp("\\p{M}", "gu"), "").toLowerCase();
var ConversationIngestor = class {
  constructor(db, home, paths, source = db) {
    this.db = db;
    this.home = home;
    this.paths = paths;
    this.source = source;
    this.encoded = !!db.prepare("SELECT 1 FROM pragma_table_info('conversation_records') WHERE name='raw_codec'").get();
    this.fts = !!db.prepare("SELECT name FROM sqlite_master WHERE name='history_fts'").get();
    if (this.encoded) registerHistoryFunctions(db);
    this.checked = Number(
      db.prepare("SELECT coalesce(max(checked),0) n FROM (SELECT checked FROM conversation_sources UNION ALL SELECT checked FROM conversation_projects)").get().n
    );
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
  jobQueue = [];
  watchers = [];
  /** Called on a watched CLI transcript change, so an idle background worker can wake early (AB-147). */
  onChange;
  watched = /* @__PURE__ */ new Set();
  dirty = /* @__PURE__ */ new Set();
  idleSources = 0;
  encoded;
  fts;
  watchRoots() {
    for (const root of [
      join(this.paths.claude, "projects"),
      join(this.paths.codex, "sessions"),
      this.paths.opencode,
      ...this.paths.antigravity ? [join(this.paths.antigravity, "brain")] : []
    ]) {
      if (this.watched.has(root)) continue;
      try {
        const watcher = watch(
          root,
          { recursive: true, persistent: false },
          (_, name) => {
            if (name && this.dirty.size < 2048)
              this.dirty.add(join(root, String(name)));
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
    return this.jobQueue.length > 0 || this.idleSources < Number(
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
      "INSERT INTO history_cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor"
    ).run(key, cursor);
  }
  conversation(agent, session, cwd, child) {
    const id = `${agent}:${child ? `${session}:native:${child}` : session}`;
    const project = conversationProject(cwd);
    this.db.prepare(
      `INSERT INTO conversations(id,agent,session,parent,project) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project=CASE WHEN excluded.project<>'' THEN excluded.project ELSE conversations.project END`
    ).run(
      id,
      agent,
      child ?? session,
      child ? `${agent}:${session}` : null,
      project
    );
    if (project)
      this.db.prepare(
        "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
      ).run(project);
    return id;
  }
  register() {
    const key = "durable-files";
    const files = this.db.prepare(
      "SELECT rowid AS n,* FROM history_files WHERE rowid>? ORDER BY rowid LIMIT 32"
    ).all(Number(this.cursor(key)));
    for (const file of files) {
      const session = String(file.session), agent = String(file.agent), child = file.child ? String(file.child) : null;
      const kind = String(file.kind);
      const id = kind === "transcript" ? this.conversation(agent, session, String(file.cwd), child) : `bridge:${kind}:${kind === "run" ? basename(String(file.path)).replace(/\.(?:log|json)(?:-\d+-[\w-]+)?$/, "") : basename(String(file.path))}`;
      if (kind !== "transcript")
        this.db.prepare(
          "INSERT OR IGNORE INTO conversations(id,agent,session,kind) VALUES(?,?,?,?)"
        ).run(id, agent, session, kind === "context" ? "progress" : kind);
      this.db.prepare(
        "INSERT OR IGNORE INTO conversation_sources(id,path,conversation,format) VALUES(?,?,?,?)"
      ).run(
        String(file.path),
        String(file.path),
        id,
        kind === "context" ? "journal" : kind === "approval" ? "approval" : agent === "opencode" ? "sqlite" : "jsonl"
      );
      this.advance(key, String(file.n));
    }
    for (const binding of this.db.prepare("SELECT * FROM conversation_bindings WHERE pending=1 LIMIT 32").all()) {
      const id = this.conversation(
        String(binding.agent),
        String(binding.session),
        String(binding.cwd),
        null
      );
      if (binding.job)
        this.db.prepare("UPDATE conversations SET job=? WHERE id=?").run(binding.job, id);
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
    for (const file of this.db.prepare(
      `SELECT c.id,f.cwd FROM conversations c JOIN conversation_sources s ON s.conversation=c.id JOIN history_files f ON f.path=s.path WHERE c.project='' AND f.cwd<>'' LIMIT 32`
    ).all()) {
      const project = conversationProject(String(file.cwd));
      this.db.prepare("UPDATE conversations SET project=? WHERE id=?").run(project, file.id);
      if (project)
        this.db.prepare(
          "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
        ).run(project);
    }
  }
  jobs() {
    if (Date.now() - this.jobsAt < 3e4 && (this.jobsSignature || this.jobQueue.length)) return;
    this.jobsAt = Date.now();
    const path = join(this.home, "jobs.json");
    const archive = jobArchivePath(path);
    const stores = [path, archive, `${archive}-wal`, join(this.home, "archive")].map((file) => {
      try {
        return fileSignature(statSync(file));
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
    const id = `bridge:job:${job.name}`;
    this.db.prepare(
      "INSERT INTO conversations(id,agent,session,project,job,kind) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session=excluded.session,project=CASE WHEN excluded.project<>'' THEN excluded.project ELSE conversations.project END"
    ).run(
      id,
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
      id,
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
    const body = indexedConversationText(raw), stored = body === raw.toString("utf8") ? "" : body;
    const encoded = this.encoded ? encodeBytes(raw) : null;
    const result = encoded ? this.db.prepare("INSERT OR IGNORE INTO conversation_records(source,generation,offset,conversation,at,raw,raw_codec,body,part) VALUES(?,?,?,?,?,?,?,?,?)").run(source, generation, offset, conversation, at, encoded.value, encoded.codec, stored, part) : this.db.prepare("INSERT OR IGNORE INTO conversation_records(source,generation,offset,conversation,at,raw,body,part) VALUES(?,?,?,?,?,?,?,?)").run(source, generation, offset, conversation, at, raw, stored, part);
    const record = Number(result.changes) ? Number(result.lastInsertRowid) : Number(this.db.prepare("SELECT id FROM conversation_records WHERE source=? AND generation=? AND offset=?").get(source, generation, offset).id);
    const retained = this.db.prepare("SELECT * FROM conversation_records WHERE id=?").get(record);
    if (!decodeBytes(retained.raw, retained.raw_codec).equals(raw)) {
      throw Object.assign(new Error(`History import verification failed at ${source}:${generation}:${offset}; cursor not advanced, originals retained`), { code: "HISTORY_IMPORT_VERIFICATION_FAILED" });
    }
    const native = this.db.prepare("SELECT kind,agent FROM conversations WHERE id=?").get(conversation);
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
    const id = `durable:${record}`, c = this.db.prepare("SELECT * FROM conversations WHERE id=?").get(conversation);
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
      recordJob = binding?.job ?? (/^(claude|codex|opencode|antigravity)-job-/.test(String(metadata.from_name)) ? metadata.from_name : recordSession === c.session ? recordJob : null);
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
      id,
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
        this.db.prepare("INSERT OR IGNORE INTO history_tags VALUES(?,?,?)").run(id, type, value);
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
    const id = `bridge:${table === "messages" ? row.conversation_id : `decision:${row.topic}`}`;
    const binding = this.db.prepare(
      "SELECT * FROM conversation_bindings WHERE session=? OR session IN (SELECT session FROM history_sessions WHERE alias=?) LIMIT 1"
    ).get(session, session);
    const project = binding ? conversationProject(String(binding.cwd)) : "";
    this.db.prepare(
      "INSERT OR IGNORE INTO conversations(id,agent,session,project,job,kind) VALUES(?,?,?,?,?,?)"
    ).run(id, agent, session, project, binding?.job ?? null, kind);
    if (project)
      this.db.prepare(
        "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
      ).run(project);
    const { n: _cursorRowid, ...record } = row;
    const raw = Buffer.from(JSON.stringify(record)), fingerprint = createHash("sha256").update(raw).digest("hex"), generation = 1 + Number.parseInt(fingerprint.slice(0, 12), 16), offset = saved.fingerprint && saved.fingerprint !== fingerprint ? 0 : Number(saved.offset ?? 0), chunk = raw.subarray(offset, offset + CONVERSATION_BYTES);
    this.put(
      `${table}:${row.id}:${row.recipient ?? row.revision}`,
      generation,
      offset,
      id,
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
      const path = join(this.home, "archive.db");
      if (existsSync(path)) {
        const archive = new DatabaseSync(path, { readOnly: true, timeout: 50 });
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
    const id = `bridge:${row.conversation_id}`;
    const binding = this.db.prepare(
      "SELECT * FROM conversation_bindings WHERE session=? OR session IN (SELECT session FROM history_sessions WHERE alias=?) LIMIT 1"
    ).get(row.from_id, row.from_id);
    const project = binding ? conversationProject(String(binding.cwd)) : "";
    this.db.prepare(
      "INSERT OR IGNORE INTO conversations(id,agent,session,project,job,kind) VALUES(?,?,?,?,?,?)"
    ).run(
      id,
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
    ), fingerprint = createHash("sha256").update(raw).digest("hex"), generation = 1 + Number.parseInt(fingerprint.slice(0, 12), 16), offset = saved.fingerprint && saved.fingerprint !== fingerprint ? 0 : Number(saved.offset ?? 0), chunk = raw.subarray(offset, offset + CONVERSATION_BYTES);
    this.put(
      `messages:${row.id}:${envelope.recipient}`,
      generation,
      offset,
      id,
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
      fd = openSync(source.path, "r");
      const stat = fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let offset = Number(source.offset), generation = Number(source.generation);
      const anchor = Buffer.alloc(Math.min(64, offset));
      if (offset && offset <= stat.size)
        readSync(fd, anchor, 0, anchor.length, offset - anchor.length);
      if (offset > stat.size || source.identity && source.identity !== identity || offset && source.anchor && source.anchor !== hash(anchor)) {
        offset = 0;
        generation++;
      }
      const data = Buffer.alloc(
        Math.min(CONVERSATION_BYTES, Math.max(0, stat.size - offset))
      );
      let bytes = readSync(fd, data, 0, data.length, offset);
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
            const id = row.job ? `bridge:job:${row.job}` : source.conversation;
            const project = conversationProject(
              typeof row.project === "string" ? row.project : ""
            );
            this.db.prepare(
              "INSERT INTO conversations(id,agent,session,project,job,kind) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project=CASE WHEN excluded.project<>'' THEN excluded.project ELSE conversations.project END"
            ).run(
              id,
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
            fragment = { id, kind: row.kind ?? "approval" };
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
        this.put(
          source.id,
          generation,
          offset,
          source.conversation,
          data.subarray(0, bytes),
          stat.mtimeMs
        );
      }
      offset += bytes;
      const tail = Buffer.alloc(Math.min(64, offset));
      if (offset) readSync(fd, tail, 0, tail.length, offset - tail.length);
      this.db.prepare(
        "UPDATE conversation_sources SET offset=?,generation=?,identity=?,anchor=? WHERE id=?"
      ).run(offset, generation, identity, hash(tail), source.id);
      return bytes ? 1 : 0;
    } finally {
      if (fd !== void 0) closeSync(fd);
    }
  }
  journal(source) {
    return this.jsonl(source);
  }
  sqlite(source) {
    const path = safeFile(
      this.paths.opencode,
      join(this.paths.opencode, "opencode.db")
    );
    if (!path) return 0;
    const input = new DatabaseSync(path, { readOnly: true, timeout: 50 });
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
    this.register();
    this.jobs();
    const nextJob = this.jobQueue[0]?.job;
    if (nextJob)
      conversationProject(String(nextJob.cwd ?? nextJob.workdir ?? ""));
    let work = 0;
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
      const archive = join(this.home, "archive.db");
      const archiveSignature = [archive, `${archive}-wal`].map((file) => {
        try {
          return fileSignature(statSync(file));
        } catch {
          return "missing";
        }
      }).join("|");
      if (existsSync(archive) && archiveSignature !== this.quietArchive) {
        const input = new DatabaseSync(archive, {
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
        `SELECT c.id,p.job,p.project FROM conversations c JOIN conversations p ON c.parent=p.id WHERE (c.job IS NULL AND p.job IS NOT NULL) OR (c.project='' AND p.project<>'') LIMIT 100`
      ).all()) {
        this.db.prepare(
          "UPDATE conversations SET job=coalesce(job,?),project=CASE WHEN project='' THEN ? ELSE project END WHERE id=?"
        ).run(c.job, c.project, c.id);
        if (c.project)
          this.db.prepare(
            "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)"
          ).run(c.project);
        work++;
      }
      for (const path of [...this.dirty].slice(0, 32)) {
        this.dirty.delete(path);
        if (path.startsWith(this.paths.opencode))
          this.db.prepare(
            "UPDATE conversation_sources SET checked=-1 WHERE format='sqlite'"
          ).run();
        else
          this.db.prepare("UPDATE conversation_sources SET checked=-1 WHERE path=?").run(path);
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
          String(record.body) || indexedConversationText(record.raw),
          Number(row.at),
          Number(row.offset)
        );
        this.advance("durable-index-rows", String(row.id));
        work++;
      }
      const sourceDeadline = Date.now() + HISTORY_BATCH_MS;
      for (const source of this.db.prepare(
        "SELECT * FROM conversation_sources ORDER BY checked,id LIMIT 2"
      ).all()) {
        if (Date.now() >= sourceDeadline) break;
        try {
          const amount = source.format === "jsonl" ? this.jsonl(source) : source.format === "sqlite" ? this.sqlite(source) : this.journal(source);
          work += amount;
          this.idleSources = amount ? 0 : this.idleSources + 1;
        } catch (err) {
          if (!["ENOENT", "EACCES", "EPERM"].includes(
            err.code ?? ""
          ))
            throw err;
        }
        this.db.prepare("UPDATE conversation_sources SET checked=? WHERE id=?").run(++this.checked, source.id);
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
  if (!existsSync(file)) return { conversation: null, records: [], next: null, ...migration };
  const db = openHistoryReader(file);
  try {
    return { ...readConversation(db, input), ...migration };
  } finally {
    db.close();
  }
}

export {
  ConversationIngestor,
  foreignMirrorRecord,
  readConversation,
  readConversationFile
};
