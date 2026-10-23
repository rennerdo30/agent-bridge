import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { deliveryFailure } from "../src/mcp/delivery-evidence.js";
import { makeEnv } from "./helpers.js";

const connect = vi.hoisted(() => vi.fn());
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(), connect }));

it("aborts its actual pending socket without admitting a late connection or retaining a handle", async () => {
  const env = makeEnv(), stop = new AbortController(), effect = vi.fn();
  const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(() => { socket.emit("close"); }) });
  connect.mockReturnValue(socket);
  try {
    const pending = BridgeClient.connect(env.pipe, nullLogger, 300, { readOnlyDirectory: true, signal: stop.signal });
    const settled = pending.then(effect, error => error); stop.abort();
    expect(await settled).toMatchObject({ name: "AbortError" }); expect(socket.destroy).toHaveBeenCalledOnce();
    socket.emit("connect"); expect(effect).not.toHaveBeenCalled();
  } finally { await env.cleanup(); }
});

it("keeps real parsed refusal frames and connection generations distinct without sending mail", async () => {
  const env = makeEnv(), operations: string[] = [], observations: unknown[] = [];
  const log = { ...nullLogger, info: (event: string, data?: unknown) => { if (event === "client protocol refusal observation") observations.push(data); } };
  connect.mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), { setEncoding() {}, end() {}, destroy() { socket.emit("close"); },
      write(frame: string) {
        const request = JSON.parse(frame); operations.push(request.op);
        const error = request.op === "sendState" ? { code: "bad_request", message: "unknown op: sendState" } :
          { code: "protocol_mismatch", message: "broker speaks protocol 5; PRIVATE_ERROR_TOKEN", details: { brokerProtocol: 5 } };
        queueMicrotask(() => socket.emit("data", JSON.stringify({ t: "res", id: request.id, ok: false, error }) + "\n")); return true;
      } });
    queueMicrotask(() => socket.emit("connect")); return socket;
  });
  const clients: BridgeClient[] = [];
  let firstGeneration: number | undefined;
  try {
    for (const op of ["auth", "sendState"] as const) {
      const client = await BridgeClient.connect(env.pipe, log); clients.push(client);
      let refusal: unknown;
      try {
        if (op === "auth") await client.request("auth", { protocol: PROTOCOL_VERSION, token: "isolated-fixture" });
        else await client.request("sendState", { id: "11111111-1111-4111-8111-111111111111" });
      }
      catch (error) { refusal = error; }
      const evidence = deliveryFailure(refusal);
      expect(evidence).toMatchObject({ code: "protocol_mismatch", reason: "protocol-refusal", protocol: {
        source: op === "auth" ? "version" : "unsupported-operation", operation: op === "auth" ? "auth_hello" : "status_read", clientProtocol: PROTOCOL_VERSION,
      } });
      expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE_ERROR_TOKEN|isolated-fixture/);
      const generation = evidence.protocol!.connectionGeneration!;
      expect(generation).toBeGreaterThan(0);
      if (op === "auth") firstGeneration = generation;
      else expect(generation).not.toBe(firstGeneration);
    }
    expect(operations).toEqual(["auth", "sendState"]);
    expect(observations).toHaveLength(2);
    expect(JSON.stringify(observations)).not.toMatch(/PRIVATE_ERROR_TOKEN|isolated-fixture|broker speaks|details/);
  } finally { clients.forEach(client => client.close()); await env.cleanup(); }
});
