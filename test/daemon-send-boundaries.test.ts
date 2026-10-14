import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { type Server, type Socket } from "node:net";
import { type DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { BridgeClient, clientConnectionClosedDiagnostic, CLIENT_TRANSPORT_DIAGNOSTIC_EVENT,
  CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT, type ClientConnectionClosedDiagnostic } from "../src/core/client.js";
import { nullLogger } from "../src/core/logger.js";
import type { Logger } from "../src/core/logger.js";
import type { RequestMap } from "../src/core/protocol.js";
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
    let diagnostic: ClientConnectionClosedDiagnostic | undefined, originalError: unknown;
    await expect(client.request("trackedSend", { messageId: id, to: "offline-boundary", body: "definitely not written" }).catch(error => {
      originalError = error; diagnostic = clientConnectionClosedDiagnostic(error); throw error;
    }))
      .rejects.toMatchObject({ code: "BROKER_CONNECTION_CLOSED" });
    expect(diagnostic).toEqual({ phase: "prewrite_closed", operation: "tracked_send", frame_encoded: false, write_call_boundary: "not_reached", write_returned: false });
    expect(clientConnectionClosedDiagnostic({ ...(originalError as Error) })).toBeUndefined();
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
      let diagnostic: ClientConnectionClosedDiagnostic | undefined;
      await expect(client.request("trackedSend", { messageId: id, to: "offline-boundary", body: "durable accepted boundary bytes" }).catch(error => {
        diagnostic = clientConnectionClosedDiagnostic(error); throw error;
      }))
        .rejects.toMatchObject({ code: "BROKER_CONNECTION_CLOSED" });
      expect(requestCount).toBe(1); expect(dropped).toBe(1);
      expect(diagnostic).toEqual({ phase: "pending_close", operation: "tracked_send", frame_encoded: true, write_call_boundary: "reached", write_returned: true });
    } finally { clientSpy.mockRestore(); serverSpy.mockRestore(); }
    const state = await sender.sendState(id);
    expect(state).toMatchObject({ id, state: "stored", message: { id, to: "offline-boundary", body: "durable accepted boundary bytes" } });
    const db = Reflect.get(Reflect.get(broker, "store"), "db") as DatabaseSync;
    const stored = () => db.prepare("SELECT id,recipient,to_target,body FROM messages WHERE id=?").all(id);
    expect(db.isTransaction).toBe(false);
    expect(stored()).toEqual([{ id, recipient: "offline-boundary", to_target: "offline-boundary", body: "durable accepted boundary bytes" }]);
    // Explicit same-ID reconciliation exercises existing durable dedupe, not
    // a production automatic resend or UUID replacement.
    const same = await sender.send({ messageId: id, to: "offline-boundary", body: "durable accepted boundary bytes" }, { quiet: true });
    expect(same.messages.map(message => message.id)).toEqual([id]);
    expect(stored()).toEqual([{ id, recipient: "offline-boundary", to_target: "offline-boundary", body: "durable accepted boundary bytes" }]);
    const recipient = env.node("offline-boundary"); await recipient.start();
    await until(() => recipient.unread().some(message => message.id === id));
    expect(recipient.unread().filter(message => message.id === id)).toHaveLength(1);
  });
  it("SIMULATED encoding failure after pending registration preserves call order and pending_close does not prove a write", async () => {
    const host = env.node("unencoded-host"); await host.start();
    const observations: Array<Record<string, unknown>> = [];
    const log: Logger = { ...nullLogger, info: (event, data) => { if (event === CLIENT_TRANSPORT_DIAGNOSTIC_EVENT && data) observations.push(data); }, child: () => log };
    const client = await BridgeClient.connect(env.pipe, log); await client.request("auth", { token: loadOrCreateToken(env.home) });
    const socket = Reflect.get(client, "socket") as Socket, originalWrite = socket.write, originalDescriptor = Object.getOwnPropertyDescriptor(socket, "write");
    const order: string[] = [], failure = new Error("SIMULATED argument encoding failure"), id = randomUUID(); let actualWrites = 0;
    Object.defineProperty(socket, "write", { configurable: true, get: () => {
      order.push("method_lookup");
      return function(this: Socket, ...args: Parameters<Socket["write"]>) { actualWrites++; return originalWrite.apply(this, args); };
    } });
    const args = { messageId: id, to: "offline-unencoded", body: "Exact unsubmitted bytes" };
    Object.defineProperty(args, "encodingFailure", { enumerable: true, get: () => { order.push("argument_encoding"); throw failure; } });
    try {
      await expect(client.request("trackedSend", args as RequestMap["trackedSend"][0])).rejects.toBe(failure);
      expect(order).toEqual(["method_lookup", "argument_encoding"]); expect(actualWrites).toBe(0);
      expect(clientConnectionClosedDiagnostic(failure)).toBeUndefined();
      expect((Reflect.get(client, "pending") as Map<number, unknown>).size).toBe(1);
    } finally {
      // Restore the exact native method before actual socket disposal; no fake
      // close event, framing or broker/storage acknowledgement is emitted.
      if (originalDescriptor) Object.defineProperty(socket, "write", originalDescriptor);
      else delete (socket as unknown as { write?: Socket["write"] }).write;
      const closed = once(client, "close"); client.close(); await closed;
    }
    expect(observations).toEqual([{ phase: "pending_close", operation: "tracked_send", frame_encoded: false,
      write_call_boundary: "not_reached", write_returned: false, count: 1, overflow: false }]);
    expect(actualWrites).toBe(0);
    const db = Reflect.get(Reflect.get(Reflect.get(host, "broker"), "store"), "db") as DatabaseSync;
    expect(db.prepare("SELECT id FROM messages WHERE id=?").all(id)).toEqual([]);
  });
  it("caps source diagnostics while every real prewrite rejection survives SIMULATED logger failures", async () => {
    const host = env.node("capped-host"); await host.start();
    const observations: Array<Record<string, unknown>> = [], loggerFailure = new Error("SIMULATED diagnostics logger failure");
    const log: Logger = { ...nullLogger, info: (event, data) => {
      if (event === CLIENT_TRANSPORT_DIAGNOSTIC_EVENT && data) { observations.push(data); throw loggerFailure; }
    }, child: () => log };
    const client = await BridgeClient.connect(env.pipe, log); await client.request("auth", { token: loadOrCreateToken(env.home) });
    const socket = Reflect.get(client, "socket") as Socket, closed = once(client, "close"); client.close(); await closed;
    const writes = vi.spyOn(socket, "write"), id = randomUUID();
    const requests = Array.from({ length: CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT + 4 }, () => client.request("trackedSend", { messageId: id, to: "offline-capped", body: "Unwritten capped bytes" }));
    const outcomes = await Promise.allSettled(requests);
    expect(outcomes).toHaveLength(CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT + 4);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({ code: "BROKER_CONNECTION_CLOSED", message: "connection to broker closed" });
        expect(outcome.reason).not.toBe(loggerFailure);
        expect(clientConnectionClosedDiagnostic(outcome.reason)).toMatchObject({ phase: "prewrite_closed", write_call_boundary: "not_reached" });
      }
    }
    expect(writes).not.toHaveBeenCalled(); expect(observations).toHaveLength(CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT);
    expect(observations.map(value => value.count)).toEqual(Array.from({ length: CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT }, (_, n) => n + 1));
    expect(observations.at(-1)?.overflow).toBe(true);
    const db = Reflect.get(Reflect.get(Reflect.get(host, "broker"), "store"), "db") as DatabaseSync;
    expect(db.prepare("SELECT id FROM messages WHERE id=?").all(id)).toEqual([]);
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
