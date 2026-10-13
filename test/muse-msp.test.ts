import { mkdtempSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { delegateToMuseMsp, museMspQuery, type MuseMspRequest, type MuseSteering } from "../src/core/muse-msp.js";
import { DELEGATE_DEPTH_ENV } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";

const host = fileURLToPath(new URL("./fixtures/muse-msp/host.cjs", import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); vi.unstubAllEnvs(); });
function fixture(overrides: Partial<MuseMspRequest> = {}, env: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ab-muse-msp-")); dirs.push(cwd);
  const logfile = join(cwd, "requests.jsonl");
  const req: MuseMspRequest = { bin: process.execPath, serveArgs: [host], cwd, access: "edit", prompt: "Complete this task", timeoutSec: 5, cleanupTimeoutMs: 30, log: nullLogger, ...overrides, extraEnv: { MSP_TEST_LOG: logfile, MSP_TEST_PID: join(cwd, "host.pid"), ...env, ...overrides.extraEnv } };
  const calls = () => readFileSync(logfile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { req, calls, cwd };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("fixture condition did not happen");
}

describe("Muse stable MSP delegation", () => {
  it("initializes v1, creates a native session, submits UUIDv7 commands and reads authoritative final items", async () => {
    const onSession = vi.fn(), onInfo = vi.fn(), onSpawn = vi.fn();
    const f = fixture({ onSession, onInfo, onSpawn, model: "chosen-model", effort: "high", permissionProfile: "workspace" });
    const result = await delegateToMuseMsp(f.req);
    expect(result).toMatchObject({ text: "Completed native turn", isError: false, sessionId: "0198f0aa-1111-7000-8000-0000000000aa", details: { transport: "msp", model: "effective-native-model", effort: "high", terminal: "completed" } });
    const calls = f.calls();
    expect(calls[0].params).toMatchObject({ clientInfo: { name: "agent_bridge" }, capabilities: { experimentalApi: false, userInputDialogs: false } });
    expect(calls[1].method).toBe("initialized");
    expect(calls.find((m) => m.method === "session/start").params).toMatchObject({ workspaceRoot: f.cwd, approvalMode: "promptUnmatched", modelId: "chosen-model", permissionProfile: "workspace" });
    expect(calls.find((m) => m.method === "turn/start").params).toMatchObject({ reasoningEffort: "high", ifBusy: "queue", input: [{ type: "text", text: "Complete this task" }] });
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onInfo).toHaveBeenCalledWith(expect.objectContaining({ model: "effective-native-model" }));
    expect(onSpawn).toHaveBeenCalledOnce();
    expect(alive(onSpawn.mock.calls[0]![0])).toBe(false);
    expect(calls.filter((m) => m.params?.commandId).every((m) => /^[0-9a-f-]{14}7[0-9a-f-]+$/.test(m.params.commandId))).toBe(true);
  });

  it("resumes the requested identity and reapplies approval mode and model before submitting", async () => {
    const f = fixture({ sessionId: "0198f0aa-2222-7000-8000-0000000000aa", access: "ask", model: "new-model", effort: "medium" });
    const result = await delegateToMuseMsp(f.req);
    expect(result.sessionId).toBe(f.req.sessionId);
    const calls = f.calls();
    expect(calls.find((m) => m.method === "session/resume").params).toMatchObject({ sessionId: f.req.sessionId, excludeItems: true });
    expect(calls.find((m) => m.method === "session/setApprovalMode").params.mode).toBe("promptUnmatched");
    expect(calls.find((m) => m.method === "session/setModel").params.model).toEqual({ modelId: "new-model" });
    expect(calls.map((m) => m.method)).toEqual(["initialize", "initialized", "session/resume", "session/setApprovalMode", "session/setModel", "turn/start"]);
  });

  it("rejects a resume that acknowledges but does not apply the requested approval mode", async () => {
    const f = fixture({ sessionId: "saved", access: "ask" }, { MSP_TEST_APPROVAL_MODE: "allowAll" });
    await expect(delegateToMuseMsp(f.req)).rejects.toMatchObject({ startupFailed: true, sessionId: "saved" });
    expect(f.calls().some((m) => m.method === "turn/start")).toBe(false);
  });

  it("fails before submitting when a resumed profile cannot be verified on the stable surface", async () => {
    const f = fixture({ sessionId: "saved", permissionProfile: "read-only" });
    await expect(delegateToMuseMsp(f.req)).rejects.toMatchObject({ startupFailed: true, sessionId: "saved" });
    expect(f.calls().some((m) => m.method === "turn/start")).toBe(false);
  });

  it.each([undefined, "saved"])("proves a committed named profile by session/read (%s)", async (sessionId) => {
    const f = fixture({ sessionId, permissionProfile: "read-only" }, { MSP_TEST_PROFILE_READ: "1", MSP_TEST_PROFILE: "read-only" });
    await delegateToMuseMsp(f.req);
    expect(f.calls().find((m) => m.method === "session/read").params).toMatchObject({ excludeItems: true });
    expect(f.calls().some((m) => m.method === "turn/start")).toBe(true);
  });

  it("rejects a silently ignored or mismatched initial permission profile before submitting", async () => {
    const f = fixture({ permissionProfile: "read-only" }, { MSP_TEST_PROFILE: "full" });
    await expect(delegateToMuseMsp(f.req)).rejects.toMatchObject({ startupFailed: true, sessionId: "0198f0aa-1111-7000-8000-0000000000aa" });
    expect(f.calls().some((m) => m.method === "turn/start")).toBe(false);
  });

  it.each([
    [],
    [{ enabled: false, event: "preToolUse", handlerKind: "plugin", key: "agent-bridge:PreToolUse:0" }],
    [{ enabled: true, event: "preToolUse", handlerKind: "plugin", key: "unrelated-plugin:PreToolUse:0" }],
    [{ enabled: true, event: "permissionRequest", handlerKind: "plugin", key: "agent-bridge:PermissionRequest:0" }],
    [{ enabled: true, event: "preToolUse", handlerKind: "project", key: "agent-bridge:PreToolUse:0" }],
  ].map((hooks) => ({ hooks })))("refuses missing or ineffective native permission hooks before paid submission ($hooks)", async ({ hooks }) => {
    const f = fixture({ requirePermissionHooks: true }, { MSP_TEST_HOOKS: JSON.stringify(hooks) });
    await expect(delegateToMuseMsp(f.req)).rejects.toMatchObject({ startupFailed: true });
    expect(f.calls().some((m) => m.method === "turn/start")).toBe(false);
  });

  it("accepts an enabled native agent-bridge preToolUse plugin hook", async () => {
    const f = fixture({ requirePermissionHooks: true });
    await expect(delegateToMuseMsp(f.req)).resolves.toMatchObject({ isError: false });
    expect(f.calls().find((m) => m.method === "hook/list").params).toEqual({ sessionId: "0198f0aa-1111-7000-8000-0000000000aa" });
  });

  it.each(["early", "queued", "foreign"])("handles %s notifications without assuming event order or treating foreign turns as ours", async (mode) => {
    const f = fixture({}, { MSP_TEST_MODE: mode });
    await expect(delegateToMuseMsp(f.req)).resolves.toMatchObject({ isError: false, text: "Completed native turn" });
  });

  it("injects live messages with an exact turn guard and reports the native response", async () => {
    let steering: MuseSteering | null = null;
    const onAnswer = vi.fn();
    const f = fixture({ live: { from: "parent", onSteering: (value) => { steering = value; }, onAnswer } }, { MSP_TEST_MODE: "hold" });
    const run = delegateToMuseMsp(f.req);
    await until(() => steering !== null);
    expect(await steering!.send("Please explain progress")).toBe(true);
    await expect(run).resolves.toMatchObject({ text: "Completed native turn" });
    const steer = f.calls().find((m) => m.method === "turn/steer");
    expect(steer.params.expectedTurnId).toBe(f.calls().find((m) => m.method === "turn/start").params.commandId);
    expect(steer.params.input[0].text).toContain("Please explain progress");
    expect(onAnswer).toHaveBeenCalledWith("Completed native turn");
    expect(steering).toBeNull();
  });

  it("returns false for unsupported live steering without pretending the message was sent", async () => {
    let steering: MuseSteering | null = null;
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal, live: { from: "parent", onSteering: (value) => { steering = value; }, onAnswer: vi.fn() } }, { MSP_TEST_MODE: "hold", MSP_TEST_UNSUPPORTED: "turn/steer" });
    const run = delegateToMuseMsp(f.req); run.catch(() => {});
    await until(() => steering !== null);
    expect(await steering!.send("change task")).toBe(false);
    controller.abort();
    await expect(run).rejects.toMatchObject({ kind: "aborted" });
  });

  it.each(["session/start", "session/setApprovalMode", "turn/start"])("reports unsupported %s without replaying the task or changing transport", async (method) => {
    const f = fixture(method === "session/setApprovalMode" ? { sessionId: "saved" } : {}, { MSP_TEST_UNSUPPORTED: method });
    await expect(delegateToMuseMsp(f.req)).rejects.toMatchObject({ kind: "failed", startupFailed: method !== "turn/start" });
    const calls = f.calls();
    expect(calls.filter((m) => m.method === "turn/start")).toHaveLength(method === "turn/start" ? 1 : 0);
    expect(calls.map((m) => m.method)).not.toContain("session/create");
  });

  it("negotiates sessionMcp and passes explicit parent environment to a sanitized child server", async () => {
    const sessionConfig = { mcpServers: { bridge: { transport: "stdio" as const, command: "bridge", env: { AGENT_BRIDGE_PARENT_JOB: "owner", AGENT_BRIDGE_ROOT_SESSION: "root" } } } };
    const f = fixture({ sessionConfig });
    await delegateToMuseMsp(f.req);
    expect(f.calls()[0].params.capabilities.requestedCapabilities).toEqual(["sessionMcp"]);
    expect(f.calls().find((m) => m.method === "session/start").params.config).toEqual(sessionConfig);
  });

  it("fails before session creation if required sessionMcp is not granted", async () => {
    const f = fixture({ sessionConfig: { mcpServers: { bridge: { transport: "stdio", command: "bridge" } } } }, { MSP_TEST_NO_MCP: "1" });
    await expect(delegateToMuseMsp(f.req)).rejects.toMatchObject({ startupFailed: true });
    expect(f.calls()).toHaveLength(1);
  });

  it("preserves startup deadlines and does not submit a paid turn after a stalled session start", async () => {
    const f = fixture({ startupTimeoutMs: 80 }, { MSP_TEST_HANG: "session/start" });
    await expect(delegateToMuseMsp(f.req)).rejects.toMatchObject({ startupFailed: true });
    expect(f.calls().some((m) => m.method === "turn/start")).toBe(false);
  });

  it("marks an unanswered turn admission as unsafe to replay and preserves the session", async () => {
    const f = fixture({ startupTimeoutMs: 100 }, { MSP_TEST_HANG: "turn/start" });
    await expect(delegateToMuseMsp(f.req)).rejects.toMatchObject({ startupFailed: false, sessionId: "0198f0aa-1111-7000-8000-0000000000aa" });
    expect(f.calls().filter((m) => m.method === "turn/start")).toHaveLength(1);
  });

  it("fails on a mismatched command echo without replaying the submitted input", async () => {
    const f = fixture({}, { MSP_TEST_BAD_ACK: "1" });
    await expect(delegateToMuseMsp(f.req)).rejects.toMatchObject({ startupFailed: false, sessionId: "0198f0aa-1111-7000-8000-0000000000aa" });
    expect(f.calls().filter((m) => m.method === "turn/start")).toHaveLength(1);
  });

  it.each(["failure", "crash", "gap", "malformed"])("propagates %s with native session identity and cleans the owned process", async (mode) => {
    const onSpawn = vi.fn();
    const f = fixture({ onSpawn }, { MSP_TEST_MODE: mode });
    await expect(delegateToMuseMsp(f.req)).rejects.toMatchObject({ kind: "failed", startupFailed: false, sessionId: "0198f0aa-1111-7000-8000-0000000000aa" });
    expect(alive(onSpawn.mock.calls[0]![0])).toBe(false);
  });

  it("cancels during a real tool process, preserving abort identity and cleaning both processes", async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal }, { MSP_TEST_MODE: "cancel" });
    f.req.extraEnv!.MSP_TEST_TOOL_PID = join(f.cwd, "tool.pid");
    const run = delegateToMuseMsp(f.req); run.catch(() => {});
    await until(() => existsSync(join(f.cwd, "tool.pid")));
    controller.abort();
    await expect(run).rejects.toMatchObject({ kind: "aborted", sessionId: "0198f0aa-1111-7000-8000-0000000000aa" });
    const call = f.calls().find((m) => m.method === "turn/cancel");
    expect(call.params.turnId).toBe(f.calls().find((m) => m.method === "turn/start").params.commandId);
    expect(alive(Number(readFileSync(join(f.cwd, "host.pid"), "utf8")))).toBe(false);
    await until(() => !alive(Number(readFileSync(join(f.cwd, "tool.pid"), "utf8"))));
  });

  it.skipIf(process.platform === "win32")("cleans an owned tool group even if its host exits before the tool", async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal }, { MSP_TEST_MODE: "orphan" });
    f.req.extraEnv!.MSP_TEST_TOOL_PID = join(f.cwd, "tool.pid");
    const run = delegateToMuseMsp(f.req); run.catch(() => {});
    await until(() => existsSync(join(f.cwd, "tool.pid")));
    controller.abort();
    await expect(run).rejects.toMatchObject({ kind: "aborted" });
    await until(() => !alive(Number(readFileSync(join(f.cwd, "tool.pid"), "utf8"))));
  });

  it("bounds cleanup when the host ignores cancellation, stdin EOF and SIGTERM", async () => {
    const f = fixture({ timeoutSec: 0.15 }, { MSP_TEST_MODE: "stubborn" });
    const start = Date.now();
    await expect(delegateToMuseMsp(f.req)).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - start).toBeLessThan(5000);
    expect(alive(Number(readFileSync(join(f.cwd, "host.pid"), "utf8")))).toBe(false);
    expect(f.calls().some((m) => m.method === "turn/cancel")).toBe(true);
  });

  it("rejects already-aborted requests and depth violations without spawning", async () => {
    const controller = new AbortController(); controller.abort();
    const onSpawn = vi.fn();
    const f = fixture({ signal: controller.signal, onSpawn });
    await expect(delegateToMuseMsp(f.req)).rejects.toMatchObject({ kind: "aborted" });
    vi.stubEnv(DELEGATE_DEPTH_ENV, "4");
    await expect(delegateToMuseMsp({ ...f.req, signal: undefined, maxDelegateDepth: 4 })).rejects.toMatchObject({ kind: "depth" });
    expect(onSpawn).not.toHaveBeenCalled();
  });
});

describe("Muse no-turn queries", () => {
  it("reads native models without constructing a session or starting a provider turn", async () => {
    const f = fixture();
    const response = await museMspQuery({ ...f.req, method: "model/list" });
    expect(response.models).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: "muse-large-2", providerId: "muse" })]));
    expect(f.calls().map((m) => m.method)).toEqual(["initialize", "initialized", "model/list"]);
    expect(f.calls()[2].params).toEqual({});
    expect(alive(Number(readFileSync(join(f.cwd, "host.pid"), "utf8")))).toBe(false);
  });

  it("preserves truthful absence from usage/read rather than fabricating quota", async () => {
    const f = fixture();
    await expect(museMspQuery({ ...f.req, method: "usage/read" })).resolves.toEqual({});
    expect(f.calls().map((m) => m.method)).toEqual(["initialize", "initialized", "usage/read"]);
  });

  it("forwards model query params and preserves unsupported-method errors", async () => {
    const f = fixture({}, { MSP_TEST_UNSUPPORTED: "model/list" });
    await expect(museMspQuery({ ...f.req, method: "model/list", params: { sessionId: "saved" } })).rejects.toMatchObject({ message: expect.stringContaining("Method not found"), rpcCode: -32601, rpcMethod: "model/list" });
    expect(f.calls()[2].params).toEqual({ sessionId: "saved" });
    expect(f.calls().some((m) => m.method === "turn/start" || m.method === "session/start")).toBe(false);
  });

  it("rejects a runtime attempt to use the no-turn helper for a turn command", async () => {
    const onSpawn = vi.fn(), f = fixture({ onSpawn });
    await expect(museMspQuery({ ...f.req, method: "turn/start" as "model/list" })).rejects.toThrow("does not support");
    expect(onSpawn).not.toHaveBeenCalled();
  });
});

describe("Muse approval decisions", () => {
  it.each([
    { kind: "fileAccess", path: "/tmp/write", access: "write" },
    { kind: "shell", command: "rm -rf work" },
    { kind: "tool", toolName: "mcp_external_publish" },
    { kind: "network", host: "external" },
  ])("read-only denies $kind even when the supervisor could approve", async (subject) => {
    const approve = vi.fn().mockResolvedValue({ allow: true });
    const f = fixture({ access: "read", canApprove: true, approve }, { MSP_TEST_MODE: "approval", MSP_TEST_SUBJECT: JSON.stringify(subject) });
    await delegateToMuseMsp(f.req);
    const calls = f.calls();
    expect(calls.find((m) => m.id === 1000 && !m.method).result).toEqual({ received: true });
    expect(calls.find((m) => m.method === "approval/decide").params).toMatchObject({ choiceId: "abort", feedback: expect.stringContaining("read-only"), requirementId: { sourceIndex: 0 } });
    expect(approve).not.toHaveBeenCalled();
  });

  it.each([true, false])("ask relays a decision (%s) using a one-time choice and requirement guard", async (allow) => {
    const approve = vi.fn().mockResolvedValue({ allow, message: "supervisor decision" }), onDenied = vi.fn();
    const f = fixture({ access: "ask", canApprove: true, approve, onDenied }, { MSP_TEST_MODE: "approval" });
    await delegateToMuseMsp(f.req);
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ agent: "muse", tool: "fileAccess", cwd: f.cwd, detail: expect.stringContaining("write_file") }));
    expect(f.calls().find((m) => m.method === "approval/decide").params.choiceId).toBe(allow ? "allow_once" : "abort");
    expect(onDenied).toHaveBeenCalledTimes(allow ? 0 : 1);
  });

  it("ask denies without canApprove and never silently grants persistent approval", async () => {
    const approve = vi.fn().mockResolvedValue({ allow: true });
    const f = fixture({ access: "ask", approve, canApprove: false }, { MSP_TEST_MODE: "approval" });
    await delegateToMuseMsp(f.req);
    expect(f.calls().find((m) => m.method === "approval/decide").params.choiceId).toBe("abort");
    expect(approve).not.toHaveBeenCalled();
  });

  it("edit permits workspace file access and relays external writes", async () => {
    for (const within of [true, false]) {
      const approve = vi.fn().mockResolvedValue({ allow: false });
      const f = fixture({ access: "edit", canApprove: true, approve }, { MSP_TEST_MODE: "approval" });
      f.req.extraEnv!.MSP_TEST_SUBJECT = JSON.stringify({ kind: "fileAccess", access: "write", path: within ? join(f.cwd, "new.txt") : join(tmpdir(), "outside.txt") });
      await delegateToMuseMsp(f.req);
      expect(f.calls().find((m) => m.method === "approval/decide").params.choiceId).toBe(within ? "allow_once" : "abort");
      expect(approve).toHaveBeenCalledTimes(within ? 0 : 1);
    }
  });

  it("denies unknown subjects under full access unless the supervisor decides", async () => {
    const f = fixture({ access: "full" }, { MSP_TEST_MODE: "approval", MSP_TEST_SUBJECT: JSON.stringify({ kind: "future-danger" }) });
    await delegateToMuseMsp(f.req);
    expect(f.calls().find((m) => m.method === "approval/decide").params.choiceId).toBe("abort");
  });

  it("deduplicates reissued approval requests while acknowledging every presentation", async () => {
    const approve = vi.fn().mockResolvedValue({ allow: true });
    const f = fixture({ access: "ask", canApprove: true, approve }, { MSP_TEST_MODE: "approval", MSP_TEST_DUPLICATE: "1" });
    await delegateToMuseMsp(f.req);
    expect(approve).toHaveBeenCalledOnce();
    expect(f.calls().filter((m) => m.method === "approval/decide")).toHaveLength(1);
    expect(f.calls().filter((m) => !m.method && m.result?.received)).toHaveLength(2);
  });

  it("sends a denial when forwarding the approval throws", async () => {
    const f = fixture({ access: "ask", canApprove: true, approve: vi.fn().mockRejectedValue(new Error("relay closed")) }, { MSP_TEST_MODE: "approval" });
    await delegateToMuseMsp(f.req);
    expect(f.calls().find((m) => m.method === "approval/decide").params).toMatchObject({ choiceId: "abort", feedback: expect.stringContaining("relay closed") });
  });

  it("fails safely if the host offers no safe approval choice", async () => {
    const f = fixture({ access: "read" }, { MSP_TEST_MODE: "approval", MSP_TEST_NO_CHOICES: "1" });
    await expect(delegateToMuseMsp(f.req)).rejects.toMatchObject({ kind: "failed", startupFailed: false });
    expect(f.calls().some((m) => m.method === "approval/decide")).toBe(false);
    expect(f.calls().some((m) => m.method === "turn/cancel")).toBe(true);
  });

  it("cancels without waiting on an unresponsive supervisor approval", async () => {
    const controller = new AbortController(), approve = vi.fn(() => new Promise<never>(() => {}));
    const f = fixture({ access: "ask", canApprove: true, approve, signal: controller.signal }, { MSP_TEST_MODE: "approval" });
    const run = delegateToMuseMsp(f.req); run.catch(() => {});
    await until(() => approve.mock.calls.length === 1);
    controller.abort();
    await expect(run).rejects.toMatchObject({ kind: "aborted" });
    expect(f.calls().some((m) => m.method === "approval/decide")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("edit refuses files whose existing parent symlink escapes the workspace", async () => {
    const approve = vi.fn().mockResolvedValue({ allow: false });
    const f = fixture({ access: "edit", canApprove: true, approve }, { MSP_TEST_MODE: "approval" });
    const outside = mkdtempSync(join(tmpdir(), "ab-muse-outside-")); dirs.push(outside);
    symlinkSync(outside, join(f.cwd, "escape"));
    f.req.extraEnv!.MSP_TEST_SUBJECT = JSON.stringify({ kind: "fileAccess", access: "write", path: join(f.cwd, "escape", "new-file") });
    await delegateToMuseMsp(f.req);
    expect(f.calls().find((m) => m.method === "approval/decide").params.choiceId).toBe("abort");
    expect(approve).toHaveBeenCalledOnce();
  });
});
