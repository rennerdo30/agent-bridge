import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithStdioTuple } from "node:child_process";

/** Diagnostics only. This module has no identity/turn/descendant/ownership producer or retry permit. */
export const MAX_PROVIDER_ATTEMPT_OBSERVATIONS = 8;
export type ProviderAttemptPhase = "attempt_recorded" | "child_returned" | "spawn_observed" | "error_observed" | "close_observed" | "spawn_unreturned";

export interface ProviderAttemptObservation {
  readonly phase: ProviderAttemptPhase;
  readonly childMembership: "unknown" | "source_returned";
  readonly listenerMembership: "unknown" | "source_recorded";
  readonly pid: number | null;
  readonly spawnObserved: boolean;
  readonly errorObserved: boolean;
  readonly directCloseObserved: boolean;
  readonly closeCode: number | null;
  readonly closeSignal: string | null;
  readonly creationIdentity: null;
  readonly sessionId: null;
  readonly nativeTurnId: null;
  readonly effectiveModel: null;
  readonly descendants: "unknown";
  readonly ownership: "unsupported";
  readonly observationOverflow: boolean;
}
export type ProviderAttemptObserver = (view: Readonly<ProviderAttemptObservation>) => void;
declare const keyBrand: unique symbol;
/** Runtime registry identity, not fields or a TypeScript cast, authenticates this reference. */
export interface ProviderAttemptKey { readonly [keyBrand]: true }
export type ProviderAttemptLookup = { readonly type: "held";
  readonly reason: "unregistered_key" | "child_unreturned" | "spawn_unreturned" | "source_facts_unsupported";
  readonly observation: Readonly<ProviderAttemptObservation> | null };

interface RecordState {
  child: ChildProcess | null;
  listeners: { spawn: () => void; error: () => void; close: (code: number | null, signal: string | null) => void } | null;
  listenersRecorded: boolean;
  phase: ProviderAttemptPhase;
  pid: number | null;
  spawnObserved: boolean;
  errorObserved: boolean;
  directCloseObserved: boolean;
  closeCode: number | null;
  closeSignal: string | null;
  notifications: number;
  overflow: boolean;
}
// No strong global list or eviction: live uncertain/overflow membership is retained by its key.
const records = new WeakMap<object, RecordState>();
const validPid = (pid: number | undefined) => pid !== undefined && Number.isSafeInteger(pid) && pid > 0 ? pid : null;

function view(record: RecordState): Readonly<ProviderAttemptObservation> {
  return Object.freeze({ phase: record.phase, childMembership: record.child === null ? "unknown" : "source_returned",
    listenerMembership: record.listenersRecorded ? "source_recorded" : "unknown",
    pid: record.pid, spawnObserved: record.spawnObserved, errorObserved: record.errorObserved,
    directCloseObserved: record.directCloseObserved, closeCode: record.closeCode, closeSignal: record.closeSignal,
    creationIdentity: null, sessionId: null, nativeTurnId: null, effectiveModel: null,
    descendants: "unknown", ownership: "unsupported", observationOverflow: record.overflow });
}

/** Reject DTOs/casts/clones without reading their properties or invoking caller code. Never returns settled. */
export function lookupProviderAttempt(key: unknown): ProviderAttemptLookup {
  const record = key !== null && (typeof key === "object" || typeof key === "function") ? records.get(key) : undefined;
  if (!record) return { type: "held", reason: "unregistered_key", observation: null };
  return { type: "held", reason: record.phase === "spawn_unreturned" ? "spawn_unreturned"
    : record.child === null ? "child_unreturned" : "source_facts_unsupported", observation: view(record) };
}

/**
 * Opt-in source owner: records the attempt before spawn and owns the actual Node spawn call.
 * No child, identity, witness, completion flag or producer callback can be supplied by a caller.
 * The only public failure marker records absence of a returned child, never positive evidence.
 */
export function createProviderAttemptSource(observer: ProviderAttemptObserver): {
  readonly key: ProviderAttemptKey;
  spawn(command: string, args: readonly string[], options: SpawnOptionsWithStdioTuple<"pipe", "pipe", "pipe">): ChildProcessWithoutNullStreams;
  noteUnreturned(): void;
} {
  const key = Object.freeze(Object.create(null)) as ProviderAttemptKey;
  const record: RecordState = { child: null, listeners: null, listenersRecorded: false, phase: "attempt_recorded", pid: null, spawnObserved: false,
    errorObserved: false, directCloseObserved: false, closeCode: null, closeSignal: null, notifications: 0, overflow: false };
  records.set(key, record);
  let invoked = false;
  const publish = () => {
    if (record.notifications >= MAX_PROVIDER_ATTEMPT_OBSERVATIONS) { record.overflow = true; return; }
    // Reserve the final bounded notification to expose overflow conservatively.
    if (record.notifications === MAX_PROVIDER_ATTEMPT_OBSERVATIONS - 1) record.overflow = true;
    record.notifications++;
    const snapshot = view(record);
    // Never insert arbitrary observer execution into spawn/stdio/error/close handler ordering.
    queueMicrotask(() => {
      try { void Promise.resolve(observer(snapshot)).catch(() => {}); }
      catch { /* Diagnostics cannot change the original launch/outcome or lose capture membership. */ }
    });
  };
  const noteUnreturned = () => {
    if (record.child !== null) return;
    record.phase = "spawn_unreturned";
    publish();
  };
  publish();
  return Object.freeze({ key, noteUnreturned, spawn(command: string, args: readonly string[], options: SpawnOptionsWithStdioTuple<"pipe", "pipe", "pipe">) {
    if (invoked) throw new Error("provider attempt source already invoked");
    invoked = true;
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(command, args, options); }
    catch (error) { noteUnreturned(); throw error; }
    record.child = child;
    record.pid = validPid(child.pid);
    // Membership/listeners precede any exposure or use by runProcess. These listeners remain
    // independent of its finish guard, including close after timeout/abort rejection.
    const onSpawn = () => {
      record.pid = validPid(child.pid);
      record.spawnObserved = true; record.phase = "spawn_observed"; publish();
    };
    const onError = () => { record.errorObserved = true; record.phase = "error_observed"; publish(); };
    const onClose = (code: number | null, signal: string | null) => {
      record.directCloseObserved = true;
      record.closeCode = code !== null && Number.isSafeInteger(code) ? code : null;
      record.closeSignal = signal !== null && /^SIG[A-Z0-9]{1,16}$/.test(signal) ? signal : null;
      record.phase = "close_observed";
      publish();
    };
    record.listeners = { spawn: onSpawn, error: onError, close: onClose };
    child.once("spawn", onSpawn);
    child.on("error", onError);
    child.once("close", onClose);
    record.listenersRecorded = true;
    record.phase = "child_returned";
    publish();
    return child;
  } });
}
