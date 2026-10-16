import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { CODING_AGENTS } from "../src/core/protocol.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";
import { ClaudeMailScopes, CLAUDE_SCOPED_TOOLS } from "../src/mcp/claude-mail-scope.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv, ctx: ServerContext;
let handlers: Map<string, (a: any, extra: any) => Promise<any>>;
let specs: Map<string, any>;
const agentId = "native-worker";
const schema = (spec: any) => spec.inputSchema instanceof z.ZodObject ? spec.inputSchema : z.object(spec.inputSchema ?? {});
const call = (name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) =>
  handlers.get(name)!(args, { signal: new AbortController().signal, _meta: meta });
const scope = (tool: string, child?: string) => ctx.claudeMailScopes!.issue(tool, "parent-session", child);
const childStart = () => ctx.node!.nativeChild({ action: "start", agentId });
beforeEach(async () => {
  env = makeEnv();
  const node = env.node("claude-parent");
  await node.setSessionId("parent-session"); await node.start();
  ctx = { agent: "claude", node, home: env.home, cfg: { ...DEFAULT_CONFIG }, log: nullLogger,
    cwd: () => env.home, channelActive: () => false, observeMeta: vi.fn() };
  handlers = new Map(); specs = new Map();
  registerTools({ registerTool: (name: string, spec: any, fn: any) => {
    specs.set(name, spec);
    handlers.set(name, (a, extra) => fn(schema(spec).parse(a), extra));
  } } as any, ctx, [...CODING_AGENTS]);
});
afterEach(async () => { await env.cleanup(); vi.restoreAllMocks(); });

/** Exercise the real mod's filter and flat event, with a synthetic endpoint. No live registration files. */
async function hostMod(fails: boolean | number = false) {
  let fetches = 0;
  const modulePath = "../plugins/claude/hooks/mail-scope.ts";
  const { register } = await import(modulePath);
  let filter: string[] = [], middleware: any;
  register(((event: string, spec: any, fn: any) => { filter = spec.tool; middleware = fn; }) as any);
  const engine = { session: { id: async () => "parent-session" }, env: { get: async () => env.home },
    fs: { read: async () => JSON.stringify({ port: 1234, secret: "synthetic-test-only" }) },
    http: { fetch: async (url: string) => {
      // A number fails only that many first fetches (transient endpoint stall).
      if (fails === true || typeof fails === "number" && fetches++ < fails) throw new Error("endpoint unavailable");
      const u = new URL(url);
      return { ok: true, text: JSON.stringify({ token: scope(u.searchParams.get("tool")!, u.searchParams.get("agent_id") ?? undefined) }) };
    } }, clock: { sleep: async () => new Promise(() => {}) } };
  const forwarded: Record<string, unknown>[] = [];
  const host = async (name: string, args: Record<string, unknown> = {}, child?: string) => {
    const tool = `mcp__plugin_agent-bridge_bridge__${name}`;
    const e = Object.freeze({ ...args, tool, tool_use_id: "fixture", agentId: child });
    const next = (event: any) => {
      expect(event.agentId).toBe(child);
      const { tool: _t, tool_use_id: _id, agentId: _a, ...input } = event;
      forwarded.push(input); return call(name, input);
    };
    return filter.includes(tool) ? middleware(engine, e, next) : next(e);
  };
  return Object.assign(host, { filter, forwarded });
}

it("a host-pinned child cannot record decisions or answer approvals", async () => {
  const host = await hostMod(); await childStart();
  const decide = vi.spyOn(ctx.node!, "decide");
  for (const args of [{ topic: "rule", text: "child decision" }, { approval_id: "11111111-1111-4111-8111-111111111111", decision: "allow" }]) {
    expect((await host("decide", args, agentId)).isError).toBe(true);
  }
  expect(decide).not.toHaveBeenCalled(); expect(ctx.observeMeta).not.toHaveBeenCalled();
});

it.each([undefined, "auto"])("an unlabelled child send (mode: %s) is stored with the native child's own sender address", async mode => {
  const host = await hostMod(); await childStart();
  const target = env.node("granted-target", "codex"); await target.start();
  await ctx.node!.nativeChild({ action: "grant", agentId, sendTo: [target.name] });
  const send = vi.spyOn(ctx.node!, "send");
  const result = await host("send", { to: target.name, message: "child result", mode }, agentId);
  expect(result.isError).not.toBe(true);
  await target.refreshPending();
  expect(target.unread()).toContainEqual(expect.objectContaining({ body: "child result", from: expect.objectContaining({ name: `${ctx.node!.name}/sub:${agentId}` }) }));
  expect(send).not.toHaveBeenCalled(); expect(ctx.observeMeta).not.toHaveBeenCalled();
});

it.each(CODING_AGENTS.flatMap(a => [`spawn_${a}`, `ask_${a}`]))("a child %s is refused before job admission", async tool => {
  const host = await hostMod(); await childStart();
  const start = vi.fn(() => { throw new Error("fixture admission"); }), track = vi.fn(() => { throw new Error("fixture admission"); });
  ctx.jobs = { start, track, canStart: vi.fn(() => true) } as any;
  expect((await host(tool, { prompt: "do work", title: "Test work" }, agentId)).isError).toBe(true);
  expect(start).not.toHaveBeenCalled(); expect(track).not.toHaveBeenCalled();
});

it.each([false, true])("parent decide, send and spawn keep their handlers (live child: %s)", async live => {
  // No-child path also proves compatibility when the host endpoint is unavailable.
  const host = await hostMod(!live); if (live) await childStart();
  const decide = vi.spyOn(ctx.node!, "decide").mockResolvedValue({ decision: {} as any, deliveredTo: [] });
  const target = env.node("target", "codex"); await target.start();
  const send = vi.spyOn(ctx.node!, "send");
  const start = vi.fn(() => ({ id: "fixture", name: "codex-job-fixture" }));
  expect((await host("decide", { topic: "owner", text: "yes" })).isError).not.toBe(true);
  expect((await host("send", { to: "target", message: "parent result" })).isError).not.toBe(true);
  ctx.jobs = { start, persist: vi.fn(), limit: 3 } as any;
  // A worktree skips usage probes; the fake manager never executes the captured run.
  expect((await host("spawn_codex", { prompt: "work", title: "Test work", worktree: true })).isError).not.toBe(true);
  expect(decide).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce();
});

it("unscoped non-mail calls with a live child fail closed before parent effects", async () => {
  await childStart(); const decide = vi.spyOn(ctx.node!, "decide"), send = vi.spyOn(ctx.node!, "send");
  for (const [tool, args] of [["decide", { topic: "x", text: "x" }], ["send", { to: "target", message: "x" }], ["spawn_codex", { prompt: "x" }], ["peers", {}]] as const) {
    const result = await call(tool, args);
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("Ambiguous caller");
  }
  expect(decide).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});

it("non-mail scopes reject forgery, replay, wrong tool/session, conflicting identity and stopped children", async () => {
  const decide = vi.spyOn(ctx.node!, "decide").mockResolvedValue({ decision: {} as any, deliveredTo: [] });
  const args = { topic: "owner", text: "yes" };
  expect((await call("decide", { ...args, _bridge_scope: "forged" })).isError).toBe(true);
  await childStart();
  const token = scope("decide");
  expect((await call("decide", { ...args, _bridge_scope: token })).isError).not.toBe(true);
  expect((await call("decide", { ...args, _bridge_scope: token })).isError).toBe(true);
  expect((await call("decide", { ...args, _bridge_scope: scope("send") })).isError).toBe(true);
  expect((await call("decide", { ...args, _bridge_scope: ctx.claudeMailScopes!.issue("decide", "foreign") })).isError).toBe(true);
  expect((await call("decide", { ...args, _bridge_scope: scope("decide", agentId) }, { agent_id: "sibling" })).isError).toBe(true);
  const stopped = scope("send", agentId); await ctx.node!.nativeChild({ action: "end", agentId });
  expect((await call("send", { to: "target", message: "x", _bridge_scope: stopped })).isError).toBe(true);
  expect(decide).toHaveBeenCalledOnce();
});

it("every registered model tool carries a scope schema and is covered by the host mod", async () => {
  const host = await hostMod();
  for (const [name, spec] of specs) {
    expect(host.filter).toContain(`mcp__plugin_agent-bridge_bridge__${name}`);
    if (name !== "hook_event") {
      expect(CLAUDE_SCOPED_TOOLS).toContain(name);
      expect(schema(spec).shape._bridge_scope).toBeDefined();
    }
  }
  expect(host.filter.map(t => t.split("bridge__")[1]).sort()).toEqual([...CLAUDE_SCOPED_TOOLS, "hook_event"].sort());
  expect([...specs.keys()].sort()).toEqual([...CLAUDE_SCOPED_TOOLS.filter(t => t !== "report_progress"), "hook_event"].sort());
});

it("all parent controls and unsupported child transports refuse authenticated children before effects", async () => {
  await childStart();
  const controls: Record<string, Record<string, unknown>> = {
    ask_owner: { title: "Question", context: "test", topic: "test", options: [{ id: "a", label: "A", consequence: "test", recommended: true }, { id: "b", label: "B", consequence: "test", recommended: false }], blocking: true, blocks: "test", meanwhile: "test" },
    withdraw_owner_question: { id: "11111111-1111-4111-8111-111111111111", status: "cancelled", reason: "test" },
    project_main: { to: "target" }, coordinator_availability: { unavailable: true },
    native_child_grant: { agent_id: agentId, send_to: ["target"] },
    max_subagents: { count: 2 }, auto_wake: { enabled: true },
    set_job_outcome: { job: "job", state: "discarded" }, handoff_subagents: { to: "target" },
    message_subagent: { job: "job", message: "continue" }, cancel_subagent: { job: "job" },
    pause_subagent: { job: "job", reason: "owner build" }, resume_subagent: { job: "job" },
    send_files: { to: "target", paths: ["fixture"] }, fetch_files: { from: "target", paths: ["fixture"] },
    cancel_transfer: { id: "11111111-1111-4111-8111-111111111111" }, dashboard: {},
    send_status: { message_id: "11111111-1111-4111-8111-111111111111" },
  };
  for (const [name, args] of Object.entries(controls)) {
    // Parsing is intentionally separate: all supplied fixture arguments must be valid.
    const parsed = schema(specs.get(name)).safeParse(args);
    expect(parsed.success, `${name}: ${JSON.stringify(parsed.error)}`).toBe(true);
    const result = await call(name, { ...args, _bridge_scope: scope(name, agentId) });
    expect(result.isError, name).toBe(true);
    expect(JSON.stringify(result), name).toContain("Native child refused");
  }
  expect(ctx.observeMeta).not.toHaveBeenCalled();
});

it("child peers and status omit parent identity, private decisions and network details", async () => {
  const host = await hostMod(); await childStart();
  const peers = await host("peers", {}, agentId);
  expect(JSON.stringify(peers)).toContain(`${ctx.node!.name}/sub:${agentId}`);
  expect(JSON.stringify(peers)).not.toContain("You are claude-parent.");
  await ctx.node!.decide({ topic: "parent-secret", text: "parent only", scope: { sessions: [ctx.node!.name] } });
  await ctx.node!.decide({ topic: "shared-rule", text: "project rule", scope: { project: env.home } });
  const decisions = await host("decisions", { scope: { sessions: [ctx.node!.name] } }, agentId);
  expect(JSON.stringify(decisions)).toContain("project rule");
  expect(JSON.stringify(decisions)).not.toContain("parent only");
  vi.spyOn(ctx.node!, "networkStatus").mockResolvedValue({ enabled: true, discovered: [{ name: "private-host" }], paired: [{ name: "paired-private", connected: true }], config: { fetchRoots: ["private-root"] } } as any);
  const network = await host("network_status", {}, agentId);
  expect(network.isError).not.toBe(true);
  expect(JSON.stringify(network)).not.toContain("private");
  expect(JSON.parse(network.content[0].text)).toMatchObject({ discovered: 1, paired: 1, connected: 1 });
  expect((await host("resource_slots", {}, agentId)).isError).not.toBe(true);
  expect((await host("list_models", { agent: "codex" }, agentId)).isError).not.toBe(true);
  expect(ctx.observeMeta).not.toHaveBeenCalled();
});

it("model hook_event calls cannot spoof lifecycle events; genuine hooks remain registered", async () => {
  const host = await hostMod(); await childStart();
  for (const child of [undefined, agentId]) {
    expect(await host("hook_event", { event: "SubagentStop", agent_id: agentId, session_id: "parent-session" }, child)).toEqual({ deny: expect.any(String) });
  }
  expect(await ctx.node!.nativeChildren()).toHaveLength(1);
  // Real mcp_tool lifecycle hooks bypass model tool.call middleware.
  expect((await call("hook_event", { event: "SubagentStop", agent_id: agentId, session_id: "parent-session" })).isError).not.toBe(true);
  expect(await ctx.node!.nativeChildren()).toEqual([]);
});

it("non-mail tokens expire and are stripped from logs and forwarded parent arguments", async () => {
  let now = 0; const expiring = new ClaudeMailScopes(() => now);
  const expired = expiring.issue("decide", "parent-session"); now = 10_000;
  expect(() => expiring.take(expired, "decide", "parent-session")).toThrow(/scope/);
  const host = await hostMod();
  const debug = vi.spyOn(ctx.log, "debug"), decide = vi.spyOn(ctx.node!, "decide").mockResolvedValue({ decision: {} as any, deliveredTo: [] });
  const result = await host("decide", { topic: "x", text: "x", _bridge_scope: "model-forged", input: { _bridge_scope: "nested-forgery" } });
  const token = host.forwarded[0]!._bridge_scope;
  expect(token).toEqual(expect.any(String)); expect(token).not.toBe("model-forged");
  expect(host.forwarded[0]!.input).toEqual({ _bridge_scope: "nested-forgery" });
  expect(decide).toHaveBeenCalledWith({ topic: "x", text: "x", scope: undefined, sourceMessageId: undefined });
  expect(JSON.stringify(debug.mock.calls)).not.toContain(token);
  expect(JSON.stringify(result)).not.toContain(token);
});

it("a failed endpoint denies child non-mail calls even before SubagentStart; parent fallback stays compatible", async () => {
  const host = await hostMod(true);
  for (const tool of ["send", "decide", "spawn_codex", "peers"]) {
    expect(await host(tool, {}, agentId)).toEqual({ deny: expect.any(String) });
  }
  expect(host.forwarded).toEqual([]);
  const decide = vi.spyOn(ctx.node!, "decide").mockResolvedValue({ decision: {} as any, deliveredTo: [] });
  expect((await host("decide", { topic: "x", text: "x", _bridge_scope: "forged" })).isError).not.toBe(true);
  expect(host.forwarded[0]).not.toHaveProperty("_bridge_scope");
  await childStart();
  expect((await host("decide", { topic: "x", text: "x" })).isError).toBe(true);
  expect(decide).toHaveBeenCalledOnce();
});

it("a parent retries a failed scope fetch once while a child is live; a child does not", async () => {
  await childStart();
  const decide = vi.spyOn(ctx.node!, "decide").mockResolvedValue({ decision: {} as any, deliveredTo: [] });
  expect((await (await hostMod(1))("decide", { topic: "x", text: "x" })).isError).not.toBe(true);
  expect(decide).toHaveBeenCalledOnce();
  expect(await (await hostMod(1))("send", { to: "target", message: "x" }, agentId)).toEqual({ deny: expect.any(String) });
  expect((await (await hostMod(2))("decide", { topic: "x", text: "x" })).isError).toBe(true);
  expect(decide).toHaveBeenCalledOnce();
});

it("an expired parent grant falls back to the unscoped path only while no child is live", async () => {
  let now = 0; ctx.claudeMailScopes = new ClaudeMailScopes(() => now);
  // Re-register so the guard uses the clock-controlled scopes.
  handlers = new Map(); specs = new Map();
  registerTools({ registerTool: (name: string, spec: any, fn: any) => {
    specs.set(name, spec); handlers.set(name, (a, extra) => fn(schema(spec).parse(a), extra));
  } } as any, ctx, [...CODING_AGENTS]);
  const decide = vi.spyOn(ctx.node!, "decide").mockResolvedValue({ decision: {} as any, deliveredTo: [] });
  const args = { topic: "x", text: "x" };
  const slowPrompt = scope("decide"); now = 60_000;
  expect((await call("decide", { ...args, _bridge_scope: slowPrompt })).isError).not.toBe(true);
  expect(decide).toHaveBeenCalledOnce();
  await childStart();
  const whileChild = scope("decide"); now = 120_000;
  const refused = await call("decide", { ...args, _bridge_scope: whileChild });
  expect(refused.isError).toBe(true); expect(JSON.stringify(refused)).toContain("Ambiguous caller");
  await ctx.node!.nativeChild({ action: "end", agentId });
  // Expired child or wrong-tool grants never become parent calls.
  const childGrant = ctx.claudeMailScopes.issue("decide", "parent-session", agentId);
  const wrongTool = scope("send"); now = 180_000;
  expect((await call("decide", { ...args, _bridge_scope: childGrant })).isError).toBe(true);
  expect((await call("decide", { ...args, _bridge_scope: wrongTool })).isError).toBe(true);
  expect(decide).toHaveBeenCalledOnce();
});

it("children cannot exhaust the scope map; the parent keeps headroom", () => {
  const scopes = new ClaudeMailScopes(() => 0);
  let issued = 0;
  while (issued < 200) { try { scopes.issue("peers", "parent-session", agentId); issued++; } catch { break; } }
  expect(issued).toBeLessThan(128);
  expect(() => scopes.issue("decide", "parent-session")).not.toThrow();
});

it("an older broker without nativeChildren retains unscoped parent non-mail behavior", async () => {
  vi.spyOn(ctx.node!, "nativeChildren").mockRejectedValue(new Error("unknown op: nativeChildren"));
  const decide = vi.spyOn(ctx.node!, "decide").mockResolvedValue({ decision: {} as any, deliveredTo: [] });
  expect((await call("decide", { topic: "x", text: "x" })).isError).not.toBe(true);
  expect(decide).toHaveBeenCalledOnce();
});
