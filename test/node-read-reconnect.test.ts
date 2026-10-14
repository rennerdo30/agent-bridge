import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient, brokerConnectionClosedError } from "../src/core/client.js";
import { BridgeError } from "../src/core/protocol.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
async function connected() {
  const previous = env.node("previous"), reader = env.node("reader");
  await previous.start(); await reader.start();
  return { previous, reader };
}
function holdPeers(node: unknown) {
  const broker = (node as any).broker, original = broker.handlers.peers;
  let entered = false, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  broker.handlers.peers = async (connection: any, args: unknown) => {
    if (connection.peer?.name === "reader") { entered = true; await ready; return []; }
    return original(connection, args);
  };
  return { entered: () => entered, release };
}

it("reconnects one actual in-flight peers read across broker retirement and preserves retained mail", async () => {
  const { previous, reader } = await connected();
  const stored = await reader.send({ to: "later", body: "retained during read retry" });
  const held = holdPeers(previous), peers = reader.peers();
  try {
    await until(held.entered); await previous.stop();
    expect(await peers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "reader" })]));
    expect(reader.isBroker).toBe(true);
    const later = env.node("later"); await later.start(); await until(() => later.unread().length === 1);
    expect(later.unread()[0]!.id).toBe(stored.messages[0]!.id);
  } finally { held.release(); }
});

it.each(["semantic", "timeout"])("does not retry a %s read failure on an open client", async kind => {
  const { reader } = await connected(), client = (reader as any).client as BridgeClient;
  const error = kind === "semantic" ? new BridgeError("unauthorized", "no permission") : new Error("broker request timed out: peers");
  const request = vi.spyOn(client, "request").mockRejectedValue(error);
  await expect(reader.peers()).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1); expect(client.isClosed).toBe(false);
});

it.each(["abort", "stop"])("%s cancels a held read without reconnecting or submitting another request", async action => {
  const { previous, reader } = await connected(), held = holdPeers(previous), signal = new AbortController();
  const result = reader.peers(signal.signal), rejected = expect(result).rejects.toThrow(action === "stop" ? "bridge node stopped" : "cancelled read");
  try {
    await until(held.entered);
    const connect = vi.spyOn(reader, "ensureConnected");
    if (action === "stop") await reader.stop(); else signal.abort(new Error("cancelled read"));
    await rejected; expect(connect).not.toHaveBeenCalled();
  } finally { held.release(); }
});

it("surfaces a second actual closed socket instead of retrying the read indefinitely", async () => {
  const { previous, reader } = await connected(), held = holdPeers(previous);
  let secondReads = 0;
  reader.once("connected", () => {
    const broker = (reader as any).broker, original = broker.handlers.peers;
    broker.handlers.peers = (connection: any, args: unknown) => {
      if (connection.peer?.name === "reader") { secondReads++; connection.socket.destroy(); return []; }
      return original(connection, args);
    };
  });
  const result = reader.peers(), rejected = expect(result).rejects.toMatchObject({ message: "connection to broker closed", code: "BROKER_CONNECTION_CLOSED" });
  try { await until(held.entered); await previous.stop(); await rejected; expect(secondReads).toBe(1); }
  finally { held.release(); await reader.stop(); }
});

it("never applies the read retry policy to a mutation", async () => {
  const { reader } = await connected(), client = (reader as any).client as BridgeClient;
  const error = brokerConnectionClosedError();
  const request = vi.spyOn(client, "request").mockRejectedValue(error);
  await expect(reader.setProjectMain("reader")).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledWith("projectMain", { to: "reader" });
});

it("bounds a stalled reconnect and cancels its read wait without a late request", async () => {
  const { previous, reader } = await connected(), held = holdPeers(previous);
  const client = (reader as any).client as BridgeClient, requests = vi.spyOn(client, "request");
  const result = reader.peers(), rejected = expect(result).rejects.toMatchObject({ code: "ETIMEDOUT", message: "broker read reconnect timed out" });
  try {
    await until(held.entered);
    vi.spyOn(reader, "ensureConnected").mockImplementation(() => new Promise(() => {}));
    await previous.stop(); await rejected;
    expect(requests.mock.calls.filter(call => call[0] === "peers")).toHaveLength(1);
    expect(reader.listenerCount("stopped")).toBe(0);
  } finally { held.release(); }
});
