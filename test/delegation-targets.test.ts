import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { type CodingAgent } from "../src/core/protocol.js";
import { delegationTargets, registerTools, type ServerContext } from "../src/mcp/server.js";

const kinds: CodingAgent[] = ["claude", "codex", "opencode", "antigravity", "muse"];
const inventory = ["spawn"];
afterEach(() => vi.unstubAllEnvs());

async function registeredInventory(agent: CodingAgent) {
  const server = new McpServer({ name: "inventory-test", version: "0" });
  const ctx: ServerContext = {
    agent, cfg: DEFAULT_CONFIG, log: nullLogger, node: null, home: process.env.AGENT_BRIDGE_HOME!,
    cwd: () => process.cwd(), channelActive: () => false,
    jobs: { restore: () => {} } as unknown as NonNullable<ServerContext["jobs"]>,
  };
  registerTools(server, ctx, delegationTargets(agent));
  const client = new Client({ name: "inventory-client", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    expect(names.filter(name => /^(ask|spawn)_/.test(name) && name !== "ask_owner")).toEqual([]);
    for (const name of inventory.filter(name => names.includes(name))) {
      expect(tools.find(tool => tool.name === name)!.inputSchema.properties!.agent).toMatchObject({ enum: kinds });
    }
    return names.filter((name) => /^(ask|spawn)$/.test(name)).sort();
  } finally { await client.close(); await server.close(); }
}

it.each(kinds)("%s can delegate to every CLI, including itself (AB-270)", async (agent) => {
  expect(delegationTargets(agent)).toEqual(kinds);
  expect(await registeredInventory(agent)).toEqual(inventory);
});

it("spawn rejects unknown or missing agents before job admission", async () => {
  const server = new McpServer({ name: "agent-validation", version: "0" });
  const start = vi.fn(), track = vi.fn();
  registerTools(server, {
    agent: "codex", cfg: DEFAULT_CONFIG, log: nullLogger, node: null,
    home: process.env.AGENT_BRIDGE_HOME!, cwd: () => process.cwd(), channelActive: () => false,
    jobs: { restore() {}, start, track } as unknown as NonNullable<ServerContext["jobs"]>,
  }, kinds);
  const client = new Client({ name: "agent-validation-client", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(inventory));
    expect(names.filter(name => /^(ask|spawn)_/.test(name))).toEqual([]);
    for (const name of inventory) for (const agent of ["unknown", undefined]) {
      const result = await client.callTool({ name, arguments: { agent, title: "Refused", prompt: "do not run" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("agent");
    }
    const missingBlockingTitle = await client.callTool({ name: "spawn", arguments: { agent: "codex", wait: true, prompt: "do not run" } });
    expect(missingBlockingTitle.isError).toBe(true);
    expect(JSON.stringify(missingBlockingTitle)).toContain("title");
    expect(start).not.toHaveBeenCalled(); expect(track).not.toHaveBeenCalled();
  } finally { await client.close(); await server.close(); }
});

it.each(kinds)("%s still cannot delegate beyond the configured depth", async (agent) => {
  vi.stubEnv("AGENT_BRIDGE_DELEGATE_DEPTH", String(DEFAULT_CONFIG.maxDelegateDepth));
  expect(await registeredInventory(agent)).toEqual([]);
});

it("returns a separate target list so one caller cannot change another's inventory", () => {
  delegationTargets("claude").pop();
  expect(delegationTargets("opencode")).toEqual(kinds);
});
