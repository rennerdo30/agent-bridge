import { setTimeout as delay } from "node:timers/promises";
import { BridgeError } from "../src/core/protocol.js";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { readProcessIdentity } from "../src/core/process-identity.js";

export interface FixtureReadinessBudget { remaining: () => number; signal: AbortSignal }

/** Existing endpoint only. Every awaited stage shares the original discovery
 * deadline; no hello/registration, publication, launch or mailbox operation. */
export async function fixtureDaemonProbe(pipe: string, token: string, budget: FixtureReadinessBudget): Promise<{ pid: number; identity: string | null }> {
  let client: BridgeClient | undefined;
  const close = () => client?.close();
  try {
    client = await BridgeClient.connect(pipe, nullLogger, budget.remaining(), { readOnlyDirectory: true, signal: budget.signal });
    budget.remaining(); budget.signal.addEventListener("abort", close, { once: true });
    await client.request("auth", { protocol: PROTOCOL_VERSION, token }, budget.remaining());
    budget.remaining(); const ping = await client.request("ping", {}, budget.remaining());
    budget.remaining(); const identity = await readProcessIdentity(ping.brokerPid, budget.signal, budget.remaining);
    budget.remaining(); return { pid: ping.brokerPid, identity };
  } catch (error) { budget.signal.throwIfAborted(); throw error; }
  finally { budget.signal.removeEventListener("abort", close); close(); }
}

/** Fixture discovery only: callers supply auth/ping, never a mailbox operation. */
export async function fixtureDaemonReadiness(probe: (budget: FixtureReadinessBudget) => Promise<number>, deadline: number,
  pause: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, signal) => delay(ms, undefined, { signal }),
  signal?: AbortSignal): Promise<number | undefined> {
  signal?.throwIfAborted();
  const expired = () => new BridgeError("timeout", "Daemon readiness exceeded its original discovery deadline; no ready identity was admitted.");
  if (!Number.isFinite(deadline)) throw expired();
  if (Date.now() >= deadline) return undefined;
  const controller = new AbortController(), cancelled = () => controller.abort(signal!.reason);
  signal?.addEventListener("abort", cancelled, { once: true });
  const timer = setTimeout(() => controller.abort(expired()), Math.max(1, deadline - Date.now()));
  const budget = { signal: controller.signal, remaining: () => {
    signal?.throwIfAborted(); controller.signal.throwIfAborted();
    const left = deadline - Date.now(); if (left <= 0) throw expired(); return left;
  } };
  try {
  while (Date.now() < deadline) {
    try { const pid = await probe(budget); budget.remaining(); return pid; }
    catch (error) {
      budget.remaining();
      // The reservation has not authenticated, registered or admitted a request.
      // Only this exact typed refusal permits another auth/ping discovery pass.
      const tentative = error instanceof BridgeError && error.code === "internal" &&
        error.message === "Core is initializing; no request was admitted.";
      if (!tentative && !["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await pause(Math.min(100, budget.remaining()), budget.signal);
      signal?.throwIfAborted(); controller.signal.throwIfAborted();
    }
  }
  return undefined;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancelled); }
}
