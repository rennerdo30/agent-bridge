import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonSnapshot } from "./file-cache.js";
import { isRecord } from "./json-store.js";
import { readProcessIdentity } from "./process-identity.js";

/** Absence from a stalled broker's peer list is not proof that a coordinator process exited. */
export async function verifiedGoneJobOwners(home: string, owners: readonly string[]): Promise<Set<string>> {
  if (!owners.length) return new Set();
  const records = new Map<string, { pid: number; identity?: string }[]>();
  try {
    const dir = join(home, "storage-capabilities");
    for (const name of readdirSync(dir).filter(name => /^\d+\.json$/.test(name))) {
      const record = readJsonSnapshot(join(dir, name)).value;
      if (!isRecord(record) || typeof record.name !== "string" || !owners.includes(record.name) || record.pid !== Number(name.slice(0, -5))) continue;
      const entries = records.get(record.name) ?? [];
      entries.push({ pid: record.pid as number, identity: typeof record.processIdentity === "string" ? record.processIdentity : undefined });
      records.set(record.name, entries);
    }
  } catch { return new Set(); }
  const gone = new Set<string>();
  await Promise.all([...records].map(async ([owner, entries]) => {
    const exited = await Promise.all(entries.map(async entry => {
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
