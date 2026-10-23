import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { BridgeClient } from "./client.js";
import { APP_NAME, CONNECT_TIMEOUT_MS, DB_FILE_NAME, PROTOCOL_VERSION, WINDOWS_PIPE_PREFIX } from "./constants.js";
import type { Logger } from "./logger.js";
import { maxSocketPathBytes, shortSocketDirectory } from "./paths.js";
import { physicalPath } from "./project-identity.js";
import { BridgeError } from "./protocol.js";
import { assertCompatibleMailboxReadersAsync, withMailboxReaderAdmission } from "./storage-lock.js";
import { isSqliteBusy, retrySqlite } from "./sqlite-policy.js";
import { ownProcessIdentity } from "./process-identity.js";
import { AdmissionObservation } from "./admission-observation.js";

const PROBE_MS = 300;
/** Only historical endpoints derived from this data home; never discovery/config scanning. */
export function priorEndpoints(home: string, platform: NodeJS.Platform = process.platform, uid = process.getuid?.()): string[] {
  const homes = new Set([resolve(home), physicalPath(resolve(home))]);
  if (platform === "win32") for (const path of [...homes]) {
    if (/^[de]:/i.test(path)) { homes.add(path.replace(/^[de]:/i, "E:")); homes.add(path.replace(/^[de]:/i, "D:")); }
  }
  const endpoints = new Set<string>();
  for (const path of homes) for (const protocol of [undefined, 2, 3, 4, 5, 6, 7]) {
    const suffix = protocol === undefined ? "" : `-p${protocol}`;
    if (platform === "win32") {
      const hash = createHash("sha256").update(path.toLowerCase()).digest("hex").slice(0, 12);
      endpoints.add(`${WINDOWS_PIPE_PREFIX}${APP_NAME}-${hash}${suffix}`);
    } else {
      const name = `bridge${suffix}.sock`, inHome = posix.join(path, name);
      if (Buffer.byteLength(inHome) <= maxSocketPathBytes(platform)) endpoints.add(inHome);
      const hash = createHash("sha256").update(path).digest("hex").slice(0, 16);
      endpoints.add(posix.join(shortSocketDirectory(uid), `${hash}-${name}`));
    }
  }
  return [...endpoints];
}

function refused(endpoint: string, reason: string): BridgeError {
  return new BridgeError("protocol_mismatch", `Prior Core endpoint ${endpoint} is ${reason}; owner-coordinated shutdown is required before sharing this data home. No downgrade or replacement was attempted.`);
}

/** Current-protocol auth only; no hello, handover, mailbox RPC or loopback fallback.
 * This observation is NOT migration exclusion: the storage maintenance lock supplies that boundary. */
export async function guardPriorEndpoints<T = void>(home: string, current: string, token: string, log: Logger, signal?: AbortSignal, effect?: (check: () => number) => T, file = join(home, DB_FILE_NAME)): Promise<T> {
  signal?.throwIfAborted();
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  const observation = new AdmissionObservation();
  const admission = new AbortController();
  const expired = () => new BridgeError("timeout", "Prior endpoint admission exceeded its aggregate budget; startup was not admitted. Original data is retained for owned recovery; no downgrade or process replacement was attempted.", { admission: observation.snapshot() });
  const remaining = () => {
    signal?.throwIfAborted();
    const left = deadline - Date.now();
    if (left <= 0 && !admission.signal.aborted) admission.abort(expired());
    admission.signal.throwIfAborted();
    return left;
  };
  const cancelled = () => admission.abort(signal!.reason);
  signal?.addEventListener("abort", cancelled, { once: true });
  const timer = setTimeout(() => admission.abort(expired()), CONNECT_TIMEOUT_MS);
  try {
    remaining();
    if (existsSync(file)) {
      let inspectionState: { version: number; metadata: number };
      try {
        inspectionState = await observation.wait("inspection", () => retrySqlite(() => {
          remaining();
          // Each failed attempt releases its own read-only handle before yielding.
          // Never wait synchronously on a writer or infer compatibility from busy.
          const inspection = new DatabaseSync(file, { readOnly: true, timeout: 0 });
          try {
            remaining();
            const components = inspection.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get(); remaining();
            const metadata = components ? Number(inspection.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) : 0;
            remaining();
            const version = Number(inspection.prepare("PRAGMA user_version").get()!.user_version); remaining();
            return { version, metadata };
          }
          finally { inspection.close(); }
        }, remaining(), admission.signal));
      } catch (error) {
        remaining();
        if (isSqliteBusy(error)) throw new BridgeError("timeout", "Prior mailbox schema inspection remained busy; startup was not admitted. Retry after the active writer settles.");
        throw error;
      }
      remaining();
      if (inspectionState.version === 2 || inspectionState.version === 3) throw refused(home, "a pre-lease schema2/3 store requiring explicit offline migration into an isolated home");
      if (inspectionState.metadata === 1 || inspectionState.metadata === 2) throw refused(home, `a component${inspectionState.metadata} metadata store whose cached inactive writers require explicit owner-coordinated offline migration into an isolated home`);
    }
    // Construction may need this process's identity for a metadata/migration
    // lease. Prepare it asynchronously inside the same budget, never by a cold
    // synchronous query nested in the constructor.
    if (effect) {
      const identity = await observation.wait("identity", () => ownProcessIdentity(admission.signal, remaining)); remaining();
      if (!identity) throw new BridgeError("internal", "Own process identity is unproven; storage admission was refused without construction.");
    }
    const probeEndpoints = async () => {
      remaining();
      for (const endpoint of priorEndpoints(home)) {
        remaining();
        if (endpoint === current) continue; // The ordinary current endpoint exact-auth gate handles custom overrides.
        if (process.platform === "win32") {
          // Node cannot attest a foreign named pipe's ACL/server identity. Do not
          // disclose a token to it: any live or indeterminate pipe blocks startup.
          await new Promise<void>((accept, reject) => {
            let socket: ReturnType<typeof connect> | undefined, probeTimer: ReturnType<typeof setTimeout> | undefined, settled = false;
            const done = (error?: unknown) => {
              if (settled) return; settled = true;
              clearTimeout(probeTimer); admission.signal.removeEventListener("abort", aborted); socket?.destroy();
              try { remaining(); if (error) reject(error); else accept(); } catch (failure) { reject(failure); }
            };
            const aborted = () => done(admission.signal.reason);
            try {
              remaining(); socket = connect(endpoint);
              socket.once("connect", () => done(refused(endpoint, "active with unverified pipe ownership")));
              socket.once("error", error => done(["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "") ? undefined : refused(endpoint, "inaccessible")));
              remaining();
              probeTimer = setTimeout(() => done(refused(endpoint, "unresponsive")), Math.min(PROBE_MS, remaining()));
              admission.signal.addEventListener("abort", aborted, { once: true });
            } catch (error) { done(error); }
          });
          remaining();
          continue;
        }
        try {
          const entry = lstatSync(endpoint); remaining();
          const directory = lstatSync(dirname(endpoint)), uid = process.getuid?.();
          remaining();
          if (!entry.isSocket() || entry.isSymbolicLink() || uid === undefined || entry.uid !== uid ||
              !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || (directory.mode & 0o077) !== 0)
            throw refused(endpoint, "not a verified private socket");
        } catch (error) { remaining(); if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        let client: BridgeClient | undefined;
        const close = () => client?.close();
        try {
          try { client = await BridgeClient.connect(endpoint, log, Math.min(PROBE_MS, remaining()), { readOnlyDirectory: true, signal: admission.signal }); }
          catch (error) {
            remaining();
            if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
            throw refused(endpoint, "inaccessible or unresponsive");
          }
          remaining(); admission.signal.addEventListener("abort", close, { once: true });
          try { await client.request("auth", { protocol: PROTOCOL_VERSION, token }, Math.min(PROBE_MS, remaining())); remaining(); }
          catch { remaining(); throw refused(endpoint, "active and incompatible or unauthenticated"); }
        } finally { admission.signal.removeEventListener("abort", close); close(); }
        throw refused(endpoint, "active");
      }
      remaining();
    };
    for (let attempt = 0; ; attempt++) {
      await observation.wait("endpoints", probeEndpoints);
      let proof: Awaited<ReturnType<typeof assertCompatibleMailboxReadersAsync>> | undefined;
      try {
        proof = await observation.wait("readers", () => assertCompatibleMailboxReadersAsync(home, admission.signal, remaining)); remaining();
        await observation.wait("endpoints", probeEndpoints); remaining(); proof.assert(home);
      }
      catch (error) {
        proof = undefined; remaining();
        if (error instanceof BridgeError) throw error;
        const census = error as { code?: string; readerCompatibility?: string };
        // Only a new successful census can admit. Never expire, clean or grant an
        // unknown reader; a completed old declaration and all other errors refuse.
        // Recheck endpoints too: one may have appeared while the census yielded.
        if (!(census.code === "ENOENT" || census.code === "STORE_READER_ACTIVE" && census.readerCompatibility === "unproven") || Date.now() >= deadline)
          throw refused(home, "retained by an unproven storage reader");
      }
      if (proof) {
        const value = observation.scope(() => observation.measure("effect", () => withMailboxReaderAdmission(proof!, () => effect ? effect(remaining) : undefined as T)));
        remaining(); // Owned policy cleanup cannot turn late proof into admission.
        return value;
      }
      try { await delay(Math.min(25 * 2 ** Math.min(attempt, 4), remaining()), undefined, { signal: admission.signal }); }
      catch (error) { remaining(); throw error; }
    }
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancelled); }
}
