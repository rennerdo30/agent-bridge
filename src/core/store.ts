import { admissionSqliteBusy } from "./storage-admission.js";
import { observeAdmissionPhase } from "./admission-observation.js";
import { guardPriorEndpoints } from "./prior-endpoints.js";
import { assertBootstrapAccess, assertBootstrapWitness } from "./store-bootstrap-journal.js";
import { assertMetadataUpgradeBoundary, metadataDb } from "./metadata-db.js";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { cleanupSavepoint } from "./savepoint.js";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "./logger.js";
import { isQuietMessage, SIBLING_CONVERSATION_PREFIX, type AgentKind, type BridgeMessage, type PeerInfo } from "./protocol.js";
import { migrateSqlite } from "./sqlite-migrations.js";
import { archiveDbPath, archiveMessages, ensureMessageQuarantine, openArchive, unquarantined } from "./sqlite-maintenance.js";
import { assertCompatibleMailboxReaders, maintenanceLock, storageLease, storageLeaseObservation } from "./storage-lock.js";
import { BackupBackground } from "./backup-background.js";
import { historySchema } from "./history-schema.js";
import { CONVERSATION_MIGRATION } from "./conversation-schema.js";
import { HistoryIndex } from "./history.js";
import { historyDbPath, openHistoryStore } from "./history-store.js";
import { isPluginCacheCwd } from "./session-visibility.js";
import { DECISIONS_SCHEMA, DecisionStore } from "./decisions.js";
import { configureSqlite, isSqliteBusy, retrySqlite, SQLITE_BUSY_TIMEOUT_MS, SQLITE_REQUEST_BUSY_MS } from "./sqlite-policy.js";
import { attachStoreCompatibility } from "./store-compatibility-overlay.js";
import { NativeLifecycleReader, type NativeRouteSnapshot } from "./native-lifecycle-reader.js";
import { physicalPath } from "./project-identity.js";
import { projectKey } from "./project-identity.js";
import { roleQueueSchema } from "./role-queue.js";
import { jobMailGrantSchema, jobRouteSchema, type JobMailGrant, type JobMailSuccessor, type JobRouteProof } from "./job-mail-routing.js";
import { t3BindingSchema, type T3Binding } from "./t3-identity.js";
import type { RemoteDestination } from "../network/link.js";
import { localMailbox, mailboxSchema, nativeOwner, nativeIdentitySchema, ownershipFromKey, peerOwnership, recipientKey, sameMailbox, verifiedNative } from "./recipient-ownership.js";

import { SQLITE_STORE_VERSION } from "./store-version.js";
export { SQLITE_STORE_VERSION } from "./store-version.js";

/** Offline broadcasts retain recently observed sessions for one day. */
export const BROADCAST_RECENT_MS = 24 * 60 * 60 * 1_000;

/** Recipient key used while a message waits for "any peer of this agent kind". */
export function agentQueueKey(agent: AgentKind): string {
  return `agent:${agent}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
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
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages (recipient, read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_id ON messages (id);
`;

const MIGRATIONS = [
  { version: 1, sql: `${SCHEMA} PRAGMA user_version = 1;` },
  { version: 2, sql: `
    CREATE TABLE IF NOT EXISTS archived_messages AS
      SELECT *, '' AS archive_reason, 0 AS archived_at FROM messages WHERE 0;
    PRAGMA user_version = 2;
  ` },
  { version: 3, sql: `${DECISIONS_SCHEMA} PRAGMA user_version = 3;` },
  { version: 4, sql: historySchema() },
  { version: 5, sql: `
    CREATE TABLE IF NOT EXISTS session_bindings (
      identity TEXT NOT NULL,
      session_id TEXT NOT NULL,
      learned_at INTEGER NOT NULL,
      PRIMARY KEY (identity, session_id)
    );
    PRAGMA user_version = 5;
  ` },
  { version: 6, sql: `
    CREATE TABLE IF NOT EXISTS peer_names (
      identity TEXT NOT NULL, name TEXT NOT NULL, session_id TEXT, agent TEXT NOT NULL,
      learned_at INTEGER NOT NULL, PRIMARY KEY (identity, name)
    );
    CREATE TABLE IF NOT EXISTS peer_name_owners (
      name TEXT PRIMARY KEY, identity TEXT NOT NULL
    );
    INSERT INTO peer_names
      SELECT binding.identity, json_extract(binding.identity, '$[4]'), binding.session_id, json_extract(binding.identity, '$[0]'), binding.learned_at
      FROM session_bindings binding WHERE json_valid(binding.identity)
        AND json_type(binding.identity, '$[4]')='text' AND json_type(binding.identity, '$[0]')='text'
        AND NOT EXISTS (
          SELECT 1 FROM session_bindings other WHERE json_valid(other.identity)
            AND other.identity<>binding.identity
            AND json_extract(other.identity, '$[4]')=json_extract(binding.identity, '$[4]')
        )
      ORDER BY binding.learned_at ASC
      ON CONFLICT(identity, name) DO UPDATE SET session_id=excluded.session_id, learned_at=excluded.learned_at;
    INSERT INTO peer_name_owners SELECT name, identity FROM peer_names WHERE 1 ORDER BY learned_at ASC
      ON CONFLICT(name) DO UPDATE SET identity=excluded.identity;
    PRAGMA user_version = 6;
  ` },
  { version: 7, sql: `
    CREATE TABLE IF NOT EXISTS job_delivery_routes (
      id TEXT PRIMARY KEY, recipient TEXT NOT NULL, consumed_at INTEGER
    );
    PRAGMA user_version = 7;
  ` },
  { version: 8, sql: CONVERSATION_MIGRATION },
  { version: 9, backupTables: ["peer_names"], sql: `
    CREATE TABLE IF NOT EXISTS peer_last_seen (
      name TEXT PRIMARY KEY, seen_at INTEGER NOT NULL
    );
    INSERT INTO peer_last_seen SELECT name, MAX(learned_at) FROM peer_names GROUP BY name;
    PRAGMA user_version = 9;
  ` },
  { version: 10, backupTables: [], sql: `
    CREATE TABLE message_frontends (
      id TEXT NOT NULL, recipient TEXT NOT NULL, binding TEXT NOT NULL,
      PRIMARY KEY(id,recipient)
    );
    CREATE INDEX idx_message_frontends_binding ON message_frontends(binding,recipient,id);
    CREATE TABLE send_intents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, fingerprint TEXT NOT NULL);
    CREATE TABLE send_destinations (
      id TEXT NOT NULL, recipient TEXT NOT NULL, message TEXT NOT NULL, destination TEXT NOT NULL,
      PRIMARY KEY(id,recipient)
    );
    PRAGMA user_version = 10;
  ` },
  // Add columns and project only new metadata; original rows/binding bytes stay
  // unchanged. No snapshot of a table that a v9 source has not created yet.
  { version: 11, backupTables: [], sql: `
    ALTER TABLE message_frontends ADD COLUMN state TEXT NOT NULL DEFAULT 'ambiguous';
    ALTER TABLE message_frontends ADD COLUMN identity TEXT NOT NULL DEFAULT '';
    UPDATE message_frontends SET state='hosted',identity=binding
      WHERE CASE WHEN json_valid(binding) THEN json_extract(binding,'$.kind')='t3'
        AND json_type(binding,'$.scope')='text' AND length(json_extract(binding,'$.scope'))=64
        AND json_extract(binding,'$.scope') NOT GLOB '*[^a-f0-9]*'
        AND json_type(binding,'$.threadId')='text' AND length(json_extract(binding,'$.threadId')) BETWEEN 1 AND 512
        AND json_type(binding,'$.providerInstanceId')='text' AND length(json_extract(binding,'$.providerInstanceId')) BETWEEN 1 AND 256 ELSE 0 END;
    CREATE TABLE recipient_registrations (
      name TEXT PRIMARY KEY, identity TEXT NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL, peer_id TEXT NOT NULL
    );
    PRAGMA user_version = 11;
  ` },
  // Preserve every intermediate proof string. It did not encode session versus
  // process provenance, so no native authority can be reconstructed from it.
  { version: 12, backupTables: [], sql: `
    ALTER TABLE message_frontends ADD COLUMN owner TEXT NOT NULL DEFAULT '';
    ALTER TABLE message_frontends ADD COLUMN sender TEXT NOT NULL DEFAULT '';
    UPDATE message_frontends SET owner=binding WHERE state='hosted' AND binding=identity;
    ALTER TABLE recipient_registrations ADD COLUMN owner TEXT NOT NULL DEFAULT '';
    PRAGMA user_version = 12;
  ` },
  // Intermediate readers did not record direction. Keep every original proof;
  // a display address or missing remote pin cannot prove historical locality.
  { version: 13, backupTables: [], sql: `
    ALTER TABLE message_frontends ADD COLUMN mailbox TEXT NOT NULL DEFAULT '';
    ALTER TABLE message_frontends ADD COLUMN source TEXT NOT NULL DEFAULT '';
    ALTER TABLE send_intents ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
    ALTER TABLE send_destinations ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
    ALTER TABLE job_delivery_routes ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS mailbox_store (id INTEGER PRIMARY KEY CHECK(id=1), namespace TEXT NOT NULL);
    INSERT OR IGNORE INTO mailbox_store VALUES (1,lower(hex(randomblob(32))));
    CREATE INDEX idx_message_mailbox_owner ON message_frontends(mailbox,state,owner,recipient,id);
    PRAGMA user_version = 13;
  ` },
  { version: 14, backupTables: [], sql: `
    CREATE TABLE job_mail_grants (
      id TEXT PRIMARY KEY, namespace TEXT NOT NULL, authority TEXT NOT NULL,
      original_recipient TEXT NOT NULL, original_owner TEXT NOT NULL, original_mailbox TEXT NOT NULL,
      body_hash TEXT NOT NULL, original_envelope TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE job_mail_succession (
      id TEXT NOT NULL, generation INTEGER NOT NULL, recipient TEXT NOT NULL,
      owner TEXT NOT NULL, mailbox TEXT NOT NULL, authority TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(id,generation)
    );
    CREATE TABLE job_mail_retirements (
      id TEXT NOT NULL, recipient TEXT NOT NULL, generation INTEGER NOT NULL,
      retired_at INTEGER NOT NULL, successor_generation INTEGER NOT NULL,
      PRIMARY KEY(id,recipient,generation)
    );
    PRAGMA user_version = 14;
  ` },
] as const;

/** Upgrade only the schema, without broker startup, archive movement or retention.
 * Pre-lease sources require explicit operator admission: all readers stopped and
 * this copy placed in an isolated home. This API neither verifies old binaries
 * have stopped nor copies/splits data; automatic startup cannot supply admission. */
export function migrateMessageSchema(db: DatabaseSync, file: string, existed: boolean, log: Logger,
  admission?: { kind: "offline-isolated"; home: string }): void {
  const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  if (file !== ":memory:" && (version === 2 || version === 3) &&
      (!admission || admission.kind !== "offline-isolated" || physicalPath(resolve(admission.home)) !== physicalPath(dirname(resolve(file)))))
    throw Object.assign(new Error("Pre-lease schema2/3 requires owner-coordinated shutdown and explicit offline migration into an isolated home; automatic shared-home migration is refused."), { code: "STORE_OFFLINE_REQUIRED" });
  migrateSqlite(db, file, existed, SQLITE_STORE_VERSION, MIGRATIONS, log);
}

export function registrationIdentity(peer: PeerInfo): string | null {
  if (peer.frontend) {
    const bound = t3BindingSchema.parse(peer.frontend);
    return JSON.stringify([peer.agent, "t3", bound.scope, bound.threadId, peer.name.replace(/-\d+$/, ""), bound.providerInstanceId]);
  }
  if (peer.jobAgent || !Number.isSafeInteger(peer.agentPid) || !peer.agentPid || peer.agentPid <= 0 || !peer.agentStartedAt) return null;
  let cwd = resolve(peer.cwd);
  try { cwd = physicalPath(cwd); } catch { /* A removed working folder still has a stable absolute spelling. */ }
  if (process.platform === "win32") cwd = cwd.toLowerCase();
  return JSON.stringify([peer.agent, peer.agentPid, peer.agentStartedAt, cwd, peer.name.replace(/-\d+$/, "")]);
}
function frontendKey(frontend?: T3Binding): string { return frontend ? JSON.stringify(t3BindingSchema.parse(frontend)) : ""; }

interface Row {
  id: string;
  recipient: string;
  from_id: string;
  from_name: string;
  from_agent: string;
  to_target: string;
  conversation_id: string;
  reply_to: string | null;
  hop: number;
  body: string;
  created_at: number;
  read_at: number | null;
}

function toMessage(r: Row): BridgeMessage {
  return {
    id: r.id,
    recipient: r.recipient,
    from: { id: r.from_id, name: r.from_name, agent: r.from_agent as AgentKind },
    to: r.to_target,
    conversationId: r.conversation_id,
    replyTo: r.reply_to,
    hop: r.hop,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

type StoreHandleCapture = { readonly identity: symbol; readonly db: DatabaseSync; readonly kinds: Set<"main" | "archive" | "history" | "admission">;
  close: "not_attempted" | "attempted" | "returned" | "unknown" };
type StoreConstructionCapture = { readonly identity: symbol; handles: Map<DatabaseSync, StoreHandleCapture>;
  statements: Set<StatementSync>; consumers: Set<DecisionStore | HistoryIndex>; lease: (() => void) | null;
  construction: "attempted" | "returned" | "unknown"; ordinaryClose: "not_attempted" | "attempted" | "returned" | "unknown"; unknown: boolean };
type StoreOperationCapture = { readonly identity: symbol; readonly kind: "direct" | "retry" | "maintenance"; active: boolean };
type StoreStatement = {
  get(...args: SQLInputValue[]): ReturnType<StatementSync["get"]>;
  all(...args: SQLInputValue[]): ReturnType<StatementSync["all"]>;
  run(...args: SQLInputValue[]): ReturnType<StatementSync["run"]>;
  setReadBigInts(value: boolean): void;
};
const storeHandleCaptures = new WeakMap<DatabaseSync, StoreConstructionCapture>();
const retainedStoreConstructions = new Set<StoreConstructionCapture>();

/** Actual historical constructor capture only; never native handle export,
 * current cold/schema proof, complete managed census or retirement permission.
 */
export function messageStoreHandleObservation(db: DatabaseSync) {
  const owner = storeHandleCaptures.get(db), handle = owner?.handles.get(db);
  return Object.freeze({ captured: handle !== undefined, construction: owner?.construction ?? "unavailable",
    main: handle?.kinds.has("main") ?? false, archive: handle?.kinds.has("archive") ?? false, history: handle?.kinds.has("history") ?? false,
    close: handle?.close ?? "not_attempted", handles: owner?.handles.size ?? 0, statements: owner?.statements.size ?? 0,
    consumers: owner?.consumers.size ?? 0, unknown: owner?.unknown ?? true, ordinaryClose: owner?.ordinaryClose ?? "not_attempted",
    retained: owner !== undefined && retainedStoreConstructions.has(owner), ownerBound: false as const,
    settled: false as const, ownershipReleased: false as const });
}

/**
 * Durable message store. Only the broker process opens it, so there is a single writer at a time.
 * All statements are prepared once and bound with parameters.
 */
export class MessageStore {
  private ownershipReady = false;
  #producerSealed = false;
  // No setter/retirement entry is exposed: actual committed-intent/joint-owner
  // permission remains a separate, currently unsupported source boundary.
  #writeAuthorityRetired = false;
  #producerGeneration = 0;
  #producerUnknown = false;
  #callbackUnknown = false;
  #nativeBorrowerUnknown = false;
  readonly #operationContext = new AsyncLocalStorage<StoreOperationCapture>();
  readonly #operations = new Set<StoreOperationCapture>();
  #maintenanceOperation: StoreOperationCapture | null = null;
  #operationWaiter: (() => void) | null = null;
  #decisionConsumer: DecisionStore | null = null;
  #historyConsumer: HistoryIndex | null = null;
  #consumersSealed = false;
  private producerChanged(): void {
    this.#producerGeneration++;
    if (!Number.isSafeInteger(this.#producerGeneration)) this.#producerUnknown = true;
  }
  private currentAcceptedOperation(): boolean {
    const operation = this.#operationContext.getStore();
    return operation !== undefined && operation.active && this.#operations.has(operation);
  }
  private assertProducerAdmission(): void {
    if (this.#writeAuthorityRetired || this.#producerSealed && !this.currentAcceptedOperation())
      throw Object.assign(new Error("store producer is quiesced"), { code: "OWNER_QUIESCED" });
  }
  private beginOperation(kind: StoreOperationCapture["kind"]): StoreOperationCapture {
    this.assertProducerAdmission();
    const operation = { identity: Symbol("actual accepted Store operation"), kind, active: true };
    this.#operations.add(operation); this.producerChanged();
    if (this.#operations.size > 128) this.#producerUnknown = true;
    return operation;
  }
  private finishOperation(operation: StoreOperationCapture, failed = false): void {
    if (!operation.active || !this.#operations.has(operation)) { this.#producerUnknown = true; this.producerChanged(); return; }
    if (failed) this.#producerUnknown = true;
    operation.active = false; this.#operations.delete(operation); this.producerChanged();
    this.sealCapturedConsumersIfReady(); this.#operationWaiter?.();
  }
  private acceptedOperation<T>(kind: StoreOperationCapture["kind"], action: () => T): T {
    const operation = this.beginOperation(kind);
    let result: T;
    try { result = this.#operationContext.run(operation, action); }
    catch (error) { this.finishOperation(operation, !isSqliteBusy(error)); throw error; }
    if (result instanceof Promise) {
      // Retain the exact promise/operation until its actual outcome, including
      // SQLite lock retries. The caller receives its original promise unchanged.
      void result.then(() => this.finishOperation(operation), () => this.finishOperation(operation, true));
    } else this.finishOperation(operation);
    return result;
  }
  private guardNative(db: DatabaseSync): void {
    this.assertProducerAdmission();
    if (!this.lifecycleConstruction.handles.has(db)) this.#nativeBorrowerUnknown = true;
    if (this.lifecycleConstruction.construction === "returned" && !this.currentAcceptedOperation()) this.#nativeBorrowerUnknown = true;
    this.producerChanged();
  }
  private native<T>(db: DatabaseSync, action: () => T): T {
    this.guardNative(db);
    try { return action(); }
    catch (error) { if (!isSqliteBusy(error)) this.#producerUnknown = true; this.producerChanged(); throw error; }
  }
  private exec(db: DatabaseSync, sql: string): void { this.native(db, () => db.exec(sql)); }
  private statementFrame(db: DatabaseSync, statement: StatementSync): StoreStatement {
    return Object.freeze({
      get: (...args: SQLInputValue[]) => this.native(db, () => statement.get(...args)),
      all: (...args: SQLInputValue[]) => this.native(db, () => statement.all(...args)),
      run: (...args: SQLInputValue[]) => this.native(db, () => statement.run(...args)),
      setReadBigInts: (value: boolean) => this.native(db, () => statement.setReadBigInts(value)),
    });
  }
  private statement(db: DatabaseSync, sql: string): StoreStatement { return this.statementFrame(db, this.native(db, () => db.prepare(sql))); }
  private sealCapturedConsumersIfReady(): void {
    // Do not reject a retained parent retry's later child action to manufacture
    // drain. Until that exact accepted work finishes, child seal is DEFERRED and
    // no complete preparation candidate can be inferred from the parent seal.
    if (!this.#producerSealed || this.#operations.size || this.#consumersSealed) return;
    if (!this.#decisionConsumer || !this.#historyConsumer || this.decisions !== this.#decisionConsumer || this.history !== this.#historyConsumer) {
      this.#producerUnknown = true; this.producerChanged(); return;
    }
    this.#decisionConsumer.sealLifecycleConsumer(); this.#historyConsumer.sealLifecycleConsumer();
    this.#consumersSealed = true; this.producerChanged();
  }
  sealLifecycleProducers() { this.#producerSealed = true; this.producerChanged(); this.sealCapturedConsumersIfReady(); return this.lifecycleProducerObservation(); }
  resumeLifecycleProducers() {
    if (this.#writeAuthorityRetired || this.closed) throw Object.assign(new Error("store ownership cannot resume"), { code: "OWNER_UNAVAILABLE" });
    if (this.#consumersSealed) { this.#decisionConsumer!.resumeLifecycleConsumer(); this.#historyConsumer!.resumeLifecycleConsumer(); this.#consumersSealed = false; }
    this.#producerSealed = false; this.producerChanged(); return this.lifecycleProducerObservation();
  }
  lifecycleProducerObservation() {
    // Pure source state. No page-reading writer SQL or assumed cold zero. Every
    // durable archive/purge/history/worker obligation still requires preparation.
    return Object.freeze({ generation: this.#producerGeneration, sealed: this.#producerSealed, retired: this.#writeAuthorityRetired,
      pendingOperations: this.#operations.size, unknown: this.#producerUnknown, callbackUnknown: this.#callbackUnknown,
      nativeBorrowerUnknown: this.#nativeBorrowerUnknown, pendingMaintenance: this.#maintenanceOperation?.active === true,
      consumersSealed: this.#consumersSealed,
      legacyArchivePending: this.legacyArchivePending, purgePending: this.purgeCutoff !== null || this.nextPurgeCutoff !== null,
      purgeCursorPending: this.purgeCursor !== null || this.purgeHighWater !== null, pendingReaders: this.nativeLifecycleReader.pending(),
      coldPreparation: "unverified" as const, nativeCompositeCoverage: "unverified" as const, blocker: "owner_unsupported" as const,
      ownerBound: false as const, settled: false as const, ownershipReleased: false as const });
  }
  async observeLifecycleProducers(deadline: number): Promise<ReturnType<MessageStore["lifecycleProducerObservation"]>> {
    const remaining = deadline - performance.now();
    if (this.#operationWaiter || !Number.isFinite(deadline) || remaining <= 0 || remaining > 2000) return this.lifecycleProducerObservation();
    while (this.#operations.size && performance.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined, waiter!: () => void;
      try {
        await new Promise<void>(resolve => { waiter = resolve; this.#operationWaiter = waiter; timer = setTimeout(resolve, Math.max(0, deadline - performance.now())); });
      } finally { if (timer) clearTimeout(timer); if (this.#operationWaiter === waiter) this.#operationWaiter = null; }
    }
    return this.lifecycleProducerObservation();
  }
  private readonly lifecycleConstruction: StoreConstructionCapture = { identity: Symbol("actual MessageStore constructor"),
    handles: new Map(), statements: new Set(), consumers: new Set(), lease: null, construction: "attempted", ordinaryClose: "not_attempted", unknown: false };
  private captureHandle(kind: "main" | "archive" | "history" | "admission", db: DatabaseSync): void {
    let capture = this.lifecycleConstruction.handles.get(db);
    if (!capture) { capture = { identity: Symbol("actual Store native handle"), db, kinds: new Set(), close: "not_attempted" }; this.lifecycleConstruction.handles.set(db, capture); }
    capture.kinds.add(kind); storeHandleCaptures.set(db, this.lifecycleConstruction);
  }
  private captureStatement(statement: StatementSync): StoreStatement { this.lifecycleConstruction.statements.add(statement); return this.statementFrame(this.db, statement); }
  private closeCapturedHandle(db: DatabaseSync): void {
    const capture = this.lifecycleConstruction.handles.get(db);
    if (capture) capture.close = "attempted"; else this.lifecycleConstruction.unknown = true;
    retainedStoreConstructions.add(this.lifecycleConstruction);
    try { db.close(); if (capture) capture.close = "returned"; }
    catch (error) { if (capture) capture.close = "unknown"; this.lifecycleConstruction.unknown = true; throw error; }
  }
  private readonly db: DatabaseSync;
  private readonly archiveDb: DatabaseSync;
  private readonly historyDb: DatabaseSync;
  private readonly release: () => void;
  private readonly home: string | null;
  private readonly writeAbort = new AbortController();
  private backups: BackupBackground | null = null;
  private archiveTimer: ReturnType<typeof setTimeout> | null = null;
  private legacyArchivePending = true;
  private purgeCutoff: number | null = null;
  private purgeCursor: string | null = null;
  private purgeHighWater: string | null = null;
  private nextPurgeCutoff: number | null = null;
  private archiveMaintenanceFailed = false;
  private closed = false;
  private readonly nativeLifecycleReader = new NativeLifecycleReader();
  private lifecycleMaintenanceQuiesced = false;
  private lifecycleResumeArchive = false;
  private lifecycleWriteGeneration = 0;
  private lifecycleWriteUnknown = false;
  private lifecyclePendingWriteCount = 0;
  private lifecycleDrainWaiter: (() => void) | null = null;
  readonly decisions: DecisionStore;
  readonly history: HistoryIndex;
  readonly historyFile: string;
  historyPeerSink: ((peer: PeerInfo) => void) | undefined;
  /** Told about every stored or claimed message, so a backed-off history worker indexes it promptly. */
  historyMessageSink: (() => void) | undefined;
  readonly file: string;
  private readonly stmt: {
    insert: StoreStatement;
    markRead: StoreStatement;
    byId: StoreStatement;
    replyConflicts: StoreStatement;
  };

  constructor(
    file: string,
    private readonly log: Logger,
  ) {
    if (file !== ":memory:") { assertBootstrapAccess(dirname(file)); assertMetadataUpgradeBoundary(dirname(file)); }
    retainedStoreConstructions.add(this.lifecycleConstruction);
    try {
    this.file = file;
    const existed = file !== ":memory:" && existsSync(file);
    this.home = file === ":memory:" ? null : dirname(file);
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); // owner-only on Unix
    // Shipped readers check this common maintenance lock before AND after
    // creating their storage lease. Endpoint probes alone cannot exclude a
    // legacy process which opens SQLite before binding its older endpoint.
    let unlockUpgrade: (() => void) | undefined;
    if (file !== ":memory:") {
      observeAdmissionPhase("constructor-readers", () => assertCompatibleMailboxReaders(dirname(file)));
      let version = 0;
      if (existed) {
        const inspection = new DatabaseSync(file, { readOnly: true });
        this.captureHandle("admission", inspection);
        try { version = Number(inspection.prepare("PRAGMA user_version").get()!.user_version); }
        finally { this.closeCapturedHandle(inspection); }
      }
      // A refusal must precede canonical metadata initialization as well as
      // mailbox DDL: metadata shares this exact database file.
      if (version > SQLITE_STORE_VERSION) throw new Error("Message store schema is newer than this reader; original database retained unchanged.");
      if (version === 2 || version === 3) throw Object.assign(new Error("Pre-lease schema2/3 requires owner-coordinated shutdown and explicit offline migration into an isolated home; automatic shared-home migration is refused."), { code: "STORE_OFFLINE_REQUIRED" });
      metadataDb(dirname(file));
      if (version < SQLITE_STORE_VERSION) {
        try { unlockUpgrade = observeAdmissionPhase("leases", () => maintenanceLock(dirname(file), false, true)); }
        catch (cause) { throw Object.assign(new Error("Mailbox migration exclusion is unavailable; owner-coordinated shutdown is required before sharing this data home.", { cause }), { code: "STORE_READER_ACTIVE" }); }
      }
    }
    try { this.release = file === ":memory:" ? () => {} : observeAdmissionPhase("leases", () => storageLease(dirname(file), unlockUpgrade)); }
    catch (error) { unlockUpgrade?.(); throw error; }
    this.lifecycleConstruction.lease = this.release;
    try {
    try { this.db = observeAdmissionPhase("main-open", () => new DatabaseSync(file)); this.captureHandle("main", this.db); }
    catch (err) { this.release(); throw err; }
    try {
      admissionSqliteBusy(this.db, SQLITE_BUSY_TIMEOUT_MS, true);
      if (file !== ":memory:") {
        const current = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
        if (!unlockUpgrade && current < SQLITE_STORE_VERSION)
          throw Object.assign(new Error("Mailbox changed after inspection; migration exclusion is unavailable. Owner-coordinated shutdown is required."), { code: "STORE_READER_ACTIVE" });
        observeAdmissionPhase("constructor-readers", () => assertCompatibleMailboxReaders(dirname(file)));
      }
      let deferred = false;
      try { observeAdmissionPhase("main-schema", () => migrateMessageSchema(this.db, file, existed, log)); }
      catch (error) {
        const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
        if ((error as NodeJS.ErrnoException).code !== "STORE_UPGRADE_DEFERRED" || version < 4) throw error;
        deferred = true;
        log.info("hosting broker on compatible existing schema while upgrade waits for retained readers", { file, version, target: SQLITE_STORE_VERSION });
      }
      if (file !== ":memory:") observeAdmissionPhase("overlay", () => attachStoreCompatibility(this.db, file, log, deferred));
      observeAdmissionPhase("main-configure", () => configureSqlite(this.db));
      ensureMessageQuarantine(this.db);
      this.ownershipReady = Number(this.statement(this.db, "PRAGMA user_version").get()!.user_version) >= SQLITE_STORE_VERSION;
    } catch (err) {
      this.closeCapturedHandle(this.db);
      this.release();
      throw err;
    }
    } finally { unlockUpgrade?.(); }
    try { this.archiveDb = observeAdmissionPhase("archive", () => openArchive(archiveDbPath(file))); this.captureHandle("archive", this.archiveDb); }
    catch (err) { this.closeCapturedHandle(this.db); this.release(); throw err; }
    // Legacy archived rows stay readable in their original table. Relocation
    // starts in bounded chunks only after the broker listener is available.
    this.decisions = new DecisionStore(this.db);
    this.#decisionConsumer = this.decisions;
    this.lifecycleConstruction.consumers.add(this.decisions);
    this.historyFile = historyDbPath(file);
    let historyDb: DatabaseSync | undefined;
    try {
      this.historyDb = historyDb = file === ":memory:" ? this.db : observeAdmissionPhase("history", () => openHistoryStore(this.historyFile));
      this.captureHandle("history", this.historyDb);
      this.history = new HistoryIndex(this.historyDb, this.home, undefined, this.db,
        file === ":memory:" ? undefined : (peer) => this.historyPeerSink?.(peer as PeerInfo));
      this.#historyConsumer = this.history;
      this.lifecycleConstruction.consumers.add(this.history);
    } catch (err) {
      if (historyDb && historyDb !== this.db) this.closeCapturedHandle(historyDb);
      this.closeCapturedHandle(this.archiveDb); this.closeCapturedHandle(this.db); this.release(); throw err;
    }
    this.stmt = {
      insert: this.captureStatement(this.db.prepare(
        `INSERT INTO messages (id, recipient, from_id, from_name, from_agent, to_target, conversation_id, reply_to, hop, body, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )),
      markRead: this.captureStatement(this.db.prepare(`UPDATE messages SET read_at = ? WHERE id = ? AND recipient = ? AND read_at IS NULL AND ${unquarantined("messages")}`)),
      byId: this.captureStatement(this.db.prepare(`SELECT * FROM messages WHERE id = ? ORDER BY created_at ASC LIMIT 1`)),
      replyConflicts: this.captureStatement(this.db.prepare(`SELECT id, from_name, conversation_id FROM deliverable_messages WHERE recipient = ? AND read_at IS NULL
        AND (conversation_id = ? OR from_name IN (SELECT value FROM json_each(?)))
        AND (? IS NULL OR created_at >= ?) AND id != ?
        AND conversation_id NOT LIKE '%:note' AND conversation_id NOT LIKE '%:ack'
        AND conversation_id NOT LIKE 'files-progress-%' ${this.frontendOwnership ? `AND ${this.ownershipSql("deliverable_messages")}` : ""} ORDER BY created_at, id LIMIT 50`)),
    };
    log.debug("message store opened", { file });
    this.lifecycleConstruction.construction = "returned"; retainedStoreConstructions.delete(this.lifecycleConstruction);
    } catch (error) { this.lifecycleConstruction.construction = "unknown"; this.lifecycleConstruction.unknown = true; throw error; }
  }

  startBackups(): void {
    return this.acceptedOperation("direct", () => {
    this.scheduleArchiveMaintenance();
    if (process.env.AGENT_BRIDGE_AUTO_BACKUP === "1" && this.home && !this.backups) this.backups = new BackupBackground(this.home, this.log);
    });
  }
  /** Only the isolated cold initializer uses this, before any listener/service
   * or accepted operation exists. Ordinary close is not silently promoted to
   * a witness: every actual captured native handle and own lease must close. */
  closeBootstrapPreparation(): void {
    if (this.backups || this.archiveTimer || this.#operations.size || this.closed) throw new Error("Cold-store preparation cleanup is unproven");
    this.close();
    if (this.lifecycleConstruction.unknown || this.lifecycleConstruction.ordinaryClose !== "returned" ||
        [...this.lifecycleConstruction.handles.values()].some(handle => handle.close !== "returned" || handle.db.isOpen) ||
        this.lifecycleConstruction.lease && storageLeaseObservation(this.lifecycleConstruction.lease).release !== "returned")
      throw new Error("Cold-store preparation retained unclosed resources");
  }
  backupPressure(pending: boolean, lockError = false): void { this.acceptedOperation("direct", () => this.backups?.pressure(pending, lockError)); }
  backupStatus(): import("./backup-background.js").BackupHealth | null { return this.backups?.status() ?? null; }
  async closeBackups(): Promise<void> {
    if (this.#producerSealed || this.#writeAuthorityRetired) throw Object.assign(new Error("accepted backup work is retained"), { code: "OWNER_QUIESCED" });
    await this.acceptedOperation("direct", async () => { await this.backups?.close(); this.backups = null; });
  }

  /** Append identities learned from hooks; previous session bindings remain retained. */
  rememberSession(peer: PeerInfo, at: number): void {
    return this.acceptedOperation("direct", () => {
    const identity = registrationIdentity(peer);
    if (!identity || !peer.sessionId) return;
    this.statement(this.db, `INSERT INTO session_bindings VALUES (?,?,?) ON CONFLICT(identity,session_id)
      DO UPDATE SET learned_at=excluded.learned_at`).run(identity, peer.sessionId, at);
    });
  }

  recoverSession(peer: PeerInfo): string | null {
    return this.acceptedOperation("direct", () => {
    const identity = registrationIdentity(peer);
    if (!identity) return null;
    const row = this.statement(this.db, "SELECT session_id FROM session_bindings WHERE identity=? ORDER BY learned_at DESC, rowid DESC LIMIT 1").get(identity);
    return row ? String(row.session_id) : null;
    });
  }

  /** Retain names only with CLI or hook identity; a similar spelling is never an alias. */
  rememberName(peer: PeerInfo, at: number): void {
    return this.acceptedOperation("direct", () => {
    const jobOwner = peer.jobAgent ? nativeOwner(peer) : undefined;
    const identity = jobOwner ? JSON.stringify(["job", jobOwner]) : registrationIdentity(peer) ?? (!peer.jobAgent && peer.sessionId ? JSON.stringify(["session", peer.agent, peer.sessionId]) : null);
    this.exec(this.db, "BEGIN IMMEDIATE");
    try {
      if (identity) this.statement(this.db, `INSERT INTO peer_names VALUES (?,?,?,?,?) ON CONFLICT(identity,name)
        DO UPDATE SET session_id=COALESCE(excluded.session_id,peer_names.session_id), learned_at=MIN(peer_names.learned_at,excluded.learned_at)`)
        .run(identity, peer.name, peer.sessionId, peer.agent, at);
      // Even an older or unidentified server supersedes historical ownership of its exact name.
      this.statement(this.db, `INSERT INTO peer_name_owners VALUES (?,?) ON CONFLICT(name)
        DO UPDATE SET identity=excluded.identity`).run(peer.name, identity ?? `unidentified:${peer.id}`);
      if (this.frontendOwnership) this.statement(this.db, `INSERT INTO recipient_registrations VALUES (?,?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET identity=excluded.identity,binding=excluded.binding,state=excluded.state,peer_id=excluded.peer_id,owner=excluded.owner`)
        .run(peer.name, identity ?? `unidentified:${peer.id}`, frontendKey(peer.frontend), peer.frontend ? "hosted" : nativeOwner(peer) ? "native" : "ambiguous", peer.id, nativeOwner(peer) ?? "");
      if (!peer.jobAgent && !peer.subagent) this.markPeerSeen(peer.name, at);
      this.exec(this.db, "COMMIT");
    } catch (err) { this.exec(this.db, "ROLLBACK"); throw err; }
    });
  }

  /** Presence updates never change the identity that currently owns a name. */
  markPeerSeen(name: string, at: number): void {
    return this.acceptedOperation("direct", () => {
    this.statement(this.db, `INSERT INTO peer_last_seen VALUES (?,?)
      ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)`).run(name, at);
    });
  }

  namesFor(peer: PeerInfo): string[] {
    return this.acceptedOperation("direct", () => {
    if (peer.jobAgent) return this.jobNames(nativeOwner(peer));
    const identity = registrationIdentity(peer);
    if (!identity && !peer.sessionId) return [];
    return this.statement(this.db, `SELECT name FROM peer_names JOIN peer_name_owners USING(name,identity)
      WHERE identity=? OR (session_id=? AND agent=? AND (CASE WHEN json_valid(identity) THEN json_extract(identity,'$[1]') END) IS NOT 't3'
        AND (CASE WHEN json_valid(identity) THEN json_extract(identity,'$[0]') END) IS NOT 'job') GROUP BY name ORDER BY MIN(learned_at) ASC, MIN(peer_names.rowid) ASC`)
      .all(identity, peer.frontend ? null : peer.sessionId, peer.agent).map((r) => String(r.name));
    });
  }

  /** Exact broker-issued leases for a validated durable job incarnation. No spelling inference.
   * Older branch registrations remain usable evidence; new leases survive name reuse. */
  jobNames(owner: string | undefined): string[] {
    return this.acceptedOperation("direct", () => {
      if (!this.frontendOwnership || !owner || verifiedNative(owner) !== owner || JSON.parse(owner).kind !== "job") return [];
      return this.statement(this.db, `SELECT name FROM peer_names WHERE identity=?
        UNION SELECT name FROM recipient_registrations WHERE state='native' AND owner=? ORDER BY name`)
        .all(JSON.stringify(["job", owner]), owner).map(row => String(row.name));
    });
  }

  /** Retained registrations include offline sessions, but never worker runners or agent queue keys. */
  broadcastNames(): string[] {
    return this.acceptedOperation("direct", () => {
    return this.statement(this.db, `SELECT name,identity FROM peer_name_owners
      WHERE identity NOT LIKE 'unidentified:job:%' ORDER BY name`).all().filter((row) => {
        const identity = String(row.identity);
        let session: string | undefined;
        try {
          const parts: unknown = JSON.parse(identity);
          if (Array.isArray(parts)) {
            if (parts[0] === "job") return false;
            if (parts[0] === "session" && typeof parts[2] === "string") session = parts[2];
            else if (typeof parts[1] === "number" && typeof parts[3] === "string") return !isPluginCacheCwd(parts[3]);
          }
        } catch { /* Older unidentified registrations may still have indexed session metadata. */ }
        const cwds = this.history.sessionProjectPaths(identity.startsWith("unidentified:") ? identity.slice(13) : String(row.name), session);
        // Historical rows remain untouched. Unknown paths and any real project path stay eligible.
        return !cwds.length || cwds.some((cwd) => !isPluginCacheCwd(cwd));
      }).map((row) => String(row.name));
    });
  }

  /** Eligibility never removes history or old queued messages. Unknown old names are skipped. */
  recentProjectSenders(address: string, previous: string, since: number): string[] {
    return this.acceptedOperation("direct", () => {
    return this.statement(this.db, `SELECT from_name FROM deliverable_messages WHERE to_target=? AND recipient=? AND created_at>=?
      AND from_id NOT LIKE 'job:%' GROUP BY from_name ORDER BY MAX(created_at) DESC LIMIT 64`)
      .all(address, previous, since).map((row) => String(row.from_name));
    });
  }
  recentProjectSenderOwners(address: string, previous: string, since: number): { name: string; owner: string }[] {
    return this.acceptedOperation("direct", () => !this.frontendOwnership ? [] : this.statement(this.db,
      `SELECT m.from_name,f.sender FROM deliverable_messages m JOIN message_frontends f ON f.id=m.id AND f.recipient=m.recipient
       WHERE m.to_target=? AND m.recipient=? AND m.created_at>=? AND m.from_id NOT LIKE 'job:%' AND f.sender<>'' AND f.mailbox=? AND f.source=?
       GROUP BY m.from_name,f.sender ORDER BY MAX(m.created_at) DESC LIMIT 64`).all(address, previous, since, JSON.stringify(localMailbox(this.namespace)), JSON.stringify(localMailbox(this.namespace)))
      .map(row => ({ name: String(row.from_name), owner: String(row.sender) })));
  }

  broadcastRecipients(now: number, masters: ReadonlySet<string>): { queued: string[]; skipped: string[] } {
    return this.acceptedOperation("direct", () => {
    const seen = this.statement(this.db, "SELECT seen_at FROM peer_last_seen WHERE name=?");
    const queued: string[] = [], skipped: string[] = [];
    for (const name of this.broadcastNames()) {
      const at = Number(seen.get(name)?.seen_at ?? 0);
      (masters.has(name) || at > 0 && at >= now - BROADCAST_RECENT_MS ? queued : skipped).push(name);
    }
    for (const name of masters) if (!queued.includes(name) && !skipped.includes(name)) queued.push(name);
    return { queued, skipped };
    });
  }

  /** Keep lock waits out of the broker event loop. Callbacks must be synchronous atomic steps. */
  retryWrite<T>(operation: () => T): Promise<T> {
    return this.acceptedOperation("retry", () => {
    this.#callbackUnknown = true; this.producerChanged();
    // Register before the first synchronous attempt, including its lock wait.
    // Observation never aborts/rejects accepted operations to manufacture drain.
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const tracked = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    this.lifecyclePendingWriteCount++; this.lifecycleWriteGeneration++;
    if (!Number.isSafeInteger(this.lifecyclePendingWriteCount) || !Number.isSafeInteger(this.lifecycleWriteGeneration)) this.lifecycleWriteUnknown = true;
    const settled = () => {
      this.lifecyclePendingWriteCount--; this.lifecycleWriteGeneration++;
      if (!Number.isSafeInteger(this.lifecycleWriteGeneration)) this.lifecycleWriteUnknown = true;
      if (!this.lifecyclePendingWriteCount) this.lifecycleDrainWaiter?.();
    };
    void tracked.then(settled, () => { this.lifecycleWriteUnknown = true; settled(); });
    void retrySqlite(() => {
      this.exec(this.db, `PRAGMA busy_timeout = ${SQLITE_REQUEST_BUSY_MS}`);
      try { return operation(); }
      finally { this.exec(this.db, `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`); }
    }, Infinity, this.writeAbort.signal).then(resolve, reject);
    return tracked;
    });
  }

  /** Inhibits this maintenance producer only. Dispatch and all other owners need their own gates. */
  quiesceLifecycleMaintenance(): void {
    this.lifecycleMaintenanceQuiesced = true;
    this.lifecycleResumeArchive ||= !!this.archiveTimer;
    if (this.archiveTimer) clearTimeout(this.archiveTimer);
    this.archiveTimer = null;
  }
  resumeLifecycleMaintenance(): void {
    if (this.#writeAuthorityRetired) throw Object.assign(new Error("store ownership cannot resume"), { code: "OWNER_UNAVAILABLE" });
    this.lifecycleMaintenanceQuiesced = false;
    const resume = this.lifecycleResumeArchive; this.lifecycleResumeArchive = false;
    if (!this.closed && resume) this.scheduleArchiveMaintenance();
  }
  lifecycleWriteManifest(): { generation: number; pending: number; unknown: boolean; maintenanceQuiesced: boolean;
    pendingReaders: number; transactionsSettled: boolean; legacyArchivePending: boolean; purgePending: boolean } {
    return { generation: this.lifecycleWriteGeneration, pending: this.lifecyclePendingWriteCount, unknown: this.lifecycleWriteUnknown,
      maintenanceQuiesced: this.lifecycleMaintenanceQuiesced, pendingReaders: this.nativeLifecycleReader.pending(),
      transactionsSettled: !this.closed && [this.db, this.archiveDb, this.historyDb].every(db => db.isTransaction === false),
      legacyArchivePending: this.legacyArchivePending, purgePending: this.purgeCutoff !== null || this.nextPurgeCutoff !== null };
  }
  /** Queue settlement observation, not a file flush/checkpoint or release witness. */
  async settleLifecycleWrites(deadline: number): Promise<ReturnType<MessageStore["lifecycleWriteManifest"]> & { settled: boolean }> {
    // One bounded observer, with no copy of the admitted retry queue/payloads.
    if (this.lifecycleDrainWaiter) return { ...this.lifecycleWriteManifest(), settled: false };
    if (Number.isFinite(deadline) && performance.now() < deadline && this.lifecyclePendingWriteCount) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let waiter!: () => void;
      try {
        await new Promise<void>(resolve => {
          waiter = resolve; this.lifecycleDrainWaiter = waiter;
          timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
        });
      } finally { if (timer) clearTimeout(timer); if (this.lifecycleDrainWaiter === waiter) this.lifecycleDrainWaiter = null; }
    }
    const manifest = this.lifecycleWriteManifest();
    return { ...manifest, settled: Number.isFinite(deadline) && performance.now() < deadline && manifest.maintenanceQuiesced &&
      !manifest.pending && !manifest.unknown && !manifest.pendingReaders && manifest.transactionsSettled };
  }

  insert(m: BridgeMessage): void {
    return this.acceptedOperation("direct", () => {
    if (!this.frontendOwnership) throw new Error("Verified recipient ownership storage upgrade is required; mail was not stored.");
    // Only fresh locally produced envelopes can acquire this store's namespace.
    // An outbound address without its authenticated remote proof stays blocked.
    if (!m.recipientMailbox && (!m.recipient.includes("/") || m.recipient.includes("/sub:"))) m.recipientMailbox = localMailbox(this.namespace);
    const parsedMailbox = mailboxSchema.safeParse(m.recipientMailbox), mailbox = parsedMailbox.success ? JSON.stringify(parsedMailbox.data) : "";
    if (parsedMailbox.success && parsedMailbox.data.kind === "local" && parsedMailbox.data.namespace !== this.namespace) throw new Error("Envelope belongs to a different local store namespace.");
    if (!m.senderMailbox && !m.from.id.includes("/")) m.senderMailbox = localMailbox(this.namespace);
    const parsedSource = mailboxSchema.safeParse(m.senderMailbox), source = parsedSource.success ? JSON.stringify(parsedSource.data) : "";
    if (parsedSource.success && parsedSource.data.kind === "local" && parsedSource.data.namespace !== this.namespace) throw new Error("Sender belongs to a different local store namespace.");
    const role = m.recipientRole ? roleQueueSchema.parse(m.recipientRole) : undefined;
    if (role && (m.to !== agentQueueKey(role.agent) || m.recipient !== m.to || role.namespace !== this.namespace ||
        !sameMailbox(m.recipientMailbox, localMailbox(this.namespace)) || m.recipientFrontend || m.recipientNative || m.recipientAmbiguous ||
        !sameMailbox(m.senderMailbox, localMailbox(this.namespace)) || !m.senderOwner)) throw new Error("Explicit local role-queue authority is invalid");
    const state = role ? "role" : m.recipientAmbiguous ? "ambiguous" : m.recipientFrontend ? "hosted" : verifiedNative(m.recipientNative) ? "native" : "ambiguous";
    const binding = frontendKey(m.recipientFrontend), identity = role ? JSON.stringify(role) : state === "hosted" ? binding : m.recipientNative ?? "";
    const owner = role ? identity : state === "hosted" ? binding : state === "native" ? verifiedNative(m.recipientNative)! : "";
    const retainedOwner = this.statement(this.db, "SELECT binding,state,identity,owner,sender,mailbox,source FROM message_frontends WHERE id=? AND recipient=?").get(m.id, m.recipient);
    if (retainedOwner && (retainedOwner.binding !== binding || retainedOwner.state !== state || retainedOwner.identity !== identity || retainedOwner.owner !== owner || retainedOwner.sender !== (m.senderOwner ?? "") || retainedOwner.mailbox !== mailbox || retainedOwner.source !== source)) throw new Error("Retained message ownership cannot be overwritten.");
    this.exec(this.db, "SAVEPOINT owned_message_insert");
    try {
    this.stmt.insert.run(
      m.id,
      m.recipient,
      m.from.id,
      m.from.name,
      m.from.agent,
      m.to,
      m.conversationId,
      m.replyTo,
      m.hop,
      m.body,
      m.createdAt,
    );
    this.notifyHistoryChanged();
    this.statement(this.db, "INSERT OR IGNORE INTO message_frontends(id,recipient,binding,state,identity,owner,sender,mailbox,source) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(m.id, m.recipient, binding, state, identity, owner, m.senderOwner ?? "", mailbox, source);
    this.exec(this.db, "RELEASE owned_message_insert");
    } catch (error) { cleanupSavepoint(this.db, "owned_message_insert", true, error); }
    });
  }

  /** Old retained readers block the schema upgrade: hosted operations fail closed. */
  get frontendOwnership(): boolean { return this.ownershipReady; }

  /** Only registration evidence, never a missing field or the next name claimant,
   * may select ownership for a NEW copy. Historical copies are never backfilled. */
  recipientOwnership(name: string, live?: PeerInfo): Pick<BridgeMessage, "recipientFrontend" | "recipientNative" | "recipientAmbiguous"> {
    return this.acceptedOperation("direct", () => {
      if (live) return peerOwnership(live);
      if (!this.frontendOwnership) return { recipientAmbiguous: true };
      const row = this.statement(this.db, `SELECT r.* FROM recipient_registrations r JOIN peer_name_owners n
        ON n.name=r.name AND n.identity=r.identity WHERE r.name=?`).get(name);
      if (row?.state === "hosted") return { recipientFrontend: t3BindingSchema.parse(JSON.parse(String(row.binding))) };
      if (row?.state === "native" && verifiedNative(String(row.owner))) return { recipientNative: String(row.owner) };
      // Older authenticated helloT3 registrations retained the complete binding.
      // This proves a current offline destination, not the owner of older mail.
      const old = this.statement(this.db, `SELECT n.identity FROM peer_name_owners n JOIN peer_names p
        ON n.name=p.name AND n.identity=p.identity WHERE n.name=?`).get(name);
      if (old) {
        try {
          const parts: unknown = JSON.parse(String(old.identity));
          if (Array.isArray(parts) && parts[1] === "t3") {
            const frontend = t3BindingSchema.safeParse({ kind: "t3", scope: parts[2], threadId: parts[3], providerInstanceId: parts[5] });
            if (frontend.success) return { recipientFrontend: frontend.data };
          }
        } catch { /* Unprovable historical registrations remain ambiguous. */ }
      }
      return { recipientAmbiguous: true };
    });
  }

  /** Bounded offline recovery inventory; no ownership grant or payload exposure. */
  blockedOwnership(limit = 100, after: { source: string; rowid: number } = { source: "main", rowid: 0 }): {
    records: { id: string; recipient: string; source: string; readAt: number | null; reason: string }[];
    next: { source: string; rowid: number } | null;
  } {
    return this.acceptedOperation("direct", () => {
      const result: { id: string; recipient: string; source: string; readAt: number | null; reason: string }[] = [];
      limit = Math.max(1, Math.min(1000, Math.trunc(limit) || 100));
      let scanning = false, scanned = 0;
      for (const [db, table, source] of [[this.db, "messages", "main"], [this.db, "archived_messages", "legacy-archive"], [this.archiveDb, "messages", "archive"]] as const) {
        if (source === after.source) scanning = true;
        if (!scanning) continue;
        let rowid = source === after.source ? after.rowid : 0;
        for (const row of this.statement(db, `SELECT rowid,id,recipient,read_at FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`).all(rowid, limit - scanned + 1)) {
          if (scanned >= limit) return { records: result, next: { source, rowid } };
          rowid = Number(row.rowid); scanned++;
          const owner = this.frontendOwnership ? this.statement(this.db, "SELECT state,owner,mailbox FROM message_frontends WHERE id=? AND recipient=?").get(row.id!, row.recipient!) : undefined;
          const provenance = this.parseMailbox(owner?.mailbox);
          if (!this.ledgerKey(owner) || !provenance || provenance.kind === "local" && provenance.namespace !== this.namespace) result.push({ id: String(row.id), recipient: String(row.recipient), source,
            readAt: row.read_at === null ? null : Number(row.read_at), reason: "Recipient provenance is missing or ambiguous; explicit reviewed recovery required." });
        }
      }
      return { records: result, next: null };
    });
  }

  private ownershipSql(table: string): string {
    return `(SELECT CASE WHEN state='native' AND owner<>'' THEN 'native:'||owner WHEN state='hosted' AND owner<>'' THEN 'hosted:'||owner ELSE NULL END
      FROM message_frontends f WHERE f.id=${table}.id AND f.recipient=${table}.recipient
        AND f.mailbox=(SELECT json_object('kind','local','namespace',namespace) FROM mailbox_store WHERE id=1 AND length(namespace)=64 AND namespace NOT GLOB '*[^a-f0-9]*')) = ?
      AND (NOT EXISTS(SELECT 1 FROM job_mail_grants g WHERE g.id=${table}.id) OR EXISTS(
        SELECT 1 FROM job_mail_succession s WHERE s.id=${table}.id AND s.recipient=${table}.recipient
        AND s.generation=(SELECT MAX(latest.generation) FROM job_mail_succession latest WHERE latest.id=s.id)
        AND EXISTS(SELECT 1 FROM job_delivery_routes r WHERE r.id=s.id AND r.recipient=s.recipient AND r.consumed_at IS NULL AND r.namespace=(SELECT namespace FROM mailbox_store WHERE id=1))))`;
  }
  /** Stable namespace belongs to the selected backup group, never a host display name. */
  get namespace(): string {
    const value = this.frontendOwnership ? this.statement(this.db, "SELECT namespace FROM mailbox_store WHERE id=1").get()?.namespace : undefined;
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Local mailbox namespace is unavailable; restore the complete selected backup group.");
    return value;
  }
  private parseMailbox(value: unknown): BridgeMessage["recipientMailbox"] {
    try { return mailboxSchema.parse(JSON.parse(String(value))); } catch { return undefined; }
  }
  private ledgerKey(row?: Record<string, unknown>): string | null {
    try { return row?.state === "role" || row?.state === "role-claimed" ? `role:${JSON.stringify(roleQueueSchema.parse(JSON.parse(String(row.owner))))}` : row?.state === "hosted" ? recipientKey(t3BindingSchema.parse(JSON.parse(String(row.owner)))) :
      row?.state === "native" ? recipientKey(undefined, String(row.owner)) : null; } catch { return null; }
  }
  localCopy(message: BridgeMessage): boolean { return !message.recipientAmbiguous && sameMailbox(message.recipientMailbox, localMailbox(this.namespace)); }
  private decode(row: Row): BridgeMessage {
    const message = toMessage(row);
    const owner = this.frontendOwnership ? this.statement(this.db, "SELECT binding,state,identity,owner,sender,mailbox,source FROM message_frontends WHERE id=? AND recipient=?").get(row.id, row.recipient) : undefined;
    if (owner?.sender) message.senderOwner = String(owner.sender);
    message.senderMailbox = this.parseMailbox(owner?.source);
    if (owner?.state === "hosted" && owner.owner) message.recipientFrontend = t3BindingSchema.parse(JSON.parse(String(owner.owner)));
    else if (owner?.state === "native" && verifiedNative(String(owner.owner))) message.recipientNative = String(owner.owner);
    else if (owner?.state === "role" || owner?.state === "role-claimed") message.recipientRole = roleQueueSchema.parse(JSON.parse(String(owner.owner)));
    else message.recipientAmbiguous = true;
    try { message.recipientMailbox = mailboxSchema.parse(JSON.parse(String(owner?.mailbox))); } catch { message.recipientAmbiguous = true; }
    if (message.recipientMailbox?.kind === "local" && message.recipientMailbox.namespace !== this.namespace) message.recipientAmbiguous = true;
    message.jobRoute = this.jobRouteFor(message.id, message.recipient);
    return message;
  }

  private jobRouteFor(id: string, recipient: string): JobRouteProof | undefined {
    if (!this.frontendOwnership) return undefined;
    const row = this.statement(this.db, "SELECT generation FROM job_mail_succession WHERE id=? AND recipient=? ORDER BY generation DESC LIMIT 1").get(id, recipient);
    return row ? { grant: id, generation: Number(row.generation) } : undefined;
  }
  jobRoutingGrant(id: string): { grant: JobMailGrant; namespace: string; originalRecipient: string; originalOwner: string } | null {
    return this.acceptedOperation("direct", () => {
      if (!this.frontendOwnership) return null;
      const row = this.statement(this.db, "SELECT * FROM job_mail_grants WHERE id=?").get(id);
      return row ? { grant: jobMailGrantSchema.parse(JSON.parse(String(row.authority))), namespace: String(row.namespace),
        originalRecipient: String(row.original_recipient), originalOwner: String(row.original_owner) } : null;
    });
  }
  isActiveJobCopy(message: BridgeMessage): boolean {
    return this.acceptedOperation("direct", () => {
      const grant = this.jobRoutingGrant(message.id);
      if (!grant) return true;
      if (grant.namespace !== this.namespace || !this.localCopy(message)) return false;
      const latest = this.statement(this.db, "SELECT s.* FROM job_mail_succession s JOIN job_delivery_routes r USING(id) WHERE s.id=? AND r.consumed_at IS NULL AND r.recipient=s.recipient AND r.namespace=? ORDER BY generation DESC LIMIT 1").get(message.id, this.namespace);
      return !!latest && latest.recipient === message.recipient && latest.owner === recipientKey(message.recipientFrontend, message.recipientNative) &&
        message.jobRoute?.grant === message.id && message.jobRoute.generation === Number(latest.generation);
    });
  }
  private jobBodyHash(message: BridgeMessage): string {
    return createHash("sha256").update(JSON.stringify([message.id, message.from.id, message.from.agent, message.body, message.replyTo, message.hop])).digest("hex");
  }
  private retainJobGrant(message: BridgeMessage, authority: JobMailGrant): void {
    const grant = jobMailGrantSchema.parse(authority), owner = recipientKey(message.recipientFrontend, message.recipientNative), ns = this.namespace;
    if (!jobRouteSchema.safeParse({ grant: message.id, generation: 0 }).success || !owner || message.from.id !== `job:${grant.job}` ||
        message.from.agent !== JSON.parse(grant.principal).agent || message.senderOwner !== `native:${grant.principal}` ||
        !this.localCopy(message) || !sameMailbox(message.senderMailbox, localMailbox(ns)) || message.recipientRole)
      throw new Error("Job report grant requires an exact proven local-origin copy");
    const existing = this.statement(this.db, "SELECT * FROM job_mail_grants WHERE id=?").get(message.id);
    if (existing) {
      const original = jobMailGrantSchema.parse(JSON.parse(String(existing.authority)));
      if (existing.namespace !== ns || existing.body_hash !== this.jobBodyHash(message) || original.job !== grant.job || original.incarnation !== grant.incarnation || original.principal !== grant.principal || projectKey(original.project) !== projectKey(grant.project))
        throw new Error("Original job report grant or accepted bytes changed");
      return;
    }
    // A grant cannot be added retrospectively to an existing ungranted copy.
    if (this.byId(message.id)) throw new Error("Existing ungranted job evidence remains pending");
    this.statement(this.db, "INSERT INTO job_mail_grants VALUES (?,?,?,?,?,?,?,?,?)")
      .run(message.id, ns, JSON.stringify(grant), message.recipient, owner, JSON.stringify(message.recipientMailbox), this.jobBodyHash(message), JSON.stringify(message), message.createdAt);
    this.statement(this.db, "INSERT INTO job_mail_succession VALUES (?,0,?,?,?,?,?)")
      .run(message.id, message.recipient, owner, JSON.stringify(message.recipientMailbox), JSON.stringify(grant), message.createdAt);
  }
  rememberSendIntent(id: string, owner: string, fingerprint: string): void {
    return this.acceptedOperation("direct", () => {
      if (!this.frontendOwnership) throw new Error("Durable send storage upgrade is required.");
      this.statement(this.db, "INSERT OR IGNORE INTO send_intents VALUES (?,?,?,?)").run(id, owner, fingerprint, this.namespace);
      const original = this.statement(this.db, "SELECT owner,fingerprint,namespace FROM send_intents WHERE id=?").get(id)!;
      if (original.namespace !== this.namespace || original.owner !== owner || original.fingerprint !== fingerprint) throw new Error("Message id already retained with different sender, namespace or content.");
    });
  }
  sendIntentOwner(id: string): string | undefined {
    return this.acceptedOperation("direct", () => {
      if (!this.frontendOwnership) return undefined;
      const record = this.statement(this.db, "SELECT owner,namespace FROM send_intents WHERE id=?").get(id);
      if (record && record.namespace !== this.namespace) throw new Error("Retained sender namespace is unproven; recovery requires explicit reviewed evidence.");
      return record ? String(record.owner) : undefined;
    });
  }
  /** A crash may leave both original request and exact destination, or neither;
   * never a request-only intent that a future registration could retarget. */
  admitRemoteSend(message: BridgeMessage, destination: RemoteDestination, request: { owner: string; fingerprint: string }): void {
    this.acceptedOperation("direct", () => {
      if (!mailboxSchema.safeParse({ kind: "remote", hostId: destination.hostId, hostFingerprint: destination.hostFingerprint }).success ||
          !destination.name || !recipientKey(destination.frontend, destination.native) || !message.senderOwner ||
          !sameMailbox(message.senderMailbox, localMailbox(this.namespace)) ||
          !sameMailbox(message.recipientMailbox, { kind: "remote", hostId: destination.hostId, hostFingerprint: destination.hostFingerprint }) ||
          recipientKey(message.recipientFrontend, message.recipientNative) !== recipientKey(destination.frontend, destination.native))
        throw new Error("Complete authenticated remote destination is required before admission");
      this.exec(this.db, "SAVEPOINT remote_send_admission");
      try {
        this.rememberSendIntent(message.id, request.owner, request.fingerprint);
        this.pinDestination(message, destination);
        this.exec(this.db, "RELEASE remote_send_admission");
      } catch (error) {
        this.exec(this.db, "ROLLBACK TO remote_send_admission");
        this.exec(this.db, "RELEASE remote_send_admission");
        throw error;
      }
    });
  }
  pinDestination(message: BridgeMessage, destination: RemoteDestination): { message: BridgeMessage; destination: RemoteDestination } {
    return this.acceptedOperation("direct", () => {
      if (!this.frontendOwnership) throw new Error("Durable destination storage upgrade is required.");
      // SQLite commits this immutable intent before the caller can dispatch a wire frame.
      const routeKey = message.to === "*" ? message.recipient : message.to;
      const { jobControlAuthorized: _liveAuthorization, ...durableMessage } = message;
      this.statement(this.db, "INSERT OR IGNORE INTO send_destinations VALUES (?,?,?,?,?)")
        .run(message.id, routeKey, JSON.stringify(durableMessage), JSON.stringify(destination), this.namespace);
      const original = this.statement(this.db, "SELECT message,destination,namespace FROM send_destinations WHERE id=? AND recipient=?").get(message.id, routeKey)!;
      if (original.namespace !== this.namespace) throw new Error("Retained destination namespace is unproven; no dispatch or retarget.");
      const retained = JSON.parse(String(original.message)) as BridgeMessage;
      if (retained.id !== message.id || retained.body !== message.body || retained.to !== message.to || retained.replyTo !== message.replyTo || retained.hop !== message.hop ||
          retained.from.name !== message.from.name || retained.from.agent !== message.from.agent) throw new Error("Message id already retained with different content.");
      return { message: retained, destination: JSON.parse(String(original.destination)) as RemoteDestination };
    });
  }
  pinnedDestinations(id: string): RemoteDestination[] {
    return this.pinnedSends(id).map(send => send.destination);
  }
  /** Routing must consult the original envelope before resolving any current address. */
  pinnedSends(id: string): { message: BridgeMessage; destination: RemoteDestination }[] {
    return this.acceptedOperation("direct", () => this.frontendOwnership ? this.statement(this.db, "SELECT message,destination,namespace FROM send_destinations WHERE id=?")
      .all(id).map(row => {
        if (row.namespace !== this.namespace) throw new Error("Retained destination namespace is unproven; no dispatch or retarget.");
        return { message: JSON.parse(String(row.message)) as BridgeMessage, destination: JSON.parse(String(row.destination)) as RemoteDestination };
      }) : []);
  }
  frontendRecipients(frontend?: T3Binding, native?: string): string[] {
    return this.acceptedOperation("direct", () => this.frontendOwnership && recipientKey(frontend, native) ? this.statement(this.db,
      `SELECT DISTINCT m.recipient FROM message_frontends f JOIN messages m ON m.id=f.id AND m.recipient=f.recipient
       WHERE f.mailbox=? AND f.state=? AND f.owner=? AND m.read_at IS NULL`)
      .all(JSON.stringify(localMailbox(this.namespace)), frontend ? "hosted" : "native", frontend ? frontendKey(frontend) : verifiedNative(native)!).map(row => String(row.recipient)) : []);
  }

  unread(recipient: string, limit: number, frontend?: T3Binding, native?: string): BridgeMessage[] {
    return this.acceptedOperation("direct", () => {
    if (!this.frontendOwnership) return [];
    return (this.statement(this.db, `SELECT * FROM deliverable_messages WHERE recipient=? AND read_at IS NULL AND ${this.ownershipSql("deliverable_messages")}
      ORDER BY CASE WHEN (conversation_id LIKE '%:note' OR conversation_id LIKE '%:ack' OR conversation_id LIKE 'files-progress-%') THEN 1 ELSE 0 END, created_at,id LIMIT ?`)
      .all(recipient, recipientKey(frontend, native), limit) as unknown as Row[]).map(row => this.decode(row));
    });
  }

  /** Select once while retaining the original row/proofs; retirement is not consumption. */
  claimRole(peer: PeerInfo, project: string): number {
    return this.acceptedOperation("direct", () => {
      const evidence = peerOwnership(peer), concrete = recipientKey(evidence.recipientFrontend, evidence.recipientNative);
      if (peer.host || peer.jobAgent || peer.subagent || !concrete) return 0;
      const from = agentQueueKey(peer.agent), namespace = this.namespace, mailbox = JSON.stringify(localMailbox(namespace));
      this.exec(this.db, "SAVEPOINT role_mail_claim");
      try {
        let count = 0;
        for (const raw of this.statement(this.db, `SELECT m.* FROM deliverable_messages m JOIN message_frontends f USING(id,recipient)
          WHERE m.recipient=? AND m.to_target=? AND m.read_at IS NULL AND f.state='role' AND f.mailbox=?`).all(from, from, mailbox)) {
          const message = this.decode(raw as unknown as Row), role = message.recipientRole;
          if (!role || role.namespace !== namespace || role.agent !== peer.agent || projectKey(role.project) !== projectKey(project) || !this.localCopy(message)) continue;
          if (this.statement(this.db, "SELECT 1 FROM messages WHERE id=? AND recipient=?").get(message.id, peer.name)) continue;
          // Retire the role grant before insertion can invoke a retained sink.
          // The same savepoint restores this state if either effect fails. Keep
          // the original envelope and every proof byte; never fake a read ACK.
          const retired = this.statement(this.db, "UPDATE message_frontends SET state='role-claimed' WHERE id=? AND recipient=? AND state='role' AND mailbox=?")
            .run(message.id, from, mailbox);
          if (Number(retired.changes) !== 1) throw new Error("Role claim changed before concrete copy admission");
          this.insert({ ...message, recipient: peer.name, recipientRole: undefined, ...evidence });
          count++;
        }
        this.exec(this.db, "RELEASE role_mail_claim");
        if (count) this.notifyHistoryChanged(); return count;
      } catch (error) { cleanupSavepoint(this.db, "role_mail_claim", true, error); throw error; }
    });
  }

  /** A guarded fan-out is one transaction; lock retries cannot leave half a send persisted. */
  insertBatch(messages: BridgeMessage[], before: () => void = () => {}): void {
    return this.acceptedOperation("direct", () => {
    this.#callbackUnknown = true; this.producerChanged();
    this.exec(this.db, "BEGIN IMMEDIATE");
    try {
      before();
      for (const message of messages) this.insert(message);
      this.exec(this.db, "COMMIT");
    } catch (err) { this.exec(this.db, "ROLLBACK"); throw err; }
    });
  }

  /** Query the whole inbox before a reply, independent of the hook batch limit. */
  replyConflicts(recipient: string, from: string[], conversationId: string, anchor?: BridgeMessage, frontend?: T3Binding, native?: string): { id: string; from: { name: string }; conversationId: string }[] {
    return this.acceptedOperation("direct", () => {
    if (!this.frontendOwnership) return [];
    const rows = this.stmt.replyConflicts
      .all(recipient, conversationId, JSON.stringify(from), anchor?.id ?? null, anchor?.createdAt ?? 0, anchor?.id ?? "", ...(this.frontendOwnership ? [recipientKey(frontend, native)] : []));
    return rows.map(row => ({ id: String(row.id), from: { name: String(row.from_name) }, conversationId: String(row.conversation_id) }));
    });
  }

  /** Copy pending job mail to its new supervisor, retaining the old row as history. Replay is idempotent. */
  handoffMail(from: string, to: string, job: string, at: number, fallback = false, toFrontend?: T3Binding, toNative?: string,
    authorize?: (grant: JobMailGrant) => JobMailSuccessor | null): BridgeMessage[] {
    return this.acceptedOperation("direct", () => {
    if (from === to) return [];
    this.exec(this.db, "BEGIN IMMEDIATE");
    try {
      const rows = this.statement(this.db, "SELECT * FROM deliverable_messages WHERE recipient=? AND from_id=? AND read_at IS NULL AND conversation_id NOT LIKE ?").all(from, `job:${job}`, `${SIBLING_CONVERSATION_PREFIX}%`) as unknown as Row[];
      const copied: BridgeMessage[] = [];
      for (const row of rows) {
        const original = this.decode(row), grant = this.jobRoutingGrant(row.id), successor = grant && authorize?.(grant.grant);
        if (!grant || grant.namespace !== this.namespace || !successor || !/^[a-f0-9]{64}$/.test(successor.authority) ||
            !this.localCopy(original) || !this.isActiveJobCopy(original) || !sameMailbox(original.senderMailbox, localMailbox(this.namespace))) continue;
        const route = this.statement(this.db, "SELECT recipient, consumed_at,namespace FROM job_delivery_routes WHERE id=?").get(row.id);
        if (route && (route.namespace !== this.namespace || route.consumed_at !== null || route.recipient !== from)) continue;
        // This method is the existing authorized supervisor-transfer path, not a
        // registration claim. Give the new copy its explicitly selected owner.
        const evidence = toFrontend ? { recipientFrontend: toFrontend } : verifiedNative(toNative) ? { recipientNative: toNative! } : { recipientAmbiguous: true as const };
        if ("recipientAmbiguous" in evidence || recipientKey(evidence.recipientFrontend, evidence.recipientNative) !== successor.owner) continue;
        const m = { ...this.decode(row), recipient: to, to, readAt: null, recipientFrontend: undefined, recipientNative: undefined,
          recipientAmbiguous: undefined, ...evidence };
        if (this.statement(this.db, "SELECT 1 FROM message_archive_conflicts WHERE source_table='messages' AND id=? AND recipient=?").get(m.id, to)) continue;
        if (fallback && !isQuietMessage(m)) m.conversationId = m.conversationId.replace(/:note$/, "") + (m.conversationId.endsWith(":fallback") ? "" : ":fallback");
        const existing = this.statement(this.db, "SELECT * FROM messages WHERE id=? AND recipient=?").get(m.id, to) as unknown as Row | undefined;
        if (existing && (this.decode(existing).recipientAmbiguous || frontendKey(this.decode(existing).recipientFrontend) !== frontendKey(m.recipientFrontend) ||
          this.decode(existing).recipientNative !== m.recipientNative || !this.localCopy(this.decode(existing)) || existing.read_at !== null || this.jobBodyHash(this.decode(existing)) !== this.jobBodyHash(original))) continue;
        if (!route || !original.jobRoute) continue;
        const generation = original.jobRoute.generation + 1;
        this.statement(this.db, "INSERT INTO job_mail_succession VALUES (?,?,?,?,?,?,?)").run(m.id, generation, to, successor.owner, JSON.stringify(m.recipientMailbox), successor.authority, at);
        if (!existing) this.insert(m);
        const changed = this.statement(this.db, "UPDATE job_delivery_routes SET recipient=? WHERE id=? AND recipient=? AND consumed_at IS NULL AND namespace=?").run(to, m.id, from, this.namespace);
        if (Number(changed.changes) !== 1) throw new Error("Job report route changed during succession");
        this.statement(this.db, "INSERT INTO job_mail_retirements VALUES (?,?,?,?,?)").run(m.id, from, original.jobRoute.generation, at, generation);
        copied.push({ ...(existing ? this.decode(existing) : m), jobRoute: { grant: m.id, generation } });
      }
      this.exec(this.db, "COMMIT");
      return copied;
    } catch (err) { this.exec(this.db, "ROLLBACK"); throw err; }
    });
  }

  pendingJobRecipients(job: string): string[] {
    return this.acceptedOperation("direct", () => {
    return this.statement(this.db, "SELECT DISTINCT recipient FROM deliverable_messages WHERE from_id=? AND read_at IS NULL AND conversation_id NOT LIKE ?").all(`job:${job}`, `${SIBLING_CONVERSATION_PREFIX}%`).map((row) => String(row.recipient));
    });
  }
  /** Privileged recovery scans retain each source copy's actual owner for its journal lookup. */
  pendingJobCopies(recipient: string, job: string, limit = 500): BridgeMessage[] {
    return this.acceptedOperation("direct", () => this.statement(this.db,
      "SELECT * FROM deliverable_messages WHERE recipient=? AND from_id=? AND read_at IS NULL ORDER BY created_at,id LIMIT ?")
      .all(recipient, `job:${job}`, Math.max(1, Math.min(500, limit))).map(row => this.decode(row as unknown as Row)).filter(m => this.localCopy(m)));
  }

  pendingJobSenders(): Set<string> {
    return this.acceptedOperation("direct", () => {
    return new Set(this.statement(this.db, "SELECT DISTINCT from_id FROM deliverable_messages WHERE read_at IS NULL AND from_id LIKE 'job:%' AND conversation_id NOT LIKE ?")
      .all(`${SIBLING_CONVERSATION_PREFIX}%`).map((row) => String(row.from_id)));
    });
  }

  insertOnce(m: BridgeMessage): boolean {
    return this.acceptedOperation("direct", () => {
    if (this.statement(this.db, "SELECT 1 FROM messages WHERE id=? AND recipient=?").get(m.id, m.recipient)) return false;
    this.insert(m);
    return true;
    });
  }

  /** A recovered inline envelope must never replay after a recipient consumed it or it was forwarded. */
  insertJobDelivery(m: BridgeMessage, authority?: JobMailGrant, request?: { owner: string; fingerprint: string }): boolean {
    return this.acceptedOperation("direct", () => {
    if (authority) m = { ...m, jobRoute: undefined, recipientMailbox: m.recipientMailbox ?? localMailbox(this.namespace), senderMailbox: m.senderMailbox ?? localMailbox(this.namespace) };
    if (this.statement(this.db, "SELECT 1 FROM message_archive_conflicts WHERE source_table='messages' AND id=? AND recipient=?").get(m.id, m.recipient)) return false;
    const route = this.statement(this.db, "SELECT namespace,recipient FROM job_delivery_routes WHERE id=?").get(m.id);
    if (route) {
      if (authority) this.retainJobGrant(m, authority);
      const retained = this.messagesById(m.id).find(copy => copy.recipient === route.recipient);
      const ledger = this.statement(this.db, "SELECT state,owner,mailbox FROM message_frontends WHERE id=? AND recipient=?").get(m.id, String(route.recipient));
      const proven = this.ledgerKey(ledger) && sameMailbox(this.parseMailbox(ledger?.mailbox), localMailbox(this.namespace));
      if (route.namespace !== this.namespace || !proven || retained && !this.localCopy(retained)) throw new Error("Historical job route provenance is unproven; pending report retained.");
      return false;
    }
    this.exec(this.db, "BEGIN IMMEDIATE");
    try {
      if (request) {
        const owner = JSON.parse(request.owner);
        if (!authority || !Array.isArray(owner) || owner.length !== 3 || owner[0] !== m.from.name || owner[2] !== `native:${authority.principal}`)
          throw new Error("Job dispatch request does not match the proven report sender");
        this.rememberSendIntent(m.id, request.owner, request.fingerprint);
      }
      if (authority) this.retainJobGrant(m, authority);
      const inserted = this.insertOnce(m);
      const retained = this.messagesById(m.id).find(copy => copy.recipient === m.recipient);
      if (!retained || !this.localCopy(retained) || recipientKey(retained.recipientFrontend, retained.recipientNative) !== recipientKey(m.recipientFrontend, m.recipientNative)) throw new Error("Job delivery has no matching proven local copy; pending evidence retained.");
      const row = this.statement(this.db, "SELECT read_at FROM messages WHERE id=? AND recipient=?").get(m.id, m.recipient);
      this.statement(this.db, "INSERT INTO job_delivery_routes(id,recipient,consumed_at,namespace) VALUES (?,?,?,?)").run(m.id, m.recipient, row?.read_at ?? null, this.namespace);
      this.exec(this.db, "COMMIT");
      return inserted;
    } catch (err) { this.exec(this.db, "ROLLBACK"); throw err; }
    });
  }

  markRead(recipient: string, ids: string[], at: number = Date.now(), frontend?: T3Binding, nativeOwners?: Record<string, string>, native?: string,
    jobRoutes?: Record<string, JobRouteProof>): number {
    return this.acceptedOperation("direct", () => {
    let changed = 0;
    const route = this.statement(this.db, "UPDATE job_delivery_routes SET consumed_at=? WHERE id=? AND recipient=? AND consumed_at IS NULL AND namespace=?");
    // Replay acknowledgements are DB-only. Bound each durable group instead of
    // syncing every message separately; failed groups remain safe to retry.
    for (let offset = 0; offset < ids.length; offset += 100) {
      this.exec(this.db, "SAVEPOINT message_ack");
      try {
        for (const id of ids.slice(offset, offset + 100)) {
          if (this.jobRoutingGrant(id)) {
            const supplied = jobRouteSchema.safeParse(jobRoutes?.[id]), actual = this.jobRouteFor(id, recipient);
            if (!supplied.success || !actual || supplied.data.grant !== actual.grant || supplied.data.generation !== actual.generation) continue;
          }
          if (!frontend && nativeOwners && (typeof nativeOwners[id] !== "string" || !this.statement(this.db,
            "SELECT 1 FROM message_frontends WHERE id=? AND recipient=? AND state='native' AND owner=?").get(id, recipient, nativeOwners[id]))) continue;
          const owned = this.frontendOwnership;
          const updated = owned ? Number(this.statement(this.db, `UPDATE messages SET read_at=? WHERE id=? AND recipient=? AND read_at IS NULL AND ${unquarantined("messages")} AND ${this.ownershipSql("messages")}`)
            .run(at, id, recipient, recipientKey(frontend, native)).changes) : 0;
          changed += updated;
          if (updated) route.run(at, id, recipient, this.namespace);
        }
        this.exec(this.db, "RELEASE message_ack");
      } catch (err) {
        cleanupSavepoint(this.db, "message_ack", true, err);
      }
    }
    return changed;
    });
  }

  /** Move messages waiting for "any <agent>" to a concrete peer name. */
  nativeChildRoutes(): { address: string; parent: string }[] {
    return this.acceptedOperation("direct", () => {
    if (!this.statement(this.db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_child_routes'").get()) return [];
    return this.statement(this.db, "SELECT address,parent FROM native_child_routes WHERE active=1").all() as { address: string; parent: string }[];
    });
  }

  /** Lifecycle observation only: no migration, lease, repair or route retirement. */
  committedNativeChildRoutes(ownerInstance: string, generation: number, deadline: number): Promise<NativeRouteSnapshot> {
    return this.acceptedOperation("direct", () => {
    if (this.db.isTransaction !== false || typeof this.db.location !== "function") return Promise.reject(new Error("native_state_unknown"));
    const path = this.db.location("main");
    if (!path || path === ":memory:") return Promise.reject(new Error("native_state_unknown"));
    return this.nativeLifecycleReader.read(path, ownerInstance, generation, deadline);
    });
  }
  nativeLifecyclePendingReaders(): number { return this.nativeLifecycleReader.pending(); }

  retainNativeChild(address: string, parent: string): void {
    return this.acceptedOperation("direct", () => {
    this.exec(this.db, "CREATE TABLE IF NOT EXISTS native_child_routes (address TEXT PRIMARY KEY, parent TEXT NOT NULL, active INTEGER NOT NULL)");
    this.statement(this.db, "INSERT INTO native_child_routes(address,parent,active) VALUES (?,?,1) ON CONFLICT(address) DO UPDATE SET parent=excluded.parent,active=1").run(address, parent);
    });
  }

  /** Return unread child mail and retire its route atomically; retained rows are never removed. */
  returnNativeChild(address: string, parent: string): void {
    return this.acceptedOperation("direct", () => {
    this.exec(this.db, "BEGIN IMMEDIATE");
    try {
      if (this.frontendOwnership) {
        for (const raw of this.statement(this.db, "SELECT * FROM deliverable_messages WHERE recipient=? AND read_at IS NULL").all(address)) {
          const m = this.decode(raw as unknown as Row);
          if (!this.localCopy(m)) continue;
          if (!m.recipientNative) continue;
          const original = nativeIdentitySchema.parse(JSON.parse(m.recipientNative));
          if (original.kind !== "child" || original.parent !== parent) continue;
          const evidence = ownershipFromKey(original.parentOwner);
          if (evidence.recipientAmbiguous) continue;
          const existing = this.statement(this.db, "SELECT * FROM messages WHERE id=? AND recipient=?").get(m.id, parent);
          if (existing) {
            const copy = this.decode(existing as unknown as Row);
            if (copy.recipientAmbiguous || frontendKey(copy.recipientFrontend) !== frontendKey(evidence.recipientFrontend) || copy.recipientNative !== evidence.recipientNative) continue;
          } else this.insert({ ...m, recipient: parent, recipientFrontend: undefined, recipientNative: undefined, ...evidence });
          this.markRead(address, [m.id], Date.now(), undefined, undefined, m.recipientNative);
        }
      }
      this.statement(this.db, "UPDATE native_child_routes SET active=0 WHERE address=?").run(address);
      this.exec(this.db, "COMMIT");
      this.notifyHistoryChanged();
    } catch (err) { this.exec(this.db, "ROLLBACK"); throw err; }
    });
  }

  claim(fromKey: string, toName: string, frontend?: T3Binding, native?: string): number {
    return this.acceptedOperation("direct", () => {
    if (fromKey === toName || !this.frontendOwnership) return 0;
    this.exec(this.db, "SAVEPOINT owned_mail_claim");
    try {
      if (this.frontendOwnership) {
        const rows = this.statement(this.db, `SELECT * FROM deliverable_messages WHERE recipient=? AND read_at IS NULL AND ${this.ownershipSql("deliverable_messages")}`)
          .all(fromKey, recipientKey(frontend, native)) as unknown as Row[];
        let changed = 0;
        for (const row of rows) {
          // Granted reports retain their original copy. The broker's proven
          // succession/alias path creates a new generation after registration.
          if (this.jobRoutingGrant(row.id)) continue;
          const sourceOwner = this.statement(this.db, "SELECT owner,mailbox FROM message_frontends WHERE id=? AND recipient=?").get(row.id, fromKey);
          const targetOwner = this.statement(this.db, "SELECT owner,mailbox FROM message_frontends WHERE id=? AND recipient=?").get(row.id, toName);
          if (targetOwner && (targetOwner.owner !== sourceOwner?.owner || targetOwner.mailbox !== sourceOwner?.mailbox)) continue;
          const existing = this.statement(this.db, "SELECT * FROM messages WHERE id=? AND recipient=?").get(row.id, toName) as unknown as Row | undefined;
          if (existing) {
            if (this.decode(existing).recipientAmbiguous || frontendKey(this.decode(existing).recipientFrontend) !== frontendKey(frontend)) continue;
            changed += Number(this.statement(this.db, "UPDATE messages SET read_at=? WHERE id=? AND recipient=? AND read_at IS NULL").run(Date.now(), row.id, fromKey).changes);
          } else {
            this.statement(this.db, `INSERT INTO message_frontends(id,recipient,binding,state,identity,owner,sender,mailbox,source)
              SELECT id,?,binding,state,identity,owner,sender,mailbox,source FROM message_frontends WHERE id=? AND recipient=?
              ON CONFLICT(id,recipient) DO NOTHING`).run(toName, row.id, fromKey);
            changed += Number(this.statement(this.db, "UPDATE messages SET recipient=? WHERE id=? AND recipient=?").run(toName, row.id, fromKey).changes);
          }
          this.statement(this.db, `UPDATE job_delivery_routes SET recipient=?,consumed_at=COALESCE(consumed_at,?)
            WHERE id=? AND recipient=? AND namespace=?`).run(toName, existing?.read_at ?? null, row.id, fromKey, this.namespace);
        }
        this.exec(this.db, "RELEASE owned_mail_claim");
        if (changed) this.notifyHistoryChanged();
        return changed;
      }
      this.exec(this.db, "RELEASE owned_mail_claim");
      return 0;
    } catch (err) {
      cleanupSavepoint(this.db, "owned_mail_claim", true, err);
      throw err;
    }
    });
  }

  /** Archive unread mail waiting for a queue key or name that is older than the cutoff. */
  expireQueued(recipient: string, cutoff: number): number {
    return this.acceptedOperation("direct", () => {
    if (!this.statement(this.db, "SELECT 1 FROM deliverable_messages WHERE recipient = ? AND read_at IS NULL AND created_at < ? LIMIT 1").get(recipient, cutoff)) return 0;
    const n = archiveMessages(this.db, this.archiveDb, "recipient = ? AND read_at IS NULL AND created_at < ?", [recipient, cutoff], "stale queue", "messages", this.log);
    if (n > 0) this.log.info("archived stale queued messages", { recipient, count: n });
    return n;
    });
  }

  /** Finish TTL archival before a broker claims/replays a reused queue name. */
  async expireQueuedAsync(recipient: string, cutoff: number): Promise<number> {
    return this.acceptedOperation("direct", async () => {
    let count = 0;
    for (;;) {
      const result = await this.retryWrite(() => {
        this.exec(this.archiveDb, `PRAGMA busy_timeout = ${SQLITE_REQUEST_BUSY_MS}`);
        try {
          const moved = this.archiveChunk("messages", "recipient = ? AND read_at IS NULL AND created_at < ?", [recipient, cutoff], "stale queue");
          const remaining = Boolean(this.statement(this.db, "SELECT 1 FROM deliverable_messages WHERE recipient = ? AND read_at IS NULL AND created_at < ? LIMIT 1").get(recipient, cutoff));
          return { moved, remaining };
        }
        finally { this.exec(this.archiveDb, `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`); }
      });
      count += result.moved;
      if (!result.remaining) break;
      await delay(50, undefined, { signal: this.writeAbort.signal });
    }
    if (count) this.log.info("archived stale queued messages", { recipient, count });
    return count;
    });
  }

  receipts(id: string): { recipient: string; readAt: number | null }[] {
    return this.acceptedOperation("direct", () => {
    const merged = new Map<string, { recipient: string; readAt: number | null }>();
    for (const [db, table] of [[this.archiveDb, "messages"], [this.db, "archived_messages"], [this.db, "messages"]] as const) {
      const rows = this.statement(db, `SELECT recipient, read_at AS readAt FROM ${table} WHERE id = ?`).all(id) as unknown as { recipient: string; readAt: number | null }[];
      for (const row of rows) {
        const owner = this.frontendOwnership ? this.statement(this.db, "SELECT state,owner,mailbox FROM message_frontends WHERE id=? AND recipient=?").get(id, row.recipient) : undefined;
        // Retained role originals are routing evidence, not another pending or
        // consumed recipient. The selected concrete copy carries the receipt.
        if (owner?.state === "role-claimed") continue;
        const proven = Boolean(owner?.state !== "role" && this.ledgerKey(owner) && sameMailbox(this.parseMailbox(owner?.mailbox), localMailbox(this.namespace)));
        // Keep raw historical timestamps intact; ambiguous marks cannot establish
        // consumption through local or remote receipt APIs. Inventory exposes them.
        merged.set(row.recipient, proven ? row : { ...row, readAt: null });
      }
    }
    return [...merged.values()];
    });
  }

  byId(id: string): BridgeMessage | null {
    return this.acceptedOperation("direct", () => {
    const row = (this.stmt.byId.get(id) ?? this.statement(this.archiveDb, "SELECT * FROM messages WHERE id = ? LIMIT 1").get(id) ??
      this.statement(this.db, "SELECT * FROM archived_messages WHERE id = ? LIMIT 1").get(id)) as unknown as Row | undefined;
    return row ? this.decode(row) : null;
    });
  }

  /** Retained recipient copies for a durable retry; active rows take precedence. */
  messagesById(id: string): BridgeMessage[] {
    return this.acceptedOperation("direct", () => {
    const merged = new Map<string, BridgeMessage>();
    for (const [db, table] of [[this.archiveDb, "messages"], [this.db, "archived_messages"], [this.db, "messages"]] as const) {
      for (const row of this.statement(db, `SELECT * FROM ${table} WHERE id = ? ORDER BY rowid`).all(id) as unknown as Row[]) {
        const message = this.decode(row); merged.set(message.recipient, message);
      }
    }
    return [...merged.values()];
    });
  }

  purgeOlderThan(cutoff: number): number {
    return this.acceptedOperation("direct", () => {
    if (!this.statement(this.db, "SELECT 1 FROM deliverable_messages WHERE created_at < ? LIMIT 1").get(cutoff)) return 0;
    const n = archiveMessages(this.db, this.archiveDb, "created_at < ?", [cutoff], "expired", "messages", this.log);
    if (n > 0) this.log.info("archived expired messages", { count: n });
    return n;
    });
  }

  /** Broker retention queues bounded work; direct/offline purge remains synchronous. */
  schedulePurgeOlderThan(cutoff: number): void {
    return this.acceptedOperation("direct", () => {
    if (this.purgeCutoff === null) this.purgeCutoff = cutoff;
    else if (cutoff > this.purgeCutoff) this.nextPurgeCutoff = Math.max(this.nextPurgeCutoff ?? cutoff, cutoff);
    this.scheduleArchiveMaintenance();
    });
  }

  private scheduleArchiveMaintenance(delayMs = 50): void {
    if (this.lifecycleMaintenanceQuiesced) { this.lifecycleResumeArchive = true; return; }
    if (this.closed || this.archiveMaintenanceFailed || this.archiveTimer) return;
    // A scheduled continuation belongs to this exact accepted maintenance
    // obligation. Cancelling/pausing its timer does not settle that obligation.
    const operation = this.#maintenanceOperation?.active ? this.#maintenanceOperation : this.beginOperation("maintenance");
    this.#maintenanceOperation = operation;
    this.archiveTimer = setTimeout(() => {
      try { this.#operationContext.run(operation, () => {
      this.archiveTimer = null;
      if (this.closed || this.lifecycleMaintenanceQuiesced) return;
      let more = false;
      let retryDelay = 50;
      try {
        this.exec(this.db, `PRAGMA busy_timeout = ${SQLITE_REQUEST_BUSY_MS}`);
        this.exec(this.archiveDb, `PRAGMA busy_timeout = ${SQLITE_REQUEST_BUSY_MS}`);
        if (this.legacyArchivePending) {
          this.legacyArchivePending = this.archiveChunk("archived_messages", "1", [], "legacy") > 0;
          more = this.legacyArchivePending;
        } else if (this.purgeCutoff !== null) {
          more = this.archivePurgeChunk(this.purgeCutoff);
          if (!more) {
            this.purgeCutoff = this.nextPurgeCutoff;
            this.nextPurgeCutoff = null;
            this.purgeCursor = this.purgeHighWater = null;
          }
        }
        more ||= this.purgeCutoff !== null;
      } catch (error) {
        if (isSqliteBusy(error)) { more = true; retryDelay = 250; }
        else {
          this.#producerUnknown = true; this.producerChanged();
          this.archiveMaintenanceFailed = true;
          this.log.warn("message archive maintenance stopped; original rows preserved", { err: String(error) });
        }
      } finally {
        this.exec(this.db, `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
        this.exec(this.archiveDb, `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      }
      if (more) this.scheduleArchiveMaintenance(retryDelay);
      else if (!this.archiveMaintenanceFailed && !this.legacyArchivePending && this.purgeCutoff === null && this.nextPurgeCutoff === null) {
        this.finishOperation(operation); if (this.#maintenanceOperation === operation) this.#maintenanceOperation = null;
      }
      }); } catch (error) { this.#producerUnknown = true; this.producerChanged(); throw error; }
    }, delayMs);
    this.archiveTimer.unref();
  }

  private archiveChunk(table: "messages" | "archived_messages", where: string, args: (string | number)[], reason: string): number {
    // octet_length reads SQLite's stored length without materializing TEXT.
    // One unusually large row still makes progress; later rows wait for a yield.
    const rows = this.statement(this.db, `SELECT rowid AS id, octet_length(body) AS bytes FROM ${table} WHERE (${where}) AND ${unquarantined(table)} ORDER BY ${table === "messages" ? "created_at" : "rowid"} LIMIT 16`).all(...args);
    const ids: string[] = [];
    let bytes = 0;
    for (const row of rows) {
      if (ids.length && bytes + Number(row.bytes) > 256 * 1024) break;
      ids.push(String(row.id)); bytes += Number(row.bytes);
    }
    if (!ids.length) return 0;
    // Selection happens before BEGIN IMMEDIATE. Recheck eligibility while
    // locked so a concurrent claim/receipt update cannot archive fresh mail.
    return archiveMessages(this.db, this.archiveDb, `rowid IN (${ids.map(() => "?").join(",")}) AND (${where})`, [...ids, ...args], reason, table, this.log);
  }

  private archivePurgeChunk(cutoff: number): boolean {
    // Older schemas have no global created_at index. Limit the rowid scan
    // itself so a LIMIT cannot conceal a full-table sort/filter before yield.
    if (this.purgeHighWater === null) {
      const high = this.statement(this.db, "SELECT MAX(rowid) AS id FROM messages");
      high.setReadBigInts(true);
      const id = high.get()!.id;
      if (id === null) return false;
      this.purgeHighWater = String(id);
    }
    const select = this.statement(this.db, `SELECT rowid AS id, created_at AS at, octet_length(body) AS bytes FROM messages WHERE ${this.purgeCursor === null ? "" : "rowid > ? AND "}rowid <= ? ORDER BY rowid LIMIT 16`);
    select.setReadBigInts(true);
    const rows = select.all(...(this.purgeCursor === null ? [this.purgeHighWater] : [this.purgeCursor, this.purgeHighWater]));
    const ids: string[] = [];
    let bytes = 0;
    let next = this.purgeCursor;
    for (const row of rows) {
      if (Number(row.at) < cutoff) {
        if (ids.length && bytes + Number(row.bytes) > 256 * 1024) break;
        ids.push(String(row.id)); bytes += Number(row.bytes);
      }
      next = String(row.id);
    }
    if (ids.length) archiveMessages(this.db, this.archiveDb, `rowid IN (${ids.map(() => "?").join(",")}) AND created_at < ?`, [...ids, cutoff], "expired", "messages", this.log);
    // Publish the cursor only after a successful copy+source transaction.
    this.purgeCursor = next;
    return rows.length > 0;
  }

  private notifyHistoryChanged(): void {
    if (this.historyMessageSink) { this.#callbackUnknown = true; this.producerChanged(); this.historyMessageSink(); }
  }
  stopWrites(): void {
    if (this.#producerSealed || this.#writeAuthorityRetired) throw Object.assign(new Error("accepted store work is retained"), { code: "OWNER_QUIESCED" });
    this.writeAbort.abort();
  }

  close(): void {
    if (this.closed) return;
    if (this.#producerSealed || this.#writeAuthorityRetired) throw Object.assign(new Error("store ownership is retained"), { code: "OWNER_QUIESCED" });
    this.lifecycleConstruction.ordinaryClose = "attempted"; retainedStoreConstructions.add(this.lifecycleConstruction);
    try {
    this.closed = true;
    if (this.archiveTimer) clearTimeout(this.archiveTimer);
    this.archiveTimer = null;
    this.stopWrites();
    this.history.close();
    if (this.historyDb !== this.db) this.closeCapturedHandle(this.historyDb);
    void this.closeBackups();
    try {
      this.closeCapturedHandle(this.db);
      this.closeCapturedHandle(this.archiveDb);
    } catch (err) {
      this.log.warn("error closing message store", { err });
    } finally {
      this.release();
      if (!this.lifecycleConstruction.unknown && [...this.lifecycleConstruction.handles.values()].every(handle => handle.close === "returned"))
        retainedStoreConstructions.delete(this.lifecycleConstruction);
    }
    this.lifecycleConstruction.ordinaryClose = "returned";
    } catch (error) { this.lifecycleConstruction.ordinaryClose = "unknown"; this.lifecycleConstruction.unknown = true; throw error; }
  }
}

/** Full asynchronous hosting admission, including constructor effects under the
 * same fresh reader proof/deadline. A completed earlier guard grants no authority. */
export async function openMessageStore(file: string, log: Logger, endpoint: string, token: string, signal?: AbortSignal, startupDeadline?: number): Promise<MessageStore> {
  signal?.throwIfAborted();
  if (file !== ":memory:") assertBootstrapAccess(dirname(file));
  if (file === ":memory:") return new MessageStore(file, log);
  const expected = startupDeadline !== undefined ? await (await import("./store-bootstrap.js")).prepareColdStore(file, endpoint, token, log, signal, startupDeadline) : undefined;
  let store: MessageStore | undefined, admitted: (() => number) | undefined;
  try {
    const opened = await guardPriorEndpoints(dirname(file), endpoint, token, log, signal, check => {
      admitted = check; assertBootstrapWitness(expected); store = new MessageStore(file, log); assertBootstrapWitness(expected); check(); return store;
    }, file, startupDeadline);
    admitted?.(); signal?.throwIfAborted(); return opened;
  } catch (error) {
    try { store?.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Unadmitted store cleanup failed; original operation evidence is retained."); }
    throw error;
  }
}
