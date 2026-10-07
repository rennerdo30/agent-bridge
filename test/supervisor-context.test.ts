import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { BridgeNode } from "../src/core/node.js";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { ParentLink } from "../src/core/parent-link.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { SiblingLink } from "../src/mcp/siblings.js";
import type { Job } from "../src/mcp/jobs.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
let env: TestEnv;
let cleanups: (() => unknown | Promise<unknown>)[];
beforeEach(() => { env = makeEnv(); cleanups = []; });
afterEach(async () => {
  for (const close of cleanups.reverse()) await close();
  await env.cleanup();
});
const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");
const call = async (c: Client, name: string, args = {}) => textOf(await c.callTool({ name, arguments: args }));
async function connect(agent: string, name: string, extra = {}) {
  const c = new Client({ name: "context-scenario", version: "1" });
  cleanups.push(() => c.close());
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, `--agent=${agent}`],
    env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_DELIVERY: "hooks",
      AGENT_BRIDGE_WAKE_ON_DIRECT: "off", AGENT_BRIDGE_AUTO_WAKE: "off", AGENT_BRIDGE_DASHBOARD: "off",
      AGENT_BRIDGE_LINGER_SEC: "0", AGENT_BRIDGE_DELEGATE_DEPTH: "0", ...extra } as Record<string, string>, stderr: "ignore" }));
  await call(c, "peers");
  return c;
}
async function runner(id: string, agent: "codex" | "opencode", supervisor: string) {
  const job: Job = { id, name: `${agent}-job-${id}`, agent, model: null, prompt: "fixture", startedAt: Date.now(),
    controller: new AbortController(), status: "running", sessionId: null, workdir: null, worktree: null, progress: null, queue: [] };
  const node = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name: job.name,
    agent: "other", jobAgent: agent, jobOwner: "supervisor-session", jobParent: supervisor, id: `job:${id}`,
    cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
  cleanups.push(() => node.stop());
  await node.start();
  const chat = new SiblingLink(node, job, 32, nullLogger);
  const parent = new ParentLink(supervisor, () => {}, nullLogger, undefined, chat);
  cleanups.push(() => chat.close(), () => parent.close());
  await parent.start();
  job.live = { post: (body, message) => parent.post(body, message) };
  return { node, job, parent };
}

it.each(["claude", "codex", "opencode"])("keeps sibling observer copies out of the %s supervisor MCP hooks", async (agent) => {
  const sup = await connect(agent, "supervisor");
  await call(sup, "hook_event", { event: "SessionStart", session_id: "supervisor-session" });
  const notifications: string[] = [];
  sup.setNotificationHandler(z.object({ method: z.literal("notifications/agent-bridge/message"), params: z.any() }),
    (n) => { notifications.push(JSON.stringify(n.params)); });
  const a = await runner("a", "codex", "supervisor");
  const b = await runner("b", "opencode", "supervisor");
  const child = await connect("codex", "child", { ...a.parent.childEnv(), AGENT_BRIDGE_DELEGATE_DEPTH: "1" });
  const sent = await call(child, "send", { to: b.job.name, message: "SIBLING_ONLY_SECRET" });
  const id = /Message (\S+) sent/.exec(sent)![1]!;
  await until(() => b.node.hasSeen(id));
  // The receiver really gets the message through its delegated MCP hook.
  const recipient = await connect("opencode", "receiver", { ...b.parent.childEnv(), AGENT_BRIDGE_DELEGATE_DEPTH: "1" });
  expect(await call(recipient, "hook_event", { event: "PostToolUse" })).toContain("SIBLING_ONLY_SECRET");
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    expect(await call(sup, "hook_event", { event, session_id: "supervisor-session" })).not.toContain("SIBLING_ONLY_SECRET");
  }
  expect(notifications).toEqual([]);
  expect(await call(sup, "inbox", { mark_read: false })).toContain("SIBLING_ONLY_SECRET");
  await a.node.send({ to: "supervisor", conversationId: "job-a", body: "REAL_COMPLETION" });
  // No jobs are owned by this MCP manager and global/direct wake are disabled.
  expect(await call(sup, "hook_event", { event: "Stop" })).toContain("REAL_COMPLETION");
  expect(await call(sup, "inbox", { mark_read: false })).not.toContain("REAL_COMPLETION");
});

it("drains 550 queued results across the replay limit while retaining 159 quiet copies", async () => {
  const store = new MessageStore(env.db, nullLogger);
  try {
    for (let i = 0; i < 709; i++) {
      const quiet = i < 159;
      store.insert({ id: randomUUID(), recipient: "supervisor", to: "supervisor", from: { id: `job:${i}`, name: `codex-job-${i}`, agent: "codex" },
        body: quiet ? `OBSERVER_${i}` : `RESULT_${i - 159}_END`, conversationId: quiet ? `siblings-${i}:note` : `job-${i}`,
        replyTo: null, hop: 0, createdAt: Date.now() + i, readAt: null });
    }
  } finally { store.close(); }
  const sup = await connect("opencode", "supervisor");
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const text = await call(sup, "hook_event", { event: "PostToolUse" });
    expect(text).not.toContain("OBSERVER_");
    for (const result of text.matchAll(/RESULT_(\d+)_END/g)) {
      expect(seen.has(result[1]!)).toBe(false);
      seen.add(result[1]!);
    }
    if (seen.size === 550) break;
  }
  expect(seen.size).toBe(550);
  expect(await call(sup, "peers")).toContain("159 retained quiet");
  const explicit = await call(sup, "inbox", { limit: 100, mark_read: false });
  expect(explicit).toContain("OBSERVER_0");
  expect(explicit).toContain("OBSERVER_99");
});

it("warns the supervisor when aggregate jobs exceed the measured broker load", async () => {
  const sup = await connect("opencode", "supervisor");
  expect(await call(sup, "peers")).not.toContain("Broker load warning");
  for (let i = 0; i < 51; i++) {
    const client = await BridgeClient.connect(env.pipe, nullLogger);
    cleanups.push(() => client.close());
    await client.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: {
      id: `job:load-${i}`, name: `codex-job-load-${i}`, agent: "other", jobAgent: "codex", cwd: env.home,
      pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false,
    } });
  }
  const warning = await call(sup, "peers");
  expect(warning).toContain("Broker load warning: 51 jobs are connected");
  expect(warning).toContain("load check covered 50");
});

it("delivers a final result ahead of more than500 retained job status notes", async () => {
  const store = new MessageStore(env.db, nullLogger);
  try {
    for (let i = 0; i <= 600; i++) store.insert({ id: randomUUID(), recipient: "supervisor", to: "supervisor",
      from: { id: `job:${i}`, name: `opencode-job-${i}`, agent: "opencode" }, replyTo: null, hop: 0,
      conversationId: i < 600 ? `job-${i}:note` : "job-600", body: i < 600 ? `STATUS_${i}` : "FINAL_AFTER_NOTES", createdAt: Date.now() + i, readAt: null });
  } finally { store.close(); }
  const sup = await connect("claude", "supervisor");
  const stopped = await call(sup, "hook_event", { event: "Stop" });
  expect(stopped).toContain("FINAL_AFTER_NOTES");
  expect(stopped).not.toContain("STATUS_");
  expect(await call(sup, "inbox", { limit: 100, mark_read: false })).toContain("STATUS_0");
});
