import { createHash } from "node:crypto";
import { isRecord } from "./json-store.js";
import { metadataDb } from "./metadata-db.js";
import { importMetadataDomain } from "./metadata-import.js";
import { storageLease } from "./storage-lock.js";
import type { BridgeMessage } from "./protocol.js";
import { ReadJournal } from "./read-journal.js";

export const RESULT_HEADER = /^Subagent .+ (?:done|failed|cancelled) after \d+s\./;
export const LOCAL_RESULTS_DIR = "local-result-receipts";
const key = (name: string) => createHash("sha256").update(name).digest("hex");

/** Local results skip the broker, so retain their delivery evidence alongside the read journal. */
export function recordLocalResult(home: string, message: BridgeMessage): void {
  if (!message.from.id.startsWith("job:") || !RESULT_HEADER.test(message.body.split("\n")[0]!)) return;
  importMetadataDomain(home, LOCAL_RESULTS_DIR, ".json", true);
  const value = { id: message.id, name: message.from.name, recipient: message.recipient, deliveredAt: message.createdAt, envelope: message };
  const release = storageLease(home);
  try { metadataDb(home).prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO NOTHING")
    .run(LOCAL_RESULTS_DIR, `${key(message.from.name)}/${key(message.id)}`, JSON.stringify(value), Date.now());
  } finally { release(); }
}

export function localResultReceipt(home: string, name: string, owner: string | undefined, after: number, before: number): {
  status: "delivered" | "read"; messageId: string; recipient: string; deliveredAt: number; readAt: number | null;
} | null {
  importMetadataDomain(home, LOCAL_RESULTS_DIR, ".json", true);
  const prefix = key(name);
  const records = metadataDb(home).prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key>=? AND key<?")
    .all(LOCAL_RESULTS_DIR, `${prefix}/`, `${prefix}0`).map(row => JSON.parse(String(row.value)))
    .filter((r): r is Record<string, unknown> => isRecord(r) && typeof r.id === "string" && typeof r.recipient === "string" && typeof r.deliveredAt === "number"
      && (!owner || r.recipient === owner) && r.deliveredAt >= after && r.deliveredAt < before)
    .sort((a, b) => (b.deliveredAt as number) - (a.deliveredAt as number));
  const record = records[0];
  if (!record) return null;
  const receipt = new ReadJournal(home).receipt(`name:${record.recipient}`, record.id as string);
  return { status: receipt.read ? "read" : "delivered", messageId: record.id as string, recipient: record.recipient as string,
    deliveredAt: record.deliveredAt as number, readAt: receipt.at };
}
