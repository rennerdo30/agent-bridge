import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { CodexLineageLookup, codexMainThreadAdmission } from "../src/mcp/codex-lineage.js";
import { registerTools } from "../src/mcp/server.js";
import { codexRollout, makeEnv, until, type TestEnv } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const ROOT_THREAD = "root", CHILD_THREAD = "child";

interface McpHook { type: string; server?: string; tool?: string; input?: Record<string, unknown> }
type HookTable = Record<string, { hooks: McpHook[] }[]>;
const mcpHooks = (table: HookTable) => Object.entries(table).flatMap(([event, groups]) =>
  groups.flatMap(g => g.hooks).filter(h => h.type === "mcp_tool").map(h => ({ event, input: h.input! })));

// Port of Codex's expand_mcp_argument_template (codex-rs/hooks/src/engine/mcp_runner.rs): no optional
// or default syntax; a missing field fails the hook; a whole-value placeholder keeps its JSON type.
function expandCodex(template: unknown, event: Record<string, unknown>): unknown {
  if (Array.isArray(template)) return template.map(v => expandCodex(v, event));
  if (template && typeof template === "object") return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, expandCodex(v, event)]));
  if (typeof template !== "string") return template;
  const resolve = (path: string) => path.split(".").reduce<unknown>((value, field) => {
    if (!value || typeof value !== "object" || !(field in value)) throw new Error(`hook input placeholder \`\${${path}}\` was not found`);
    return (value as Record<string, unknown>)[field];
  }, event);
  const whole = /^\$\{([^{}]+)\}$/.exec(template);
  if (whole) return resolve(whole[1]!);
  return template.replace(/\$\{([^{}]+)\}/g, (_, path: string) => { const v = resolve(path); return typeof v === "string" ? v : JSON.stringify(v); });
}

// Codex hook inputs (codex-rs/hooks/src/schema.rs). session_id is shared by the root and all descendant
// threads; agent_id/agent_type exist only for a subagent's UserPromptSubmit/PostToolUse and never for
// SessionStart or Stop. transcript_path is a NullableString.
const common = { session_id: ROOT_THREAD, transcript_path: null, cwd: "/work/project", model: "gpt", permission_mode: "default" };
const rootEvents: Record<string, Record<string, unknown>> = {
  SessionStart: { ...common, hook_event_name: "SessionStart", source: "startup" },
  UserPromptSubmit: { ...common, turn_id: "t1", hook_event_name: "UserPromptSubmit", prompt: "hello" },
  PostToolUse: { ...common, turn_id: "t1", hook_event_name: "PostToolUse", tool_name: "shell", tool_input: {}, tool_response: {}, tool_use_id: "u1" },
  Stop: { ...common, turn_id: "t1", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: null },
};
const rootEvent = (event: string) => {
  const payload = rootEvents[event];
  if (!payload) throw new Error(`no Codex ${event} fixture`);
  return payload;
};
const childEvent = (event: string) => ({ ...rootEvent(event), agent_id: CHILD_THREAD, agent_type: "worker" });

describe("Codex plugin hook manifest", () => {
  const codexHooks = mcpHooks(readJson("plugins/codex/.codex-plugin/plugin.json").hooks.hooks);

  it("expands every MCP hook for a Codex main thread, where agent_id is absent", () => {
    expect(codexHooks.map(h => h.event).sort()).toEqual(Object.keys(rootEvents).sort());
    for (const { event, input } of codexHooks) expect(() => expandCodex(input, rootEvent(event)), event).not.toThrow();
  });

  it("the resolver port rejects a missing placeholder like Codex does", () => {
    expect(() => expandCodex({ agent_id: "${agent_id}" }, rootEvent("PostToolUse"))).toThrow("hook input placeholder `${agent_id}` was not found");
  });

  it("Codex resolves the agent-bridge marketplace to the Codex flavour before any .claude-plugin manifest", () => {
    // Codex checks .agents/plugins/marketplace.json before .claude-plugin/marketplace.json (core-plugins/src/marketplace.rs).
    const market = readJson(".agents/plugins/marketplace.json");
    expect(market.plugins).toEqual([expect.objectContaining({ name: "agent-bridge", source: { source: "local", path: "./plugins/codex" } })]);
    expect(readJson("plugins/codex/.codex-plugin/plugin.json").name).toBe("agent-bridge");
  });
});

describe("Claude plugin hooks", () => {
  it("keep agent_id for native-subagent detection", () => {
    const claudeHooks = mcpHooks(readJson("plugins/claude/hooks/hooks.json").hooks);
    const withAgent = claudeHooks.filter(h => h.input.agent_id === "${agent_id}").map(h => h.event).sort();
    expect(withAgent).toEqual(["PostToolUse", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "UserPromptSubmit"]);
  });
});

describe("hook_event with Codex-expanded manifest arguments", () => {
  let env: TestEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("serves main-thread hooks, including null transcript_path, and keeps child-thread hooks out", async () => {
    const codexHome = codexRollout(env.home, ROOT_THREAD); codexRollout(env.home, CHILD_THREAD, ROOT_THREAD);
    const node = env.node("parent", "codex"), observer = env.node("observer", "other");
    await node.start(); await observer.start();
    const server = new McpServer({ name: "test", version: "1" });
    registerTools(server, { node, home: env.home, cfg: DEFAULT_CONFIG, agent: "codex", log: nullLogger, cwd: () => env.home, channelActive: () => false,
      admitCodex: codexMainThreadAdmission(new CodexLineageLookup(join(codexHome, "sessions"))) }, []);
    const client = new Client({ name: "test", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const codexHooks = mcpHooks(readJson("plugins/codex/.codex-plugin/plugin.json").hooks.hooks);
    const template = (event: string) => codexHooks.find(h => h.event === event)!.input;
    // Codex adds the calling thread's id to every hook MCP call (codex-rs/core/src/hook_mcp_executor.rs).
    const fire = async (event: string, payload: Record<string, unknown>, threadId: string) => {
      const result: any = await client.callTool({ name: "hook_event", arguments: expandCodex(template(event), payload) as Record<string, unknown>, _meta: { threadId } });
      expect(result.isError, `${event} on ${threadId}: ${JSON.stringify(result.content)}`).not.toBe(true);
      return JSON.parse(result.content[0].text);
    };
    try {
      await observer.send({ to: node.name, body: "mail for the main thread" });
      await until(() => node.unread().length === 1);
      expect(await fire("PostToolUse", childEvent("PostToolUse"), CHILD_THREAD)).toEqual({});
      expect(await fire("UserPromptSubmit", childEvent("UserPromptSubmit"), CHILD_THREAD)).toEqual({});
      expect(node.unread()).toHaveLength(1);
      expect(node.currentSessionId).not.toBe(ROOT_THREAD);
      expect(JSON.stringify(await fire("SessionStart", rootEvent("SessionStart"), ROOT_THREAD))).toContain("You are connected to agent-bridge");
      expect(node.currentSessionId).toBe(ROOT_THREAD);
      expect(JSON.stringify(await fire("PostToolUse", rootEvent("PostToolUse"), ROOT_THREAD))).toContain("mail for the main thread");
      expect(await fire("Stop", rootEvent("Stop"), ROOT_THREAD)).toEqual({});
    } finally { await client.close(); await server.close(); }
  });
});
