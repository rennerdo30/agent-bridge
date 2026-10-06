import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Runs the bundled plugin server (npm run build first) as two real MCP servers. */
const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
const home = mkdtempSync(join(tmpdir(), "agent-bridge-e2e-"));

async function spawnAgent(agent: "claude" | "codex", name: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, `--agent=${agent}`],
    env: { ...process.env, AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_DELIVERY: "hooks", AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_LOG_LEVEL: "debug" } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: `test-${agent}`, version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const textOf = (r: any): string => r.content.map((c: any) => c.text).join("\n");

async function waitFor(fn: () => Promise<boolean>, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!existsSync(SERVER))("bundled MCP server end-to-end", () => {
  let claude: Client;
  let codex: Client;

  beforeAll(async () => {
    claude = await spawnAgent("claude", "claude-e2e");
    codex = await spawnAgent("codex", "codex-e2e");
    await waitFor(async () => textOf(await claude.callTool({ name: "peers", arguments: {} })).includes("codex-e2e"));
  }, 30_000);

  afterAll(async () => {
    await claude?.close();
    await codex?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("exposes the expected tools per agent", async () => {
    const c = (await claude.listTools()).tools.map((t) => t.name).sort();
    const x = (await codex.listTools()).tools.map((t) => t.name).sort();
    expect(c).toEqual(["ask_codex", "ask_opencode", "auto_wake", "cancel_subagent", "dashboard", "decide", "decisions", "hook_event", "inbox", "list_models", "max_subagents", "message_subagent", "network_status", "peers", "send", "send_files", "spawn_codex", "spawn_opencode", "usage_limits", "wait_for_message"]);
    expect(x).toEqual(["ask_claude", "ask_opencode", "auto_wake", "cancel_subagent", "dashboard", "decide", "decisions", "hook_event", "inbox", "list_models", "max_subagents", "message_subagent", "network_status", "peers", "send", "send_files", "spawn_claude", "spawn_opencode", "usage_limits", "wait_for_message"]);
  });

  it("declares the Claude channel capability only for Claude", () => {
    expect(claude.getServerCapabilities()?.experimental?.["claude/channel"]).toEqual({});
    expect(codex.getServerCapabilities()?.experimental?.["claude/channel"]).toBeUndefined();
  });

  it("round-trips a question and a threaded answer", async () => {
    const sent = textOf(await claude.callTool({ name: "send", arguments: { to: "codex", message: "What is 2+2?" } }));
    expect(sent).toContain("codex-e2e");
    const id = /Message (\S+) sent/.exec(sent)![1]!;

    // Codex sees it through its UserPromptSubmit hook.
    const hook = JSON.parse(textOf(await codex.callTool({ name: "hook_event", arguments: { event: "UserPromptSubmit", session_id: "t1" } })));
    expect(hook.hookSpecificOutput.additionalContext).toContain("What is 2+2?");

    const waiting = claude.callTool({ name: "wait_for_message", arguments: { timeout_sec: 10, reply_to: id } });
    await codex.callTool({ name: "send", arguments: { to: "claude-e2e", message: "4", reply_to: id } });
    const answer = textOf(await waiting);
    expect(answer).toContain(`reply_to="${id}"`);
    expect(answer).toContain("\n4\n");
    expect(answer).toContain('hop="1"');
  });

  it("auto-wake turns a Stop into a continuation", async () => {
    await codex.callTool({ name: "auto_wake", arguments: { enabled: true } });
    await claude.callTool({ name: "send", arguments: { to: "codex-e2e", message: "one more thing" } });
    await waitFor(async () => {
      const out = JSON.parse(textOf(await codex.callTool({ name: "hook_event", arguments: { event: "Stop", stop_hook_active: false } })));
      return out.decision === "block" && out.reason.includes("one more thing");
    });
  });

  it("reports an empty inbox after everything was consumed", async () => {
    expect(textOf(await codex.callTool({ name: "inbox", arguments: {} }))).toContain("No unread messages");
  });

  it("returns structured decision revisions and searchable history through MCP", async () => {
    const tool = (await claude.listTools()).tools.find((t) => t.name === "decisions")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    const first = JSON.parse(textOf(await claude.callTool({ name: "decide", arguments: { topic: "Test decision", text: "Original choice", scope: "all" } })));
    expect(first.decision).toMatchObject({ topic: "test decision", text: "Original choice", current: true, author: { name: "claude-e2e" }, sourceMessageId: null });
    expect(first.deliveredTo).toContain("codex-e2e");
    const second = JSON.parse(textOf(await codex.callTool({ name: "decide", arguments: { topic: "TEST DECISION", text: "Updated choice", scope: "all" } })));
    expect(second.decision.supersedes).toBe(first.decision.id);
    const current = JSON.parse(textOf(await claude.callTool({ name: "decisions", arguments: { query: "CHOICE", scope: "all" } })));
    expect(current).toHaveLength(1);
    expect(current[0].text).toBe("Updated choice");
    const history = JSON.parse(textOf(await codex.callTool({ name: "decisions", arguments: { query: "test decision", scope: "all", history: true } })));
    expect(history.map((d: any) => d.current)).toEqual([true, false]);
    const invalid = await claude.callTool({ name: "decide", arguments: { topic: "invalid source", text: "choice", source_message_id: "missing" } });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain("Source message does not exist");
  });
});
