import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { type CodingAgent } from "../src/core/protocol.js";
import { delegationTargets, registerTools, type ServerContext } from "../src/mcp/server.js";

const kinds: CodingAgent[] = ["claude", "codex", "opencode", "antigravity", "muse"];
const inventory = ["ask_antigravity", "ask_claude", "ask_codex", "ask_muse", "ask_opencode",
  "spawn_antigravity", "spawn_claude", "spawn_codex", "spawn_muse", "spawn_opencode"];
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
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    return names.filter((name) => /^(ask|spawn)_(claude|codex|opencode|antigravity|muse)$/.test(name)).sort();
  } finally { await client.close(); await server.close(); }
}

it.each(kinds)("%s can delegate to every CLI, including itself (AB-270)", async (agent) => {
  expect(delegationTargets(agent)).toEqual(kinds);
  expect(await registeredInventory(agent)).toEqual(inventory);
});

it.each(kinds)("%s still cannot delegate beyond the configured depth", async (agent) => {
  vi.stubEnv("AGENT_BRIDGE_DELEGATE_DEPTH", String(DEFAULT_CONFIG.maxDelegateDepth));
  expect(await registeredInventory(agent)).toEqual([]);
});

it("returns a separate target list so one caller cannot change another's inventory", () => {
  delegationTargets("claude").pop();
  expect(delegationTargets("opencode")).toEqual(kinds);
});
