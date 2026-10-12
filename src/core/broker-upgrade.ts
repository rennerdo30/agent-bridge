import type { PeerInfo } from "./protocol.js";
import { readdir, open } from "node:fs/promises";
import { join } from "node:path";
import { physicalMetadataPath } from "./metadata-db.js";

export const BROKER_UPGRADE_CHECK_MS = 1_000;
export const BROKER_UPGRADE_DRAIN_MS = 5_000;
export const BROKER_UPGRADE_COOLDOWN_MS = 60_000;
export const BROKER_SUCCESSOR_GRACE_MS = 5_000;

/** Fail closed for unknown/prerelease versions; protocol compatibility is checked by hello. */
export function compareBrokerVersions(a: string | undefined, b: string | undefined): number | null {
  const parse = (v: string | undefined) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v ?? "") ? v!.split(".").map(Number) : null;
  const left = parse(a), right = parse(b);
  if (!left || !right || !left.every(Number.isSafeInteger) || !right.every(Number.isSafeInteger)) return null;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
  return 0;
}

/** Only explicitly advertised interactive hosts implementing the handover event can succeed. */
export function newestBrokerSuccessor(peers: PeerInfo[], version: string): PeerInfo | undefined {
  return peers.filter(p => p.brokerEligible === true && !p.host && !p.jobAgent && !p.subagent && p.agent !== "other" &&
    compareBrokerVersions(p.version, version) === 1 && p.storeCapabilities)
    .sort((a, b) => -(compareBrokerVersions(a.version, b.version) ?? 0) || a.startedAt - b.startedAt || a.id.localeCompare(b.id))[0];
}

/** SQLite commits and atomic JSON writers already flush transactions. Sync retained files/WALs
 * after broker workers have stopped, before relinquishing the existing listener/storage lease.
 * No checkpoint truncation, deletion, migration or registry rewrite occurs here. */
export async function syncBrokerStores(home: string): Promise<void> {
  physicalMetadataPath(home);
  for (const entry of await readdir(home, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === "approvals") { await syncBrokerStores(join(home, entry.name)); continue; }
    if (!entry.isFile() || !/\.(?:db(?:-wal|-journal)?|json)$/.test(entry.name)) continue;
    let file;
    try { file = await open(join(home, entry.name), "r+"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    try { await file.sync(); } finally { await file.close(); }
  }
  if (process.platform !== "win32") {
    const directory = await open(home, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
