import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { BROKER_SUCCESSOR_GRACE_MS } from "../src/core/broker-upgrade.js";
import { CONNECT_TIMEOUT_MS, ELECTION_RETRY_MAX_MS, RECONNECT_BACKOFF_MIN_MS } from "../src/core/constants.js";
import { makeEnv } from "./helpers.js";

// The fixture advances Date.now for product election deadlines. Its polling
// budget must use an independent clock so that jump cannot spend 5.1s of it.
async function until(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > end) throw new Error("condition not met in time");
    await delay(20);
  }
}

for (const releaseDelayMs of [0, 3_000]) it("gives the successor its full grace at socket close when announcement time has already elapsed" +
  (releaseDelayMs ? " with a delayed endpoint release" : ""), async () => {
  const env = makeEnv();
  try {
    let elapsed = 0;
    const now = Date.now.bind(Date), connect = BridgeClient.connect.bind(BridgeClient);
    vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
    vi.spyOn(BridgeClient, "connect").mockImplementation(async (...args) => {
      const client = await connect(...args), request = client.request.bind(client);
      vi.spyOn(client, "request").mockImplementation((op, args: any, timeout) => {
        if (op === "hello" && args.peer?.name === "old") {
          // Simulate time consumed between announcement and socket close,
          // after the node's event listener records the original deadline.
          client.on("event", event => { if (event === "broker_handover") elapsed = BROKER_SUCCESSOR_GRACE_MS + 100; });
        }
        return request(op, args, timeout);
      });
      return client;
    });
    const old = env.node("old");
    // Release-version injection is fixture setup, before either host connects.
    (old as any).version = "0.30.12"; await old.start(); (old as any).broker.version = "0.30.12";
    if (releaseDelayMs) {
      const broker = (old as any).broker, close = broker.close.bind(broker);
      vi.spyOn(broker, "close").mockImplementation((beforeRelease: any) => close(beforeRelease && (async () => {
        await beforeRelease();
        while (!elapsed) await delay(1);
        // Keep the old endpoint owned while announcement processing consumes
        // real time too. The successor still receives a full window at close.
        await delay(releaseDelayMs);
      })));
    }
    const sent = await old.send({ to: "later", body: "retained across delayed successor" });
    const next = env.node("next"); await next.setBrokerEligibility(false); await next.start();
    const ensure = next.ensureConnected.bind(next);
    vi.spyOn(next, "ensureConnected").mockImplementation(async () => { if (elapsed) await delay(200); return ensure(); });
    await next.setBrokerEligibility(true);
    const budget = BROKER_SUCCESSOR_GRACE_MS + RECONNECT_BACKOFF_MIN_MS + ELECTION_RETRY_MAX_MS + 2 * CONNECT_TIMEOUT_MS;
    await until(() => next.isBroker && old.isConnected && !old.isBroker, budget);
    expect(elapsed).toBe(BROKER_SUCCESSOR_GRACE_MS + 100);
    const later = env.node("later"); await later.start();
    await until(() => later.unread().length === 1);
    expect(later.unread()[0]?.id).toBe(sent.messages[0]?.id);
    expect(next.isBroker).toBe(true); expect(old.isBroker).toBe(false);
  } finally { vi.restoreAllMocks(); await env.cleanup(); }
});
