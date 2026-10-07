import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { registerTools } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

it.each(["claude", "codex", "opencode", "antigravity"] as const)("%s can confirm and retry a durable send through MCP", async agent => {
  const sender = env.node("sender", agent), recipient = env.node("recipient", agent);
  await sender.start(); await recipient.start();
  const server = new McpServer({ name: "test", version: "1" });
  registerTools(server, { node: sender, home: env.home, cfg: DEFAULT_CONFIG, agent, log: nullLogger, cwd: () => env.home, channelActive: () => false }, []);
  const client = new Client({ name: "test", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const id = randomUUID(), args = { to: recipient.name, message: "Durable tool send", message_id: id };
    const content = (r: any) => r.content.map((c: any) => c.text).join("\n");
    const sent = content(await client.callTool({ name: "send", arguments: args }));
    expect(sent).toContain(`Message ${id} is stored in the broker`);
    const status = JSON.parse(content(await client.callTool({ name: "send_status", arguments: { message_id: id } })));
    expect(status).toMatchObject({ id, state: "stored", receipts: [{ recipient: recipient.name, readAt: null }] });
    expect(content(await client.callTool({ name: "send", arguments: args }))).toContain("no additional message sent");
    await until(() => recipient.unread().length === 1);
    recipient.markRead([id]);
    await recipient.send({ to: sender.name, body: "Consumed" });
    await expect.poll(async () => JSON.parse(content(await client.callTool({ name: "send_status", arguments: { message_id: id } }))).receipts[0].readAt).not.toBeNull();
  } finally { await client.close(); await server.close(); }
});
