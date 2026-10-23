import { setTimeout as delay } from "node:timers/promises";
import { quarantineTextAsync } from "../core/oversize.js";
import { completionMessageId, COMPLETION_DEDUPE_PREFIX } from "../core/completion.js";
import { readOriginalRunnerSpec, readRunnerStateRecord, runnerLedgerNamespace, runnerRetentionStamp, writeRunnerStateRecord } from "../core/runner-store.js";
import { ACK_CONVERSATION_SUFFIX, QUESTION_CONVERSATION_SUFFIX } from "../core/protocol.js";
import { isPureAcknowledgement } from "../core/job-messaging.js";
import { NOTE_CONVERSATION_SUFFIX, type RunnerState } from "./jobs.js";
import { retainRunnerDelivery, runnerLedgerPrincipal, RunnerRetentionUnsettled, type PendingRunnerRetention } from "./runner-delivery-retention.js";

/** Evidence-only recovery; never consumes a spec, selects a recipient or dispatches an envelope. */
export async function recoverRunnerLedger(home: string, id: string, signal: AbortSignal, current: () => boolean = () => true): Promise<void> {
  let state = readRunnerStateRecord(home, id);
  const spec = readOriginalRunnerSpec(home, id), principal = spec?.job as Record<string, unknown> | undefined;
  if (!state || !spec || !principal || principal.id !== id || typeof principal.name !== "string" || typeof principal.agent !== "string") throw new RunnerRetentionUnsettled("invalid-evidence");
  const originalSpec = JSON.stringify(spec);
  const raw = state as unknown as RunnerState, ledger = raw.deliveryLedger;
  const namespace = runnerLedgerNamespace(home);
  if (!ledger || ledger.namespace !== namespace) throw new RunnerRetentionUnsettled("invalid-evidence");
  if (ledger && (ledger.version !== 1 || ledger.job !== id || ledger.principal !== runnerLedgerPrincipal(spec) || typeof ledger.generation !== "string" || !Array.isArray(ledger.entries))) throw new RunnerRetentionUnsettled("invalid-evidence");
  if (raw.pendingDeliveryRetention !== undefined && !Array.isArray(raw.pendingDeliveryRetention) || ledger.entries.length > 129 ||
      (raw.pendingDeliveryRetention?.length ?? 0) > 129) throw new RunnerRetentionUnsettled("invalid-evidence");
  const items = new Map<string, PendingRunnerRetention>();
  let bytes = 0;
  for (const item of [...ledger?.entries ?? [], ...raw.pendingDeliveryRetention ?? []]) {
    if (!item || typeof item.messageId !== "string" || typeof item.record !== "string" || items.has(item.messageId) && items.get(item.messageId)!.record !== item.record) throw new RunnerRetentionUnsettled("invalid-evidence");
    if (!items.has(item.messageId) && (bytes += Buffer.byteLength(item.record)) > 8 * 1024 * 1024) throw new RunnerRetentionUnsettled("invalid-evidence");
    items.set(item.messageId, item);
  }
  if (!items.size && !raw.retainedRunnerInputs && raw.deliveryRetentionFailure) throw new RunnerRetentionUnsettled("invalid-evidence");
  const commit = (patch: Record<string, unknown>) => {
    if (!current() || JSON.stringify(readOriginalRunnerSpec(home, id)) !== originalSpec) throw new RunnerRetentionUnsettled("invalid-evidence");
    const next = { ...state, ...patch };
    writeRunnerStateRecord(home, id, next, false, runnerRetentionStamp(state)); state = next;
  };
  const wait = (ms: number) => delay(ms, undefined, { signal });
  for (const item of items.values()) {
    let record;
    try { record = JSON.parse(item.record); } catch { throw new RunnerRetentionUnsettled("invalid-evidence"); }
    const suffix = isPureAcknowledgement(record?.wireBody) ? ACK_CONVERSATION_SUFFIX : record?.question ? QUESTION_CONVERSATION_SUFFIX : record?.note ? NOTE_CONVERSATION_SUFFIX : "";
    const expected = record?.final && typeof record.dedupeKey === "string" && record.dedupeKey.startsWith(COMPLETION_DEDUPE_PREFIX)
      ? completionMessageId(`job:${id}`, record.dedupeKey.slice(COMPLETION_DEDUPE_PREFIX.length))
      : typeof record?.dedupeKey === "string" ? completionMessageId(`send:${record.senderName ?? principal.name}`, record.dedupeKey) : null;
    if (record?.version !== 1 || !["accepted-runner-delivery", "refused-runner-delivery"].includes(record.kind) || record.authority !== "evidence-only-no-replay" ||
      record.job !== id || record.intendedSender?.kind !== "job" || record.intendedSender?.id !== `job:${id}` || record.intendedSender?.agent !== principal.agent ||
      record.supervisor !== (principal.supervisor ?? null) || record.parentJob !== (principal.parentJob ?? null) || record.rootSession !== (principal.rootSession ?? null) ||
      record.kind === "accepted-runner-delivery" && (record.generation !== ledger?.generation || record.namespace !== namespace || typeof record.senderName !== "string" || !record.senderName) ||
      typeof record.body !== "string" || typeof record.wireBody !== "string" || typeof record.to !== "string" || !record.to ||
      typeof record.attemptedTo !== "string" || typeof record.note !== "boolean" || typeof record.question !== "boolean" ||
      record.conversationId !== `job-${id}${suffix}` || !(record.replyTo === null || typeof record.replyTo === "string") || record.messageId !== item.messageId || expected !== item.messageId) throw new RunnerRetentionUnsettled("invalid-evidence");
    await retainRunnerDelivery(async () => {
      if (!current()) throw new RunnerRetentionUnsettled("invalid-evidence");
      await quarantineTextAsync(home, item.messageId, item.record, () => {
        const before = state as unknown as RunnerState;
        commit({ pendingDeliveryRetention: (before.pendingDeliveryRetention ?? []).filter(entry => entry.messageId !== item.messageId),
          ...(before.deliveryLedger ? { deliveryLedger: { ...before.deliveryLedger, entries: before.deliveryLedger.entries.filter(entry => entry.messageId !== item.messageId) } } : {}),
          retainedDeliveryCount: Math.min(65_535, (before.retainedDeliveryCount ?? 0) + 1) });
      });
    }, signal, wait);
  }
  const input = (state as unknown as RunnerState).retainedRunnerInputs;
  if (input && !["evidence", "consumed"].includes(input.phase)) {
    if (input.generation !== ledger?.generation || !Array.isArray(input.bodies) || input.bodies.length > 128 || !input.bodies.every(body => typeof body === "string") ||
      !Array.isArray(input.controls) || input.controls.length > 128 || !input.controls.every(control => typeof control.cid === "string" && typeof control.body === "string") ||
      Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) throw new RunnerRetentionUnsettled("invalid-evidence");
    const text = JSON.stringify({ version: 1, kind: "runner-input-intent", authority: "evidence-only-no-replay", job: id,
      namespace, principal: ledger.principal, input });
    await retainRunnerDelivery(() => quarantineTextAsync(home, completionMessageId(`runner-input:${id}`, input.generation), text,
      () => commit({ retainedRunnerInputs: { ...input, phase: "evidence" } })).then(() => {}), signal, wait);
  }
  commit({ deliveryRetentionFailure: undefined });
}
