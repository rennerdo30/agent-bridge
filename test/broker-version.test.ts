import { createServer, type Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { FrameDecoder, encodeFrame } from "../src/core/protocol.js";
import { APP_VERSION, MAX_FRAME_BYTES } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
it.each([undefined, "0.29.10"])("reports a clear version message for an old broker (%s) without applying handoff", async (brokerVersion) => {
  const sockets = new Set<Socket>(), operations: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket); socket.setEncoding("utf8");
    const decoder = new FrameDecoder(MAX_FRAME_BYTES);
    socket.on("data", (data: string) => {
      for (const frame of decoder.push(data)) if (frame.t === "req") {
        operations.push(frame.op);
        socket.write(encodeFrame(frame.op === "hello" ? { t: "res", id: frame.id, ok: true, result: { name: "supervisor", brokerPid: 1, brokerVersion, peers: [] } } :
          { t: "res", id: frame.id, ok: false, error: { code: "bad_request", message: `unknown op: ${frame.op}` } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => { for (const socket of sockets) socket.destroy(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address() as { port: number };
  // BridgeClient accepts native socket endpoints as well as named pipes.
  const client = await BridgeClient.connect({ host: "127.0.0.1", port: address.port } as unknown as string, nullLogger);
  cleanup.push(() => client.close());
  await client.request("hello", { protocol: 1, token: "fixture", peer: { id: "fixture", name: "supervisor", agent: "codex", cwd: "/fixture", pid: 1, agentPid: null, sessionId: null, startedAt: 1, autoWake: false } });
  for (const op of ["jobAuthority", "handoffSubagents"] as const) {
    const result = client.request(op, op === "jobAuthority" ? { job: "codex-job-one" } : { to: "recipient", jobs: "all" });
    await expect(result).rejects.toMatchObject({ code: "protocol_mismatch" });
    await expect(result).rejects.toThrow(`required by server v${APP_VERSION}`);
    await expect(result).rejects.toThrow(brokerVersion ? `Broker v${brokerVersion}` : "version unknown");
  }
  expect(operations).toEqual(["hello", "jobAuthority", "handoffSubagents"]);
});
