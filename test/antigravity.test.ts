import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { delegateToAntigravity, parseAntigravityJsonl } from "../src/core/antigravity.js";
import { DelegateError, retryTransient } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import { antigravityPermission, antigravityHookOutput } from "../src/cli/antigravity-hook.js";
import { installAntigravity, uninstallAntigravity } from "../src/cli/antigravity-install.js";
import { readTranscript, listNativeSubagents } from "../src/core/transcripts/index.js";
import { antigravityItems } from "../src/core/transcripts/antigravity.js";
import { changedJobArgs, parseJobSettings } from "../src/mcp/job-settings.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { DELEGATION_TARGETS, supportsAsk } from "../src/mcp/targets.js";
import { isAutoApproved, isHandoffToolCall } from "../src/core/tool-allow.js";
import { delegationTargets } from "../src/mcp/server.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), ask: vi.fn() }));
vi.mock("../src/core/delegate.js", async (original) => ({ ...await original<typeof import("../src/core/delegate.js")>(), runProcess: mocks.run }));
vi.mock("../src/core/relay.js", async (original) => ({ ...await original<typeof import("../src/core/relay.js")>(), askRelay: mocks.ask }));
vi.mock("../src/core/antigravity-plugin.js", async (original) => ({ ...await original<typeof import("../src/core/antigravity-plugin.js")>(), requireAntigravityPlugin: vi.fn() }));
const temporary: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "ab-agy-")); temporary.push(dir); return dir; };
afterEach(() => { vi.clearAllMocks(); for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stream = (status = "SUCCESS") => [
  { event: "init", conversation_id: "saved", init: { model: "example" } },
  { event: "step_update", step_update: { conversation_id: "saved", text_delta: "earlier draft" } },
  { event: "result", result: { conversation_id: "saved", status, response: "final answer", usage: { total_tokens: 12 } } },
].map((row) => JSON.stringify(row)).join("\n");

describe("Antigravity delegation", () => {
  it("uses the result envelope, reports native failures and preserves session identity", () => {
    expect(parseAntigravityJsonl(stream())).toMatchObject({ sessionId: "saved", text: "final answer", isError: false, details: { usage: { total_tokens: 12 } } });
    expect(parseAntigravityJsonl(stream("ERROR")).isError).toBe(true);
    expect(parseAntigravityJsonl(JSON.stringify({ event: "result", result: { conversation_id: "saved", status: "SUCCESS", response: "", denied_actions: [{ action: "mcp" }] } }))).toMatchObject({ isError: true, text: "Antigravity denied permissions: mcp" });
    expect(parseAntigravityJsonl('noise\n{"event":"init","conversation_id":"saved"}\n{')).toMatchObject({ sessionId: "saved", isError: true });
  });
  it("passes model, effort, sandbox and resume without shell interpolation", async () => {
    mocks.run.mockImplementation(async (opts) => { for (const line of stream().split("\n")) opts.onLine(line); return { code: 0, stdout: stream(), stderr: "" }; });
    const onSession = vi.fn(), signal = new AbortController().signal;
    const result = await delegateToAntigravity({ bin: "agy", prompt: 'literal $() "text"', cwd: temp(), sessionId: "previous", model: "example", effort: "high", access: "read", sandbox: true, autoApprove: true, timeoutSec: 20, log: nullLogger, onSession, signal });
    const opts = mocks.run.mock.calls[0]![0];
    expect(opts.args).toEqual(["--output-format", "stream-json", "--input-format", "stream-json", "--print-timeout", "20s", "--conversation", "previous", "--model", "example", "--effort", "high", "--sandbox", "--dangerously-skip-permissions"]);
    expect(JSON.parse(opts.stdin).message.content).toBe('literal $() "text"');
    expect(opts.env.AGENT_BRIDGE_ANTIGRAVITY_ACCESS).toBe("read");
    expect(opts.signal).toBe(signal);
    expect(result.sessionId).toBe("saved");
  });
  it("keeps early conversation ids after cancellation or timeout", async () => {
    mocks.run.mockImplementation(async (opts) => { opts.onLine('{"event":"init","conversation_id":"early"}'); throw new DelegateError("aborted", "aborted"); });
    await expect(delegateToAntigravity({ bin: "agy", prompt: "task", cwd: temp(), access: "read", timeoutSec: 20, log: nullLogger })).rejects.toMatchObject({ kind: "aborted", sessionId: "early" });
  });
  it("rejects unsupported effort before starting a process", async () => {
    await expect(delegateToAntigravity({ bin: "agy", prompt: "task", cwd: temp(), access: "read", effort: "ultra", timeoutSec: 20, log: nullLogger })).rejects.toThrow("low, medium, high, xhigh or max");
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it.each(["result", "stderr"])("resumes transient provider failures from %s on the same native session and model", async (source) => {
    const failure = source === "result"
      ? { code: 0, stdout: JSON.stringify({ event: "result", result: { conversation_id: "saved", status: "ERROR", error: "stream disconnected before completion" } }), stderr: "" }
      : { code: 3, stdout: JSON.stringify({ event: "init", conversation_id: "saved" }), stderr: "stream disconnected before completion" };
    mocks.run.mockResolvedValueOnce(failure).mockResolvedValueOnce({ code: 0, stdout: stream(), stderr: "" });
    const request = { prompt: "task", cwd: temp(), model: "example", timeoutSec: 20, log: nullLogger };
    const result = await retryTransient(request, (req) => delegateToAntigravity({ ...req, bin: "agy", access: "read" }));
    expect(result).toMatchObject({ sessionId: "saved", isError: false, details: { retries: 1 } });
    expect(mocks.run.mock.calls[1]![0].args).toEqual(expect.arrayContaining(["--conversation", "saved", "--model", "example"]));
  });
  it("routes ask mode through the common approval handler instead of an inherited relay", async () => {
    const approve = vi.fn().mockResolvedValue({ allow: true });
    mocks.run.mockImplementation(async (opts) => {
      expect(opts.env.AGENT_BRIDGE_RELAY_URL).not.toBe("http://127.0.0.1:1/inherited");
      const response = await fetch(opts.env.AGENT_BRIDGE_RELAY_URL, { method: "POST", headers: { authorization: `Bearer ${opts.env.AGENT_BRIDGE_RELAY_TOKEN}` }, body: JSON.stringify({ agent: "antigravity", tool: "run_command", detail: "npm test" }) });
      expect(await response.json()).toEqual({ allow: true });
      return { code: 0, stdout: stream(), stderr: "" };
    });
    await delegateToAntigravity({ bin: "agy", prompt: "task", cwd: temp(), access: "ask", timeoutSec: 20, log: nullLogger, approve, extraEnv: { AGENT_BRIDGE_RELAY_URL: "http://127.0.0.1:1/inherited" } });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ tool: "run_command", detail: "npm test" }));
  });
  it("drains an unanswered approval relay when the CLI times out", async () => {
    let entered!: () => void, response!: Promise<unknown>;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const approve = vi.fn(() => { entered(); return new Promise<never>(() => {}); });
    mocks.run.mockImplementation(async (opts) => {
      response = fetch(opts.env.AGENT_BRIDGE_RELAY_URL, { method: "POST", headers: { authorization: `Bearer ${opts.env.AGENT_BRIDGE_RELAY_TOKEN}` }, body: JSON.stringify({ agent: "antigravity", tool: "run_command", detail: "npm test" }) }).then((result) => result.json());
      await waiting;
      throw new DelegateError("timed out", "timeout");
    });
    await expect(delegateToAntigravity({ bin: "agy", prompt: "task", cwd: temp(), access: "ask", timeoutSec: 1, log: nullLogger, approve })).rejects.toMatchObject({ kind: "timeout" });
    expect(await response).toEqual({ allow: false, message: "Antigravity run ended" });
  });
  it("registers shared targets and keeps Antigravity access settings agent-specific", () => {
    expect(delegationTargets("claude")).toContain("antigravity");
    expect(delegationTargets("antigravity")).toEqual(["claude", "codex", "opencode"]);
    expect(DELEGATION_TARGETS.antigravity.permission(DEFAULT_CONFIG, {})).toBe("read");
    expect(supportsAsk("antigravity", undefined)).toBe(true);
    expect(isAutoApproved({ tool: "mcp:pair-desk_pair-desk", detail: "comment: {}" }, ["pair-desk:worker"])).toBe(true);
    expect(isHandoffToolCall({ tool: "mcp:pair-desk_pair-desk", detail: "update_handoff: {}" })).toBe(true);
    expect(parseJobSettings({ terminal_sandbox: true, access: "ask" }, "antigravity")).toEqual({ terminal_sandbox: true, access: "ask" });
    expect(parseJobSettings({ terminal_sandbox: true }, "codex")).toContain("only to antigravity");
    expect(parseJobSettings({ effort: "ultra" }, "antigravity")).toContain("low, medium, high, xhigh or max");
    expect(parseJobSettings({ bypass_permissions: true }, "antigravity")).toEqual({ bypass_permissions: true });
    expect(parseJobSettings({ bypass_permissions: true }, "codex")).toContain("only to antigravity");
    expect(changedJobArgs({ access: "read", terminal_sandbox: true }, { bypass_permissions: true })).toEqual({ terminal_sandbox: true, bypass_permissions: true });
    expect(changedJobArgs({ bypass_permissions: true, terminal_sandbox: true }, { access: "read" })).toEqual({ terminal_sandbox: true, access: "read" });
  });
  it.each([false, true])("honors explicit native approval override=%s and keeps the terminal sandbox", async (bypass) => {
    mocks.run.mockResolvedValue({ code: 0, stdout: stream(), stderr: "" });
    await DELEGATION_TARGETS.antigravity.run(DEFAULT_CONFIG, { prompt: "task", cwd: temp(), timeoutSec: 20, log: nullLogger }, { access: "read", bypass_permissions: bypass, terminal_sandbox: true });
    const opts = mocks.run.mock.calls[0]![0];
    expect(opts.env.AGENT_BRIDGE_ANTIGRAVITY_ACCESS).toBe("edit");
    expect(opts.args.includes("--dangerously-skip-permissions")).toBe(bypass);
    expect(opts.args).toContain("--sandbox");
  });
});

describe("Antigravity hooks", () => {
  it("denies writes and unknown tools in read mode while retaining bridge messaging", async () => {
    expect(await antigravityPermission({ toolCall: { name: "view_file" } }, "read")).toEqual({ decision: "allow" });
    for (const name of ["write_to_file", "run_command", "new_unknown_tool"]) expect(await antigravityPermission({ toolCall: { name } }, "read")).toMatchObject({ decision: "deny" });
    expect(await antigravityPermission({ toolCall: { name: "call_mcp_tool", args: { ServerName: "agent-bridge_agent-bridge", ToolName: "send" } } }, "read")).toEqual({ decision: "allow", permissionOverrides: ["mcp(agent-bridge_agent-bridge/send)"] });
    expect(await antigravityPermission({ toolCall: { name: "call_mcp_tool", args: { ServerName: "other", ToolName: "send" } } }, "read")).toMatchObject({ decision: "deny" });
    expect(await antigravityPermission({ toolCall: { name: "call_mcp_tool", args: { ServerName: "agent-bridge_agent-bridge", ToolName: "decide" } } }, "read")).toMatchObject({ decision: "allow" });
  });
  it("relays explicit approval and denial without expanding native edit policy", async () => {
    mocks.ask.mockResolvedValueOnce({ allow: true }).mockResolvedValueOnce({ allow: false, message: "owner denied" });
    const input = { toolCall: { name: "run_command", args: { CommandLine: "npm test" } }, workspacePaths: ["/project"] };
    expect(await antigravityPermission(input, "ask")).toEqual({ decision: "allow", permissionOverrides: ["command(npm test)"] });
    expect(await antigravityPermission(input, "ask")).toEqual({ decision: "deny", reason: "owner denied" });
    expect(mocks.ask).toHaveBeenCalledWith(expect.objectContaining({ agent: "antigravity", tool: "run_command", cwd: "/project" }));
    expect(await antigravityPermission(input, "edit")).toEqual({});
    expect(antigravityHookOutput("PreInvocation", "mail")).toEqual({ injectSteps: [{ ephemeralMessage: "mail" }] });
    expect(antigravityHookOutput("Stop", "mail")).toEqual({ decision: "continue", reason: "mail" });
  });
  it("normalizes MCP approvals for shared allow rules and declines handoff writes", async () => {
    mocks.ask.mockResolvedValue({ allow: true });
    const input = { toolCall: { name: "call_mcp_tool", args: { ServerName: "pair-desk", ToolName: "comment", Arguments: { id: "AB-1" } } } };
    expect(await antigravityPermission(input, "ask")).toEqual({ decision: "allow", permissionOverrides: ["mcp(pair-desk/comment)"] });
    expect(mocks.ask).toHaveBeenCalledWith(expect.objectContaining({ tool: "mcp:pair-desk", detail: expect.stringMatching(/^comment:/) }));
    input.toolCall.args.ToolName = "update_handoff";
    for (const access of ["read", "ask", "edit"]) expect(await antigravityPermission(input, access)).toMatchObject({ decision: "deny" });
  });
});

describe("Antigravity retained transcripts and installation", () => {
  it("rejects overlapping plugin installs before changing source files", () => {
    const source = temp();
    writeFileSync(join(source, "plugin.json"), JSON.stringify({ name: "agent-bridge" }));
    writeFileSync(join(source, ".agent-bridge-owned"), "agent-bridge\n");
    const before = readdirSync(source);
    for (const target of [source, join(source, "nested")]) expect(() => installAntigravity(source, target)).toThrow("separate directories");
    expect(readdirSync(source)).toEqual(before);
    expect(readFileSync(join(source, "plugin.json"), "utf8")).toBe(JSON.stringify({ name: "agent-bridge" }));
  });
  it("reads native logs and explicit child links without changing source data", () => {
    const home = temp(), paths = { claude: home, codex: home, opencode: home, antigravity: home };
    const file = (id: string) => join(home, "brain", id, ".system_generated", "logs", "transcript.jsonl");
    const rows = [{ type: "USER_INPUT", content: "question", step_index: 0 }, { type: "GENERIC", source: "MODEL", content: "answer", step_index: 1 }, { type: "PLANNER_RESPONSE", tool_calls: [{ name: "view_file", args: { path: "a" } }], subagent_info: { subagents: [{ conversation_id: "child", role: "review" }] } }];
    for (const id of ["parent", "child", "unrelated"]) { mkdirSync(dirname(file(id)), { recursive: true }); writeFileSync(file(id), rows.map((row) => JSON.stringify(row)).join("\n") + "\n"); }
    const session = { agent: "antigravity" as const, cwd: home, sessionId: "parent" }, before = readFileSync(file("parent"));
    const page = readTranscript(session, "0", undefined, paths)!;
    expect(page.items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "subagent"]);
    expect(readTranscript(session, page.next, undefined, paths)!.items).toEqual([]);
    expect(listNativeSubagents(session, paths)[0]!.id).toBe("child");
    expect(readTranscript(session, "0", "child", paths)).not.toBeNull();
    expect(readTranscript(session, "0", "unrelated", paths)).toBeNull();
    expect(readTranscript({ ...session, sessionId: "../../escape" }, "0", undefined, paths)).toBeNull();
    expect(readFileSync(file("parent"))).toEqual(before);
    expect(antigravityItems({ type: "unknown", content: "internal" })).toEqual([]);
    expect(antigravityItems({ type: "GENERIC", source: "MODEL", content: "Created At: 2026-10-07\nCompleted At: 2026-10-07\npeers result" })).toEqual([expect.objectContaining({ kind: "tool", tool: "result", summary: expect.stringContaining("peers result") })]);
  });
  it("backs up updates and archives uninstall including user additions", () => {
    const root = temp(), source = join(root, "source"), target = join(root, "plugin");
    mkdirSync(source); writeFileSync(join(source, "plugin.json"), '{"name":"agent-bridge"}'); writeFileSync(join(source, "package.json"), '{"version":"0.29.10"}');
    mkdirSync(join(source, "dist"));
    for (const name of ["server.mjs", "worker.mjs", "cli.mjs", "history-worker.mjs"]) writeFileSync(join(source, "dist", name), "// fixture");
    installAntigravity(source, target);
    writeFileSync(join(target, "owner-note.txt"), "keep me");
    writeFileSync(join(source, "package.json"), '{"version":"0.29.11"}');
    installAntigravity(source, target);
    expect(readFileSync(join(target, "owner-note.txt"), "utf8")).toBe("keep me");
    expect(readdirSync(target).some((name) => name.startsWith("package.json.backup-"))).toBe(true);
    expect(JSON.parse(readFileSync(join(target, "mcp_config.json"), "utf8")).mcpServers["agent-bridge"].args.at(-1)).toBe("--agent=antigravity");
    expect(uninstallAntigravity(target).files).toEqual([target]);
    const archive = readdirSync(join(root, "archive")).find((name) => name.startsWith("plugin-"))!;
    expect(readFileSync(join(root, "archive", archive, "owner-note.txt"), "utf8")).toBe("keep me");
  });
  it("refuses to overwrite foreign plugin folders", () => {
    const target = temp(), source = temp(); writeFileSync(join(target, "owner.txt"), "safe");
    expect(() => installAntigravity(source, target)).toThrow("unowned");
    expect(uninstallAntigravity(target).skipped).toEqual([target]);
    expect(readFileSync(join(target, "owner.txt"), "utf8")).toBe("safe");
  });
});
