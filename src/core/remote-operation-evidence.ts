import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JSON_STORE_VERSION } from "./json-store.js";
import { physicalMetadataPath } from "./metadata-db.js";
import { remoteJobRequestSchema, remoteJobSnapshotSchema, type RemoteJobRequest } from "../network/remote-job-protocol.js";
import type { RemoteJobSnapshot } from "../network/remote-jobs.js";
import { RunnerRetentionUnsettled } from "../mcp/runner-delivery-retention.js";

export interface PendingRemoteOperation { id: string; turn: number; request: RemoteJobRequest; state: "pending" | "confirmed" | "blocked" | "refused" }
export interface RemoteOperationCache { fetchedAt: number; snapshot: RemoteJobSnapshot; operations?: PendingRemoteOperation[] }
const fail = () => new RunnerRetentionUnsettled("invalid-evidence");

/** Strict, read-only, bounded evidence inspection. Never rename corruption or
 * interpret its disappearance into .corrupt/archive as absence. No payloads or
 * paths enter diagnostics; unknown evidence needs owner-coordinated recovery. */
export function readRemoteOperationEvidence(home: string, id: string): RemoteOperationCache | null {
  try { return inspectRemoteOperationEvidence(home, id); } catch { throw fail(); }
}
function inspectRemoteOperationEvidence(home: string, id: string): RemoteOperationCache | null {
  if (!/^[\w.-]+$/.test(id) || id.startsWith(".")) throw fail();
  const root = join(home, "remote-job-states"), file = join(root, `${id}.json`);
  const started = performance.now(); let count = 0, bytes = 0;
  for (const folder of [root, join(root, "archive")]) {
    physicalMetadataPath(folder);
    let dir;
    try { dir = opendirSync(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw fail(); }
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++count > 256 || performance.now() - started > 25) throw fail();
        // A tolerant earlier reader can have preserved an incomplete accepted
        // operation here. An unrelated job cannot claim/resolve those bytes.
        if (entry.name.startsWith(`${id}.json.`) && !entry.name.startsWith(`${id}.json.backup-`)) throw fail();
        if (folder === root && entry.name === `${id}.json`) continue; // Read once, after the retained-proof census.
        if (entry.name !== `${id}.json` && !entry.name.startsWith(`${id}.json.backup-`) && !entry.name.startsWith(`${id}.json-`)) continue;
        const path = join(folder, entry.name);
        const cache = read(path);
        if (cache?.operations?.some(op => op.state === "pending" || op.state === "blocked")) throw fail();
      }
    } finally { dir.closeSync(); }
  }
  return read(file, true);

  function read(path: string, absent = false): RemoteOperationCache | null {
    physicalMetadataPath(path);
    let before;
    try { before = lstatSync(path, { bigint: true }); } catch (error) { if (absent && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw fail(); }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(8 * 1024 * 1024 - bytes)) throw fail();
    bytes += Number(before.size);
    const identity = (s: typeof before) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (identity(fstatSync(fd, { bigint: true })) !== identity(before)) throw fail();
      const raw = readFileSync(fd, "utf8");
      if (Buffer.byteLength(raw) !== Number(before.size) || identity(fstatSync(fd, { bigint: true })) !== identity(before) ||
          identity(lstatSync(path, { bigint: true })) !== identity(before) || performance.now() - started > 25) throw fail();
      let value: any;
      try { value = JSON.parse(raw); } catch { throw fail(); }
      if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isSafeInteger(value.version) || value.version < 0 || value.version > JSON_STORE_VERSION ||
          !Number.isFinite(value.fetchedAt) || value.fetchedAt < 0 || !remoteJobSnapshotSchema.safeParse(value.snapshot).success ||
          !Array.isArray(value.operations) || value.operations.length > 128) throw fail();
      const ids = new Set();
      for (const op of value.operations ?? []) {
        if (!op || typeof op.id !== "string" || !/^[a-f0-9]{64}$/.test(op.id) || ids.has(op.id) || !Number.isSafeInteger(op.turn) || op.turn < 0 ||
            !["pending", "confirmed", "blocked", "refused"].includes(op.state) || !remoteJobRequestSchema.safeParse(op.request).success || op.request.job !== id) throw fail();
        ids.add(op.id);
      }
      return value;
    } finally { closeSync(fd); }
  }
}

/** Effect fence independent of any parent-registry remote projection. */
export function assertRemoteOperationAdmission(home: string, id: string): void {
  if (readRemoteOperationEvidence(home, id)?.operations?.some(op => op.state === "pending" || op.state === "blocked")) throw fail();
}
