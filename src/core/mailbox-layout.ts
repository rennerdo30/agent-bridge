import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SQLITE_STORE_VERSION, METADATA_COMPONENT_VERSION } from "./store-version.js";
import { storageAdmissionRemaining, storageAdmissionTimeout } from "./storage-admission.js";

export interface OfflineMetadataAdmission { kind: "offline-isolated"; home: string }
let offline: string | undefined;
let initializing: string | undefined;
const homeKey = (home: string) => process.platform === "win32" ? resolve(home).replace(/^[de]:/i, "E:").toLowerCase() : resolve(home);
export function offlineMetadataAdmitted(home: string): boolean { return offline === homeKey(home); }
export function messagingInitializationAdmitted(home: string): boolean { return offlineMetadataAdmitted(home) || initializing === homeKey(home); }
export function withFreshMessagingInitialization<T>(home: string, effect: () => T, file = join(home,'bridge.db')): T {
  preflightMessagingHome(home,file);
  if (existsSync(file)) {
    const db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
    try { if (Number(db.prepare("PRAGMA user_version").get()!.user_version) !== 0) throw new Error("Fresh initialization cannot borrow existing authority"); }
    finally { db.close(); }
  }
  const previous = initializing; initializing = homeKey(home);
  try { return effect(); } finally { initializing = previous; }
}
/** Exact destination only, synchronous scope, supplied by an explicitly coordinated operator. */
export function withOfflineMetadataAdmission<T>(admission: OfflineMetadataAdmission, effect: () => T): T {
  if (admission.kind !== "offline-isolated") throw new Error("Explicit offline isolated admission required");
  const previous = offline; offline = homeKey(admission.home);
  try { return effect(); } finally { offline = previous; }
}
export function assertMailboxVersion(db: DatabaseSync, file: string): void {
  const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  if (version >= 10 && version <= 14 || version > SQLITE_STORE_VERSION)
    throw Object.assign(new Error(`Unreleased/future mailbox schema ${version}; original bytes retained`), { code: "STORE_LAYOUT_UNSUPPORTED" });
  if (version > 0 && version < SQLITE_STORE_VERSION && file !== ":memory:" && !offlineMetadataAdmitted(dirname(file)))
    throw Object.assign(new Error("Shipping mailbox requires storage migrate-messaging with coordinated shutdown into an isolated destination; endpoint absence cannot revoke cached old handles"), { code: "STORE_OFFLINE_REQUIRED" });
  if (version === SQLITE_STORE_VERSION) assertCurrentMailboxEnvelope(db);
  if (version === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('messages','mailbox_store','message_frontends','messaging_candidate')").get())
    throw Object.assign(new Error("Unversioned mailbox authority retained; automatic initialization refused"), { code: "STORE_LAYOUT_UNSUPPORTED" });
  if (version===0 && file!==':memory:' && !messagingInitializationAdmitted(dirname(file))) {
    const component = db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get();
    if (!component || Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version)!==METADATA_COMPONENT_VERSION)
      throw Object.assign(new Error('Existing unproved empty/partial SQLite file retained; explicit isolated recovery required'),{code:'STORE_LAYOUT_UNSUPPORTED'});
  }
}

/** A read-only early check. No metadata connection, DDL, lease, snapshot or mkdir. */
export function preflightMessagingHome(home: string, mailbox = join(home, "bridge.db")): void {
  for (const file of new Set([join(home, "bridge.db"), mailbox])) {
    storageAdmissionRemaining();
    if (!existsSync(file)) continue;
    for (let path = resolve(file); ; path = dirname(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || path === resolve(file) && (!stat.isFile() || stat.nlink !== 1)) throw new Error("Linked or substituted mailbox retained");
      if (path === dirname(path)) break;
    }
    const db = new DatabaseSync(file, { readOnly: true, timeout: storageAdmissionTimeout(0) });
    try {
      assertMailboxVersion(db, file);
      const component = db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get();
      const version = component ? Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) : 0;
      if (version >= 2 && version <= 6 || version > METADATA_COMPONENT_VERSION) throw Object.assign(new Error(`Unreleased/future metadata component ${version}; retained unchanged`), { code: "STORE_LAYOUT_UNSUPPORTED" });
      if (version === 1 && !offlineMetadataAdmitted(home)) throw Object.assign(new Error("Shipping metadata requires explicitly coordinated offline isolated migration"), { code: "STORE_OFFLINE_REQUIRED" });
      if (version===METADATA_COMPONENT_VERSION) {
        for (const [table,columns] of Object.entries({bridge_metadata:['domain','key','value','updated_at'],bridge_read_receipts:['identity','message_id','read_at']})) {
          const present = db.prepare(`PRAGMA table_info(${table})`).all();
          if (!columns.every(name=>present.some(column=>column.name===name))) throw Object.assign(new Error('Malformed current metadata layout retained'),{code:'STORE_LAYOUT_UNSUPPORTED'});
        }
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_metadata'").get()) {
        const row = db.prepare("SELECT value FROM bridge_metadata WHERE domain='messaging-migration' AND key='candidate-p12-m7-s15'").get();
        if (row) {
          const attempt = JSON.parse(String(row.value)) as {phase?:unknown};
          if (attempt.phase!=='ready' && !offlineMetadataAdmitted(home)) throw Object.assign(new Error('Interrupted migration cannot serve; resume the exact explicit offline attempt'),{code:'STORE_OFFLINE_REQUIRED'});
        }
      }
      storageAdmissionRemaining();
    } finally { db.close(); }
  }
}

/** Read-only, before metadata, snapshots or schema effects. A current label is
 * a promise of the ownership envelope, never permission to repair its absence. */
export function assertCurrentMailboxEnvelope(db: DatabaseSync): void {
  const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  if (version < SQLITE_STORE_VERSION) return;
  const refuse = () => Object.assign(new Error("Unsupported current mailbox envelope; original bytes retained. Owner-coordinated isolated recovery is required."), { code: "STORE_LAYOUT_UNSUPPORTED" });
  if (version > SQLITE_STORE_VERSION) throw Object.assign(new Error("Unsupported newer SQLite store version; original bytes retained unchanged."), { code: "STORE_LAYOUT_UNSUPPORTED" });
  const required: Record<string, string[]> = {
    messages: ["id", "recipient", "from_id", "from_name", "from_agent", "to_target", "conversation_id", "reply_to", "hop", "body", "created_at", "read_at"],
    mailbox_store: ["id", "namespace"],
    message_frontends: ["id", "recipient", "binding", "state", "identity", "owner", "sender", "mailbox", "source"],
    send_intents: ["id", "owner", "fingerprint", "namespace"],
    send_destinations: ["id", "recipient", "message", "destination", "namespace"],
    recipient_registrations: ["name", "identity", "binding", "state", "peer_id", "owner"],
    job_delivery_routes: ["id", "recipient", "consumed_at", "namespace"],
    job_mail_grants: ["id", "namespace", "authority", "original_recipient", "original_owner", "original_mailbox", "body_hash", "original_envelope", "created_at"],
    job_mail_succession: ["id", "generation", "recipient", "owner", "mailbox", "authority", "created_at"],
    job_mail_retirements: ["id", "recipient", "generation", "retired_at", "successor_generation"],
    messaging_candidate: ["id", "contract", "state", "attempt"],
  };
  for (const [table, names] of Object.entries(required)) {
    if (db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table)?.type !== "table") throw refuse();
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!names.every(name => columns.some(column => column.name === name))) throw refuse();
    if (table === "messages" && (columns.find(c => c.name === "id")?.pk !== 1 || columns.find(c => c.name === "recipient")?.pk !== 2)) throw refuse();
  }
  const namespaces = db.prepare("SELECT id,namespace FROM mailbox_store LIMIT 2").all();
  if (namespaces.length !== 1 || namespaces[0]!.id !== 1 || typeof namespaces[0]!.namespace !== "string" || !/^[a-f0-9]{64}$/.test(namespaces[0]!.namespace)) throw refuse();
  const candidate = db.prepare("SELECT contract,state,attempt FROM messaging_candidate WHERE id=1").get();
  if (candidate?.contract !== "p12/m7/s15" || candidate.state !== "ready" && !messagingInitializationAdmitted(String(db.location("main") ? dirname(db.location("main")!) : "")) && db.location("main") !== null) throw refuse();
}
