import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { BridgeClient } from "../src/core/client.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv, extra: BridgeNode[];
beforeEach(() => { env = makeEnv(); extra = []; });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(extra.map(node => node.stop())); await env.cleanup(); });

async function registeredClient(node: BridgeNode): Promise<BridgeClient> {
  // Pass through real auth/hello/election and capture the actual registered client.
  const spy = vi.spyOn(BridgeClient.prototype, "request");
  try {
    await node.start();
    const index = spy.mock.calls.findIndex(([op]) => op === "hello");
    expect(index).toBeGreaterThanOrEqual(0);
    return spy.mock.contexts[index] as BridgeClient;
  } finally { spy.mockRestore(); }
}
function frame(data: unknown): { t?: string; op?: string; id?: number; args?: { messageId?: string }; ok?: boolean } | null {
  if (typeof data !== "string") return null;
  try { return JSON.parse(data); } catch { return null; }
}

describe("real transport send admission boundaries (no production recovery change)", () => {
  it("a definitely closed prewrite client admits zero frames; same error code cannot be used for pending writes", async () => {
    const host = env.node("prewrite-host"); await host.start();
    const sender = env.node("prewrite-sender"), client = await registeredClient(sender);
    const socket = Reflect.get(client, "socket") as Socket;
    const closed = once(client, "close"); client.close(); await closed;
    expect(client.isClosed).toBe(true);
    const writes = vi.spyOn(socket, "write"), id = randomUUID();
    await expect(client.request("trackedSend", { messageId: id, to: "offline-boundary", body: "definitely not written" }))
      .rejects.toMatchObject({ code: "BROKER_CONNECTION_CLOSED" });
    expect(writes).not.toHaveBeenCalled();
    expect(await sender.sendState(id)).toMatchObject({ id, state: "not_stored", message: null });
  });
  it("lost ACK after real durable storage keeps the SAME UUID and reconciles exact bytes without a new send identity", async () => {
    const host = env.node("ack-host"); await host.start();
    const broker = Reflect.get(host, "broker"), server = Reflect.get(broker, "server") as Server;
    const acceptedSocket = once(server, "connection");
    const sender = env.node("ack-sender"), client = await registeredClient(sender);
    const [serverSocket] = await acceptedSocket as [Socket];
    const socket = Reflect.get(client, "socket") as Socket, write = socket.write, serverWrite = serverSocket.write;
    const id = randomUUID(); let requestId: number | undefined, requestCount = 0, dropped = 0;
    const clientSpy = vi.spyOn(socket, "write").mockImplementation(function (this: Socket, ...args: Parameters<Socket["write"]>) {
      const value = frame(args[0]);
      if (value?.t === "req" && value.op === "trackedSend" && value.args?.messageId === id) { requestId = value.id; requestCount++; }
      return write.apply(this, args);
    });
    const serverSpy = vi.spyOn(serverSocket, "write").mockImplementation(function (this: Socket, ...args: Parameters<Socket["write"]>) {
      const value = frame(args[0]);
      if (value?.t === "res" && value.id === requestId && value.ok) {
        // Actual broker/storage completed before this real reply. Drop ONLY
        // this fixture ACK, then close; no handler/storage/auth mocking.
        dropped++; this.destroy(); return true;
      }
      return serverWrite.apply(this, args);
    });
    try {
      await expect(client.request("trackedSend", { messageId: id, to: "offline-boundary", body: "durable accepted boundary bytes" }))
        .rejects.toMatchObject({ code: "BROKER_CONNECTION_CLOSED" });
      expect(requestCount).toBe(1); expect(dropped).toBe(1);
    } finally { clientSpy.mockRestore(); serverSpy.mockRestore(); }
    const state = await sender.sendState(id);
    expect(state).toMatchObject({ id, state: "stored", message: { id, to: "offline-boundary", body: "durable accepted boundary bytes" } });
    // Explicit same-ID reconciliation exercises existing durable dedupe, not
    // a production automatic resend or UUID replacement.
    const same = await sender.send({ messageId: id, to: "offline-boundary", body: "durable accepted boundary bytes" }, { quiet: true });
    expect(same.messages.map(message => message.id)).toEqual([id]);
    const recipient = env.node("offline-boundary"); await recipient.start();
    await until(() => recipient.unread().some(message => message.id === id));
    expect(recipient.unread().filter(message => message.id === id)).toHaveLength(1);
  });
  it("SIMULATED unknown creation followed by real auth-ready then broker loss stays latched without second creation", async () => {
    const host = env.node("unknown-established-host");
    const launch = vi.fn(async () => { await host.start(); return { kind: "unknown" as const }; });
    const client = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name: "unknown-client", agent: "codex",
      cwd: env.home, autoWake: false, log: nullLogger, daemon: { cli: "fixture-unused-runtime", launch } }); extra.push(client);
    await client.start(); expect(client.isConnected).toBe(true); expect(client.isBroker).toBe(false); expect(launch).toHaveBeenCalledOnce();
    const disconnected = once(client, "disconnected"); await host.stop(); await disconnected;
    await expect(client.ensureConnected()).rejects.toThrow("could not connect");
    expect(launch).toHaveBeenCalledOnce(); expect(client.isBroker).toBe(false); expect(client.isConnected).toBe(false);
    // A separately authorized existing host can still be discovered; no new
    // daemon creation is inferred from authenticated readiness alone.
    const replacement = env.node("external-established-host"); await replacement.start(); await client.ensureConnected();
    expect(client.isConnected).toBe(true); expect(launch).toHaveBeenCalledOnce();
  });
});
