import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writtenBeforeBoot } from "./boot-time.js";
import { atomicPluginWrite } from "./plugin-runtime.js";
import type { PeerInfo } from "./protocol.js";
import { processIdentity, readProcessIdentities, readProcessIdentitiesSync } from "./process-identity.js";
import { existingMetadataDb, metadataDb, saveMetadataValue } from "./metadata-db.js";
import { importMetadataDomain } from "./metadata-import.js";

export interface StoreCapabilities { json: number; sqlite: number; jobArchive?: number }
interface Presence extends StoreCapabilities { pid: number; name: string; version: string; explicit: boolean; processIdentity?: string; observedAt?: number }

const identities = new Map<string, { identity: string | null; at: number; signature: string }>();
const refreshes = new Map<string, Promise<void>>();
const IDENTITY_REFRESH_MS = 10_000;

/** Re-exported: the boot rule lives in boot-time.ts so lock modules can share it without import cycles. */
export { writtenBeforeBoot };

function databasePresence(home: string): {record: Presence; signature: string; at: number}[] | undefined {
  const db = existingMetadataDb(home);
  if (!db?.prepare("SELECT 1 FROM bridge_components WHERE name='import:storage-capabilities'").get()) return undefined;
  return db.prepare("SELECT key,value,updated_at FROM bridge_metadata WHERE domain='storage-capabilities'").all()
    .filter(row => /^\d+$/.test(String(row.key))).map(row => ({record:JSON.parse(String(row.value)) as Presence,signature:String(row.value),at:Number(row.updated_at)}));
}

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
    const stored = databasePresence(home);
    const records = stored ? stored.flatMap(({record,signature}) => {
      const path = join(dir,`${record.pid}.json`), cached = identities.get(path);
      return !cached || cached.signature !== signature || Date.now()-cached.at >= IDENTITY_REFRESH_MS ? [{pid:record.pid,path,signature}] : [];
    }) : existsSync(dir) ? readdirSync(dir).filter(file => /^\d+\.json$/.test(file)).flatMap(file => {
      const path = join(dir, file), signature = presenceSignature(path), cached = identities.get(path);
      return signature && (!cached || cached.signature !== signature || Date.now() - cached.at >= IDENTITY_REFRESH_MS)
        ? [{ pid: Number(file.slice(0, -5)), path, signature }] : [];
    }) : [];
    if (!records.length) return;
    let failed = false;
    const refresh = (async () => {
      let current: Map<number, string>;
      try { current = await readProcessIdentities(records.filter(record => record.pid !== process.pid).map(record => record.pid)); }
      catch {
        // A failed or timed-out query (an overloaded system) observed nothing: keep each reader's last verified
        // identity for another interval instead of marking every live reader unknown, which blocked upgrades and
        // job starts. Readers never verified stay unknown until a later query succeeds.
        failed = true;
        for (const { path } of records) { const cached = identities.get(path); if (cached) identities.set(path, { ...cached, at: Date.now() }); }
        return;
      }
      // Bind the result to the record observed before the OS query. A new PID
      // generation published during/after that query must be verified again.
      for (const { pid, path, signature } of records) identities.set(path, { identity: pid === process.pid ? processIdentity(pid) ?? null : current.get(pid) ?? null, at: Date.now(), signature });
    })();
    refreshes.set(home, refresh);
    try { await refresh; } finally { refreshes.delete(home); }
    // Do not retry a failed query in a tight loop; the next readiness check or refresh asks again.
    if (failed) return;
    // A new runner can publish presence during the previous batch. An awaited
    // readiness check must cover that PID too, rather than reuse an older scan.
  }
}

function cachedIdentity(home: string, pid: number, observedSignature?: string): string | undefined {
  if (pid === process.pid) return processIdentity(pid);
  const path = join(home, "storage-capabilities", `${pid}.json`), cached = identities.get(path);
  const stored = observedSignature === undefined ? databasePresence(home) : undefined;
  const signature = observedSignature ?? (stored ? stored.find(entry=>entry.record.pid===pid)?.signature : presenceSignature(path));
  // A verified identity stays usable past its refresh age while the background refresh renews it: a slow step
  // (e.g. creating a worktree under load) must not turn every live reader "unknown" and fail a store write.
  // Staleness can only keep a gone reader counted (refreshes and ESRCH remove it), never make an old one compatible.
  return cached && cached.signature === signature ? cached.identity ?? undefined : undefined;
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
  return Boolean(v && Number.isSafeInteger(v.json) && v.json >= 0 && Number.isSafeInteger(v.sqlite) && v.sqlite >= 0 &&
    (v.jobArchive === undefined || Number.isSafeInteger(v.jobArchive) && v.jobArchive >= 0));
}

/** Retain presence after a broker exits, so its older clients protect the next election. */
export function recordStorePeer(home: string, peer: Pick<PeerInfo, "pid" | "name" | "version" | "host" | "storeCapabilities">, options: { authoritative?: boolean } = {}): void {
  if (peer.host || !Number.isSafeInteger(peer.pid) || peer.pid <= 0) return;
  const ready = databasePresence(home);
  if (ready || metadataRelease(peer.version)) {
    try {
      metadataDb(home); importMetadataDomain(home,"storage-capabilities");
      const explicit = validStoreCapabilities(peer.storeCapabilities), caps = explicit ? peer.storeCapabilities! : releasedStoreCapabilities(peer.version);
      const prior = databasePresence(home)?.find(entry=>entry.record.pid===peer.pid)?.record;
      let identity = cachedIdentity(home,peer.pid);
      if (prior?.explicit && (!identity || prior.processIdentity===identity)) {
        if (!explicit) return;
        if (!options.authoritative && prior.version === (peer.version ?? "unknown") && prior.json === caps.json && prior.sqlite === caps.sqlite) return;
        identity ??= prior.processIdentity;
      }
      saveMetadataValue(home,"storage-capabilities",String(peer.pid),{schemaVersion:1,...caps,pid:peer.pid,name:peer.name,version:peer.version ?? "unknown",explicit,observedAt:Date.now(),...(identity ? {processIdentity:identity} : {})});
      if (!identity) void refreshStorePeerIdentities(home).catch(()=>{});
      return;
    } catch (error) {
      // Until the metadata store can open (an older reader, or this process's identity is not yet
      // verifiable for its fail-closed migration lease) the pre-AB-208 file below stays the record;
      // the store imports it when it opens.
      if (ready || !["STORE_UPGRADE_DEFERRED", "ELEASEBUSY"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
    }
  }
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
          previous.version === (peer.version ?? "unknown") && previous.json === peer.storeCapabilities!.json && previous.sqlite === peer.storeCapabilities!.sqlite && previous.jobArchive === peer.storeCapabilities!.jobArchive &&
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
  const stored = databasePresence(home);
  if (stored) {
    void refreshStorePeerIdentities(home).catch(()=>{});
    return stored.flatMap(({record,signature,at}) => {
      if (writtenBeforeBoot(at)) return [];
      try { process.kill(record.pid,0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return []; }
      const identity = cachedIdentity(home,record.pid,signature);
      if (identity && record.processIdentity && record.processIdentity !== identity) return [];
      // A record observed before its identity was known (an older peer's hello) stays valid
      // unless that PID now belongs to a process started after the observation, as for files.
      const observed = !record.processIdentity && typeof record.observedAt === "number";
      // An imported legacy row has neither; its row time is the source file's time (AB-256), so the same rule applies.
      if (identity && !record.processIdentity && legacyPidReused(identity,observed ? record.observedAt! : at)) return [];
      if (identity && (record.processIdentity === identity || observed) && validStoreCapabilities(record)) return [record];
      return [{pid:record.pid,name:record.name ?? `pid ${record.pid}`,version:"unknown",json:0,sqlite:0,explicit:false}];
    });
  }
  const dir = join(home, "storage-capabilities");
  if (!existsSync(dir)) return [];
  void refreshStorePeerIdentities(home).catch(() => {});
  return readdirSync(dir).filter((file) => /^\d+\.json$/.test(file)).flatMap((file) => {
    const pid = Number(file.slice(0, -5));
    try { if (writtenBeforeBoot(statSync(join(dir, file)).mtimeMs)) return []; } catch { /* Unreadable: judged below. */ }
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

/** True for releases that read and write the AB-208 metadata rows (0.30.4 and later). */
export function metadataRelease(version: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version ?? "");
  if (!m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return major > 0 || minor > 30 || minor === 30 && patch >= 4;
}

/**
 * Live processes of an older release (or of an unknown one) that still read and write per-file stores.
 * Uses the recorded version rather than a verified identity, so an identity cache refresh never makes
 * a current peer look old. A reused PID can only keep the compatible file projection running longer.
 */
export function legacyStorePeers(home: string): { pid: number; name: string; version: string }[] {
  const stored = databasePresence(home);
  if (stored) void refreshStorePeerIdentities(home).catch(() => {});
  const records = stored ? stored.filter(({ record, signature, at }) => {
    if (record.pid === process.pid) return false;
    // No process survives a reboot: a pre-boot row is never a live legacy reader (AB-256).
    if (writtenBeforeBoot(at)) return false;
    try { process.kill(record.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; }
    // A verified different process generation reused the PID: that reader is gone.
    const identity = cachedIdentity(home, record.pid, signature);
    if (identity && record.processIdentity && record.processIdentity !== identity) return false;
    // A row without an observation time (an imported legacy file) carries the file's time instead.
    if (identity && !record.processIdentity && legacyPidReused(identity, typeof record.observedAt === "number" ? record.observedAt : at)) return false;
    return true;
  }).map(entry => entry.record) : liveStorePeers(home).filter(peer => peer.pid !== process.pid);
  return records.filter(peer => !metadataRelease(peer.version)).map(({ pid, name, version }) => ({ pid, name: name ?? `pid ${pid}`, version: version ?? "unknown" }));
}

/** The stored presence record of pid, from the metadata rows or the legacy file. */
function storedPresence(home: string, pid: number): Presence | undefined {
  const stored = databasePresence(home);
  if (stored) return stored.find(entry => entry.record.pid === pid)?.record;
  try { return JSON.parse(readFileSync(join(home, "storage-capabilities", `${pid}.json`), "utf8")) as Presence; } catch { return undefined; }
}

/**
 * Readers not yet verified in this process (a runner that started a moment ago, or a cold cache) are checked
 * now with one query against their recorded process identity:
 * - the live process matches: it is that reader, and it no longer blocks if its recorded capabilities suffice;
 * - a successful query shows another process under that PID, or no running process at all (an exited process
 *   whose PID a lingering handle keeps answering): the recorded reader is gone.
 * A failed query, a listed process whose start time cannot be read (elevated or protected), or a record without
 * an identity keeps the reader blocking.
 */
function verifiedNow(home: string, peers: Presence[], format: keyof StoreCapabilities, target: number): Set<number> {
  const candidates = peers.flatMap(peer => {
    const record = storedPresence(home, peer.pid);
    return record?.processIdentity ? [{ pid: peer.pid, record, identity: record.processIdentity }] : [];
  });
  if (!candidates.length) return new Set();
  const live = readProcessIdentitiesSync(candidates.map(candidate => candidate.pid));
  if (!live) return new Set();
  return new Set(candidates.filter(({ pid, record, identity }) => {
    const now = live.get(pid);
    if (now === undefined) return true;
    if (now === "") return false;
    return now !== identity || validStoreCapabilities(record) && (record[format] ?? 0) >= target;
  }).map(candidate => candidate.pid));
}

export function assertStoreUpgrade(home: string, format: keyof StoreCapabilities, current: number, target: number): void {
  if (target <= current) return;
  let blockers = liveStorePeers(home).filter((peer) => (peer[format] ?? 0) < target);
  const unverified = blockers.filter(peer => peer.version === "unknown");
  if (unverified.length && unverified.length <= 64) {
    const verified = verifiedNow(home, unverified, format, target);
    blockers = blockers.filter(peer => !verified.has(peer.pid));
  }
  if (!blockers.length) return;
  throw Object.assign(new Error(`Waiting to upgrade ${format} store ${current}→${target}: ${blockers.map((p) => `${p.name} (v${p.version}, pid ${p.pid}, reads ${p[format]})`).join(", ")}. Existing sessions keep their code and data; retry when these readers finish naturally.`), { code: "STORE_UPGRADE_DEFERRED" });
}
