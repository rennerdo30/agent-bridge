import { expect, it, vi } from "vitest";
import { MessageStore } from "../src/core/store.js";
import { metadataValue } from "../src/core/metadata-db.js";
import { BROKER_SUCCESSOR_GRACE_MS } from "../src/core/broker-upgrade.js";
import { CONNECT_TIMEOUT_MS, ELECTION_RETRY_MAX_MS, RECONNECT_BACKOFF_MIN_MS } from "../src/core/constants.js";
import { makeEnv, until } from "./helpers.js";

vi.mock("../src/core/broker-upgrade.js", async original => ({
  ...await original<typeof import("../src/core/broker-upgrade.js")>(),
  BROKER_UPGRADE_CHECK_MS: 50, BROKER_UPGRADE_DRAIN_MS: 150, BROKER_UPGRADE_RETRY_MS: 200,
}));

it("retries a timed-out automatic drain briefly and keeps the completed handover cooldown across arrivals", async () => {
  const env = makeEnv(); let release = () => {};
  try {
    const old = env.node("old");
    (old as any).version = "0.30.12"; await old.start(); (old as any).broker.version = "0.30.12";
    const held = new Promise<void>(resolve => { release = resolve; });
    let blocking = true;
    const write = MessageStore.prototype.retryWrite;
    vi.spyOn(MessageStore.prototype, "retryWrite").mockImplementation(async function<T>(this: MessageStore, operation: () => T): Promise<T> {
      if (blocking) await held;
      return write.call(this, operation) as Promise<T>;
    });
    const send = old.send({ to: "later", body: "admitted while registration waits" });
    const next = env.node("next"), start = next.start();
    // Hello has advertised the successor, but its queue registration and the
    // admitted send remain behind a real asynchronous writer boundary.
    await expect.poll(async () => (await old.health()).handoverPending).toContain("drain timed out");
    expect(old.isBroker).toBe(true); expect(next.isBroker).toBe(false);
    expect(metadataValue(env.home, "broker-election", "upgrade")).toBeNull();
    blocking = false; release(); await start; const sent = await send;
    await until(() => next.isBroker && old.isConnected && !old.isBroker,
      BROKER_SUCCESSOR_GRACE_MS + RECONNECT_BACKOFF_MIN_MS + ELECTION_RETRY_MAX_MS + 2 * CONNECT_TIMEOUT_MS);
    const completed = metadataValue(env.home, "broker-election", "upgrade") as { at: number };
    expect(completed.at).toBeGreaterThan(0);
    const later = env.node("later"); await later.start(); await until(() => later.unread().length === 1);
    expect(later.unread()[0]?.id).toBe(sent.messages[0]?.id);
    const newer = env.node("newer"); (newer as any).version = "0.30.15";
    await newer.setBrokerEligibility(false); await newer.start(); await newer.setBrokerEligibility(true);
    await expect.poll(async () => (await next.health()).handoverPending).toContain("upgrade cooldown");
    expect(next.isBroker).toBe(true); expect(newer.isBroker).toBe(false);
    expect(metadataValue(env.home, "broker-election", "upgrade")).toEqual(completed);
  } finally { release(); vi.restoreAllMocks(); await env.cleanup(); }
});
