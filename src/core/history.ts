import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, opendirSync, readSync, type Dir } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { claudeItems } from "./transcripts/claude.js";
import { antigravityItems } from "./transcripts/antigravity.js";
import { codexItems } from "./transcripts/codex.js";
import { readTranscript, transcriptPaths, type TranscriptPaths, type TranscriptItem } from "./transcripts/index.js";
import { object, parse, readHead, readJsonl, safeFile, TRANSCRIPT_ID } from "./transcripts/common.js";
import type { PeerInfo } from "./protocol.js";
import { ARCHIVE_DB_NAME } from "./sqlite-maintenance.js";
import { MAX_BODY_CHARS } from "./constants.js";

export const HISTORY_TICK_MS = 2_000;
export const HISTORY_ROWS_PER_SOURCE = 100;
export const HISTORY_FILES_PER_TICK = 2;
export const HISTORY_DISCOVERY_PER_TICK = 32;
export const HISTORY_CHUNK_BYTES = 64 * 1024;
export const HISTORY_SNIPPET_CHARS = 320;
export const HISTORY_MAX_QUERY_CHARS = 1_000;
export const HISTORY_MAX_LIMIT = 50;
export const HISTORY_DEFAULT_LIMIT = 10;
const HISTORY_MAX_BODY_CHARS = MAX_BODY_CHARS;
const HISTORY_MAX_METADATA_BYTES = 64 * 1024;
const HISTORY_MAX_TERMS = 32;
const HISTORY_FTS_SNIPPET_TOKENS = 40;
const HISTORY_FILTER_ID_CHARS = 256;
const HISTORY_SNIPPET_CONTEXT_CHARS = HISTORY_SNIPPET_CHARS / 4;
const HISTORY_RESCAN_MS = 30_000;
const HISTORY_READ_TIMEOUT_MS = 100;

const dateFilter = z.union([z.number().int().nonnegative(), z.iso.datetime({ offset: true })]).transform((v) => typeof v === "number" ? v : Date.parse(v));
export const historyFiltersSchema = z.object({
  session: z.string().min(1).max(HISTORY_FILTER_ID_CHARS).optional(), job: z.string().min(1).max(HISTORY_FILTER_ID_CHARS).optional(),
  agent: z.enum(["claude", "codex", "opencode", "antigravity", "other"]).optional(),
  kind: z.enum(["message", "run", "decision", "transcript"]).optional(),
  since: dateFilter.optional(), until: dateFilter.optional(),
}).strict();
export const historySearchSchema = z.object({
  query: z.string().trim().min(1).max(HISTORY_MAX_QUERY_CHARS),
  filters: historyFiltersSchema.optional(), limit: z.number().int().min(1).max(HISTORY_MAX_LIMIT).optional(),
}).strict().refine((a) => a.filters?.since === undefined || a.filters.until === undefined || a.filters.since <= a.filters.until, "since must not be later than until");
export type HistorySearch = z.input<typeof historySearchSchema>;
export interface HistoryHit {
  id: string; kind: "message" | "run" | "decision" | "transcript"; agent: string; at: number;
  snippet: string; link: string; sourceLink: string; message: string | null; job: string | null; run: string | null;
  session: string | null; cursor: string | null;
}
export interface HistoryResult { engine: "fts5" | "plain"; hits: HistoryHit[] }
interface Document extends Omit<HistoryHit, "snippet" | "sourceLink"> { body: string }
interface FileRow { path: string; kind: string; agent: string; session: string | null; cwd: string; child: string | null }
interface WalkRoot { path: string; root: string; kind: string; agent: string }

function folded(text: string): string { return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase(); }
function terms(query: string): string[] { return folded(query).match(/[\p{L}\p{N}_]+/gu)?.slice(0, HISTORY_MAX_TERMS) ?? []; }
const enc = encodeURIComponent;

/** Owns only derived tables. Source files and cold databases are always opened read-only. */
export class HistoryIndex {
  readonly engine: HistoryResult["engine"];
  private queue: WalkRoot[] = [];
  private walk: { entry: WalkRoot; dir: Dir } | null = null;
  private lastDiscovery = 0;
  private checked = 0;
  private idleFiles = 0;
  private opencodeComplete = false;
  private readonly paths: TranscriptPaths;

  constructor(private readonly db: DatabaseSync, private readonly home: string | null, paths?: TranscriptPaths) {
    this.paths = paths ?? transcriptPaths();
    this.engine = db.prepare("SELECT name FROM sqlite_master WHERE name = 'history_fts'").get() ? "fts5" : "plain";
    this.checked = Number(db.prepare("SELECT coalesce(max(checked),0) AS n FROM history_files").get()!.n);
  }

  rememberPeer(peer: Pick<PeerInfo, "id" | "name" | "sessionId">): void {
    if (!peer.sessionId) return;
    const job = /^(claude|codex|opencode|antigravity)-job-/.test(peer.name) ? peer.name : null;
    for (const alias of [peer.id, peer.name, peer.sessionId]) this.rememberSession(alias, peer.sessionId, job);
  }
  private rememberSession(alias: string, session: string, job: string | null): void {
    this.db.prepare(`INSERT INTO history_sessions VALUES (?,?,?) ON CONFLICT(alias) DO UPDATE SET
      session=excluded.session,job=coalesce(excluded.job,history_sessions.job)`).run(alias, session, job);
  }

  private cursor(source: string): string { return String(this.db.prepare("SELECT cursor FROM history_cursors WHERE source = ?").get(source)?.cursor ?? "0"); }
  private advance(source: string, cursor: string): void {
    this.db.prepare("INSERT INTO history_cursors VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(source, cursor);
  }
  private put(doc: Document, sessions: string[] = [], jobs: string[] = []): void {
    const body = doc.body.slice(0, HISTORY_MAX_BODY_CHARS);
    this.db.prepare(`INSERT INTO history_documents (id,kind,agent,at,body,folded,link,message,job,run,session,cursor)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,folded=excluded.folded,
      agent=excluded.agent,at=excluded.at,job=excluded.job,session=excluded.session,link=excluded.link,cursor=excluded.cursor`)
      .run(doc.id, doc.kind, doc.agent, doc.at, body, folded(body), doc.link, doc.message, doc.job, doc.run, doc.session, doc.cursor);
    for (const [type, values] of [["session", [...sessions, doc.session]], ["job", [...jobs, doc.job]]] as const) {
      for (const value of values) if (value) this.db.prepare("INSERT OR IGNORE INTO history_tags VALUES (?,?,?)").run(doc.id, type, value);
    }
  }
  private message(row: Record<string, any>): void {
    const sessions = [row.from_id, row.from_name, row.recipient, row.to_target].filter((s): s is string => typeof s === "string");
    const jobs = sessions.filter((s) => /^(claude|codex|opencode|antigravity)-job-/.test(s));
    this.put({ id: `message:${row.id}`, kind: "message", agent: row.from_agent, at: Number(row.created_at), body: row.body,
      link: `/?message=${enc(row.id)}`, message: row.id, job: jobs[0] ?? null, run: null, session: row.from_id, cursor: null }, sessions, jobs);
  }
  private rows(source: string, db: DatabaseSync, table: string, consume: (row: Record<string, any>) => void): number {
    const after = Number(this.cursor(source));
    const rows = db.prepare(`SELECT rowid AS history_rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(after, HISTORY_ROWS_PER_SOURCE);
    for (const row of rows) { consume(row); this.advance(source, String(row.history_rowid)); }
    return rows.length;
  }

  /** Fixed row, file, byte and discovery budgets; cursors commit atomically with their documents. */
  tick(): { work: number; discovering: boolean } {
    const fileCount = Number(this.db.prepare("SELECT count(*) AS n FROM history_files").get()!.n);
    if (this.idleFiles >= fileCount) this.idleFiles = 0;
    this.db.exec("BEGIN IMMEDIATE");
    let work = 0;
    try {
      work += this.rows("messages", this.db, "messages", (row) => this.message(row));
      const pending = this.db.prepare("SELECT * FROM history_pending LIMIT ?").all(HISTORY_ROWS_PER_SOURCE);
      for (const row of pending) {
        this.message(row);
        this.db.prepare("DELETE FROM history_pending WHERE id=? AND recipient=?").run(String(row.id), String(row.recipient));
      }
      work += pending.length;
      work += this.rows("decisions", this.db, "decisions", (row) => {
        const scope = parse(row.scope), sessions = Array.isArray(scope.sessions) ? scope.sessions.filter((s: unknown) => typeof s === "string") : [];
        this.put({ id: `decision:${row.id}`, kind: "decision", agent: row.author_agent, at: Number(row.created_at), body: `${row.topic}\n${row.body}`,
          link: `/api/decisions/${enc(row.topic)}/history`, message: row.source_message_id, job: null, run: null, session: row.author_id, cursor: String(row.revision) }, [row.author_id, row.author_name, ...sessions]);
      });
      if (this.home) {
        const archivePath = join(this.home, ARCHIVE_DB_NAME);
        if (existsSync(archivePath)) {
          const archive = new DatabaseSync(archivePath, { readOnly: true, timeout: HISTORY_READ_TIMEOUT_MS });
          try { work += this.rows("archive", archive, "messages", (row) => this.message(row)); }
          finally { archive.close(); }
        }
        work += this.discover();
        const files = this.db.prepare("SELECT * FROM history_files ORDER BY checked,path LIMIT ?").all(HISTORY_FILES_PER_TICK) as unknown as FileRow[];
        for (const file of files) {
          const indexed = this.indexFile(file);
          work += indexed;
          this.idleFiles = indexed ? 0 : this.idleFiles + 1;
          this.db.prepare("UPDATE history_files SET checked=? WHERE path=?").run(++this.checked, file.path);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
    const registered = Number(this.db.prepare("SELECT count(*) AS n FROM history_files").get()!.n);
    return { work, discovering: this.walk !== null || this.queue.length > 0 || this.idleFiles < registered };
  }

  private register(file: FileRow): void {
    this.db.prepare(`INSERT INTO history_files(path,kind,agent,session,cwd,child) VALUES (?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET session=excluded.session,cwd=excluded.cwd,child=excluded.child`).run(file.path, file.kind, file.agent, file.session, file.cwd, file.child);
  }
  private discover(): number {
    if (!this.walk && !this.queue.length && Date.now() - this.lastDiscovery >= HISTORY_RESCAN_MS) {
      this.lastDiscovery = Date.now();
      this.opencodeComplete = false;
      this.queue = [
        { path: join(this.home!, "runs"), root: join(this.home!, "runs"), kind: "run", agent: "other" },
        { path: join(this.paths.claude, "projects"), root: this.paths.claude, kind: "transcript", agent: "claude" },
        ...(this.paths.antigravity ? [{ path: join(this.paths.antigravity, "brain"), root: this.paths.antigravity, kind: "transcript", agent: "antigravity" }] : []),
        ...["sessions", "archived_sessions"].map((dir) => ({ path: join(this.paths.codex, dir), root: this.paths.codex, kind: "transcript", agent: "codex" })),
      ];
    }
    let work = 0;
    while (work < HISTORY_DISCOVERY_PER_TICK && (this.walk || this.queue.length)) {
      work++;
      if (!this.walk) {
        const entry = this.queue.shift()!;
        try { this.walk = { entry, dir: opendirSync(entry.path) }; } catch { continue; }
      }
      const item = this.walk.dir.readSync(), entry = this.walk.entry;
      if (!item) { this.walk.dir.closeSync(); this.walk = null; continue; }
      const path = join(entry.path, item.name);
      if (item.isDirectory()) { this.queue.push({ ...entry, path }); continue; }
      if (!item.isFile() || !safeFile(entry.root, path)) continue;
      if (entry.kind === "run" && /\.log(?:-\d+-[\w-]+)?$/.test(item.name)) {
        this.register({ path, kind: "run", agent: /-(claude|codex|opencode|antigravity)-/.exec(item.name)?.[1] ?? "other", session: null, cwd: "", child: null });
      } else if (entry.kind === "transcript" && item.name.endsWith(".jsonl")) {
        if (entry.agent === "antigravity" && item.name !== "transcript.jsonl") continue;
        const head = readHead(path), meta = entry.agent === "codex" ? object(head.payload) : head;
        // Forked Codex files may begin with ancestor metadata; the filename owns this session.
        const rolloutId = entry.agent === "codex" ? /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(item.name)?.[1] : undefined;
        const id = entry.agent === "antigravity" ? basename(dirname(dirname(entry.path))) : rolloutId ?? (typeof meta.id === "string" ? meta.id : typeof meta.sessionId === "string" ? meta.sessionId : basename(path, ".jsonl"));
        if (!TRANSCRIPT_ID.test(id)) continue;
        const child = entry.agent === "claude" && basename(entry.path) === "subagents" ? basename(path, ".jsonl").replace(/^agent-/, "") : null;
        this.register({ path, kind: "transcript", agent: entry.agent, session: child ? basename(dirname(entry.path)) : id, cwd: typeof meta.cwd === "string" ? meta.cwd : "", child });
      }
    }
    // opencode's indexed session registry avoids a filesystem crawl.
    const path = safeFile(this.paths.opencode, join(this.paths.opencode, "opencode.db"));
    if (path && !this.opencodeComplete) {
      const db = new DatabaseSync(path, { readOnly: true, timeout: HISTORY_READ_TIMEOUT_MS });
      try {
        const after = this.cursor("opencode-discovery");
        const rows = db.prepare("SELECT id FROM session WHERE id > ? ORDER BY id LIMIT ?").all(after === "0" ? "" : after, HISTORY_DISCOVERY_PER_TICK);
        for (const row of rows) if (TRANSCRIPT_ID.test(String(row.id))) this.register({ path: `opencode:${row.id}`, kind: "transcript", agent: "opencode", session: String(row.id), cwd: String(row.directory ?? ""), child: null });
        this.advance("opencode-discovery", rows.length ? String(rows.at(-1)!.id) : "0");
        if (!rows.length) this.opencodeComplete = true;
        work += rows.length;
      } finally { db.close(); }
    }
    return work;
  }

  private transcript(doc: FileRow, item: TranscriptItem, cursor: string, ordinal: number): void {
    const body = item.text ?? [item.tool, item.summary, item.subagent?.title].filter(Boolean).join("\n");
    if (!body) return;
    const id = `transcript:${doc.agent}:${doc.child ?? doc.session}:${item.id ?? `${cursor}:${ordinal}`}`;
    this.put({ id, kind: "transcript", agent: doc.agent, at: item.at, body, message: null, job: null, run: null,
      session: doc.session, cursor, link: `/?session=${enc(doc.session!)}&agent=${doc.agent}&from=${enc(cursor)}${doc.child ? `&child=${enc(doc.child)}` : ""}` });
  }
  private indexFile(file: FileRow): number {
    if (file.agent !== "opencode") {
      const root = file.kind === "run" ? join(this.home!, "runs") : this.paths[file.agent as "claude" | "codex" | "antigravity"];
      if (!root) return 0;
      if (!safeFile(root, file.path)) return 0;
    }
    const from = this.cursor(file.path);
    if (file.agent === "opencode") {
      const page = readTranscript({ agent: "opencode", sessionId: file.session, cwd: file.cwd }, from, undefined, this.paths);
      if (!page) return 0;
      page.items.forEach((item, i) => this.transcript(file, item, from, i));
      this.advance(file.path, page.next);
      return page.items.length || (page.next !== from ? 1 : 0);
    }
    if (file.kind === "transcript") {
      const page = readJsonl(file.path, from, HISTORY_CHUNK_BYTES);
      const head = file.agent === "codex" ? object(readHead(file.path).payload) : {};
      const metadata = file.agent === "codex" && head.id !== file.session
        ? object(readJsonl(file.path).entries.find(({ value }) => value.type === "session_meta" && object(value.payload).id === file.session)?.value.payload)
        : head;
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
    let fd: number | undefined;
    try {
      fd = openSync(file.path, "r");
      const stat = fstatSync(fd), offset = Number(from) > stat.size ? 0 : Number(from);
      const buffer = Buffer.alloc(HISTORY_CHUNK_BYTES);
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      const end = buffer.subarray(0, bytes).lastIndexOf(10);
      // Keep incomplete final records for the next tick; bound oversized lines as chunks.
      const length = end >= 0 ? end + 1 : bytes === HISTORY_CHUNK_BYTES ? bytes : 0;
      let meta: Record<string, any> = {};
      let metaText = "";
      const metaPath = file.path.replace(/\.log(?:-\d+-[\w-]+)?$/, ".json");
      const safeMeta = safeFile(join(this.home!, "runs"), metaPath);
      if (safeMeta) {
        const metaFd = openSync(safeMeta, "r");
        try {
          const size = fstatSync(metaFd).size;
          if (size <= HISTORY_MAX_METADATA_BYTES) {
            const buffer = Buffer.alloc(size), length = readSync(metaFd, buffer, 0, size, 0);
            metaText = buffer.subarray(0, length).toString("utf8");
            meta = parse(metaText);
          }
        } finally { closeSync(metaFd); }
      }
      const run = basename(file.path).replace(/(\.log)-\d+-[\w-]+$/, "$1");
      const start = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(run);
      const at = Number(meta.jobStartedAt) || (start ? Date.UTC(+start[1]!, +start[2]! - 1, +start[3]!, +start[4]!, +start[5]!, +start[6]!) : stat.birthtimeMs);
      const job = typeof meta.job === "string" ? meta.job : null, session = typeof meta.session === "string" ? meta.session : null;
      if (session) this.rememberSession(session, session, job);
      let metadataChanged = 0;
      if (Object.keys(meta).length) {
        const hash = createHash("sha256").update(metaText).digest("hex"), source = `metadata:${metaPath}`;
        if (hash !== this.cursor(source)) {
          this.put({ id: `run:${run}:metadata`, kind: "run", agent: file.agent, at, body: metaText,
            link: `/api/runs/${enc(basename(run, ".log"))}?from=0`, message: null, job, run, session, cursor: "0" }, [meta.by].filter((s): s is string => typeof s === "string"));
          this.advance(source, hash); metadataChanged = 1;
        }
      }
      const changed = this.db.prepare(`UPDATE history_documents SET session=?,job=? WHERE rowid IN
        (SELECT rowid FROM history_documents WHERE run=? AND (session IS NOT ? OR job IS NOT ?) LIMIT ?) RETURNING id`)
        .all(session, job, run, session, job, HISTORY_ROWS_PER_SOURCE);
      for (const row of changed) if (session) this.db.prepare("INSERT OR IGNORE INTO history_tags VALUES (?, 'session', ?)").run(row.id!, session);
      if (!length) return changed.length + metadataChanged;
      this.put({ id: `run:${run}:${offset}`, kind: "run", agent: file.agent, at, body: `${typeof meta.title === "string" ? meta.title : ""}\n${buffer.subarray(0, length).toString("utf8")}`,
        link: `/api/runs/${enc(basename(run, ".log"))}?from=${offset}`, message: null, job, run, session, cursor: String(offset) }, [meta.by].filter((s): s is string => typeof s === "string"));
      this.advance(file.path, String(offset + length));
      return 1;
    } catch (err) {
      if (["ENOENT", "EACCES", "EPERM"].includes((err as NodeJS.ErrnoException).code ?? "")) return 0;
      throw err;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  search(input: HistorySearch): HistoryResult {
    const args = historySearchSchema.parse(input), tokens = terms(args.query);
    if (!tokens.length) return { engine: this.engine, hits: [] };
    const where: string[] = [], values: SQLInputValue[] = [];
    if (this.engine === "fts5") { where.push("history_fts MATCH ?"); values.push(tokens.map((t) => `"${t}"`).join(" AND ")); }
    else for (const token of tokens) { where.push("instr(d.folded,?)>0"); values.push(token); }
    for (const [key, value] of Object.entries(args.filters ?? {})) {
      if (["session", "job"].includes(key)) { where.push(`EXISTS (SELECT 1 FROM history_tags t WHERE t.id=d.id AND
          ((t.type=? AND t.value=?) OR (t.type='session' AND EXISTS (SELECT 1 FROM history_sessions s WHERE s.alias=t.value AND s.${key === "session" ? "session" : "job"}=?))))`); values.push(key, value, value); }
      else if (key === "since" || key === "until") { where.push(`d.at ${key === "since" ? ">=" : "<="} ?`); values.push(value); }
      else { where.push(`d.${key}=?`); values.push(value); }
    }
    const joinFts = this.engine === "fts5" ? "JOIN history_fts ON history_fts.rowid=d.rowid" : "";
    const snippet = this.engine === "fts5" ? "snippet(history_fts,0,'','',' … ',40)" : "d.body";
    const order = this.engine === "fts5" ? "bm25(history_fts),d.at DESC,d.id" : "d.at DESC,d.id";
    const rows = this.db.prepare(`SELECT d.id,d.kind,d.agent,d.at,d.link,d.message,coalesce(d.job,(SELECT job FROM history_sessions s WHERE (s.session=d.session OR s.alias=d.session) AND s.job IS NOT NULL LIMIT 1)) AS job,d.run,coalesce((SELECT session FROM history_sessions s WHERE s.alias=d.session),d.session) AS session,d.cursor,${snippet} AS snippet
      FROM history_documents d ${joinFts} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`).all(...values, args.limit ?? HISTORY_DEFAULT_LIMIT);
    return { engine: this.engine, hits: rows.map((r) => {
      let snippet = String(r.snippet).replace(/\s+/g, " ");
      if (this.engine === "plain") { const position = folded(snippet).indexOf(tokens[0]!); snippet = snippet.slice(Math.max(0, position - HISTORY_SNIPPET_CONTEXT_CHARS)); }
      return { ...r, sourceLink: `/api/history/${enc(String(r.id))}`, snippet: snippet.slice(0, HISTORY_SNIPPET_CHARS) } as unknown as HistoryHit;
    }) };
  }

  reset(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try { this.db.exec("DELETE FROM history_documents; DELETE FROM history_tags; DELETE FROM history_cursors; DELETE FROM history_files;"); this.db.exec("COMMIT"); }
    catch (err) { this.db.exec("ROLLBACK"); throw err; }
    this.close(); this.queue = []; this.lastDiscovery = 0; this.opencodeComplete = false; this.idleFiles = 0;
  }
  close(): void { this.walk?.dir.closeSync(); this.walk = null; }
}

/** Dashboard reads never initialize, migrate, or change the derived index. */
export function readHistory(file: string, input: HistorySearch): HistoryResult {
  historySearchSchema.parse(input);
  if (!existsSync(file)) return { engine: "plain", hits: [] };
  const db = new DatabaseSync(file, { readOnly: true, timeout: HISTORY_READ_TIMEOUT_MS });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='history_documents'").get()) return { engine: "plain", hits: [] };
    return new HistoryIndex(db, null).search(input);
  } finally { db.close(); }
}

/** Read a bounded indexed source even when its original CLI session is no longer online. */
export function readHistorySource(file: string, id: string): Omit<HistoryHit, "snippet" | "sourceLink"> & { body: string } | null {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true, timeout: HISTORY_READ_TIMEOUT_MS });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='history_documents'").get()) return null;
    return (db.prepare("SELECT id,kind,agent,at,body,link,message,job,run,session,cursor FROM history_documents WHERE id=?").get(id) as unknown as Document | undefined) ?? null;
  } finally { db.close(); }
}
