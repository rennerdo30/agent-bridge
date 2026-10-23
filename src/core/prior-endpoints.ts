import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { BridgeClient } from "./client.js";
import { APP_NAME, CONNECT_TIMEOUT_MS, DB_FILE_NAME, PROTOCOL_VERSION, WINDOWS_PIPE_PREFIX } from "./constants.js";
import type { Logger } from "./logger.js";
import { maxSocketPathBytes, shortSocketDirectory } from "./paths.js";
import { physicalPath } from "./project-identity.js";
import { BridgeError } from "./protocol.js";
import { assertCompatibleMailboxReaders } from "./storage-lock.js";
import { isSqliteBusy, retrySqlite } from "./sqlite-policy.js";

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
export async function guardPriorEndpoints(home: string, current: string, token: string, log: Logger, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const file = join(home, DB_FILE_NAME);
  if (existsSync(file)) {
    let inspectionState: { version: number; metadata: number };
    try {
      inspectionState = await retrySqlite(() => {
        // Each failed attempt releases its own read-only handle before yielding.
        // Never wait synchronously on a writer or infer compatibility from busy.
        const inspection = new DatabaseSync(file, { readOnly: true, timeout: 0 });
        try {
          const metadata = inspection.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get()
            ? Number(inspection.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) : 0;
          return { version: Number(inspection.prepare("PRAGMA user_version").get()!.user_version), metadata };
        }
        finally { inspection.close(); }
      }, CONNECT_TIMEOUT_MS, signal);
    } catch (error) {
      if (isSqliteBusy(error)) throw new BridgeError("timeout", "Prior mailbox schema inspection remained busy; startup was not admitted. Retry after the active writer settles.");
      throw error;
    }
    signal?.throwIfAborted();
    if (inspectionState.version === 2 || inspectionState.version === 3) throw refused(home, "a pre-lease schema2/3 store requiring explicit offline migration into an isolated home");
    if (inspectionState.metadata === 1 || inspectionState.metadata === 2) throw refused(home, `a component${inspectionState.metadata} metadata store whose cached inactive writers require explicit owner-coordinated offline migration into an isolated home`);
  }
  for (const endpoint of priorEndpoints(home)) {
    signal?.throwIfAborted();
    if (endpoint === current) continue; // The ordinary current endpoint exact-auth gate handles custom overrides.
    if (process.platform === "win32") {
      // Node cannot attest a foreign named pipe's ACL/server identity. Do not
      // disclose a token to it: any live or indeterminate pipe blocks startup.
      await new Promise<void>((accept, reject) => {
        const socket = connect(endpoint), timer = setTimeout(() => { socket.destroy(); reject(refused(endpoint, "unresponsive")); }, PROBE_MS);
        const done = () => { clearTimeout(timer); socket.destroy(); };
        socket.once("connect", () => { done(); reject(refused(endpoint, "active with unverified pipe ownership")); });
        socket.once("error", error => { done(); if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) accept(); else reject(refused(endpoint, "inaccessible")); });
      });
      continue;
    }
    try {
      const entry = lstatSync(endpoint), directory = lstatSync(dirname(endpoint)), uid = process.getuid?.();
      if (!entry.isSocket() || entry.isSymbolicLink() || uid === undefined || entry.uid !== uid ||
          !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || (directory.mode & 0o077) !== 0)
        throw refused(endpoint, "not a verified private socket");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    let client: BridgeClient;
    try { client = await BridgeClient.connect(endpoint, log, PROBE_MS, { readOnlyDirectory: true }); }
    catch (error) {
      if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw refused(endpoint, "inaccessible or unresponsive");
    }
    try { signal?.throwIfAborted(); await client.request("auth", { protocol: PROTOCOL_VERSION, token }, PROBE_MS); }
    catch { signal?.throwIfAborted(); throw refused(endpoint, "active and incompatible or unauthenticated"); }
    finally { client.close(); }
    throw refused(endpoint, "active");
  }
  signal?.throwIfAborted();
  try { assertCompatibleMailboxReaders(home); }
  catch { throw refused(home, "retained by an unproven storage reader"); }
}
