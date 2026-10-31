import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { CONVERSATION_BYTES } from "./conversation-text.js";
import { decodeBytes } from "./history-codec.js";
import { conversationProject } from "./project-store.js";
import { parse, time } from "./transcripts/common.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function conversationKey(environment: string, thread: string): string {
  const readable = `t3:${environment}:${thread}`;
  return readable.length <= 256 ? readable : `t3:${digest(JSON.stringify([environment, thread]))}`;
}
// App-owned IDs include namespaced mcp:/thread:delegated-task: values, not just native transcript UUIDs.
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 &&
  value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const REFRESH_MS = 60_000, WINDOW = 32, STEPS = 8;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const columns = {
  projection_projects: { project_id: "TEXT", title: "TEXT", workspace_root: "TEXT" },
  orchestration_v2_projection_threads: { thread_id: "TEXT", project_id: "TEXT", title: "TEXT", created_at: "TEXT", updated_at: "TEXT", archived_at: "TEXT", deleted_at: "TEXT", payload_json: "TEXT" },
  orchestration_events: { sequence: "INTEGER", event_id: "TEXT", aggregate_kind: "TEXT", stream_id: "TEXT", event_type: "TEXT", occurred_at: "TEXT", application_event_version: "INTEGER", payload_json: "TEXT" },
} as const;
type Row = Record<string, any>;
interface Event { sequence: number; event_id: string; stream_id: string; event_type: string; application_event_version: number; occurred_at: string }
interface Pending extends Event { offset: number; bytes?: number }
interface State { identity: string; environment: string; high: number; highId: string; sequence: number; after: string; refreshAt: number; pending?: Pending; incomplete?: boolean }
interface Sink {
  cursor(key: string): string;
  advance(key: string, value: string): void;
  put(source: string, generation: number, offset: number, conversation: string, raw: Buffer, at: number, part?: string | null): void;
}
class SourceFault extends Error {}
function query(input: DatabaseSync, sql: string, ...args: SQLInputValue[]): Row[] {
  try { return input.prepare(sql).all(...args); }
  catch { throw new SourceFault("source busy or unreadable"); }
}
function fileIdentity(file: string): string {
  const s = statSync(file, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
function environmentId(root: string): string {
  const fd = openSync(join(root, "userdata", "environment-id"), "r");
  try {
    const size = fstatSync(fd).size;
    if (size < 1 || size > 512) throw new SourceFault("unsupported environment identity");
    const raw = Buffer.alloc(size);
    if (readSync(fd, raw, 0, size, 0) !== size) throw new SourceFault("incomplete environment identity");
    const value = raw.toString("utf8").trim();
    if (!id(value)) throw new SourceFault("unsupported environment identity");
    return value;
  } finally { closeSync(fd); }
}

/** Local T3 retained v2 events only. No connection or read transaction survives a tick.
 * All durable bytes/indexing go through ConversationIngestor's existing idempotent sink.
 * A completion receipt, rather than the existence of raw fragments, certifies a retained revision. */
export class T3History {
  discovering: boolean;
  private readonly key: string;
  private readonly codec: string;
  private verifySource?: () => void;
  constructor(private root: string | undefined, private db: DatabaseSync, private sink: Sink) {
    const path = root && isAbsolute(root) ? resolve(root).replace(/^d:/i, "E:") : root ?? "disabled";
    this.key = `durable-t3:${digest(process.platform === "win32" ? path.toLowerCase() : path)}`;
    this.sink = {
      cursor: key => sink.cursor(key),
      advance: (key, value) => { if (key !== `${this.key}:status`) this.verifySource?.(); sink.advance(key, value); },
      put: (...args) => { this.verifySource?.(); sink.put(...args); },
    };
    this.discovering = root !== undefined;
    this.codec = db.prepare("SELECT 1 FROM pragma_table_info('conversation_records') WHERE name='raw_codec'").get() ? "raw_codec" : "0 AS raw_codec";
  }
  private status(state: string, reason: string): void {
    this.sink.advance(`${this.key}:status`, JSON.stringify({ state, reason }));
  }
  private save(state: State): void { this.sink.advance(this.key, JSON.stringify(state)); }
  private conversation(environment: string, thread: string): string {
    this.verifySource?.();
    const name = conversationKey(environment, thread);
    this.db.prepare("INSERT OR IGNORE INTO conversations(id,agent,session) VALUES(?,'other',?)").run(name, name);
    return name;
  }
  private schema(input: DatabaseSync): void {
    for (const [table, required] of Object.entries(columns)) {
      const info = query(input, `PRAGMA table_info('${table}')`);
      if (!Object.entries(required).every(([name, type]) => info.some(c => c.name === name && c.type === type)))
        throw new SourceFault(`unsupported ${table} schema`);
      const pk = table === "projection_projects" ? "project_id" : table === "orchestration_v2_projection_threads" ? "thread_id" : "sequence";
      if (!info.some(c => c.name === pk && c.pk === 1)) throw new SourceFault(`unsupported ${table} key`);
    }
  }
  private metadata(input: DatabaseSync, state: State): number {
    // One keyset row per tick. Large/unrecognized metadata is explicitly unavailable;
    // never return an arbitrary projection JSON or any provider-session/auth columns.
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
    if (!row) { state.after = ""; state.refreshAt = Date.now() + REFRESH_MS; this.save(state); return 0; }
    if (!id(row.thread_id) || !id(row.project_id) || !row.relation ||
        [row.title, row.project_title, row.workspace_root].some(v => typeof v !== "string" || v.length > 8192) ||
        [row.created_at, row.updated_at, row.archived_at, row.deleted_at].some(v => v !== null && (typeof v !== "string" || v.length > 64)))
      throw new SourceFault("unsupported thread/project metadata");
    const relation = parse(row.relation);
    if ([relation.parentThreadId, relation.forkThreadId].some(v => v !== null && !id(v)))
      throw new SourceFault("unsupported thread relation");
    const conversation = this.conversation(state.environment, row.thread_id), project = conversationProject(row.workspace_root);
    this.db.prepare("UPDATE conversations SET parent=?,project=? WHERE id=?")
      .run(relation.parentThreadId ? conversationKey(state.environment, relation.parentThreadId) : null, project, conversation);
    if (project) this.db.prepare("INSERT OR IGNORE INTO conversation_projects(project) VALUES(?)").run(project);
    const raw = Buffer.from(JSON.stringify({ source: "t3-local-metadata", environmentId: state.environment, ...row, relation }));
    if (raw.length > CONVERSATION_BYTES) throw new SourceFault("unsupported oversized metadata");
    this.sink.put(`${conversation}:metadata:${digest(raw.toString())}`, 0, 0, conversation, raw, time(row.updated_at), "t3:metadata");
    state.after = row.thread_id; this.save(state); return 1;
  }
  private receipt(state: State, event: Pending, outcome: string): void {
    const conversation = this.conversation(state.environment, event.stream_id);
    const source = `${conversation}:event:${event.sequence}:${event.event_id}`;
    this.sink.put(`${source}:receipt`, 0, 0, conversation, Buffer.from(JSON.stringify({
      source: "t3-local-event-receipt", environmentId: state.environment, threadId: event.stream_id,
      sequence: event.sequence, eventId: event.event_id, eventType: event.event_type, outcome,
      confirmedBytes: event.offset, expectedBytes: event.bytes ?? null, fragments: source,
    })), time(event.occurred_at), `t3:${outcome}`);
  }
  private copy(input: DatabaseSync, state: State): void {
    const event = state.pending!;
    const conversation = this.conversation(state.environment, event.stream_id);
    const source = `${conversation}:event:${event.sequence}:${event.event_id}`;
    // A receipt may itself have been retained before its derived index failed.
    // Replay it before consulting a source that might since have compacted the event.
    const receipt = this.db.prepare(`SELECT raw,${this.codec},part FROM conversation_records WHERE source=? AND generation=0 AND offset=0`)
      .get(`${source}:receipt`);
    if (receipt) {
      const raw = decodeBytes(receipt.raw, receipt.raw_codec);
      this.sink.put(`${source}:receipt`, 0, 0, conversation, raw, time(event.occurred_at), String(receipt.part));
      if (parse(raw.toString()).outcome !== "complete") state.incomplete = true;
      state.sequence = event.sequence; delete state.pending; this.save(state); return;
    }
    // Sequence + event id identifies an immutable full message revision, not updated_at.
    // octet_length can read TEXT length metadata without loading its contents. Admit before
    // any CAST/JSON expression, whose operands otherwise materialize the complete row.
    const admission = query(input, "SELECT octet_length(payload_json) bytes,substr(event_id,1,513) event_id FROM orchestration_events WHERE sequence=?", event.sequence)[0];
    if (admission) {
      if (admission.event_id !== event.event_id || !Number.isSafeInteger(admission.bytes) || admission.bytes < 0)
        throw new SourceFault("invalid message identity or size");
      if (admission.bytes > MAX_MESSAGE_BYTES) {
        event.bytes = admission.bytes;
        this.receipt(state, event, "unavailable-oversized-message"); state.incomplete = true;
        state.sequence = event.sequence; delete state.pending; this.save(state); return;
      }
    }
    const row = admission ? query(input, `SELECT substr(event_id,1,513) event_id,substr(stream_id,1,513) stream_id,
      substr(event_type,1,129) event_type,application_event_version,substr(aggregate_kind,1,32) aggregate_kind,
      octet_length(payload_json) bytes,substr(CAST(payload_json AS BLOB),?,?) raw,
      CASE WHEN ?=0 AND json_valid(payload_json) THEN
        json_type(payload_json,'$.text')='text' AND json_type(payload_json,'$.id')='text'
        AND json_extract(payload_json,'$.threadId')=stream_id
        AND json_extract(payload_json,'$.role') IN ('user','assistant') END supported
      FROM orchestration_events WHERE sequence=? AND octet_length(payload_json)<=?`, event.offset + 1, CONVERSATION_BYTES, event.offset, event.sequence, MAX_MESSAGE_BYTES)[0] : undefined;
    if (!row) {
      // A failed derived insert can retain one extra fragment before its cursor is
      // confirmed. Repair that fragment even if compaction has since removed the row.
      const retained = this.db.prepare(`SELECT raw,${this.codec} FROM conversation_records WHERE source=? AND generation=0 AND offset=?`)
        .get(source, event.offset);
      if (retained) {
        const raw = decodeBytes(retained.raw, retained.raw_codec);
        this.sink.put(source, 0, event.offset, conversation, raw, time(event.occurred_at), "t3:fragment");
        event.offset += raw.length; this.save(state); return;
      }
      this.receipt(state, event, "incomplete-compacted-source");
      state.incomplete = true;
      this.status("incomplete", "pending event compacted; retained fragments are not a complete revision");
    } else {
      if (row.event_id !== event.event_id || row.stream_id !== event.stream_id || row.event_type !== event.event_type ||
          row.application_event_version !== 2 || row.aggregate_kind !== "thread" || event.bytes !== undefined && event.bytes !== row.bytes)
        throw new SourceFault("event identity changed; source refused");
      if (event.offset === 0 && row.supported !== 1) {
        this.receipt(state, event, "unavailable-message-schema");
        state.incomplete = true;
        this.status("incomplete", "unsupported full message payload");
      } else {
        const raw = Buffer.from(row.raw), bytes = Number(row.bytes);
        if (!Number.isSafeInteger(bytes) || bytes < event.offset || raw.length !== Math.min(CONVERSATION_BYTES, bytes - event.offset))
          throw new SourceFault("invalid message byte range");
        const conversation = this.conversation(state.environment, event.stream_id);
        event.bytes = bytes;
        this.sink.put(`${conversation}:event:${event.sequence}:${event.event_id}`, 0, event.offset,
          conversation, raw, time(event.occurred_at), "t3:fragment");
        event.offset += raw.length;
        if (event.offset < bytes) { this.save(state); return; }
        this.receipt(state, event, "complete");
      }
    }
    state.sequence = event.sequence; delete state.pending; this.save(state);
  }
  tick(deadline: number): number {
    if (this.root === undefined) { this.discovering = false; return 0; }
    let input: DatabaseSync | undefined, work = 0;
    try {
      if (!isAbsolute(this.root) || !this.root.trim() || /[\x00-\x1f]/.test(this.root)) throw new SourceFault("invalid explicit T3 home");
      let identity: string, environment: string, file: string;
      try {
        file = realpathSync.native(join(this.root, "userdata", "statev2.sqlite"));
        identity = fileIdentity(file); environment = environmentId(this.root);
        input = new DatabaseSync(file, { readOnly: true, timeout: 25 });
        this.verifySource = () => {
          try {
            if (realpathSync.native(join(this.root!, "userdata", "statev2.sqlite")) !== file ||
                fileIdentity(file) !== identity || environmentId(this.root!) !== environment) throw new Error();
          } catch { throw new SourceFault("source binding changed before publication; prior checkpoint preserved"); }
        };
        this.verifySource();
      } catch (error) { throw error instanceof SourceFault ? error : new SourceFault("source missing, busy or unreadable"); }
      this.schema(input);
      const tail = query(input, "SELECT sequence,substr(event_id,1,513) event_id FROM orchestration_events ORDER BY sequence DESC LIMIT 1")[0];
      const high = Number(tail?.sequence ?? 0), highId = String(tail?.event_id ?? "");
      const saved = this.sink.cursor(this.key);
      let state: State;
      try { state = saved === "0" ? { identity, environment, high, highId, sequence: 0, after: "", refreshAt: 0 } : JSON.parse(saved); }
      catch { throw new SourceFault("invalid retained T3 checkpoint"); }
      if (!state || !Number.isSafeInteger(state.sequence) || !Number.isSafeInteger(state.high) || state.sequence < 0 || state.sequence > state.high ||
          typeof state.after !== "string" || !Number.isFinite(state.refreshAt) || highId.length > 512)
        throw new SourceFault("invalid retained T3 checkpoint or source highwater");
      if (!Number.isSafeInteger(high) || state.identity !== identity || state.environment !== environment || high < state.high)
        throw new SourceFault("source replaced or highwater rolled back; prior checkpoint preserved");
      const anchor = query(input, "SELECT substr(event_id,1,513) event_id FROM orchestration_events WHERE sequence=?", state.high)[0];
      if (anchor && anchor.event_id !== state.highId) throw new SourceFault("source event identity replaced; prior checkpoint preserved");
      state.high = high; state.highId = highId; this.save(state);
      this.discovering = !!state.pending || state.sequence < high || Date.now() >= state.refreshAt;
      if (Date.now() < deadline && Date.now() >= state.refreshAt) work += this.metadata(input, state);
      for (let n = 0; n < STEPS && Date.now() < deadline; n++) {
        if (state.pending) { this.copy(input, state); work++; continue; }
        // Primary-key sequence windows include version metadata so future message versions
        // receive an unavailable receipt. Never fetch payloads for unrelated activity.
        const rows = query(input, `SELECT sequence,substr(event_id,1,513) event_id,substr(stream_id,1,513) stream_id,
          substr(event_type,1,129) event_type,application_event_version,substr(aggregate_kind,1,32) aggregate_kind,substr(occurred_at,1,65) occurred_at
          FROM orchestration_events WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ${WINDOW}`, state.sequence, high);
        if (!rows.length) { state.sequence = high; this.save(state); break; }
        for (const row of rows) {
          if (row.aggregate_kind === "thread" && String(row.event_type).startsWith("message.")) {
            if (!id(row.event_id) || !id(row.stream_id)) throw new SourceFault("unsupported event identity");
            const event = { ...row, offset: 0 } as Pending;
            if (row.application_event_version === 2 && row.event_type === "message.updated") {
              state.pending = event; this.save(state); break;
            }
            this.receipt(state, event, "unavailable-event-schema"); state.incomplete = true;
          }
          state.sequence = Number(row.sequence);
        }
        this.save(state); work++;
      }
      this.discovering = !!state.pending || state.sequence < high || Date.now() >= state.refreshAt;
      this.status(state.incomplete ? "incomplete" : "ready", "coverage: metadata and surviving v2 message.updated events only");
      return work;
    } catch (error) {
      if (!(error instanceof SourceFault)) throw error; // Destination/index failures must never advance the source cursor.
      this.status("unavailable", error.message); this.discovering = false; return work;
    } finally { this.verifySource = undefined; input?.close(); }
  }
}
