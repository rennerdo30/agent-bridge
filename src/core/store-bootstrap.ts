import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { bundleDirectory } from "./bundle-directory.js";
import { guardPriorEndpoints } from "./prior-endpoints.js";
import { ownProcessIdentity } from "./process-identity.js";
import { physicalPath } from "./project-identity.js";
import { maintenanceLock } from "./storage-lock.js";
import type { Logger } from "./logger.js";
import { appendBootstrapRecord, bootstrapFileIdentity, bootstrapHomeIdentity, bootstrapUnknown, bootstrapWorkerFailure, inspectBootstrapJournal, readBootstrapPair, sameBootstrapIdentity, type BootstrapRecord, type BootstrapEvidence } from "./store-bootstrap-journal.js";

export interface ColdBootstrapPlan { record: BootstrapRecord; endpoint: string; token: string; deadline: number; revoked: SharedArrayBuffer }
const pending = new Set<string>();
export const coldStoreFiles = (file: string) => [file, join(dirname(file), "archive.db"), join(dirname(file), "history.db")];
/** Read-only eligibility, not a new migration policy. Fully initialized current
 * homes are opened normally; a partially initialized current home without its
 * complete evidence cannot masquerade as fresh. */
export function needsColdPreparation(file: string): boolean {
  const files = coldStoreFiles(file), present = files.map(path => existsSync(path));
  if (present.every(value => !value)) return true;
  if (!present[0]) throw bootstrapUnknown();
  const db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
  let version: number, metadata: number;
  try {
    version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    metadata = db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get()
      ? Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) : 0;
  } finally { db.close(); }
  if (version === 0 && metadata === 4 && !present[1] && !present[2]) return true;
  if (version === 14 && (!present[1] || !present[2])) throw bootstrapUnknown();
  return false; // Existing populated/legacy stores retain the ordinary migration/refusal contract.
}
export function checkBootstrapOriginal(record: BootstrapRecord): void {
  if (physicalPath(resolve(record.home)) !== record.home || dirname(record.file) !== record.home ||
      !sameBootstrapIdentity(bootstrapHomeIdentity(record.home), record.homeIdentity)) throw bootstrapUnknown();
  for (const [path, original] of Object.entries(record.original)) {
    if (dirname(path) !== record.home || (original === null ? existsSync(path) : !sameBootstrapIdentity(bootstrapFileIdentity(path), original))) throw bootstrapUnknown();
  }
}
function workerEntry(): URL {
  if (!import.meta.url.endsWith(".ts")) return pathToFileURL(join(bundleDirectory(import.meta.url), "store-bootstrap-worker.mjs"));
  // Source tests use the ordinary CI-built worker entry. Never demand-build or
  // launch a provider/daemon as a fallback from storage admission.
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  return pathToFileURL(join(root, "plugins/codex/dist/store-bootstrap-worker.mjs"));
}
export async function prepareColdStore(file: string, endpoint: string, token: string, log: Logger, signal: AbortSignal | undefined, deadline: number): Promise<void> {
  const home = physicalPath(realpathSync.native(resolve(dirname(file)))); file = join(home, process.platform === "win32" ? basename(file).toLowerCase() : basename(file));
  const pendingKey = process.platform === "win32" ? file.toLowerCase() : file;
  const check = () => { signal?.throwIfAborted(); if (!Number.isFinite(deadline) || Date.now() >= deadline) throw bootstrapUnknown(); };
  check(); if (pending.has(pendingKey)) throw bootstrapUnknown(); pending.add(pendingKey);
  let worker: Worker | undefined;
  try {
    const record = await guardPriorEndpoints(home, endpoint, token, log, signal, () => {
      check(); bootstrapHomeIdentity(home); inspectBootstrapJournal(home);
      if (!needsColdPreparation(file)) return undefined;
      return { version: 1 as const, attempt: randomUUID(), state: "preparing" as const, home, homeIdentity: bootstrapHomeIdentity(home), file,
        contract: "protocol9-metadata4-schema14-cold-v2" as const,
        original: Object.fromEntries(coldStoreFiles(file).map(path => [path, existsSync(path) ? bootstrapFileIdentity(path) : null])),
        pid: process.pid, processIdentity: "" };
    }, file, deadline);
    if (!record) return;
    const identity = await ownProcessIdentity(signal, () => { check(); return deadline - Date.now(); }); check();
    if (!identity) throw bootstrapUnknown(); record.processIdentity = identity;
    const revoked = new SharedArrayBuffer(4), cell = new Int32Array(revoked);
    const plan: ColdBootstrapPlan = { record, endpoint, token, deadline, revoked };
    // Register cancellation before any cold owned worker can start.
    let cancelled: unknown, prepared: BootstrapRecord | undefined, originalPair: { initial: BootstrapEvidence; prepared: BootstrapEvidence } | undefined, termination: Promise<number> | undefined;
    let phase = "worker-start-or-kernel";
    let rejectWait: ((error: unknown) => void) | undefined;
    const stop = () => {
      cancelled ??= signal?.aborted ? signal.reason : Object.assign(bootstrapUnknown(), { bootstrapStage: phase, bootstrapFailure: "original-deadline-or-unsettled-stop" }); Atomics.store(cell, 0, 1);
      if (worker && !termination) {
        termination = worker.terminate();
        void termination.then(() => rejectWait?.(cancelled), error => { cancelled = new AggregateError([cancelled, error], "Owned cold-store worker termination is unproven; original evidence retained"); rejectWait?.(cancelled); });
      }
    };
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
    try {
      check(); if (signal?.aborted) stop(); if (cancelled) throw cancelled;
      worker = new Worker(workerEntry(), { workerData: { kind: "agent-bridge-cold-bootstrap-v1", plan, ownProcessIdentity: { pid: process.pid, identity } }, execArgv: [] });
      // threadId is lifecycle state and becomes -1 after exit. The durable
      // proof must match the immutable identity assigned to this owned worker.
      const workerThread = worker.threadId;
      if (!Number.isSafeInteger(workerThread) || workerThread <= 0) throw bootstrapUnknown();
      await new Promise<void>((accept, reject) => {
        rejectWait = reject;
        worker!.on("message", message => {
          if (cancelled) return;
          if (message?.attempt !== record.attempt || message?.state !== "prepared") { stop(); return; }
          try {
            const mismatch = (reason: string) => Object.assign(bootstrapUnknown(), { bootstrapStage: "prepared-record-validation", bootstrapFailure: reason });
            try { originalPair = readBootstrapPair(home, record.attempt); prepared = originalPair.prepared.record; }
            catch { throw mismatch("unreadable-prepared-record"); }
            if (prepared.attempt !== record.attempt || prepared.state !== "prepared") throw mismatch("attempt-or-state");
            if (prepared.home !== home || prepared.file !== file) throw mismatch("destination");
            if (!sameBootstrapIdentity(prepared.original, record.original)) throw mismatch("original-files");
            if (prepared.pid !== record.pid) throw mismatch("process");
            if (prepared.workerThread !== workerThread) throw mismatch("worker-thread");
            if (prepared.processIdentity !== identity) throw mismatch("process-incarnation");
            if (!prepared.files || !prepared.namespace) throw mismatch("missing-prepared-proof");
            phase = "prepared-awaiting-exit";
          } catch (error) { cancelled = error; stop(); }
        });
        worker!.on("error", error => { cancelled ??= bootstrapWorkerFailure(error); stop(); });
        worker!.once("exit", code => {
          if (cancelled || code !== 0 || !prepared) reject(cancelled ?? bootstrapUnknown());
          else { try { check(); accept(); } catch (error) { reject(error); } }
        });
        try { check(); } catch (error) { cancelled = error; stop(); }
      });
      check();
      phase = "exit-evidence-finalization";
      // Exit IPC is not a proof transfer. This new guard owns only the durable
      // exact-exit record; the final opener obtains yet another fresh proof.
      await guardPriorEndpoints(home, endpoint, token, log, signal, remaining => {
        const release = maintenanceLock(home, false, true);
        try {
          remaining(); check();
          const current = readBootstrapPair(home, record.attempt);
          if (!sameBootstrapIdentity(current, originalPair)) throw bootstrapUnknown();
          for (const [path, id] of Object.entries(current.prepared.record.files!)) if (!sameBootstrapIdentity(bootstrapFileIdentity(path), id)) throw bootstrapUnknown();
          appendBootstrapRecord({ ...current.prepared.record, state: "exited", preparedDigest: current.prepared.digest }, () => { remaining(); check(); }); remaining(); check();
          inspectBootstrapJournal(home); remaining(); check();
        } finally { release(); }
      }, file, deadline);
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", stop);
      // Every failing path revokes before awaiting termination of this exact
      // worker. Exit/cleanup can be late; that never becomes admitted success.
      Atomics.store(cell, 0, 1);
      if (termination) await termination;
      else if (worker && worker.threadId !== -1) await worker.terminate();
    }
  } finally { if (!worker || worker.threadId === -1) pending.delete(pendingKey); }
}
