import type { DatabaseSync } from "node:sqlite";
import { SQLITE_STORE_VERSION } from "./store-version.js";

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
  };
  for (const [table, names] of Object.entries(required)) {
    if (db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table)?.type !== "table") throw refuse();
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!names.every(name => columns.some(column => column.name === name))) throw refuse();
    if (table === "messages" && (columns.find(c => c.name === "id")?.pk !== 1 || columns.find(c => c.name === "recipient")?.pk !== 2)) throw refuse();
  }
  const namespaces = db.prepare("SELECT id,namespace FROM mailbox_store LIMIT 2").all();
  if (namespaces.length !== 1 || namespaces[0]!.id !== 1 || typeof namespaces[0]!.namespace !== "string" || !/^[a-f0-9]{64}$/.test(namespaces[0]!.namespace)) throw refuse();
}
