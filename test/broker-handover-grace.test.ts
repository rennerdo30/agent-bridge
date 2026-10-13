import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { BROKER_SUCCESSOR_GRACE_MS } from "../src/core/broker-upgrade.js";
import { CONNECT_TIMEOUT_MS, ELECTION_RETRY_MAX_MS, RECONNECT_BACKOFF_MIN_MS } from "../src/core/constants.js";
import { makeEnv, until } from "./helpers.js";

it("gives the successor its full grace at socket close when announcement time has already elapsed", async () => {
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
    const sent = await old.send({ to: "later", body: "retained across delayed successor" });
    const next = env.node("next"); await next.setBrokerEligibility(false); await next.start();
    const ensure = next.ensureConnected.bind(next);
    vi.spyOn(next, "ensureConnected").mockImplementation(async () => { if (elapsed) await delay(200); return ensure(); });
    await next.setBrokerEligibility(true);
    const budget = BROKER_SUCCESSOR_GRACE_MS + RECONNECT_BACKOFF_MIN_MS + ELECTION_RETRY_MAX_MS + 2 * CONNECT_TIMEOUT_MS;
    await until(() => next.isBroker && old.isConnected && !old.isBroker, budget);
    const later = env.node("later"); await later.start();
    await until(() => later.unread().length === 1);
    expect(later.unread()[0]?.id).toBe(sent.messages[0]?.id);
    expect(next.isBroker).toBe(true); expect(old.isBroker).toBe(false);
  } finally { vi.restoreAllMocks(); await env.cleanup(); }
});
