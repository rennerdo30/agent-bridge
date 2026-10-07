import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { pidAlive } from "../src/core/delegate.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

it.each(["claude", "codex", "opencode", "antigravity"])("%s internal MCP loads without user-session privileges", async (agent) => {
  const owner = env.node("owner");
  await owner.start();
  const childEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete childEnv.AGENT_BRIDGE_DELEGATE_DEPTH;
  const client = new Client({ name: "internal-probe-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve("plugins/codex/dist/server.mjs"), `--agent=${agent}`],
    cwd: env.home, stderr: "ignore", env: { ...childEnv, AGENT_BRIDGE_INTERNAL: "1", AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_PIPE: env.pipe,
      CLAUDE_PROJECT_DIR: env.home, AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_JOB_RUNNER: "0" },
  });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("handoff_subagents");
    expect(await client.callTool({ name: "peers", arguments: {} })).toHaveProperty("isError", true);
    expect((await owner.peers()).map((peer) => peer.name)).toEqual(["owner"]);
  } finally { const pid = transport.pid; await client.close(); if (pid) await until(() => !pidAlive(pid)); }
});

it("plugin-cache MCP becomes a real session only when tool metadata supplies the project", async () => {
  const owner = env.node("owner");
  await owner.start();
  const { mkdirSync } = await import("node:fs");
  const cache = join(env.home, ".codex", "plugins", "cache", "agent-bridge", "version");
  mkdirSync(cache, { recursive: true });
  const childEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of ["AGENT_BRIDGE_INTERNAL", "AGENT_BRIDGE_DELEGATE_DEPTH", "CLAUDE_PROJECT_DIR"]) delete childEnv[key];
  const client = new Client({ name: "host-metadata-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("plugins/codex/dist/server.mjs"), "--agent=codex"], cwd: cache, stderr: "ignore",
    env: { ...childEnv, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_PIPE: env.pipe, AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_JOB_RUNNER: "0" } });
  try {
    await client.connect(transport);
    await client.listTools();
    expect((await owner.peers()).map((peer) => peer.name)).toEqual(["owner"]);
    expect(await client.callTool({ name: "peers", arguments: {}, _meta: { threadId: "real-thread", "codex/sandbox-state-meta": { sandboxCwd: env.home } } })).not.toHaveProperty("isError", true);
    const peers = await owner.peers();
    expect(peers).toHaveLength(2);
    expect(peers.every((peer) => peer.cwd === env.home)).toBe(true);
  } finally { const pid = transport.pid; await client.close(); if (pid) await until(() => !pidAlive(pid)); }
});
