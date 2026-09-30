import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { isAutoApproved, mcpToolOf } from "../src/core/tool-allow.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

describe("MCP tool allow-list", () => {
  const codex = { tool: "mcp:pair-desk", detail: 'Allow the pair-desk MCP server to run tool "list_projects"?' };
  const claude = { tool: "mcp:plugin_agent-pair-programming_pair-desk", detail: "get_handoff: {}" };
  const opencode = { tool: "mcp:pair-desk", detail: "pair-desk_update_step: *" };

  it("reads server and tool from every CLI's request", () => {
    expect(mcpToolOf(codex)).toEqual({ server: "pair-desk", tool: "list_projects" });
    expect(mcpToolOf(claude)).toEqual({ server: "plugin_agent-pair-programming_pair-desk", tool: "get_handoff" });
    expect(mcpToolOf(opencode)).toEqual({ server: "pair-desk", tool: "update_step" });
    expect(mcpToolOf({ tool: "command", detail: "git push" })).toBeNull();
  });

  it("allows read-only patterns and whole servers, never commands", () => {
    const readOnly = ["pair-desk.get_*", "pair-desk.list_*"];
    expect(isAutoApproved(codex, readOnly)).toBe(true);
    expect(isAutoApproved(claude, readOnly)).toBe(true);
    expect(isAutoApproved(opencode, readOnly)).toBe(false);
    expect(isAutoApproved(opencode, ["pair-desk"])).toBe(true);
    expect(isAutoApproved({ tool: "command", detail: "git push" }, ["*"])).toBe(false);
    expect(isAutoApproved(codex, [])).toBe(false);
  });
});

describe("sessions and native subagents", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("a reloaded server replaces the old one of the same session and keeps its name", async () => {
    const broker = env.node("broker-x", "codex");
    await broker.start();
    const old = env.node("claude-app", "claude");
    await old.start();
    await old.setSessionId("sess-1");
    const fresh = env.node("claude-app", "claude");
    await fresh.start();
    expect(fresh.name).toBe("claude-app-2");
    await fresh.setSessionId("sess-1");
    expect(fresh.name).toBe("claude-app");
    await until(() => !old.isConnected);
    const names = (await broker.peers()).map((p) => p.name);
    expect(names).toContain("claude-app");
    expect(names).not.toContain("claude-app-2");
    await broker.send({ to: "claude-app", body: "hello" });
    expect((await fresh.waitForMessage(2_000))?.body).toBe("hello");
  });

  it("leaves mail for the main agent when a native subagent's tool call fires the hook", async () => {
    const me = env.node("claude-m", "claude");
    await me.start();
    const peer = env.node("codex-m", "codex");
    await peer.start();
    await peer.send({ to: "claude-m", body: "for the main agent" });
    await until(() => me.unread().length === 1);
    const ctx = { agent: "claude", cfg: { ...DEFAULT_CONFIG }, node: me, log: nullLogger, home: env.home, cwd: () => env.home, channelActive: () => false } as ServerContext;
    expect(await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false, subagent: true })).toEqual({});
    expect(me.unread()).toHaveLength(1);
    const main = (await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false })) as { hookSpecificOutput?: { additionalContext: string } };
    expect(main.hookSpecificOutput?.additionalContext).toContain("for the main agent");
  });
});
