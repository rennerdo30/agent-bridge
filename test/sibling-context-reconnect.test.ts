import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
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
    env: { ...process.env, AGENT_BRIDGE_HOME: env.home, CLAUDE_PROJECT_DIR: env.home, CODEX_HOME: join(env.home, "codex-fixture"), CLAUDE_CONFIG_DIR: join(env.home, "claude-fixture"), XDG_DATA_HOME: join(env.home, "xdg-fixture"), AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_DELIVERY: "hooks",
      AGENT_BRIDGE_WAKE_ON_DIRECT: "off", AGENT_BRIDGE_AUTO_WAKE: "off", AGENT_BRIDGE_DASHBOARD: "off",
      AGENT_BRIDGE_LINGER_SEC: "0", AGENT_BRIDGE_DELEGATE_DEPTH: "0", ...extra } as Record<string, string>, stderr: "ignore" }));
  await call(c, "peers");
  return c;
}
async function runner(id: string, agent: "codex" | "opencode", supervisor: string, replayId?: string) {
  const job: Job = { id, name: `${agent}-job-${id}`, agent, model: null, prompt: "fixture", startedAt: Date.now(),
    controller: new AbortController(), status: "running", sessionId: null, workdir: null, worktree: null, progress: null, queue: [] };
  const node = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name: job.name,
    agent: "other", jobAgent: agent, jobOwner: "supervisor-session", jobParent: supervisor, id: `job:${id}`,
    cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
  cleanups.push(() => node.stop());
  await node.start();
  // Exercise replay arriving before the resumed task has its live parent link.
  if (replayId) await until(() => node.hasSeen(replayId));
  const chat = new SiblingLink(node, job, 32, nullLogger);
  const parent = new ParentLink(supervisor, () => {}, nullLogger, undefined, chat);
  cleanups.push(() => chat.close(), () => parent.close());
  await parent.start();
  job.live = { post: (body, message) => parent.post(body, message) };
  chat.flush();
  return { node, job, parent };
}

it.each(["claude", "codex", "opencode"])("keeps sibling observer copies out of the %s supervisor MCP hooks", async (agent) => {
  const sup = await connect(agent, "supervisor");
  await call(sup, "hook_event", { event: "SessionStart", session_id: "supervisor-session" });
  const notifications: string[] = [];
  sup.setNotificationHandler(z.object({ method: z.literal("notifications/agent-bridge/message"), params: z.any() }),
    (n) => { notifications.push(JSON.stringify(n.params)); });
  const a = await runner("a", "codex", "supervisor");
  let b = await runner("b", "opencode", "supervisor");
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [a, b].map(({ job }) => ({
    id: job.id, name: job.name, agent: job.agent, status: "running", owner: "supervisor", rootName: "supervisor",
    rootSession: "supervisor-session", supervisor: "supervisor-session", projectRoot: env.home, workdir: env.home,
  })) }));
  await b.node.stop();
  const child = await connect("codex", "child", { ...a.parent.childEnv(), AGENT_BRIDGE_DELEGATE_DEPTH: "1" });
  const sent = await call(child, "send", { to: b.job.name, message: "SIBLING_ONLY_SECRET" });
  const id = /Message (\S+) (?:sent|queued)/.exec(sent)![1]!;
  // A real registry and an offline sibling force the background supervisor backlog router.
  const trigger = env.node("route-trigger", "codex"); await trigger.start();
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    expect(await call(sup, "hook_event", { event, session_id: "supervisor-session" })).not.toContain("SIBLING_ONLY_SECRET");
  }
  b = await runner("b", "opencode", "supervisor", id);
  await until(() => b.node.hasSeen(id));
  // The receiver really gets the message through its delegated MCP hook.
  const recipient = await connect("opencode", "receiver", { ...b.parent.childEnv(), AGENT_BRIDGE_DELEGATE_DEPTH: "1" });
  expect(await call(recipient, "hook_event", { event: "PostToolUse" })).toContain("SIBLING_ONLY_SECRET");
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    expect(await call(sup, "hook_event", { event, session_id: "supervisor-session" })).not.toContain("SIBLING_ONLY_SECRET");
  }
  expect(notifications).toEqual([]);
  expect(await call(sup, "inbox", { mark_read: false })).toContain("SIBLING_ONLY_SECRET");
});
