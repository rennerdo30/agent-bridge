import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicPluginWrite } from "./plugin-runtime.js";
import type { PeerInfo } from "./protocol.js";

export interface StoreCapabilities { json: number; sqlite: number }
interface Presence extends StoreCapabilities { pid: number; name: string; version: string; explicit: boolean }

/** Conservative ceilings from released formats, used only for pre-capability peers. */
export function releasedStoreCapabilities(version?: string): StoreCapabilities {
  const match = /^0\.29\.(\d+)$/.exec(version ?? "");
  if (!match) return { json: 0, sqlite: 0 };
  const patch = Number(match[1]);
  if (patch >= 13 && patch <= 15) return { json: 4, sqlite: 7 };
  if (patch === 16) return { json: 4, sqlite: 8 };
  if (patch === 12) return { json: 3, sqlite: 7 };
  // Earlier releases vary within this range; these are the lowest safe ceilings.
  if (patch <= 11) return { json: 2, sqlite: 4 };
  return { json: 0, sqlite: 0 };
}

export function validStoreCapabilities(value: unknown): value is StoreCapabilities {
  const v = value as StoreCapabilities | undefined;
  return Boolean(v && Number.isSafeInteger(v.json) && v.json >= 0 && Number.isSafeInteger(v.sqlite) && v.sqlite >= 0);
}

/** Retain presence after a broker exits, so its older clients protect the next election. */
export function recordStorePeer(home: string, peer: Pick<PeerInfo, "pid" | "name" | "version" | "host" | "storeCapabilities">): void {
  if (peer.host || !Number.isSafeInteger(peer.pid) || peer.pid <= 0) return;
  const explicit = validStoreCapabilities(peer.storeCapabilities);
  const path = join(home, "storage-capabilities", `${peer.pid}.json`);
  if (!explicit && existsSync(path)) {
    try { if (JSON.parse(readFileSync(path, "utf8")).explicit) return; } catch { /* Preserve malformed records via the metadata backup. */ }
  }
  const caps = explicit ? peer.storeCapabilities! : releasedStoreCapabilities(peer.version);
  atomicPluginWrite(path, JSON.stringify({ schemaVersion: 1, ...caps, pid: peer.pid, name: peer.name, version: peer.version ?? "unknown", explicit }) + "\n");
}

export function liveStorePeers(home: string): Presence[] {
  const dir = join(home, "storage-capabilities");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => /^\d+\.json$/.test(file)).flatMap((file) => {
    const pid = Number(file.slice(0, -5));
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return []; }
    try {
      const record = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (record.schemaVersion === 1 && record.pid === pid && validStoreCapabilities(record)) return [record as Presence];
    } catch { /* A live unknown reader must not be silently dropped. */ }
    return [{ pid, name: `pid ${pid}`, version: "unknown", json: 0, sqlite: 0, explicit: false }];
  });
}

export function assertStoreUpgrade(home: string, format: keyof StoreCapabilities, current: number, target: number): void {
  if (target <= current) return;
  const blockers = liveStorePeers(home).filter((peer) => peer[format] < target);
  if (!blockers.length) return;
  throw Object.assign(new Error(`Waiting to upgrade ${format} store ${current}→${target}: ${blockers.map((p) => `${p.name} (v${p.version}, pid ${p.pid}, reads ${p[format]})`).join(", ")}. Existing sessions keep their code and data; retry when these readers finish naturally.`), { code: "STORE_UPGRADE_DEFERRED" });
}
