import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { delegateToMuse, parseMuseJsonl, musePromptFile, museEnvSessionId } from "../src/core/muse.js";
import { DelegateError, unwrapNpmShim } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { DELEGATION_TARGETS, supportsAsk } from "../src/mcp/targets.js";
import { delegationTargets } from "../src/mcp/server.js";
import { parseJobSettings } from "../src/mcp/job-settings.js";
import { museMspQuery } from "../src/core/muse-msp.js";
import { describeModels } from "../src/core/models.js";
import { museItems } from "../src/core/transcripts/muse.js";
import { listNativeSubagents, readTranscript } from "../src/core/transcripts/index.js";
import { planFor, describeStep } from "../src/cli/installer.js";
import { musePluginArgs } from "../src/cli/muse-install.js";
import { historyFiltersSchema } from "../src/core/history.js";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/core/delegate.js", async (original) => ({ ...await original<typeof import("../src/core/delegate.js")>(), runProcess: mocks.run }));
vi.mock("../src/core/muse-msp.js", () => ({ museMspQuery: vi.fn(), delegateToMuseMsp: vi.fn() }));
const temporary: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "ab-muse-")); temporary.push(dir); return dir; };
afterEach(() => { vi.clearAllMocks(); for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Records in the shape `muse exec --json --provider echo` emits (verified against Muse 1.4.7). */
const record = (sequence: number, payloadType: string, payload: Record<string, unknown>, session = "sess-1") =>
  JSON.stringify({ schema_version: 1, id: `id-${sequence}`, stream: { kind: "session", id: session }, sequence, recorded_at: sequence, record_type: "event", durability: "durable", causation_id: "cmd-1", payload_type: payloadType, payload_schema_version: 1, payload });
const stream = (terminal = "completed", text = "echo: hi") => [
  record(1, "run.lifecycle.started", { kind: "run_started", command_id: "cmd-1" }),
  record(2, "run.output.delta", { kind: "run_output_delta", command_id: "cmd-1", text: "echo: " }),
  record(3, "run.output.delta", { kind: "run_output_delta", command_id: "cmd-1", text: "hi" }),
  record(4, "run.terminal.completed", { kind: "run_terminal", command_id: "cmd-1", terminal, text, reason: null }),
].join("\n");
const failedStream = () => [
  record(1, "run.lifecycle.started", { kind: "run_started", command_id: "cmd-1" }),
  record(2, "task.lifecycle.failed", { kind: "task_lifecycle", command_id: "cmd-1", event: { kind: "failed", task_id: "t1", reason: "provider does not support base instructions" } }),
  record(3, "run.terminal.completed", { kind: "run_terminal", command_id: "cmd-1", terminal: "failed", text: "", reason: "provider does not support base instructions" }),
].join("\n");

describe("Muse delegation", () => {
  it("removes only owned prompt scratch on partial creation failure and keeps the original error", () => {
    const error = new Error("fixture prompt write failed");
    let file = "";
    expect(() => musePromptFile("private prompt", ((path: any) => { file = String(path); writeFileSync(file, "partial"); throw error; }) as typeof writeFileSync)).toThrow(error);
    expect(existsSync(dirname(file))).toBe(false);
  });
  it("binds only a validated host session, never its native thread identity", () => {
    expect(museEnvSessionId({ MUSE_SESSION_ID: "native-root", MUSE_THREAD_ID: "child" })).toBe("native-root");
    expect(museEnvSessionId({ MUSE_THREAD_ID: "child" })).toBeNull();
    expect(museEnvSessionId({ MUSE_SESSION_ID: "../../foreign" })).toBeNull();
  });
  it("parses the terminal record, session id and output deltas", () => {
    expect(parseMuseJsonl(stream())).toMatchObject({ sessionId: "sess-1", text: "echo: hi", isError: false, details: { terminal: "completed" } });
    expect(parseMuseJsonl(failedStream())).toMatchObject({ sessionId: "sess-1", text: "", isError: true, details: { terminal: "failed", error: "provider does not support base instructions" } });
    expect(parseMuseJsonl("noise\n{")).toMatchObject({ sessionId: null, text: "", isError: true });
    // A completed run that only streamed deltas still yields its text.
    const noTerminalText = [record(1, "run.output.delta", { kind: "run_output_delta", text: "part" }), record(2, "run.terminal.completed", { kind: "run_terminal", terminal: "completed", text: "", reason: null })].join("\n");
    expect(parseMuseJsonl(noTerminalText).text).toBe("part");
  });

  it("passes prompt by file, maps model/effort/session and enforces read access", async () => {
    let promptSeen = "";
    mocks.run.mockImplementation(async (opts) => {
      promptSeen = readFileSync(opts.args[3] as string, "utf8");
      for (const line of stream().split("\n")) opts.onLine(line);
      return { code: 0, stdout: stream(), stderr: "" };
    });
    const onSession = vi.fn();
    const cwd = temp();
    const result = await delegateToMuse({ bin: "muse", prompt: 'literal $() "text"', cwd, sessionId: "previous", model: "muse-spark-1.3", effort: "high", access: "read", timeoutSec: 20, log: nullLogger, onSession });
    const opts = mocks.run.mock.calls[0]![0];
    expect(opts.stdin).toBe("");
    expect(opts.args.slice(0, 3)).toEqual(["exec", "--json", "--prompt-file"]);
    const promptFile = opts.args[3] as string;
    expect(promptSeen).toBe('literal $() "text"');
    expect(opts.args).toEqual(expect.arrayContaining(["--workspace", cwd, "--session-id", "previous", "--model", "muse-spark-1.3", "--reasoning-effort", "high", "--disable-write", "--disable-shell", "--approval-mode", "never"]));
    expect(result).toMatchObject({ sessionId: "sess-1", text: "echo: hi", isError: false });
    expect(onSession).toHaveBeenCalledWith("sess-1");
    // The prompt file is bridge-owned scratch and is removed after the run.
    expect(existsSync(promptFile)).toBe(false);
  });

  it("edit access disables approval prompts instead of read-only switches", async () => {
    mocks.run.mockResolvedValue({ code: 0, stdout: stream(), stderr: "" });
    await delegateToMuse({ bin: "muse", prompt: "task", cwd: temp(), access: "edit", timeoutSec: 20, log: nullLogger });
    const args = mocks.run.mock.calls[0]![0].args as string[];
    expect(args).toContain("--disable-approval");
    expect(args).not.toContain("--disable-write");
  });

  it("a permission profile replaces the approval flags muse exec refuses to combine", async () => {
    mocks.run.mockResolvedValue({ code: 0, stdout: stream(), stderr: "" });
    await delegateToMuse({ bin: "muse", prompt: "task", cwd: temp(), access: "read", permissionProfile: "dev", timeoutSec: 20, log: nullLogger });
    const args = mocks.run.mock.calls[0]![0].args as string[];
    expect(args).toContain("--permission-profile");
    expect(args).toContain("--disable-write");
    expect(args).not.toContain("--approval-mode");
    expect(args).not.toContain("--disable-approval");
  });

  it("reports native failure text and keeps the session for resuming", async () => {
    mocks.run.mockResolvedValue({ code: 0, stdout: failedStream(), stderr: "" });
    await expect(delegateToMuse({ bin: "muse", prompt: "task", cwd: temp(), access: "read", timeoutSec: 20, log: nullLogger }))
      .rejects.toMatchObject({ message: "provider does not support base instructions", sessionId: "sess-1" });
  });

  it("keeps the early session id when the process fails to start a terminal record", async () => {
    mocks.run.mockImplementation(async (opts) => { opts.onLine(record(1, "run.lifecycle.started", { kind: "run_started" }, "early")); throw new DelegateError("timed out", "timeout", "", record(1, "run.lifecycle.started", { kind: "run_started" }, "early")); });
    await expect(delegateToMuse({ bin: "muse", prompt: "task", cwd: temp(), access: "read", timeoutSec: 20, log: nullLogger })).rejects.toMatchObject({ kind: "timeout", sessionId: "early" });
  });

  it("rejects unsupported effort before starting a process", async () => {
    await expect(delegateToMuse({ bin: "muse", prompt: "task", cwd: temp(), access: "read", effort: "turbo", timeoutSec: 20, log: nullLogger })).rejects.toThrow("Muse effort must be");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("registers Muse as a shared target with native approval relay support", () => {
    expect(delegationTargets("claude")).toContain("muse");
    expect(delegationTargets("muse")).toEqual(["claude", "codex", "opencode", "antigravity", "muse"]);
    expect(DELEGATION_TARGETS.muse.defaultModel(DEFAULT_CONFIG)).toBeNull();
    expect(DELEGATION_TARGETS.muse.permission(DEFAULT_CONFIG, {})).toBe("read");
    expect(DELEGATION_TARGETS.muse.permission(DEFAULT_CONFIG, { access: "edit" })).toBe("edit");
    expect(supportsAsk("muse", undefined)).toBe(false);
    expect(parseJobSettings({ permission_profile: "dev" }, "muse")).toEqual({ permission_profile: "dev" });
    expect(parseJobSettings({ permission_profile: "dev" }, "codex")).toContain("only to muse");
    expect(parseJobSettings({ effort: "ultra" }, "muse")).toEqual({ effort: "ultra" });
    expect(parseJobSettings({ effort: "turbo" }, "muse")).toContain("Muse effort must be");
  });

  it("loads muse config from file and env", () => {
    const home = temp();
    const cfg = loadConfig(home, "muse", nullLogger, { AGENT_BRIDGE_MUSE_BIN: "muse-custom" } as NodeJS.ProcessEnv);
    expect(cfg.museBin).toBe("muse-custom");
    expect(cfg.museModel).toBeNull();
    expect(DEFAULT_CONFIG.museBin).toBe("muse");
  });

  it("unwraps Muse's PowerShell launcher shim instead of spawning the .cmd", () => {
    const cmd = '@echo off\r\nsetlocal\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*\r\nexit /b %ERRORLEVEL%\r\n';
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const unwrapped = unwrapNpmShim("C:\\Tools\\muse\\muse.cmd", () => cmd)!;
    expect(unwrapped.command).toMatch(/powershell\.exe$/i);
    expect(unwrapped.command).not.toContain("%");
    expect(unwrapped.prefix).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\Tools\\muse\\.muse-launcher.ps1"]);
  });

  it("plans Muse installation through its own plugin manager", () => {
    expect(planFor("muse", "install")).toEqual([{ kind: "muse", action: "install" }]);
    expect(describeStep({ kind: "muse", action: "install" })).toContain("approve");
    expect(musePluginArgs("install", "/src/muse")).toEqual([["plugins", "install", "/src/muse"], ["plugins", "approve", "agent-bridge"]]);
    expect(musePluginArgs("update", "/src/muse")).toEqual([["plugins", "update", "agent-bridge"], ["plugins", "inspect", "agent-bridge"]]);
    expect(musePluginArgs("uninstall", "/src/muse")).toEqual([["plugins", "remove", "agent-bridge"]]);
    expect(historyFiltersSchema.parse({ agent: "muse" }).agent).toBe("muse");
  });

  it("reads Muse session logs, retained frames and native subagent links", () => {
    const home = temp(), paths = { claude: home, codex: home, opencode: home, muse: home };
    const file = join(home, "sessions", "2026", "10", "13", "sess-parent", "session.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    const frame = { retained_frame: "session_permission_transaction", frame_schema_version: 1, children: [{ child_index: 0, record_json: record(1, "turn.input.user", { kind: "turn_input_user", prompt: "wrapped question" }, "sess-parent") }] };
    const rows = [
      JSON.stringify(frame),
      record(2, "turn.input.user", { kind: "turn_input_user", prompt: "question" }, "sess-parent"),
      record(3, "tool_batch.effect.started", { kind: "tool_batch_effect", record: { kind: "started", effect_id: "e1", tool_name: "powershell", call_id: "c1" } }, "sess-parent"),
      record(4, "run.terminal.completed", { kind: "run_terminal", terminal: "completed", text: "final answer", reason: null }, "sess-parent"),
      record(5, "subagent.control.child_session_bound", { kind: "subagent_control", record: { kind: "child_session_bound", subagent_id: "sub-1", child_session_id: "sess-child" } }, "sess-parent"),
    ];
    writeFileSync(file, rows.join("\n") + "\n");
    const session = { agent: "muse" as const, cwd: home, sessionId: "sess-parent" };
    const page = readTranscript(session, "0", undefined, paths)!;
    expect(page.items.map((item) => item.kind)).toEqual(["user", "user", "tool", "assistant", "subagent"]);
    expect(page.items[0]!.text).toBe("wrapped question");
    expect(page.items[3]!.text).toBe("final answer");
    expect(page.items[0]!.at).toBe(1);
    expect(listNativeSubagents(session, paths)[0]!.id).toBe("sess-child");
    expect(readTranscript({ ...session, sessionId: "../../escape" }, "0", undefined, paths)).toBeNull();
    expect(museItems({ type: "unknown" })).toEqual([]);
  });

  it("describes Muse models from the no-turn native catalog", async () => {
    vi.mocked(museMspQuery).mockResolvedValue({ source: "providerCatalog", models: [{ modelId: "muse-test", displayLabel: "Muse test", variants: ["low", "ultra"] }] });
    const lines = await describeModels("muse", DEFAULT_CONFIG, temp(), nullLogger);
    expect(lines[0]).toContain("Muse models (1; source providerCatalog)");
    expect(lines.join("\n")).toContain("ultra");
  });
});
