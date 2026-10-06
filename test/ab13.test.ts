import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { approvalHint, isAutoApproved, isHandoffToolCall, isOwnServerCall, mcpToolOf } from "../src/core/tool-allow.js";
import { hookRequest } from "../src/cli/permission-hook.js";
import { opencodePermissionRequest } from "../src/core/opencode-served.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { JobManager, NOTE_CONVERSATION_SUFFIX } from "../src/mcp/jobs.js";
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

  it("always allows the subagent's own agent-bridge tools", () => {
    expect(isOwnServerCall({ tool: "mcp:agent-bridge", detail: 'Allow the agent-bridge MCP server to run tool "send"?' })).toBe(true);
    expect(isOwnServerCall({ tool: "mcp:plugin_agent-bridge_bridge", detail: "report_progress: {}" })).toBe(true);
    expect(isOwnServerCall({ tool: "mcp:bridge", detail: "bridge_send: *" })).toBe(true);
    expect(isOwnServerCall({ tool: "mcp:pair-desk", detail: "list_projects" })).toBe(false);
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

  it("recognizes handoff-writing tools of every CLI, not reading ones", () => {
    expect(isHandoffToolCall({ tool: "mcp:pair-desk", detail: 'Allow the pair-desk MCP server to run tool "set_handoff"?' })).toBe(true);
    expect(isHandoffToolCall({ tool: "mcp:plugin_agent-pair-programming_pair-desk", detail: "update_handoff: {}" })).toBe(true);
    expect(isHandoffToolCall({ tool: "mcp:pair-desk", detail: "pair-desk_set_handoff: *" })).toBe(true);
    expect(isHandoffToolCall(claude)).toBe(false);
    expect(isHandoffToolCall({ tool: "command", detail: "set_handoff" })).toBe(false);
  });

  it("matches common desk writes in actual CLI request formats", () => {
    for (const tool of ["set_plan", "update_issue", "create_issue"]) {
      const requests = [
        { tool: "mcp:pair-desk", detail: `Allow the pair-desk MCP server to run tool '${tool}'?` },
        hookRequest("codex", { tool_name: `mcp__pair-desk__${tool}`, tool_input: {} }),
        hookRequest("claude", { tool_name: `mcp__plugin_agent-pair-programming_pair-desk__${tool}`, tool_input: {} }),
        opencodePermissionRequest({ permission: `pair-desk_${tool}` }, ["pair-desk"], "/w"),
        { tool: `functions.mcp__pair_desk__${tool}`, detail: "{}" },
      ];
      for (const request of requests) {
        expect(isAutoApproved(request, [`pair-desk.${tool.split("_")[0]}_*`])).toBe(true);
        expect(isAutoApproved(request, ["pair-desk:worker"])).toBe(true);
        expect(isAutoApproved(request, ["pair-desk.get_*", "pair-desk.list_*"])).toBe(false);
        expect(approvalHint(request)).toContain("pair-desk:worker");
      }
    }
  });

  it("normalizes opencode server prefixes and does not guess a tool from a sentence", () => {
    const request = opencodePermissionRequest({ permission: "my_server_set_plan" }, ["my server"], "/w");
    expect(mcpToolOf(request)).toEqual({ server: "my server", tool: "set_plan" });
    expect(isAutoApproved(request, ["my server.set_*"])).toBe(true);
    expect(mcpToolOf({ tool: "mcp:desk", detail: "Allow this server to run a tool?" })?.tool).toBeNull();
    expect(isAutoApproved({ tool: "mcp:desk", detail: "Allow this server to run a tool?" }, ["desk.Allow"])).toBe(false);
  });

  it("keeps the worker preset scoped to desk workers", () => {
    for (const tool of ["set_status", "set_build", "set_handoff", "update_handoff", "merge_issues", "delete_issue"]) {
      const request = { tool: "mcp:pair-desk", detail: `${tool}: {}` };
      expect(isAutoApproved(request, ["pair-desk:worker"])).toBe(false);
      expect(approvalHint(request)).not.toContain("pair-desk:worker");
    }
    expect(isAutoApproved({ tool: "mcp:another-desk", detail: "set_plan: {}" }, ["pair-desk:worker"])).toBe(false);
    expect(isHandoffToolCall({ tool: "mcp__pair_desk__update_handoff", detail: "{}" })).toBe(true);
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

  it("keeps the usual name when the server it replaces is the one with the -2 name", async () => {
    const broker = env.node("broker-y", "codex");
    await broker.start();
    const fresh = env.node("claude-app", "claude");
    await fresh.start();
    const leftover = env.node("claude-app", "claude");
    await leftover.start();
    expect(leftover.name).toBe("claude-app-2");
    await leftover.setSessionId("sess-2");
    await broker.send({ to: "claude-app-2", body: "waited under -2" });
    await fresh.setSessionId("sess-2");
    await until(() => !leftover.isConnected);
    expect(fresh.name).toBe("claude-app");
    expect((await broker.peers()).map((p) => p.name)).not.toContain("claude-app-2");
    // Mail that waited under the leftover's name still reaches the session.
    expect((await fresh.waitForMessage(2_000))?.body).toBe("waited under -2");
  });

  it("the server the session really uses takes the bridge back from a stale one", async () => {
    const broker = env.node("broker-z", "codex");
    await broker.start();
    const real = env.node("claude-app", "claude");
    await real.start();
    await real.setSessionId("sess-3");
    // A stale server of the same session connects last and wins the bridge.
    const stale = env.node("claude-app", "claude");
    await stale.start();
    await stale.setSessionId("sess-3");
    await until(() => real.wasReplaced);
    // The session keeps calling the real one: it takes its place (and the usual name) back.
    await real.reclaim();
    await until(() => !stale.isConnected);
    expect(real.name).toBe("claude-app");
    expect(stale.wasReplaced).toBe(true);
    await broker.send({ to: "claude-app", body: "for the real server" });
    expect((await real.waitForMessage(2_000))?.body).toBe("for the real server");
  });

  it("sends a retried message once when it carries the same dedupe key", async () => {
    const broker = env.node("broker-d", "codex");
    await broker.start();
    const to = env.node("claude-dd", "claude");
    await to.start();
    const job = env.node("codex-job-dd", "other");
    await job.start();
    const first = await job.send({ to: "claude-dd", body: "only once", dedupeKey: "k1" });
    const again = await job.send({ to: "claude-dd", body: "only once", dedupeKey: "k1" });
    expect(again.messages[0]!.id).toBe(first.messages[0]!.id);
    await job.send({ to: "claude-dd", body: "another one", dedupeKey: "k2" });
    await until(() => to.unread().length === 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(to.unread().map((m) => m.body)).toEqual(["only once", "another one"]);
  });

  it("claims mail of a gone stand-in name, never of a live session", async () => {
    const broker = env.node("broker-m", "codex");
    await broker.start();
    const me = env.node("claude-mm", "claude");
    await me.start();
    const other = env.node("claude-mm", "claude"); // another session of the folder: "claude-mm-2"
    await other.start();
    await broker.send({ to: "claude-mm-2", body: "for the other session" });
    await until(() => other.unread().length === 1);
    expect(await me.claimMail(["claude-mm-2"])).toBe(0);
    await other.stop();
    await broker.send({ to: "claude-mm-3", body: "result sent to a stand-in" });
    expect(await me.claimMail(["claude-mm-3", "codex-x"])).toBe(1);
    await until(() => me.unread().some((m) => m.body === "result sent to a stand-in"));
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

describe("status notes from running subagents", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("a note waits for the next prompt; an answer to a live message counts as an answer", async () => {
    const me = env.node("claude-n", "claude");
    await me.start();
    const jobs = new JobManager(me, nullLogger);
    const job = jobs.start("codex", null, "long task", () => new Promise(() => {}));
    job.live = { post: () => {} };
    const ctx = { agent: "claude", cfg: { ...DEFAULT_CONFIG, autoWake: true }, node: me, log: nullLogger, home: env.home, cwd: () => env.home, channelActive: () => false, jobs, rewakeAvailable: true } as ServerContext;
    await me.setAutoWake(true);

    jobs.fromSubagent(job, "tests pass, merging next", null);
    await until(() => me.unread().length === 1);
    expect(jobs.isNote(me.unread()[0]!)).toBe(true);
    // Ending the turn: the note does not keep it going.
    expect(await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false })).toEqual({});
    // The next prompt brings it.
    const next = (await buildHookResponse(ctx, { event: "UserPromptSubmit", sessionId: null, stopHookActive: false, prompt: "go on" })) as { hookSpecificOutput?: { additionalContext: string } };
    expect(next.hookSpecificOutput?.additionalContext).toContain("merging next");

    expect(jobs.followUp(job.name, "how far are you?").outcome).not.toBe("unknown");
    jobs.fromSubagent(job, "about half way", null);
    await until(() => me.unread().length === 1);
    expect(jobs.isNote(me.unread()[0]!)).toBe(false);
    // A job runner's note reaches the session over the bridge, marked in its conversation id.
    expect(jobs.isNote({ id: "x", conversationId: `job-abc${NOTE_CONVERSATION_SUFFIX}` })).toBe(true);
    expect(jobs.isNote({ id: "y", conversationId: "job-abc" })).toBe(false);
    jobs.cancelAll();
  });
});
