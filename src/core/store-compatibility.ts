import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicPluginWrite } from "./plugin-runtime.js";
import type { PeerInfo } from "./protocol.js";
import { processIdentity, readProcessIdentities } from "./process-identity.js";

export interface StoreCapabilities { json: number; sqlite: number }
interface Presence extends StoreCapabilities { pid: number; name: string; version: string; explicit: boolean; processIdentity?: string }

const identities = new Map<string, { identity: string | null; at: number; signature: string }>();
const refreshes = new Map<string, Promise<void>>();
const IDENTITY_REFRESH_MS = 10_000;

function presenceSignature(path: string): string | undefined {
  try { const stat = statSync(path); return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
  catch { return undefined; }
}

/** Process queries are asynchronous and never run on broker request hot paths. */
export function refreshStorePeerIdentities(home: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const ready = refreshIdentityCache(home);
  if (!signal) return ready;
  // Cancelling one queued start must not cancel a shared broker identity scan.
  return new Promise<void>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    ready.then(() => { signal.removeEventListener("abort", abort); resolve(); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

async function refreshIdentityCache(home: string): Promise<void> {
  for (;;) {
    const pending = refreshes.get(home);
    if (pending) { await pending; continue; }
    const dir = join(home, "storage-capabilities");
    const records = existsSync(dir) ? readdirSync(dir).filter(file => /^\d+\.json$/.test(file)).flatMap(file => {
      const path = join(dir, file), signature = presenceSignature(path), cached = identities.get(path);
      return signature && (!cached || cached.signature !== signature || Date.now() - cached.at >= IDENTITY_REFRESH_MS)
        ? [{ pid: Number(file.slice(0, -5)), path, signature }] : [];
    }) : [];
    if (!records.length) return;
    const refresh = (async () => {
      const current = await readProcessIdentities(records.filter(record => record.pid !== process.pid).map(record => record.pid));
      // Bind the result to the record observed before the OS query. A new PID
      // generation published during/after that query must be verified again.
      for (const { pid, path, signature } of records) identities.set(path, { identity: pid === process.pid ? processIdentity(pid) ?? null : current.get(pid) ?? null, at: Date.now(), signature });
    })();
    refreshes.set(home, refresh);
    try { await refresh; } finally { refreshes.delete(home); }
    // A new runner can publish presence during the previous batch. An awaited
    // readiness check must cover that PID too, rather than reuse an older scan.
  }
}

function cachedIdentity(home: string, pid: number): string | undefined {
  if (pid === process.pid) return processIdentity(pid);
  const path = join(home, "storage-capabilities", `${pid}.json`), cached = identities.get(path);
  return cached && cached.signature === presenceSignature(path) && Date.now() - cached.at < IDENTITY_REFRESH_MS ? cached.identity ?? undefined : undefined;
}

/** Legacy records have no identity. A process born after its record cannot own it. */
function legacyPidReused(identity: string, recordedAt: number): boolean {
  if (process.platform === "win32" && /^\d+$/.test(identity)) {
    const startedAt = Number((BigInt(identity) - 621355968000000000n) / 10000n);
    return startedAt > recordedAt;
  }
  if (process.platform !== "linux") {
    const startedAt = Date.parse(identity + " UTC");
    return Number.isFinite(startedAt) && startedAt > recordedAt;
  }
  return false;
}

/** Conservative ceilings from released formats, used only for pre-capability peers. */
export function releasedStoreCapabilities(version?: string): StoreCapabilities {
  const match = /^0\.29\.(\d+)$/.exec(version ?? "");
  if (!match) return { json: 0, sqlite: 0 };
  const patch = Number(match[1]);
  if (patch >= 13 && patch <= 15) return { json: 4, sqlite: 7 };
  if (patch === 16 || patch === 17) return { json: 4, sqlite: 8 };
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
export function recordStorePeer(home: string, peer: Pick<PeerInfo, "pid" | "name" | "version" | "host" | "storeCapabilities">, options: { authoritative?: boolean } = {}): void {
  if (peer.host || !Number.isSafeInteger(peer.pid) || peer.pid <= 0) return;
  const explicit = validStoreCapabilities(peer.storeCapabilities);
  const path = join(home, "storage-capabilities", `${peer.pid}.json`);
  let identity = cachedIdentity(home, peer.pid);
  if (!identity) void refreshStorePeerIdentities(home).catch(() => {});
  if (explicit && existsSync(path)) {
    try {
      const previous = JSON.parse(readFileSync(path, "utf8")) as Presence;
      // An observation adds no authority over the process's own identical record.
      // In particular, an unfilled foreign-PID cache must not erase its identity.
      if (previous.explicit && validStoreCapabilities(previous) && previous.pid === peer.pid &&
          previous.version === (peer.version ?? "unknown") && previous.json === peer.storeCapabilities!.json && previous.sqlite === peer.storeCapabilities!.sqlite &&
          (!identity || previous.processIdentity === identity)) {
        if (!options.authoritative || previous.name === peer.name) return;
        // Authenticated hello/self updates may resolve a new session name while
        // the foreign process query is pending. Retain its established generation.
        identity ??= previous.processIdentity;
      }
    } catch { /* Preserve malformed records via the metadata backup. */ }
  }
  if (!explicit && existsSync(path)) {
    try {
      const previous = JSON.parse(readFileSync(path, "utf8"));
      if (previous.explicit && (!identity || previous.processIdentity === identity)) return;
    } catch { /* Preserve malformed records via the metadata backup. */ }
  }
  const caps = explicit ? peer.storeCapabilities! : releasedStoreCapabilities(peer.version);
  atomicPluginWrite(path, JSON.stringify({ schemaVersion: 1, ...caps, pid: peer.pid, name: peer.name, version: peer.version ?? "unknown", explicit, ...(identity ? { processIdentity: identity } : {}) }) + "\n");
  if (!identity) void refreshStorePeerIdentities(home).catch(() => {});
}

export function liveStorePeers(home: string): Presence[] {
  const dir = join(home, "storage-capabilities");
  if (!existsSync(dir)) return [];
  void refreshStorePeerIdentities(home).catch(() => {});
  return readdirSync(dir).filter((file) => /^\d+\.json$/.test(file)).flatMap((file) => {
    const pid = Number(file.slice(0, -5));
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return []; }
    try {
      const path = join(dir, file), signature = presenceSignature(path);
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (signature !== presenceSignature(path)) throw new Error("Store reader presence changed during observation");
      const identity = cachedIdentity(home, pid);
      if (identity && typeof record.processIdentity === "string" && record.processIdentity !== identity) return [];
      if (identity && !record.processIdentity && legacyPidReused(identity, statSync(join(dir, file)).mtimeMs)) return [];
      if (identity && record.schemaVersion === 1 && record.pid === pid && validStoreCapabilities(record)) return [record as Presence];
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
