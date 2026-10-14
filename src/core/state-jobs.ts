import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** AB335 package2a: disconnected shadow model, NOT an authority adapter.
 * No production bootstrap, credential issuer, process action, legacy writer,
 * receiver permit, admission or promotion exists in this module. Only tests
 * seed this schema. Integration needs a separately reviewed authenticated
 * state-core writer/schema adapter and writer/receiver closure.
 */
export const JOBS_STATE_DEFAULT = "off" as const;
export function productionJobsCommand(_request: unknown): { status: "authority_unavailable" } {
  return { status: "authority_unavailable" };
}

export const SHADOW_JOBS_SCHEMA = `
CREATE TABLE shadow_scope (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), installation TEXT NOT NULL,
 lineage TEXT NOT NULL, epoch TEXT NOT NULL, instance TEXT NOT NULL,
 commit_version TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode='shadow')
);
CREATE TABLE shadow_sessions (
 id TEXT PRIMARY KEY, registration TEXT NOT NULL, version TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('connected','disconnected','ended'))
);
CREATE TABLE shadow_jobs (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES shadow_sessions(id),
 generation TEXT NOT NULL, version TEXT NOT NULL, lifecycle TEXT NOT NULL,
 execution_evidence TEXT NOT NULL CHECK(execution_evidence='unknown')
);
CREATE TABLE shadow_turns (
 job_id TEXT NOT NULL REFERENCES shadow_jobs(id), generation TEXT NOT NULL,
 version TEXT NOT NULL, lifecycle TEXT NOT NULL,
 PRIMARY KEY(job_id,generation)
);
CREATE TABLE shadow_events (
 commit_version TEXT NOT NULL, event_index INTEGER NOT NULL, installation TEXT NOT NULL,
 lineage TEXT NOT NULL, epoch TEXT NOT NULL, issuer TEXT NOT NULL, command_id TEXT NOT NULL,
 job_id TEXT NOT NULL, generation TEXT NOT NULL, previous_version TEXT NOT NULL,
 version TEXT NOT NULL, kind TEXT NOT NULL, request BLOB NOT NULL,
 PRIMARY KEY(commit_version,event_index)
);
CREATE TABLE shadow_commands (
 installation TEXT NOT NULL, lineage TEXT NOT NULL, issuer TEXT NOT NULL,
 command_id TEXT NOT NULL, digest TEXT NOT NULL, request BLOB NOT NULL,
 transport BLOB NOT NULL, receipt TEXT NOT NULL,
 PRIMARY KEY(installation,lineage,issuer,command_id)
);
CREATE TABLE shadow_command_conflicts (
 installation TEXT NOT NULL, lineage TEXT NOT NULL, issuer TEXT NOT NULL,
 command_id TEXT NOT NULL, digest TEXT NOT NULL, request BLOB NOT NULL,
 transport BLOB NOT NULL,
 PRIMARY KEY(installation,lineage,issuer,command_id,digest)
);
CREATE TABLE shadow_evidence (
 issuer TEXT NOT NULL, command_id TEXT NOT NULL, job_id TEXT NOT NULL,
 generation TEXT NOT NULL, request BLOB NOT NULL,
 PRIMARY KEY(issuer,command_id)
);`;

const MAX = 9223372036854775807n;
export function counter(value: unknown, zero = false): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
      BigInt(value) > MAX || !zero && value === "0") throw new Error("malformed_counter");
  return value;
}
function next(value: unknown): string {
  const n = BigInt(counter(value, true));
  if (n === MAX) throw new Error("counter_exhausted");
  return String(n + 1n);
}
export const bytesDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256 || /[\x00-\x1f]/.test(value))
    throw new Error("malformed_identity");
  return value;
}

/** Reject duplicate object keys at every level; retain the original bytes.
 * JSON.parse alone would silently select a conflicting last occurrence.
 */
export function parseExactJson(raw: Uint8Array): unknown {
  const s = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const parsed: unknown = JSON.parse(s);
  let p = 0;
  const ws = () => { while (/\s/.test(s[p] ?? "") && p < s.length) p++; };
  const string = (): string => {
    const start = p++;
    while (p < s.length) {
      const c = s[p++];
      if (c === "\\") p++;
      else if (c === '"') return JSON.parse(s.slice(start, p)) as string;
    }
    throw new Error("malformed_json");
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error("json_too_deep");
    ws();
    if (s[p] === '"') { string(); return; }
    if (s[p] === "{" || s[p] === "[") {
      const map = s[p++] === "{", end = map ? "}" : "]", keys = new Set<string>();
      ws();
      if (s[p] === end) { p++; return; }
      for (;;) {
        ws();
        if (map) {
          const key = string();
          if (keys.has(key)) throw new Error("ambiguous_json");
          keys.add(key); ws(); p++; // JSON.parse already checked the colon.
        }
        value(depth + 1); ws();
        if (s[p++] === end) return;
      }
    }
    while (p < s.length && !/[\s,}\]]/.test(s[p]!)) p++;
  };
  value(0);
  return parsed;
}

export type ShadowLifecycle = "requested" | "queued" | "starting" | "running" | "stopping" |
  "finishing" | "terminal" | "start_failed" | "interrupted";
const transitions: Record<ShadowLifecycle, readonly ShadowLifecycle[]> = {
  requested: ["queued", "terminal"], queued: ["starting", "terminal"],
  starting: ["running", "start_failed"], running: ["stopping", "finishing", "interrupted"],
  stopping: ["finishing", "interrupted"], finishing: ["terminal"],
  terminal: [], start_failed: [], interrupted: [],
};
interface ShadowRequest {
  commandId: string; operation: "create" | "transition" | "continue" | "evidence";
  installation: string; lineage: string; authorityGeneration: string;
  jobId: string; turnGeneration: string; expectedVersion: string;
  sessionId: string; sessionGeneration: string; lifecycle?: ShadowLifecycle;
}
export interface ShadowTransport {
  installation: string; lineage: string; epoch: string; instance: string;
  sessionId: string; registration: string;
}
export interface ShadowReceipt {
  status: "shadow_committed"; installation: string; lineage: string; issuer: string;
  commandId: string; digest: string; commitVersion: string; jobId: string;
  turnGeneration: string; version: string; sideEffects: "none";
}
export type ShadowResult = ShadowReceipt | { status: "refused"; reason: string };

function request(raw: Uint8Array): ShadowRequest {
  const v = parseExactJson(raw);
  if (!object(v)) throw new Error("malformed_request");
  for (const k of ["commandId", "installation", "lineage", "jobId", "sessionId"]) identity(v[k]);
  for (const k of ["authorityGeneration", "turnGeneration", "sessionGeneration"]) counter(v[k]);
  counter(v.expectedVersion, true);
  if (typeof v.operation !== "string" || !["create", "transition", "continue", "evidence"].includes(v.operation)) throw new Error("unknown_operation");
  if (v.operation === "transition" && (typeof v.lifecycle !== "string" || !Object.hasOwn(transitions, v.lifecycle)))
    throw new Error("unknown_transition");
  return v as unknown as ShadowRequest;
}

/** Explicit disconnected simulation. Transport/session rows are fixture facts,
 * never authenticated principals. This class cannot be used to grant control.
 * The caller owns the isolated DB connection; this module opens no home/store.
 */
export class ShadowJobsLedger {
  constructor(private readonly db: DatabaseSync) {}

  private durableShadowWriter(): void {
    if (this.db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal" ||
        this.db.prepare("PRAGMA synchronous").get()?.synchronous !== 2 ||
        this.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1)
      throw new Error("shadow_durability_unavailable");
  }

  private scope(): Record<string, unknown> {
    const s = this.db.prepare("SELECT * FROM shadow_scope WHERE singleton=1").get();
    if (!s || s.mode !== "shadow") throw new Error("shadow_scope_unavailable");
    identity(s.installation); identity(s.lineage); identity(s.instance);
    counter(s.epoch); counter(s.commit_version, true);
    return s;
  }

  private binding(raw: Uint8Array, scope: Record<string, unknown>): ShadowTransport {
    const t = parseExactJson(raw);
    if (!object(t)) throw new Error("unknown_shadow_binding");
    for (const k of ["installation", "lineage", "instance", "sessionId"]) identity(t[k]);
    counter(t.epoch); counter(t.registration);
    if (t.installation !== scope.installation || t.lineage !== scope.lineage ||
        t.epoch !== scope.epoch || t.instance !== scope.instance) throw new Error("changed_shadow_binding");
    const session = this.db.prepare("SELECT * FROM shadow_sessions WHERE id=?").get(String(t.sessionId));
    if (!session || session.state !== "connected" || session.registration !== t.registration)
      throw new Error("unknown_shadow_session");
    counter(session.version);
    return t as unknown as ShadowTransport;
  }

  applyShadowCommand(requestBytes: Uint8Array, transportBytes: Uint8Array): ShadowResult {
    // Bounded candidate preparation precedes writer admission. Accepted bytes
    // are copied, so later caller mutation cannot alter retained history.
    if (requestBytes.byteLength > 256 * 1024 || transportBytes.byteLength > 16 * 1024)
      return { status: "refused", reason: "command_too_large" };
    const raw = Buffer.from(requestBytes), transport = Buffer.from(transportBytes);
    try {
      const r = request(raw), digest = bytesDigest(raw);
      this.durableShadowWriter();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const s = this.scope(), t = this.binding(transport, s);
        // Stable fixture issuer owns receipts across simulated registrations.
        const key = [String(s.installation), String(s.lineage), t.sessionId, r.commandId];
        const old = this.db.prepare(`SELECT digest,request,receipt FROM shadow_commands
          WHERE installation=? AND lineage=? AND issuer=? AND command_id=?`).get(...key);
        if (old) {
          if (old.digest !== digest || !Buffer.from(old.request as Uint8Array).equals(raw)) {
            this.db.prepare("INSERT OR IGNORE INTO shadow_command_conflicts VALUES (?,?,?,?,?,?,?)")
              .run(...key, digest, raw, transport);
            this.db.exec("COMMIT");
            return { status: "refused", reason: "command_id_conflict" };
          }
          const receipt = parseExactJson(Buffer.from(String(old.receipt))) as ShadowReceipt;
          if (!object(receipt) || receipt.status !== "shadow_committed" || receipt.digest !== digest ||
              receipt.installation !== s.installation || receipt.lineage !== s.lineage || receipt.jobId !== r.jobId ||
              receipt.issuer !== t.sessionId || receipt.commandId !== r.commandId || receipt.sideEffects !== "none")
            throw new Error("malformed_receipt");
          counter(receipt.commitVersion); counter(receipt.turnGeneration); counter(receipt.version);
          this.db.exec("COMMIT"); return receipt;
        }
        if (r.installation !== s.installation || r.lineage !== s.lineage || r.authorityGeneration !== s.epoch)
          throw new Error("stale_authority_generation");
        if (r.sessionId !== t.sessionId || r.sessionGeneration !== t.registration)
          throw new Error("stale_session_generation");
        const job = this.db.prepare("SELECT * FROM shadow_jobs WHERE id=?").get(r.jobId);
        let generation = r.turnGeneration, version = "1", lifecycle: ShadowLifecycle = "requested";
        if (r.operation === "create") {
          if (job || r.expectedVersion !== "0" || r.turnGeneration !== "1") throw new Error("create_conflict");
        } else {
          if (!job || job.session_id !== t.sessionId) throw new Error("unknown_job_identity");
          counter(job.generation); counter(job.version);
          if (job.generation !== r.turnGeneration) throw new Error("stale_turn_generation");
          if (job.version !== r.expectedVersion) throw new Error("stale_row_version");
          if (!Object.hasOwn(transitions, String(job.lifecycle)) || job.execution_evidence !== "unknown")
            throw new Error("unknown_job_state");
          const turn = this.db.prepare("SELECT * FROM shadow_turns WHERE job_id=? AND generation=?").get(r.jobId, generation);
          if (!turn || turn.version !== job.version || turn.lifecycle !== job.lifecycle) throw new Error("unknown_turn_state");
          lifecycle = job.lifecycle as ShadowLifecycle;
          version = r.operation === "evidence" ? String(job.version) : next(job.version);
          if (r.operation === "continue") {
            if (lifecycle !== "terminal" && lifecycle !== "start_failed") throw new Error("unsettled_turn");
            generation = next(job.generation); lifecycle = "requested";
          } else if (r.operation === "transition") {
            if (!transitions[lifecycle].includes(r.lifecycle!)) throw new Error("transition_refused");
            lifecycle = r.lifecycle!;
          }
        }
        const commit = next(s.commit_version);
        if (r.operation === "create") {
          this.db.prepare("INSERT INTO shadow_jobs VALUES (?,?,?,?,?,?)")
            .run(r.jobId, t.sessionId, generation, version, lifecycle, "unknown");
          this.db.prepare("INSERT INTO shadow_turns VALUES (?,?,?,?)").run(r.jobId, generation, version, lifecycle);
        } else if (r.operation !== "evidence") {
          const changed = this.db.prepare(`UPDATE shadow_jobs SET generation=?,version=?,lifecycle=?
            WHERE id=? AND generation=? AND version=? AND session_id=?`)
            .run(generation, version, lifecycle, r.jobId, r.turnGeneration, r.expectedVersion, t.sessionId);
          if (changed.changes !== 1) throw new Error("row_cas_failed");
          if (r.operation === "continue")
            this.db.prepare("INSERT INTO shadow_turns VALUES (?,?,?,?)").run(r.jobId, generation, version, lifecycle);
          else this.db.prepare("UPDATE shadow_turns SET version=?,lifecycle=? WHERE job_id=? AND generation=?")
            .run(version, lifecycle, r.jobId, generation);
        }
        this.db.prepare("INSERT INTO shadow_evidence VALUES (?,?,?,?,?)").run(t.sessionId, r.commandId, r.jobId, generation, raw);
        this.db.prepare("INSERT INTO shadow_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(commit, 0, s.installation as string, s.lineage as string, s.epoch as string, t.sessionId,
            r.commandId, r.jobId, generation, r.expectedVersion, version, r.operation, raw);
        const receipt: ShadowReceipt = { status: "shadow_committed", installation: String(s.installation),
          lineage: String(s.lineage), issuer: t.sessionId, commandId: r.commandId, digest,
          commitVersion: commit, jobId: r.jobId, turnGeneration: generation, version, sideEffects: "none" };
        this.db.prepare("INSERT INTO shadow_commands VALUES (?,?,?,?,?,?,?,?)")
          .run(...key, digest, raw, transport, JSON.stringify(receipt));
        const changed = this.db.prepare("UPDATE shadow_scope SET commit_version=? WHERE singleton=1 AND epoch=? AND instance=? AND commit_version=?")
          .run(commit, String(s.epoch), String(s.instance), String(s.commit_version));
        if (changed.changes !== 1) throw new Error("authority_cas_failed");
        this.db.exec("COMMIT"); return receipt;
      } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      return { status: "refused", reason: error instanceof Error ? error.message : "unknown_failure" };
    }
  }

  /** One consistent read transaction; stable serialization has no clock fields.
   * Shadow snapshots are evidence and must never feed production badges/rights.
   */
  snapshot(): string {
    this.db.exec("BEGIN");
    try {
      const scope = this.scope();
      const result = JSON.stringify({ mode: "shadow", productionAuthority: "unavailable", scope,
        sessions: this.db.prepare("SELECT * FROM shadow_sessions ORDER BY id COLLATE BINARY").all(),
        jobs: this.db.prepare("SELECT * FROM shadow_jobs ORDER BY id COLLATE BINARY").all(),
        turns: this.db.prepare("SELECT * FROM shadow_turns ORDER BY job_id COLLATE BINARY,length(generation),generation COLLATE BINARY").all() });
      this.db.exec("COMMIT"); return result;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
}
