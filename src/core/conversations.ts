import { CONVERSATION_BYTES, conversationPageSchema, type ConversationRequest, type ConversationPage } from "./conversation-query.js";
export { CONVERSATION_BYTES, conversationPageSchema, type ConversationRequest, type ConversationPage } from "./conversation-query.js";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  object,
  parse,
  safeFile,
  type TranscriptPaths,
} from "./transcripts/common.js";
import { conversationProject, syncProjectMirror } from "./project-store.js";
import { readArchivedJobSnapshot } from "./job-archive.js";
import { readJsonSnapshot } from "./file-cache.js";
import { antigravityItems } from "./transcripts/antigravity.js";

const hash = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const fold = (s: string) =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** Preserves bytes independently of the deliberately lossy dashboard readers. Worker-only. */
export class ConversationIngestor {
  private checked = 0;
  private jobsAt = 0;
  private jobQueue: {
    job: Record<string, any>;
    raw: Buffer;
    offset: number;
    hash: string;
  }[] = [];
  private watchers: FSWatcher[] = [];
  private watched = new Set<string>();
  private dirty = new Set<string>();
  private idleSources = 0;
  private mirrorPending = new Set<string>();
  private mirrorAfter = "";
  private mirrorDiscovering = true;
  private mirrorSweepAt = 0;
  private mirrorSweepActive = true;
  constructor(
    private db: DatabaseSync,
    private home: string,
    private paths: TranscriptPaths,
    private onDirty?: (path: string) => void,
  ) {
    this.checked = Number(
      db
        .prepare("SELECT coalesce(max(checked),0) n FROM (SELECT checked FROM conversation_sources UNION ALL SELECT checked FROM conversation_projects)")
        .get()!.n,
    );
  }

  private watchRoots(): void {
    for (const root of [
      join(this.paths.claude, "projects"),
      join(this.paths.codex, "sessions"),
      this.paths.opencode,
      ...(this.paths.antigravity ? [join(this.paths.antigravity, "brain")] : []),
    ]) {
      if (this.watched.has(root)) continue;
      try {
        const watcher = watch(
          root,
          { recursive: true, persistent: false },
          (_, name) => {
            if (name && this.dirty.size < 2048) {
              const path = join(root, String(name));
              this.dirty.add(path);
              this.onDirty?.(path);
            }
          },
        );
        watcher.on("error", () => {});
        this.watchers.push(watcher);
        this.watched.add(root);
      } catch {
        /* Bounded metadata polling remains the portable fallback. */
      }
    }
  }
  close(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
  notifyJobs(): void { this.jobsAt = 0; this.mirrorSweepAt = 0; }
  private queueMirrors(force: boolean): void {
    if (!this.mirrorSweepActive && (force || Date.now() - this.mirrorSweepAt >= 30_000)) {
      this.mirrorAfter = "";
      this.mirrorDiscovering = true;
      this.mirrorSweepActive = true;
    }
    if (!this.mirrorDiscovering) return;
    const rows = this.db.prepare("SELECT project FROM conversation_projects WHERE project>? ORDER BY project LIMIT 32").all(this.mirrorAfter);
    for (const row of rows) this.mirrorPending.add(String(row.project));
    if (rows.length) this.mirrorAfter = String(rows.at(-1)!.project);
    if (rows.length < 32) this.mirrorDiscovering = false;
  }
  get discovering(): boolean {
    return (
      this.jobQueue.length > 0 ||
      this.mirrorDiscovering || this.mirrorPending.size > 0 ||
      Boolean(this.db.prepare("SELECT 1 FROM conversation_bindings WHERE pending=1 LIMIT 1").get()) ||
      this.idleSources <
        Number(
          this.db.prepare("SELECT count(*) n FROM conversation_sources").get()!
            .n,
        ) *
          2
    );
  }
  private cursor(key: string): string {
    return String(
      this.db
        .prepare("SELECT cursor FROM history_cursors WHERE source=?")
        .get(key)?.cursor ?? "0",
    );
  }
  private advance(key: string, cursor: string): void {
    this.db
      .prepare(
        "INSERT INTO history_cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor",
      )
      .run(key, cursor);
  }
  private conversation(
    agent: string,
    session: string,
    cwd: string,
    child: string | null,
  ): string {
    const id = `${agent}:${child ? `${session}:native:${child}` : session}`;
    const project = conversationProject(cwd);
    this.db
      .prepare(
        `INSERT INTO conversations(id,agent,session,parent,project) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project=CASE WHEN excluded.project<>'' THEN excluded.project ELSE conversations.project END`,
      )
      .run(
        id,
        agent,
        child ?? session,
        child ? `${agent}:${session}` : null,
        project,
      );
    if (project)
      this.mirrorPending.add(project);
    if (project)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)",
        )
        .run(project);
    return id;
  }
  private register(): void {
    const key = "durable-files";
    const files = this.db
      .prepare(
        "SELECT rowid AS n,* FROM history_files WHERE rowid>? ORDER BY rowid LIMIT 32",
      )
      .all(Number(this.cursor(key)));
    for (const file of files) {
      const session = String(file.session),
        agent = String(file.agent),
        child = file.child ? String(file.child) : null;
      const kind = String(file.kind);
      const id =
        kind === "transcript"
          ? this.conversation(agent, session, String(file.cwd), child)
          : `bridge:${kind}:${kind === "run" ? basename(String(file.path)).replace(/\.(?:log|json)(?:-\d+-[\w-]+)?$/, "") : basename(String(file.path))}`;
      if (kind !== "transcript")
        this.db
          .prepare(
            "INSERT OR IGNORE INTO conversations(id,agent,session,kind) VALUES(?,?,?,?)",
          )
          .run(id, agent, session, kind === "context" ? "progress" : kind);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO conversation_sources(id,path,conversation,format) VALUES(?,?,?,?)",
        )
        .run(
          String(file.path),
          String(file.path),
          id,
          kind === "context"
            ? "journal"
            : kind === "approval"
              ? "approval"
              : agent === "opencode"
                ? "sqlite"
                : "jsonl",
        );
      this.advance(key, String(file.n));
    }
    for (const binding of this.db
      .prepare("SELECT * FROM conversation_bindings WHERE pending=1 LIMIT 32")
      .all()) {
      const id = this.conversation(
        String(binding.agent),
        String(binding.session),
        String(binding.cwd),
        null,
      );
      if (binding.job)
        this.db
          .prepare("UPDATE conversations SET job=? WHERE id=?")
          .run(binding.job!, id);
      this.db
        .prepare(
          `UPDATE conversations SET project=?,job=coalesce(job,?) WHERE (session=? OR session IN(SELECT alias FROM history_sessions WHERE session=?)) AND (project='' OR job IS NULL)`,
        )
        .run(
          conversationProject(String(binding.cwd)),
          binding.job!,
          binding.session!,
          binding.session!,
        );
      const project = conversationProject(String(binding.cwd));
      const docs = project
        ? this.db
            .prepare(
              `SELECT id FROM history_documents d WHERE (session=? OR session IN(SELECT alias FROM history_sessions WHERE session=?)) AND (NOT EXISTS(SELECT 1 FROM history_tags t WHERE t.id=d.id AND t.type='project' AND t.value=?) OR (? IS NOT NULL AND NOT EXISTS(SELECT 1 FROM history_tags t WHERE t.id=d.id AND t.type='job' AND t.value=?))) LIMIT 32`,
            )
            .all(
              binding.session!,
              binding.session!,
              project,
              binding.job!,
              binding.job!,
            )
        : [];
      for (const doc of docs) {
        this.db
          .prepare("INSERT OR IGNORE INTO history_tags VALUES(?,?,?)")
          .run(doc.id!, "project", project);
        this.db
          .prepare(
            "UPDATE conversations SET project=? WHERE project='' AND id IN(SELECT conversation FROM conversation_records WHERE id=CAST(substr(?,9) AS INTEGER) AND ? LIKE 'durable:%')",
          )
          .run(project, doc.id!, doc.id!);
        this.db
          .prepare(
            "INSERT OR IGNORE INTO conversation_memberships SELECT ?,conversation FROM conversation_records WHERE id=CAST(substr(?,9) AS INTEGER) AND ? LIKE 'durable:%'",
          )
          .run(project, doc.id!, doc.id!);
        if (binding.job)
          this.db
            .prepare("INSERT OR IGNORE INTO history_tags VALUES(?,?,?)")
            .run(doc.id!, "job", binding.job!);
      }
      this.db
        .prepare(
          "UPDATE conversation_bindings SET pending=? WHERE session=? AND agent=?",
        )
        .run(docs.length === 32 ? 1 : 0, binding.session!, binding.agent!);
    }
    // Late hook/session identities and late metadata fill previously unknown project/job ownership.
    for (const file of this.db
      .prepare(
        `SELECT c.id,f.cwd FROM conversations c JOIN conversation_sources s ON s.conversation=c.id JOIN history_files f ON f.path=s.path WHERE c.project='' AND f.cwd<>'' LIMIT 32`,
      )
      .all()) {
      const project = conversationProject(String(file.cwd));
      this.db
        .prepare("UPDATE conversations SET project=? WHERE id=?")
        .run(project, file.id!);
      if (project)
        this.db
          .prepare(
            "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)",
          )
          .run(project);
    }
  }
  private jobs(): void {
    if (Date.now() - this.jobsAt < 30_000) return;
    this.jobsAt = Date.now();
    const path = join(this.home, "jobs.json");
    let active: Record<string, any> = {};
    try {
      active = object(readJsonSnapshot(path).value);
    } catch {
      /* Missing registry does not block CLI backfill. */
    }
    const records = [
      ...readArchivedJobSnapshot(path).jobs,
      ...(Array.isArray(active.jobs) ? active.jobs : []),
    ];
    let queuedBytes = this.jobQueue.reduce((n, item) => n + item.raw.length, 0);
    for (const job of records) {
      if (this.jobQueue.length >= 100 || queuedBytes >= 8 * 1024 * 1024) break;
      if (typeof job.name !== "string") continue;
      const raw = Buffer.from(JSON.stringify(job)),
        signature = hash(raw);
      if (
        this.cursor(`durable-job:${job.name}:${signature}`) === "1" ||
        this.jobQueue.some(
          (s) => s.job.name === job.name && s.hash === signature,
        )
      )
        continue;
      this.jobQueue.push({ job, raw, hash: signature, offset: 0 });
      queuedBytes += raw.length;
    }
  }
  private jobSnapshot(): number {
    const next = this.jobQueue[0];
    if (!next) return 0;
    const { job } = next,
      session = job.sessionId ?? job.threadId;
    const project = conversationProject(
      typeof job.cwd === "string"
        ? job.cwd
        : typeof job.workdir === "string"
          ? job.workdir
          : "",
    );
    const id = `bridge:job:${job.name}`;
    this.db
      .prepare(
        "INSERT INTO conversations(id,agent,session,project,job,kind) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session=excluded.session,project=CASE WHEN excluded.project<>'' THEN excluded.project ELSE conversations.project END",
      )
      .run(
        id,
        String(job.agent ?? "other"),
        String(session ?? ""),
        project,
        job.name,
        "report",
      );
    if (typeof session === "string")
      this.db
        .prepare(
          "UPDATE conversations SET job=?,project=CASE WHEN ?<>'' THEN ? ELSE project END WHERE session=?",
        )
        .run(job.name, project, project, session);
    if (project)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)",
        )
        .run(project);
    const chunk = next.raw.subarray(
      next.offset,
      next.offset + CONVERSATION_BYTES,
    );
    this.put(
      `job-snapshot:${job.name}:${next.hash}`,
      0,
      next.offset,
      id,
      chunk,
      Number(job.finishedAt ?? job.startedAt ?? 0),
    );
    next.offset += chunk.length;
    if (next.offset >= next.raw.length) {
      this.advance(`durable-job:${job.name}:${next.hash}`, "1");
      this.jobQueue.shift();
    }
    return 1;
  }
  private put(
    source: string,
    generation: number,
    offset: number,
    conversation: string,
    raw: Buffer,
    at: number,
    part: string | null = null,
  ): void {
    if (raw.length > CONVERSATION_BYTES) {
      for (let start = 0; start < raw.length; start += CONVERSATION_BYTES)
        this.put(
          source,
          generation,
          offset + start,
          conversation,
          raw.subarray(start, start + CONVERSATION_BYTES),
          at,
          part,
        );
      return;
    }
    const body = raw.toString("utf8");
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO conversation_records(source,generation,offset,conversation,at,raw,body,part) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(source, generation, offset, conversation, at, raw, body, part);
    if (!Number(result.changes)) return;
    this.indexRecord(
      Number(result.lastInsertRowid),
      conversation,
      body,
      at,
      offset,
    );
  }
  private indexRecord(
    record: number,
    conversation: string,
    body: string,
    at: number,
    offset: number,
  ): void {
    const id = `durable:${record}`,
      c = this.db
        .prepare("SELECT * FROM conversations WHERE id=?")
        .get(conversation)!;
    const recordInfo = this.db
      .prepare(
        "SELECT source,generation,part FROM conversation_records WHERE id=?",
      )
      .get(record)!;
    let recordAgent = c.agent!,
      recordSession = c.session!,
      recordJob = c.job!,
      recordProject = c.project!,
      recordKind = c.kind!;
    if (c.kind === "message" || c.kind === "decision") {
      const first = String(
        this.db
          .prepare(
            "SELECT body FROM conversation_records WHERE source=? AND generation=? ORDER BY offset LIMIT 1",
          )
          .get(recordInfo.source!, recordInfo.generation!)!.body,
      );
      const metadata = parse(first);
      for (const key of [
        "from_agent",
        "from_id",
        "from_name",
        "author_agent",
        "author_id",
      ])
        if (typeof metadata[key] !== "string") {
          const match = new RegExp(
            `"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`,
          ).exec(first.slice(0, 8192));
          if (match) {
            try {
              metadata[key] = JSON.parse(match[1]!);
            } catch {}
          }
        }
      recordAgent = metadata.from_agent ?? metadata.author_agent ?? recordAgent;
      recordSession = metadata.from_id ?? metadata.author_id ?? recordSession;
      const binding = this.db
        .prepare(
          "SELECT * FROM conversation_bindings WHERE session=? OR session IN(SELECT session FROM history_sessions WHERE alias=?) LIMIT 1",
        )
        .get(recordSession, recordSession);
      recordProject = binding
        ? conversationProject(String(binding.cwd))
        : recordProject;
      if (recordProject) {
        this.db
          .prepare(
            "UPDATE conversations SET project=? WHERE id=? AND project=''",
          )
          .run(recordProject, conversation);
        this.db
          .prepare(
            "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)",
          )
          .run(recordProject);
      }
      recordJob =
        binding?.job ??
        (/^(claude|codex|opencode|antigravity)-job-/.test(String(metadata.from_name))
          ? metadata.from_name
          : recordSession === c.session
            ? recordJob
            : null);
      const report = /"body"\s*:\s*"Subagent ([A-Za-z0-9][A-Za-z0-9_-]*) \(([a-z][a-z0-9_-]*)(?:, model [^"\r\n]*)?\) (?:done|failed) after \d+s\./.exec(first.slice(0, 8192));
      if (c.kind === "message" && report) {
        recordKind = "report";
        recordJob = report[1]!;
        recordAgent = report[2]!;
      }
    }
    const eventKind = String(recordInfo.part ?? "").replace(/^event:/, "");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO history_documents(id,kind,agent,at,body,folded,link,message,job,run,session,cursor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        ["approval", "progress", "report"].includes(eventKind)
          ? eventKind
          : ["approval", "progress", "report"].includes(parse(body).kind)
            ? parse(body).kind
            : recordKind,
        recordAgent,
        at,
        body,
        fold(body),
        `/api/conversations/${encodeURIComponent(conversation)}`,
        null,
        recordJob,
        null,
        recordSession,
        String(offset),
      );
    for (const [type, value] of [
      ["project", recordProject],
      ["session", recordSession],
      ["job", recordJob],
    ])
      if (value)
        this.db
          .prepare("INSERT OR IGNORE INTO history_tags VALUES(?,?,?)")
          .run(id, type!, value!);
    if (recordProject)
      this.db
        .prepare("INSERT OR IGNORE INTO conversation_memberships VALUES(?,?)")
        .run(recordProject, conversation);
  }
  private events(
    input: DatabaseSync,
    table: "messages" | "decisions",
    key: string,
  ): number {
    const saved = parse(this.cursor(key)),
      after = Number(saved.after ?? 0);
    const row = input
      .prepare(
        `SELECT rowid n,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 1`,
      )
      .get(after);
    if (!row) return 0;
    const agent = String(row.from_agent ?? row.author_agent),
      session = String(row.from_id ?? row.author_id),
      kind = table === "messages" ? "message" : "decision";
    const id = `bridge:${table === "messages" ? row.conversation_id : `decision:${row.topic}`}`;
    const binding = this.db
      .prepare(
        "SELECT * FROM conversation_bindings WHERE session=? OR session IN (SELECT session FROM history_sessions WHERE alias=?) LIMIT 1",
      )
      .get(session, session);
    const project = binding ? conversationProject(String(binding.cwd)) : "";
    this.db
      .prepare(
        "INSERT OR IGNORE INTO conversations(id,agent,session,project,job,kind) VALUES(?,?,?,?,?,?)",
      )
      .run(id, agent, session, project, binding?.job ?? null, kind);
    if (project)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)",
        )
        .run(project);
    const raw = Buffer.from(JSON.stringify(row)),
      offset = Number(saved.offset ?? 0),
      chunk = raw.subarray(offset, offset + CONVERSATION_BYTES);
    this.put(
      `${table}:${row.id}:${row.recipient ?? row.revision}`,
      0,
      offset,
      id,
      chunk,
      Number(row.created_at),
      `${table}:${row.id}`,
    );
    this.advance(
      key,
      JSON.stringify(
        offset + chunk.length >= raw.length
          ? { after: Number(row.n) }
          : { after, offset: offset + chunk.length },
      ),
    );
    return 1;
  }
  private envelopes(): number {
    const key = "durable-envelope-keys",
      saved = parse(this.cursor(key)),
      after = Number(saved.after ?? 0);
    const envelope = this.db
      .prepare(
        "SELECT * FROM conversation_envelopes WHERE id>? ORDER BY id LIMIT 1",
      )
      .get(after);
    if (!envelope) return 0;
    let row = this.db
      .prepare(
        "SELECT * FROM messages WHERE id=? ORDER BY recipient=? DESC LIMIT 1",
      )
      .get(envelope.message!, envelope.recipient!);
    if (!row) {
      const path = join(this.home, "archive.db");
      if (existsSync(path)) {
        const archive = new DatabaseSync(path, { readOnly: true, timeout: 50 });
        try {
          row = archive
            .prepare(
              "SELECT * FROM messages WHERE id=? ORDER BY recipient=? DESC LIMIT 1",
            )
            .get(envelope.message!, envelope.recipient!);
        } finally {
          archive.close();
        }
      }
    }
    if (!row) return 0; // Never discard a key while its source is transiently unavailable.
    const id = `bridge:${row.conversation_id}`;
    const binding = this.db
      .prepare(
        "SELECT * FROM conversation_bindings WHERE session=? OR session IN (SELECT session FROM history_sessions WHERE alias=?) LIMIT 1",
      )
      .get(row.from_id!, row.from_id!);
    const project = binding ? conversationProject(String(binding.cwd)) : "";
    this.db
      .prepare(
        "INSERT OR IGNORE INTO conversations(id,agent,session,project,job,kind) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        row.from_agent!,
        row.from_id!,
        project,
        binding?.job ?? null,
        "message",
      );
    if (project)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)",
        )
        .run(project);
    const raw = Buffer.from(
        JSON.stringify({ ...row, recipient: envelope.recipient }),
      ),
      offset = Number(saved.offset ?? 0),
      chunk = raw.subarray(offset, offset + CONVERSATION_BYTES);
    this.put(
      `messages:${row.id}:${envelope.recipient}`,
      0,
      offset,
      id,
      chunk,
      Number(row.created_at),
      `messages:${row.id}`,
    );
    this.advance(
      key,
      JSON.stringify(
        offset + chunk.length >= raw.length
          ? { after: Number(envelope.id) }
          : { after, offset: offset + chunk.length },
      ),
    );
    return 1;
  }
  private jsonl(source: Record<string, any>): number {
    const agent = String(source.conversation).split(":")[0] as keyof TranscriptPaths;
    const root = String(source.conversation).startsWith("bridge:")
      ? this.home
      : this.paths[agent];
    if (!root || !safeFile(root, source.path)) return 0;
    let fd: number | undefined;
    try {
      fd = openSync(source.path, "r");
      const stat = fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let offset = Number(source.offset),
        generation = Number(source.generation);
      const anchor = Buffer.alloc(Math.min(64, offset));
      if (offset && offset <= stat.size)
        readSync(fd, anchor, 0, anchor.length, offset - anchor.length);
      if (
        offset > stat.size ||
        (source.identity && source.identity !== identity) ||
        (offset && source.anchor && source.anchor !== hash(anchor))
      ) {
        offset = 0;
        generation++;
      }
      const data = Buffer.alloc(
        Math.min(CONVERSATION_BYTES, Math.max(0, stat.size - offset)),
      );
      let bytes = readSync(fd, data, 0, data.length, offset);
      if (
        source.format === "approval" &&
        bytes &&
        offset + bytes < stat.size &&
        stat.size - offset - bytes < 1024
      )
        bytes = Math.max(1, bytes - 1024);
      // Keep valid UTF-8 code points together, while the raw column retains arbitrary bytes.
      if (bytes && offset + bytes < stat.size) {
        let start = bytes - 1;
        while (start > 0 && (data[start]! & 0xc0) === 0x80) start--;
        const first = data[start]!,
          need = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
        if (bytes - start < need) bytes = start;
      }
      if (bytes) {
        if (source.format === "approval" && offset + bytes === stat.size) {
          // Legacy publishers put these short capabilities last. Reserve their
          // suffix for one chunk, remove it in the copy, and never edit the file.
          const text = data.subarray(0, bytes).toString("utf8");
          const capability =
            /,\s*"pid"\s*:\s*\d+,\s*"port"\s*:\s*\d+,\s*"token"\s*:\s*"(?:\\.|[^"\\])*"\s*}\s*$/.exec(
              text,
            );
          if (capability) {
            const start = Buffer.byteLength(text.slice(0, capability.index));
            const replacement = Buffer.from(
              " ".repeat(Buffer.byteLength(capability[0]) - 1) + "}",
            );
            replacement.copy(data, start);
          }
        }
        if (offset === 0 && /\.json(?:-.*)?$/.test(source.path)) {
          const metadata = parse(data.subarray(0, bytes).toString("utf8"));
          if (typeof metadata.job === "string") {
            const project = conversationProject(
              String(metadata.workdir ?? metadata.byCwd ?? metadata.cwd ?? ""),
            );
            this.db
              .prepare(
                "UPDATE conversations SET job=?,session=?,project=? WHERE id=?",
              )
              .run(
                metadata.job,
                String(metadata.session ?? ""),
                project,
                source.conversation,
              );
            if (project)
              this.db
                .prepare(
                  "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)",
                )
                .run(project);
          }
        }
        // Prefer record boundaries; oversized records still persist in successive raw chunks.
        const newline = data.subarray(0, bytes).lastIndexOf(10);
        if (newline >= 0) bytes = newline + 1;
        let lineOffset = offset;
        const fragmentKey = `durable-fragment:${source.id}:${generation}`;
        let fragment = parse(this.cursor(fragmentKey));
        if (Number(fragment.offset) !== offset) fragment = {};
        const lines = data.subarray(0, bytes).toString("utf8").split("\n");
        for (let ordinal = 0; ordinal < lines.length; ordinal++) {
          const line = lines[ordinal]!;
          if (!line) continue;
          const newline = ordinal < lines.length - 1;
          let row = parse(line);
          if (!Object.keys(row).length && !fragment.id) {
            // The spool and Claude put routing fields before large payloads. Keep a
            // bounded header and continue the exact raw record without buffering it.
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
              "owner",
            ]) {
              const match = new RegExp(
                `"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`,
              ).exec(line.slice(0, 8192));
              if (match) {
                try {
                  row[key] = JSON.parse(match[1]!);
                } catch {}
              }
            }
            if (/"isSidechain"\s*:\s*true/.test(line.slice(0, 8192)))
              row.isSidechain = true;
          }
          const meta = agent === "codex" ? object(row.payload) : row;
          const c = this.db
            .prepare("SELECT * FROM conversations WHERE id=?")
            .get(source.conversation)!;
          if (c.kind === "run" && typeof row.job === "string") {
            const project = conversationProject(
              typeof row.workdir === "string"
                ? row.workdir
                : typeof row.cwd === "string"
                  ? row.cwd
                  : "",
            );
            this.db
              .prepare(
                "UPDATE conversations SET job=?,session=?,project=? WHERE id=?",
              )
              .run(
                row.job,
                String(row.session ?? row.sessionId ?? ""),
                project,
                source.conversation,
              );
            if (project)
              this.db
                .prepare(
                  "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)",
                )
                .run(project);
          }
          if (
            (source.format === "journal" &&
              ["progress", "report", "approval"].includes(row.kind)) ||
            (source.format === "approval" && typeof row.id === "string")
          ) {
            const id = row.job ? `bridge:job:${row.job}` : source.conversation;
            const project = conversationProject(
              typeof row.project === "string" ? row.project : "",
            );
            this.db
              .prepare(
                "INSERT INTO conversations(id,agent,session,project,job,kind) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project=CASE WHEN excluded.project<>'' THEN excluded.project ELSE conversations.project END",
              )
              .run(
                id,
                String(row.agent ?? "other"),
                String(row.session ?? row.rootSession ?? row.owner ?? ""),
                project,
                row.job ?? null,
                row.kind ?? "approval",
              );
            if (project)
              this.db
                .prepare(
                  "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)",
                )
                .run(project);
            fragment = { id, kind: row.kind ?? "approval" };
          }
          if (
            (agent !== "codex" ||
              (row.type === "session_meta" && meta.id === c.session)) &&
            typeof meta.cwd === "string"
          ) {
            const project = conversationProject(meta.cwd);
            this.db
              .prepare("UPDATE conversations SET project=? WHERE id=?")
              .run(project, source.conversation);
            if (project)
              this.db
                .prepare(
                  "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)",
                )
                .run(project);
          }
          if (
            agent === "codex" &&
            row.type === "session_meta" &&
            meta.id === c.session
          ) {
            const spawn = object(object(meta.source).subagent).thread_spawn;
            const parent =
              object(spawn).parent_thread_id ??
              (meta.thread_source === "subagent"
                ? meta.parent_thread_id
                : null);
            if (typeof parent === "string")
              this.db
                .prepare("UPDATE conversations SET parent=? WHERE id=?")
                .run(`codex:${parent}`, source.conversation);
          }
          if (agent === "antigravity") {
            for (const item of antigravityItems(row)) {
              if (!item.subagent || item.subagent.id === c.session) continue;
              const child = this.conversation(agent, item.subagent.id, String(c.project), null);
              this.db.prepare("UPDATE conversations SET parent=? WHERE id=?").run(source.conversation, child);
            }
          }
          if (
            agent === "claude" &&
            row.isSidechain === true &&
            typeof row.agentId === "string"
          ) {
            const child = this.conversation(
              agent,
              String(c.session),
              String(c.project),
              row.agentId,
            );
            fragment = { id: child };
          }
          if (fragment.id) {
            this.put(
              `${source.id}:${source.format === "journal" ? "event" : "inline"}:${fragment.id}`,
              generation,
              lineOffset,
              fragment.id,
              Buffer.from(line + (newline ? "\n" : "")),
              stat.mtimeMs,
              fragment.kind ? `event:${fragment.kind}` : null,
            );
          }
          lineOffset += Buffer.byteLength(line) + (newline ? 1 : 0);
          if (newline) fragment = {};
        }
        this.advance(
          fragmentKey,
          JSON.stringify({ ...fragment, offset: offset + bytes }),
        );
        this.put(
          source.id,
          generation,
          offset,
          source.conversation,
          data.subarray(0, bytes),
          stat.mtimeMs,
        );
      }
      offset += bytes;
      const tail = Buffer.alloc(Math.min(64, offset));
      if (offset) readSync(fd, tail, 0, tail.length, offset - tail.length);
      this.db
        .prepare(
          "UPDATE conversation_sources SET offset=?,generation=?,identity=?,anchor=? WHERE id=?",
        )
        .run(offset, generation, identity, hash(tail), source.id);
      return bytes ? 1 : 0;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private journal(source: Record<string, any>): number {
    return this.jsonl(source);
  }
  private sqlite(source: Record<string, any>): number {
    const path = safeFile(
      this.paths.opencode,
      join(this.paths.opencode, "opencode.db"),
    );
    if (!path) return 0;
    const input = new DatabaseSync(path, { readOnly: true, timeout: 50 });
    try {
      const table = Number(source.offset) % 2 ? "message" : "part";
      this.db
        .prepare("UPDATE conversation_sources SET offset=offset+1 WHERE id=?")
        .run(source.id);
      const session = String(source.path).slice("opencode:".length),
        key = `durable-${table}:${session}`,
        saved = parse(this.cursor(key));
      const meta = input
        .prepare("SELECT * FROM session WHERE id=?")
        .get(session);
      if (meta) {
        const project = conversationProject(
          typeof meta.directory === "string" ? meta.directory : "",
        );
        this.db
          .prepare(
            "UPDATE conversations SET parent=?,project=CASE WHEN ?<>'' THEN ? ELSE project END WHERE id=?",
          )
          .run(
            meta.parent_id ? `opencode:${meta.parent_id}` : null,
            project,
            project,
            source.conversation,
          );
        if (project)
          this.db
            .prepare(
              "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)",
            )
            .run(project);
        this.put(
          `${source.id}:session:${meta.time_updated}`,
          0,
          0,
          source.conversation,
          Buffer.from(JSON.stringify(meta)),
          Number(meta.time_created),
        );
      }
      let pending = object(saved.pending);
      if (!pending.id) {
        const row = input
          .prepare(
            `SELECT p.id,p.time_updated,p.time_created FROM ${table} p WHERE p.session_id=? AND (p.time_updated>? OR (p.time_updated=? AND p.id>?)) ORDER BY p.time_updated,p.id LIMIT 1`,
          )
          .get(
            session,
            Number(saved.at ?? 0),
            Number(saved.at ?? 0),
            String(saved.id ?? ""),
          );
        if (!row) return 0;
        pending = { ...row, offset: 0 };
      }
      const row = input
        .prepare(
          `SELECT time_updated,substr(CAST(data AS BLOB),?,?) raw FROM ${table} WHERE id=? AND session_id=?`,
        )
        .get(
          Number(pending.offset) + 1,
          CONVERSATION_BYTES,
          pending.id,
          session,
        );
      if (!row) {
        this.advance(
          key,
          JSON.stringify({ at: pending.time_updated, id: pending.id }),
        );
        return 1;
      }
      if (Number(row.time_updated) !== Number(pending.time_updated)) {
        pending.offset = 0;
        pending.time_updated = row.time_updated;
        this.advance(key, JSON.stringify({ ...saved, pending }));
        return 1;
      }
      const raw = Buffer.from(row.raw as Uint8Array);
      this.put(
        `${source.id}:${table}:${pending.id}:${pending.time_updated}`,
        0,
        Number(pending.offset),
        source.conversation,
        raw,
        Number(pending.time_created),
        String(pending.id),
      );
      pending.offset += raw.length;
      this.advance(
        key,
        JSON.stringify(
          raw.length < CONVERSATION_BYTES
            ? { at: pending.time_updated, id: pending.id }
            : { ...saved, pending },
        ),
      );
      return 1;
    } finally {
      input.close();
    }
  }
  tick(forceMirrors = true): number {
    this.watchRoots();
    // Filesystem discovery/canonicalization and archive loading never hold SQLite's writer lock.
    this.register();
    this.jobs();
    this.queueMirrors(forceMirrors);
    const nextJob = this.jobQueue[0]?.job;
    if (nextJob)
      conversationProject(String(nextJob.cwd ?? nextJob.workdir ?? ""));
    this.db.exec("BEGIN IMMEDIATE");
    let work = 0;
    try {
      work += this.jobSnapshot();
      work += this.envelopes();
      work += this.events(this.db, "decisions", "durable-decisions");
      const archive = join(this.home, "archive.db");
      if (existsSync(archive)) {
        const input = new DatabaseSync(archive, {
          readOnly: true,
          timeout: 50,
        });
        try {
          work += this.events(input, "messages", "durable-archive");
        } finally {
          input.close();
        }
      }
      // One bounded generation per batch converges at any native nesting depth.
      for (const c of this.db
        .prepare(
          `SELECT c.id,p.id AS resolved FROM conversations c JOIN conversations p ON p.agent=c.agent AND p.session=substr(c.parent,length(c.agent)+2) WHERE c.parent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversations exact WHERE exact.id=c.parent) AND p.id<>c.id LIMIT 100`,
        )
        .all()) {
        this.db
          .prepare("UPDATE conversations SET parent=? WHERE id=?")
          .run(c.resolved!, c.id!);
      }
      for (const c of this.db
        .prepare(
          `SELECT c.id,p.job,p.project FROM conversations c JOIN conversations p ON c.parent=p.id WHERE (c.job IS NULL AND p.job IS NOT NULL) OR (c.project='' AND p.project<>'') LIMIT 100`,
        )
        .all()) {
        this.db
          .prepare(
            "UPDATE conversations SET job=coalesce(job,?),project=CASE WHEN project='' THEN ? ELSE project END WHERE id=?",
          )
          .run(c.job!, c.project!, c.id!);
        if (c.project)
          this.db
            .prepare(
              "INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)",
            )
            .run(c.project!);
        work++;
      }
      for (const path of [...this.dirty].slice(0, 32)) {
        this.dirty.delete(path);
        if (path.startsWith(this.paths.opencode))
          this.db
            .prepare(
              "UPDATE conversation_sources SET checked=-1 WHERE format='sqlite'",
            )
            .run();
        else
          this.db
            .prepare("UPDATE conversation_sources SET checked=-1 WHERE path=?")
            .run(path);
      }
      const indexed = Number(this.cursor("durable-index-rows"));
      for (const row of this.db
        .prepare(
          "SELECT * FROM conversation_records WHERE id>? ORDER BY id LIMIT 8",
        )
        .all(indexed)) {
        this.indexRecord(
          Number(row.id),
          String(row.conversation),
          String(row.body),
          Number(row.at),
          Number(row.offset),
        );
        this.advance("durable-index-rows", String(row.id));
        work++;
      }
      for (const source of this.db
        .prepare(
          "SELECT * FROM conversation_sources ORDER BY checked,id LIMIT 2",
        )
        .all()) {
        try {
          const amount =
            source.format === "jsonl"
              ? this.jsonl(source)
              : source.format === "sqlite"
                ? this.sqlite(source)
                : this.journal(source);
          work += amount;
          this.idleSources = amount ? 0 : this.idleSources + 1;
        } catch (err) {
          if (
            !["ENOENT", "EACCES", "EPERM"].includes(
              (err as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw err;
        }
        this.db
          .prepare("UPDATE conversation_sources SET checked=? WHERE id=?")
          .run(++this.checked, source.id!);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    const project = this.mirrorPending.values().next().value;
    if (project) {
      let pending = false;
      work += syncProjectMirror(this.db, project, (more) => { pending = more; });
      this.mirrorPending.delete(project);
      if (pending) this.mirrorPending.add(project);
      this.db
        .prepare("UPDATE conversation_projects SET checked=? WHERE project=?")
        .run(++this.checked, project);
    }
    if (!this.mirrorDiscovering && !this.mirrorPending.size && this.mirrorSweepActive) {
      this.mirrorSweepAt = Date.now();
      this.mirrorSweepActive = false;
    }
    return work;
  }
}

/** Stable numeric keyset paging, with a total response byte budget independent of limit. */
export function readConversation(
  db: DatabaseSync,
  input: ConversationRequest,
): ConversationPage {
  const args = conversationPageSchema.parse(input);
  if (
    !db
      .prepare("SELECT name FROM sqlite_master WHERE name='conversations'")
      .get()
  )
    return { conversation: null, records: [], next: null };
  const c = db.prepare("SELECT * FROM conversations WHERE id=?").get(args.id);
  if (!c) return { conversation: null, records: [], next: null };
  const rows = db
    .prepare(
      "SELECT * FROM conversation_records WHERE conversation=? AND id>? ORDER BY id LIMIT ?",
    )
    .all(args.id, args.after ?? 0, (args.limit ?? 20) + 1);
  const records: ConversationPage["records"] = [];
  let bytes = 0;
  for (const row of rows) {
    const raw = Buffer.from(row.raw as Uint8Array);
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
    });
    bytes += raw.length;
  }
  return {
    conversation: c as unknown as ConversationPage["conversation"],
    records,
    next: records.length < rows.length ? (records.at(-1)?.id ?? null) : null,
  };
}

export function readConversationFile(
  file: string,
  input: ConversationRequest,
): ConversationPage {
  if (!existsSync(file)) return { conversation: null, records: [], next: null };
  const db = new DatabaseSync(file, { readOnly: true, timeout: 100 });
  try {
    return readConversation(db, input);
  } finally {
    db.close();
  }
}
