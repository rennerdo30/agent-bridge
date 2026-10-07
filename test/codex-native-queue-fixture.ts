import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo, Socket } from "node:net";
import { expect } from "vitest";
import { resolveBinary } from "../src/core/delegate.js";
import { makeEnv, until } from "./helpers.js";

// Optional installed-CLI acceptance probe. CI still runs the hermetic idle-host regression.
const bin = resolveBinary(process.env.AB_NATIVE_CODEX_BIN ?? "codex");
export const nativeCodexBin = bin;
export async function verifyNativeCodexIdleQueue(role: "main" | "secondary"): Promise<void> {
  const env = makeEnv(), sockets = new Set<Socket>();
  const server = createServer();
  let client: Client | undefined;
  const calls: string[] = [], consumed: string[] = [], errors: unknown[] = [];
  const threadId = "019a0000-0000-7000-8000-000000000001";
  const project = join(env.home, "project"); mkdirSync(project);
  execFileSync("git", ["init", project], { windowsHide: true, stdio: "ignore" });
  const codexHome = join(env.home, "codex"); mkdirSync(codexHome);
  let attached = false, idle = true, accept = true;
  const pending: unknown[] = [];
  const runTui = async () => {
    if (!attached || !idle || !pending.length) return;
    pending.shift(); idle = false;
    try {
      const result: any = await client!.callTool({ name: "inbox", arguments: {}, _meta: { threadId, "codex/sandbox-state-meta": { sandboxCwd: project } } });
      consumed.push(result.content[0].text);
    } catch (e) { errors.push(e); }
    finally { idle = true; }
  };
  server.on("upgrade", (req, socket) => {
    const s = socket as Socket; sockets.add(s); s.on("close", () => sockets.delete(s));
    const key = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    const send = (value: unknown) => {
      const body = Buffer.from(JSON.stringify(value));
      let head = Buffer.from([0x81, body.length]);
      if (body.length >= 126) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(body.length, 2); }
      s.write(Buffer.concat([head, body]));
    };
    s.on("data", chunk => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (buffer.length >= 2) {
        const op = buffer[0]! & 15, masked = buffer[1]! & 128;
        let length = buffer[1]! & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { s.destroy(); return; }
        if (buffer.length < offset + (masked ? 4 : 0) + length) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null; offset += masked ? 4 : 0;
        const body = Buffer.from(buffer.subarray(offset, offset + length)); buffer = buffer.subarray(offset + length);
        if (mask) for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ mask[i % 4]!;
        if (op === 8) { s.end(); return; } if (op !== 1) continue;
        const r = JSON.parse(body.toString()); calls.push(r.method);
        if (r.id === undefined) continue;
        if (r.method === "initialize") send({ id: r.id, result: { userAgent: "idle-app-server-mock", codexHome, platformFamily: process.platform === "win32" ? "windows" : "unix", platformOs: process.platform } });
        else if (r.method === "thread/queue/add" && accept) {
          expect(r.params.threadId).toBe(threadId);
          expect(r.params.input[0].text).toContain("new message(s)");
          expect(r.params.clientUserMessageId).toBeTruthy();
          pending.push(r.params.input);
          send({ id: r.id, result: { queuedSubmission: { id: `queue-${pending.length}`, input: r.params.input, clientUserMessageId: r.params.clientUserMessageId } } });
          // Queue acceptance and an attached TUI starting a turn are separate events.
          void runTui();
        } else send({ id: r.id, error: { code: -32601, message: "thread/queue/add unsupported" } });
      }
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const sender = env.node("sender", "other"); await sender.start();
    if (role === "secondary") { const main = env.node("main", "claude"); await main.relocate(project); await main.start(); }
    client = new Client({ name: "native-queue-fixture", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../plugins/codex/dist/server.mjs"), "--agent=codex"], env: {
      ...process.env, CODEX_HOME: codexHome, AGENT_BRIDGE_HOME: env.home, CLAUDE_PROJECT_DIR: project, AGENT_BRIDGE_NAME: "idle-codex", AGENT_BRIDGE_CODEX_BIN: bin!,
      AGENT_BRIDGE_CODEX_WAKE_REMOTE: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, AGENT_BRIDGE_AUTO_WAKE: "off", AGENT_BRIDGE_WAKE_ON_DIRECT: "on", AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_LINGER_SEC: "0",
    } as Record<string, string>, stderr: "ignore" }));
    await client.callTool({ name: "peers", arguments: {}, _meta: { threadId } });
    const first = await sender.send({ to: "idle-codex", body: "ACCEPTED_WHILE_DETACHED" });
    await until(() => pending.length === 1).catch(e => { throw new Error(`Queue probe failed: calls=${calls.join(",")} binary=${bin}`, {cause:e}); });
    expect(consumed).toEqual([]); expect((await sender.messageReceipt(first.messages[0]!.id))[0]!.readAt).toBeNull();
    attached = true; await runTui();
    await until(() => consumed.length === 1);
    expect(consumed[0]).toContain("ACCEPTED_WHILE_DETACHED");
    const second = await sender.send({ to: "idle-codex", body: "SECOND_IDLE_WAKE" });
    await until(() => consumed.length === 2);
    expect(consumed[1]).toContain("SECOND_IDLE_WAKE");
    const receiptDeadline = Date.now() + 5_000;
    while ((await sender.messageReceipt(second.messages[0]!.id))[0]!.readAt === null) {
      if (Date.now() >= receiptDeadline) throw new Error("Attached TUI did not acknowledge its consumed bridge mail");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    accept = false;
    const rejected = await sender.send({ to: "idle-codex", body: "UNSUPPORTED_QUEUE" });
    await until(() => calls.filter(m => m === "thread/queue/add").length === 3);
    expect((await sender.messageReceipt(rejected.messages[0]!.id))[0]!.readAt).toBeNull();
    expect(consumed).toHaveLength(2); expect(errors).toEqual([]);
  } finally {
    await client?.close(); for (const s of sockets) s.destroy();
    await new Promise<void>(resolve => server.close(() => resolve())); await env.cleanup();
  }
}
