import { expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { makeEnv, until } from "./helpers.js";

it("retries health once when its exact connection closes, retaining queued mail", async () => {
  const env = makeEnv(), broker = env.node("broker"), reader = env.node("reader");
  let healthReads = 0;
  const original = BridgeClient.prototype.request;
  try {
    await broker.start(); await reader.start();
    const stored = await reader.send({ to: "later", body: "retained through health reconnect" });
    const spy = vi.spyOn(BridgeClient.prototype, "request").mockImplementation(async function (this: BridgeClient, op, args, timeout) {
      if (op === "health" && ++healthReads === 1) {
        const closed = new Promise<void>(resolve => this.once("close", resolve));
        this.close(); await closed;
      }
      return original.call(this, op, args, timeout);
    });
    const health = await reader.health();
    expect(health.brokerPid).toBe(process.pid);
    expect(healthReads).toBe(2);
    expect(reader.isConnected).toBe(true);
    spy.mockRestore();
    const later = env.node("later"); await later.start();
    await until(() => later.unread().length === 1);
    expect(later.unread()[0]!.id).toBe(stored.messages[0]!.id);
  } finally { vi.restoreAllMocks(); await env.cleanup(); }
});
