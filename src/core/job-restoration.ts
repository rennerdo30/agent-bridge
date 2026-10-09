import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJsonSnapshot } from "./file-cache.js";
import { isRecord } from "./json-store.js";
import { existingMetadataDb } from "./metadata-db.js";
import { readProcessIdentity } from "./process-identity.js";
import { writtenBeforeBoot } from "./store-compatibility.js";

interface OwnerPresence { pid: number; identity?: string; at?: number }

/**
 * Since AB-208 presence lives in bridge_metadata once the storage-capabilities import ran (its files then sit in
 * cold storage), so the database rows are the record; before that import the per-PID files are.
 */
function ownerPresence(home: string, owners: readonly string[]): Map<string, OwnerPresence[]> {
  const records = new Map<string, OwnerPresence[]>();
  const add = (record: unknown, pid: number, at: number | undefined) => {
    if (!isRecord(record) || typeof record.name !== "string" || !owners.includes(record.name) || record.pid !== pid) return;
    const entries = records.get(record.name) ?? [];
    entries.push({ pid, identity: typeof record.processIdentity === "string" ? record.processIdentity : undefined, at });
    records.set(record.name, entries);
  };
  const db = existingMetadataDb(home);
  if (db?.prepare("SELECT 1 FROM bridge_components WHERE name='import:storage-capabilities'").get()) {
    for (const row of db.prepare("SELECT key,value,updated_at FROM bridge_metadata WHERE domain='storage-capabilities'").all()) {
      if (!/^\d+$/.test(String(row.key))) continue;
      let value: unknown;
      try { value = JSON.parse(String(row.value)); } catch { continue; }
      add(value, Number(row.key), Number(row.updated_at));
    }
    return records;
  }
  const dir = join(home, "storage-capabilities");
  for (const name of readdirSync(dir).filter(name => /^\d+\.json$/.test(name))) {
    let at: number | undefined;
    try { at = statSync(join(dir, name)).mtimeMs; } catch { at = undefined; }
    add(readJsonSnapshot(join(dir, name)).value, Number(name.slice(0, -5)), at);
  }
  return records;
}

/** Absence from a stalled broker's peer list is not proof that a coordinator process exited. */
export async function verifiedGoneJobOwners(home: string, owners: readonly string[]): Promise<Set<string>> {
  if (!owners.length) return new Set();
  let records: Map<string, OwnerPresence[]>;
  try { records = ownerPresence(home, owners); } catch { return new Set(); }
  const gone = new Set<string>();
  await Promise.all([...records].map(async ([owner, entries]) => {
    const exited = await Promise.all(entries.map(async entry => {
      // No process survives a reboot: presence written before this boot belongs to an exited process.
      if (entry.at !== undefined && writtenBeforeBoot(entry.at)) return true;
      try { process.kill(entry.pid, 0); }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      if (!entry.identity) return false;
      const current = await readProcessIdentity(entry.pid);
      return current !== null && current !== entry.identity;
    }));
    if (exited.length && exited.every(Boolean)) gone.add(owner);
  }));
  return gone;
}
