import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { JobManager } from "../src/mcp/jobs.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";
import { makeEnv, until } from "./helpers.js";

it("keeps a completion unread if a Stop hand-out fails, then receipts it after a model step", async () => {
  const env = makeEnv();
  const node = env.node("claude-final", "claude");
  await node.start();
  const jobs = new JobManager(node, nullLogger);
  const ctx: ServerContext = {
    agent: "claude", cfg: { ...DEFAULT_CONFIG, lingerSec: 0 }, node, log: nullLogger,
    home: env.home, cwd: () => env.home, channelActive: () => false, jobs,
  };
  try {
    jobs.start("codex", null, "review", async () => ({ sessionId: "review-1", text: "Final review", isError: false, details: {} }));
    await until(() => node.unread().some(m => m.body.includes("Final review")));
    const id = node.unread().find(m => m.body.includes("Final review"))!.id;
    const first = await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false });
    expect(first).toMatchObject({ decision: "block" });
    expect(node.unread().some(m => m.id === id)).toBe(true);
    await buildHookResponse(ctx, { event: "StopFailure", sessionId: null, stopHookActive: false });
    expect(node.unread().some(m => m.id === id)).toBe(true);
    const retry = await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false });
    expect(retry).toMatchObject({ decision: "block" });
    await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: true });
    expect(node.unread().some(m => m.id === id)).toBe(false);
  } finally { jobs.cancelAll(); await env.cleanup(); }
});

it("keeps PostToolUse completions pending through parallel tools, inbox and waits until Stop", async () => {
  const env = makeEnv();
  const node = env.node("claude-parallel-final", "claude");
  await node.start();
  const jobs = new JobManager(node, nullLogger);
  const ctx: ServerContext = { agent: "claude", cfg: { ...DEFAULT_CONFIG, lingerSec: 0 }, node, log: nullLogger,
    home: env.home, cwd: () => env.home, channelActive: () => false, jobs };
  const server = new McpServer({ name: "test", version: "1" });
  registerTools(server, ctx, []);
  const client = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }> }).content
      .map(part => part.type === "text" ? part.text : "").join("\n");
  try {
    // claimTurn bumps startedAt one ms past creation; a result in that same ms would fall before its own turn's receipt window.
    const first = jobs.start("codex", null, "first review", async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { sessionId: "one", text: "First final review", isError: false, details: {} };
    });
    await until(() => node.unread().some(m => m.body.includes("First final review")));
    const firstId = node.unread().find(m => m.body.includes("First final review"))!.id;
    expect(JSON.stringify(await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false }))).toContain("First final review");
    expect(await call("inbox")).not.toContain("First final review");
    expect(await call("wait_for_message", { from: first.name, mode: "notify" })).not.toContain("First final review");
    expect(JSON.parse(await call("peers", { job: first.name }))).toMatchObject({ resultStored: true, delivery: "result stored, not delivered", report: expect.stringContaining("First final review") });
    expect(await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false })).toEqual({});
    expect(node.unread().some(m => m.id === firstId)).toBe(true);

    jobs.start("codex", null, "second review", async () => ({ sessionId: "two", text: "Second final review", isError: false, details: {} }));
    await until(() => node.unread().some(m => m.body.includes("Second final review")));
    const secondId = node.unread().find(m => m.body.includes("Second final review"))!.id;
    const second = await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false });
    expect(JSON.stringify(second)).toContain("Second final review");
    expect(JSON.stringify(second)).not.toContain("First final review");
    expect(await call("inbox", { mark_read: false })).not.toContain("Second final review");
    expect(node.unread().some(m => m.id === firstId || m.id === secondId)).toBe(true);
    await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false });
    expect(node.unread().some(m => m.id === firstId || m.id === secondId)).toBe(false);
    expect(JSON.parse(await call("peers", { job: first.name }))).toMatchObject({ delivery: "delivered", receipt: { status: "read" } });
  } finally { jobs.cancelAll(); await client.close(); await server.close(); await env.cleanup(); }
});

it("receipts a Stop hand-out at the next model boundary without stop_hook_active (opencode, Esc)", async () => {
  const env = makeEnv();
  const node = env.node("opencode-final", "opencode");
  await node.start();
  const jobs = new JobManager(node, nullLogger);
  const ctx: ServerContext = {
    agent: "opencode", cfg: { ...DEFAULT_CONFIG, lingerSec: 0 }, node, log: nullLogger,
    home: env.home, cwd: () => env.home, channelActive: () => false, jobs,
  };
  const handOut = async (text: string) => {
    jobs.start("codex", null, text, async () => ({ sessionId: text, text, isError: false, details: {} }));
    await until(() => node.unread().some(m => m.body.includes(text)));
    const id = node.unread().find(m => m.body.includes(text))!.id;
    expect(JSON.stringify(await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false }))).toContain(text);
    expect(node.unread().some(m => m.id === id)).toBe(true);
    return id;
  };
  try {
    // The continuation's own Stop never carries stop_hook_active in opencode.
    const first = await handOut("Opencode continuation review");
    await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false });
    expect(node.unread().some(m => m.id === first)).toBe(false);
    // The continuation called a tool.
    const second = await handOut("Opencode tool review");
    await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false });
    expect(node.unread().some(m => m.id === second)).toBe(false);
    // Esc ended the continuation; the next prompt is the later boundary.
    const third = await handOut("Interrupted continuation review");
    await buildHookResponse(ctx, { event: "UserPromptSubmit", sessionId: null, stopHookActive: false });
    expect(node.unread().some(m => m.id === third)).toBe(false);
  } finally { jobs.cancelAll(); await env.cleanup(); }
});
