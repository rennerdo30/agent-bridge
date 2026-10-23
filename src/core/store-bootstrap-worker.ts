import { isMainThread, parentPort, threadId, workerData } from "node:worker_threads";
import { join } from "node:path";
import { MessageStore } from "./store.js";
import { closeMetadataDbs } from "./metadata-db.js";
import { nullLogger } from "./logger.js";
import { maintenanceLock, withMaintenanceExclusion } from "./storage-lock.js";
import { guardBootstrapPreparation } from "./prior-endpoints.js";
import { processIdentity } from "./process-identity.js";
import { checkBootstrapOriginal, coldStoreFiles, needsColdPreparation, type ColdBootstrapPlan } from "./store-bootstrap.js";
import { appendBootstrapRecord, bootstrapFileIdentity, bootstrapHomeIdentity, bootstrapUnknown, inspectBootstrapJournal, readBootstrapEvidence, sameBootstrapIdentity, withBootstrapInitializer, type BootstrapRecord } from "./store-bootstrap-journal.js";

/** Actual initializer kernel; tests invoke it only behind an explicit fake
 * Worker transport. There is no broker, provider, listener or service launch. */
export async function runColdStoreBootstrap(plan: ColdBootstrapPlan): Promise<BootstrapRecord> {
  const { deadline } = plan, revoked = new Int32Array(plan.revoked), record = { ...plan.record, workerThread: threadId };
  if (record.state !== "preparing" || record.pid !== process.pid || plan.record.workerThread !== undefined || threadId <= 0 || !Number.isFinite(deadline) || revoked.length !== 1) throw bootstrapUnknown();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  let release: (() => void) | undefined, store: MessageStore | undefined;
  try {
    return await guardBootstrapPreparation(record.home, plan.endpoint, plan.token, nullLogger, controller.signal, check => {
      check(); if (processIdentity(process.pid) !== record.processIdentity) throw bootstrapUnknown();
      checkBootstrapOriginal(record); inspectBootstrapJournal(record.home);
      release = maintenanceLock(record.home, false, true);
      return withMaintenanceExclusion(release, check, () => {
        checkBootstrapOriginal(record); check();
        if (!needsColdPreparation(record.file)) throw bootstrapUnknown();
        appendBootstrapRecord(record); check(); // Immutable pending evidence BEFORE any schema/metadata effect.
        const initial = readBootstrapEvidence(join(record.home, ".store-bootstrap", `${record.attempt}.preparing.json`));
        const namespace = withBootstrapInitializer(record, check, () => {
          store = new MessageStore(record.file, nullLogger); check();
          const namespace = store.namespace; check();
          store.closeBootstrapPreparation(); store = undefined; closeMetadataDbs(); check(); return namespace;
        });
        if (!sameBootstrapIdentity(bootstrapHomeIdentity(record.home), record.homeIdentity)) throw bootstrapUnknown();
        const prepared: BootstrapRecord = { ...record, state: "prepared", namespace, preparingDigest: initial.digest, preparingSignature: initial.signature,
          files: Object.fromEntries(coldStoreFiles(record.file).map(file => [file, bootstrapFileIdentity(file)])) };
        for (const [file, original] of Object.entries(record.original)) if (original && !sameBootstrapIdentity(original, prepared.files![file])) throw bootstrapUnknown();
        appendBootstrapRecord(prepared); check(); return prepared;
      });
    }, record.file, deadline, revoked);
  } finally {
    clearTimeout(timer);
    try { try { store?.closeBootstrapPreparation(); } finally { closeMetadataDbs(); } }
    finally { release?.(); }
  }
}

if (!isMainThread && parentPort && workerData?.kind === "agent-bridge-cold-bootstrap-v1") {
  const plan = workerData?.plan as ColdBootstrapPlan;
  void runColdStoreBootstrap(plan).then(record => parentPort!.postMessage({ attempt: record.attempt, state: "prepared" }),
    () => parentPort!.postMessage({ attempt: plan?.record?.attempt, state: "failed" })).finally(() => parentPort!.close());
}
