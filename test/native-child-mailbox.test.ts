import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";
import { ClaudeMailScopes } from "../src/mcp/claude-mail-scope.js";
import { RewakeEndpoint, sessionFile } from "../src/mcp/rewake.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv, ctx: ServerContext;
let handlers: Map<string, (a: any, extra: any) => Promise<any>>;
let endpoint: RewakeEndpoint | undefined;
let mcpClient: Client | undefined, mcpServer: McpServer | undefined;
const agentId = "native-reviewer";
const call = (name: string, args = {}, meta?: Record<string, unknown>) =>
  handlers.get(name)!(args, { signal: new AbortController().signal, _meta: meta });
beforeEach(async () => {
  env = makeEnv();
  const node = env.node("claude-parent");
  await node.setSessionId("parent-session"); await node.start();
  ctx = { agent: "claude", node, home: env.home, cfg: DEFAULT_CONFIG, log: nullLogger,
    cwd: () => env.home, channelActive: () => false, observeMeta: vi.fn() };
  handlers = new Map();
  registerTools({ registerTool: (name: string, spec: any, fn: any) => handlers.set(name, (args, extra) => fn(z.object(spec.inputSchema ?? {}).parse(args), extra)) } as any, ctx, []);
});
afterEach(async () => {
  await mcpClient?.close(); await mcpServer?.close(); mcpClient = undefined; mcpServer = undefined;
  await endpoint?.stop(); endpoint = undefined; await env.cleanup(); vi.restoreAllMocks();
});

async function parentMail() {
  const sender = env.node("sender", "codex"); await sender.start();
  const message = (await sender.send({ to: ctx.node!.name, body: "Private parent message" })).messages[0]!;
  await until(() => ctx.node!.unread().some(m => m.id === message.id));
  return { sender, message };
}
async function childStart() {
  await buildHookResponse(ctx, { event: "SubagentStart", subagent: true, agentId,
    sessionId: "parent-session", stopHookActive: false });
}

it("an unscoped native-child inbox cannot see or consume parent mail, which parent hooks still deliver", async () => {
  await childStart();
  const { sender, message } = await parentMail();
  const result = await call("inbox");
  expect(JSON.stringify(result)).not.toContain(message.body);
  expect(ctx.node!.unread()).toContainEqual(expect.objectContaining({ id: message.id }));
  expect((await sender.messageReceipt(message.id))[0]?.readAt).toBeNull();
  const parentHook = await buildHookResponse(ctx, { event: "PostToolUse", sessionId: "parent-session", stopHookActive: false });
  expect(JSON.stringify(parentHook)).toContain(message.body);
});

it.each(["wait_for_message", "get_conversation"])("legacy ambiguous %s never enters a parent mail handler", async name => {
  await childStart();
  const { message } = await parentMail();
  const history = vi.spyOn(ctx.node!, "getConversation");
  const result = await call(name, name === "get_conversation" ? { id: message.conversationId } : {});
  expect(JSON.stringify(result)).not.toContain(message.body);
  expect(history).not.toHaveBeenCalled();
  expect(ctx.node!.unread()).toContainEqual(expect.objectContaining({ id: message.id }));
});

it("legacy parents retain ordinary inbox access when no native child is live", async () => {
  const { message } = await parentMail();
  expect(JSON.stringify(await call("inbox"))).toContain(message.body);
  expect(ctx.node!.unread().some(m => m.id === message.id)).toBe(false);
});

it("legacy explicitly scoped native inbox still reads only the live child's mail", async () => {
  await childStart();
  const { sender, message } = await parentMail();
  const child = (await ctx.node!.send({ to: `${ctx.node!.name}/sub:${agentId}`, body: "Child-only message" })).messages[0]!;
  expect(JSON.stringify(await call("inbox", { mark_read: false }))).not.toContain(message.body);
  const result = await call("inbox", { native_child: agentId });
  expect(JSON.stringify(result)).toContain(child.body);
  expect(JSON.stringify(result)).not.toContain(message.body);
  expect((await sender.messageReceipt(message.id))[0]?.readAt).toBeNull();
  expect(await ctx.node!.nativeChildPending(agentId)).toEqual([]);
});

it.each(["inbox", "wait_for_message", "get_conversation"])("mod-capable %s refuses missing/forged identity before any parent effects", async name => {
  ctx.claudeMailScopes!.capable = true;
  await childStart();
  const { sender, message } = await parentMail();
  const history = vi.spyOn(ctx.node!, "getConversation");
  const wait = vi.spyOn(ctx.node!, "waitForMessage");
  const args = name === "get_conversation" ? { id: message.conversationId } : {};
  for (const meta of [undefined, { agent_id: agentId }, { sessionId: "parent-session" }]) {
    const result = await call(name, args, meta);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(message.body);
  }
  expect((await call(name, { ...args, _bridge_scope: "forged" })).isError).toBe(true);
  if (name === "inbox") expect((await call(name, { native_child: agentId })).isError).toBe(true);
  expect(history).not.toHaveBeenCalled(); expect(wait).not.toHaveBeenCalled();
  expect(ctx.observeMeta).not.toHaveBeenCalled();
  expect(ctx.node!.unread()).toContainEqual(expect.objectContaining({ id: message.id }));
  expect((await sender.messageReceipt(message.id))[0]?.readAt).toBeNull();
});

/** Real authenticated endpoint + actual host-mod middleware + registered MCP handler. */
async function hostMod() {
  mcpServer = new McpServer({ name: "claude-mail-fixture", version: "1" });
  registerTools(mcpServer, ctx, []);
  mcpClient = new Client({ name: "host-mod-fixture", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport); await mcpClient.connect(clientTransport);
  endpoint = new RewakeEndpoint(env.home, ctx.node!, () => false, nullLogger, undefined, ctx.claudeMailScopes);
  await endpoint.start(); endpoint.register("parent-session");
  const modulePath = "../plugins/claude/hooks/mail-scope.ts";
  const { register } = await import(modulePath);
  const hooks = new Map<string, any>();
  register(((name: string, ...rest: any[]) => hooks.set(name, rest.at(-1))) as any);
  const engine = { session: { id: async () => "parent-session" }, env: { get: async (name: string) => name === "AGENT_BRIDGE_HOME" ? env.home : "" },
    fs: { read: async (path: string) => readFileSync(path, "utf8") },
    http: { fetch: async (url: string, init: RequestInit) => { const r = await fetch(url, init); return { ok: r.ok, text: await r.text() }; } },
    // No real host timeout is needed around these bounded loopback fixture requests.
    clock: { sleep: async () => new Promise(() => {}) } };
  await hooks.get("session.start")(engine, {}, async (e: any) => e);
  expect(ctx.claudeMailScopes!.capable).toBe(true);
  return (tool: string, args: Record<string, unknown> = {}, nativeId?: string) => hooks.get("tool.call")(engine,
    { tool: `mcp__plugin_agent-bridge_bridge__${tool}`, tool_use_id: "host-call", ...args, agentId: nativeId },
    async (e: any) => { const { tool: _tool, tool_use_id: _id, agentId: _agent, ...input } = e; return mcpClient!.callTool({ name: tool, arguments: input }); });
}

it("parent inbox, wait and history work end to end through current-host authentication", async () => {
  const host = await hostMod();
  await childStart();
  const first = await parentMail();
  expect(JSON.stringify(await host("inbox", { _bridge_scope: "model-forged" }))).toContain(first.message.body);
  // markRead batches broker acknowledgements; refreshPending explicitly flushes that batch.
  await ctx.node!.refreshPending();
  expect(await first.sender.messageReceipt(first.message.id)).toContainEqual(expect.objectContaining({ recipient: ctx.node!.name, readAt: expect.any(Number) }));
  const second = await parentMail();
  expect(JSON.stringify(await host("wait_for_message"))).toContain(second.message.body);
  await ctx.node!.refreshPending();
  expect(await second.sender.messageReceipt(second.message.id)).toContainEqual(expect.objectContaining({ recipient: ctx.node!.name, readAt: expect.any(Number) }));
  const history = vi.spyOn(ctx.node!, "getConversation").mockResolvedValue({ conversation: null, records: [], next: null });
  expect((await host("get_conversation", { id: "parent-history" })).isError).not.toBe(true);
  expect(history).toHaveBeenCalledWith({ id: "parent-history" });
});

it("host agentId scopes an unlabelled child inbox and prevents forged parent or sibling claims", async () => {
  const host = await hostMod();
  await childStart();
  const { sender, message } = await parentMail();
  const child = (await ctx.node!.send({ to: `${ctx.node!.name}/sub:${agentId}`, body: "Native private task" })).messages[0]!;
  const result = await host("inbox", {}, agentId);
  expect(JSON.stringify(result)).toContain(child.body);
  expect(JSON.stringify(result)).not.toContain(message.body);
  expect(await ctx.node!.nativeChildPending(agentId)).toEqual([]);
  expect((await sender.messageReceipt(message.id))[0]?.readAt).toBeNull();
  await ctx.node!.nativeChild({ action: "start", agentId: "sibling" });
  const sibling = (await ctx.node!.send({ to: `${ctx.node!.name}/sub:sibling`, body: "Sibling-only message" })).messages[0]!;
  const next = (await ctx.node!.send({ to: `${ctx.node!.name}/sub:${agentId}`, body: "Explicitly scoped child message" })).messages[0]!;
  const explicit = await host("inbox", { native_child: agentId }, agentId);
  expect(JSON.stringify(explicit)).toContain(next.body);
  expect(JSON.stringify(explicit)).not.toContain(message.body);
  expect(JSON.stringify(explicit)).not.toContain(sibling.body);
  expect(await ctx.node!.nativeChildPending("sibling")).toContainEqual(expect.objectContaining({ id: sibling.id }));
  expect((await host("inbox", { native_child: "sibling" }, agentId)).isError).toBe(true);
  expect((await host("inbox", { native_child: agentId })).isError).toBe(true);
  expect((await host("inbox", {}, "not-started")).isError).toBe(true);
  for (const tool of ["get_conversation", "wait_for_message"]) {
    expect((await host(tool, tool === "get_conversation" ? { id: message.conversationId } : {}, agentId)).isError).toBe(true);
  }
  expect(ctx.node!.unread()).toContainEqual(expect.objectContaining({ id: message.id }));
});

it("scope tokens are one-use, short-lived and bound to the session, tool and server instance", () => {
  let now = 1;
  const scopes = new ClaudeMailScopes(() => now);
  const issue = () => scopes.issue("inbox", "parent-session", agentId);
  const token = issue();
  expect(scopes.take(token, "inbox", "parent-session")).toMatchObject({ agentId });
  expect(() => scopes.take(token, "inbox", "parent-session")).toThrow(/scope/);
  const wrongTool = issue();
  expect(() => scopes.take(wrongTool, "get_conversation", "parent-session")).toThrow(/scope/);
  expect(() => scopes.take(wrongTool, "inbox", "parent-session")).toThrow(/scope/);
  expect(() => scopes.take(issue(), "inbox", "changed-session")).toThrow(/scope/);
  expect(() => new ClaudeMailScopes().take(issue(), "inbox", "parent-session")).toThrow(/scope/);
  const expired = issue(); now += 10_000;
  expect(() => scopes.take(expired, "inbox", "parent-session")).toThrow(/scope/);
});

it("host scope endpoint rejects unauthenticated, stale-session and retired requests", async () => {
  await hostMod();
  const reg = JSON.parse(readFileSync(sessionFile(env.home, "parent-session"), "utf8"));
  const url = `http://127.0.0.1:${reg.port}/mail-scope?tool=inbox&session_id=`;
  expect((await fetch(`${url}parent-session`, { method: "POST" })).status).toBe(403);
  const init = { method: "POST", headers: { authorization: `Bearer ${reg.secret}` } };
  expect((await fetch(`${url}foreign`, init)).status).toBe(409);
  endpoint!.retire();
  expect((await fetch(`${url}parent-session`, init)).status).toBe(409);
});

it("tokens are stripped before server logs, broker arguments and tool responses", async () => {
  const debug = vi.spyOn(ctx.log, "debug");
  const token = ctx.claudeMailScopes!.issue("get_conversation", "parent-session");
  const history = vi.spyOn(ctx.node!, "getConversation").mockResolvedValue({ conversation: null, records: [], next: null });
  const result = await call("get_conversation", { id: "retained", _bridge_scope: token });
  expect(result.isError).not.toBe(true);
  expect(history).toHaveBeenCalledWith({ id: "retained" });
  expect(JSON.stringify(debug.mock.calls)).not.toContain(token);
  expect(JSON.stringify(result)).not.toContain(token);
  expect((await call("inbox", { _bridge_scope: token })).isError).toBe(true);
});

it("a stopped child cannot use a previously issued scope to consume returned mail", async () => {
  await childStart();
  const child = (await ctx.node!.send({ to: `${ctx.node!.name}/sub:${agentId}`, body: "Returned child message" })).messages[0]!;
  const token = ctx.claudeMailScopes!.issue("inbox", "parent-session", agentId);
  await ctx.node!.nativeChild({ action: "end", agentId });
  const result = await call("inbox", { _bridge_scope: token });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain(child.body);
  await ctx.node!.refreshPending();
  expect(ctx.node!.unread()).toContainEqual(expect.objectContaining({ id: child.id, readAt: null }));
});
