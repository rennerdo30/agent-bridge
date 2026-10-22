import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient, brokerConnectionClosedError } from "../src/core/client.js";
import { BridgeError } from "../src/core/protocol.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { fixtureAck } from "./owned-mail.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
async function connected() {
  const previous = env.node("previous"), reader = env.node("reader");
  await previous.start(); await reader.start();
  return { previous, reader };
}

it("learns a native session while hello is in flight without changing its attested identity", async () => {
  const host = env.node("host"); await host.start();
  const reader = env.node("late-session", "opencode", false, null);
  const broker = (host as any).broker, original = broker.handlers.hello;
  let entered = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  broker.handlers.hello = async (conn: any, args: any) => {
    if (args.peer.id === reader.id) { entered = true; await held; }
    return original(conn, args);
  };
  const starting = reader.start();
  try {
    await until(() => entered);
    const learned = reader.setSessionId("late-opencode-session");
    release();
    await Promise.all([starting, learned]);
    expect((await host.peers()).find(p => p.id === reader.id)).toMatchObject({ sessionId: "late-opencode-session" });
    const sent = await host.send({ to: reader.name, body: "Only the attested session receives this" });
    await reader.refreshPending();
    expect(reader.unread()).toContainEqual(expect.objectContaining({ id: sent.messages[0]!.id }));
    reader.markRead([sent.messages[0]!.id]);
    await expect.poll(() => host.messageReceipt(sent.messages[0]!.id)).toEqual([{ recipient: reader.name, readAt: expect.any(Number) }]);
    await reader.stop();
    const replacement = env.node(reader.name, "opencode", false, "different-session"); await replacement.start();
    await replacement.refreshPending(); expect(replacement.unread()).toEqual([]);
  } finally { release(); await starting.catch(() => {}); }
});
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
  const registered = env.node("later"); await registered.start(); await registered.stop();
  const stored = await reader.send({ to: "later", body: "retained during read retry" });
  expect(stored.messages[0]!.recipientNative).toBeTruthy();
  expect(stored.messages[0]!.recipientAmbiguous).toBeUndefined();
  const held = holdPeers(previous), peers = reader.peers();
  try {
    await until(held.entered); await previous.stop();
    expect(await peers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "reader" })]));
    expect(reader.isBroker).toBe(true);
    const wrong = env.node("later"); await wrong.start(); await wrong.refreshPending();
    expect(wrong.unread()).toEqual([]);
    expect(await ((wrong as any).client as BridgeClient).request("ack", fixtureAck(stored.messages))).toEqual({ acked: 0 });
    expect((await reader.messageReceipt(stored.messages[0]!.id))[0]!.readAt).toBeNull();
    await wrong.stop();
    const later = env.node("later"); await later.setSessionId(registered.currentSessionId!); await later.start(); await until(() => later.unread().length === 1);
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
