import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { delegateToOpencode } from "../src/core/delegate.js";
import { resumeArgs, worktreeArgs, type DelegateArgs } from "../src/mcp/delegate-run.js";
import { changedJobArgs, parseJobSettings } from "../src/mcp/job-settings.js";
import { JobManager, type RunnerControl } from "../src/mcp/jobs.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

const BASE: DelegateArgs = { prompt: "task", title: "Settings test", model: "old-model", sandbox: "danger-full-access", effort: "low" };

describe("worktree sandbox defaults", () => {
  const home = join(import.meta.dirname, "bridge-home");
  const cwd = join(home, "worktrees", "repo-job");
  const permission = (a: DelegateArgs, cfg = DEFAULT_CONFIG, dir = cwd) => DELEGATION_TARGETS.codex.permission(cfg, worktreeArgs("codex", a, cfg, dir, home));

  it("keeps plain runs read-only and lets worktrees edit in workspace-write", () => {
    expect(permission({ prompt: "task", title: "test" }, DEFAULT_CONFIG, home)).toBe("read-only");
    expect(permission({ prompt: "task", title: "test", worktree: true }, DEFAULT_CONFIG, home)).toBe("workspace-write");
    expect(permission({ prompt: "task", title: "test" })).toBe("workspace-write");
  });

  it("inherits the configured sandbox and allows a separate worktree default", () => {
    const full = { ...DEFAULT_CONFIG, codexSandbox: "danger-full-access" as const };
    expect(permission({ prompt: "task", title: "test" }, full)).toBe("danger-full-access");
    expect(permission({ prompt: "task", title: "test" }, { ...full, codexWorktreeSandbox: "read-only" })).toBe("read-only");
    expect(permission({ prompt: "task", title: "test" }, { ...DEFAULT_CONFIG, codexWorktreeSandbox: "danger-full-access" })).toBe("danger-full-access");
  });

  it("keeps explicit read and ask safe and honors exact sandbox overrides", () => {
    const full = { ...DEFAULT_CONFIG, codexWorktreeSandbox: "danger-full-access" as const };
    for (const access of ["read", "ask"] as const) expect(permission({ ...BASE, sandbox: undefined, access }, full)).toBe("read-only");
    expect(permission({ ...BASE, sandbox: "workspace-write" }, full)).toBe("workspace-write");
    expect(worktreeArgs("claude", { prompt: "task", title: "test", worktree: true }, full, home, home).sandbox).toBeUndefined();
  });
});

describe("next-turn job settings", () => {
  let env: TestEnv;
  let jobs: JobManager;
  beforeEach(async () => {
    env = makeEnv();
    const node = env.node("claude-settings");
    await node.start();
    jobs = new JobManager(node, nullLogger, join(env.home, "jobs.json"));
  });
  afterEach(async () => {
    jobs.cancelAll();
    await env.cleanup();
  });

  it("persists new settings and removes stale exact overrides from continuations", async () => {
    const job = jobs.start("codex", BASE.model!, BASE.prompt, async () => ({ text: "done", sessionId: "thread-1", isError: false, details: {} }), undefined, { ...BASE });
    await until(() => job.status === "done");
    expect(jobs.setSettings(job.name, { model: "new-model", access: "read", effort: "high", native_subagents: 0 })).toBe(true);
    const args = resumeArgs(BASE, job.name, "continue", job.sessionId!, "/same-folder", null, job.args);
    expect(args).toMatchObject({ model: "new-model", access: "read", effort: "high", native_subagents: 0, session_id: "thread-1", cwd: "/same-folder" });
    expect(args.sandbox).toBeUndefined();
    const restored = new JobManager(env.node("claude-restored"), nullLogger, join(env.home, "jobs.json"));
    restored.restore(() => undefined);
    expect(restored.find(job.name)).toMatchObject({ model: "new-model", args: { model: "new-model", access: "read", effort: "high", native_subagents: 0 } });
    expect(jobs.setSettings("missing", { access: "edit" })).toBe(false);
  });

  it("forwards settings to a detached runner without interrupting its current turn", () => {
    const sent: RunnerControl[] = [];
    jobs.runners = { state: () => null, alive: () => true, send: (_job, control) => sent.push(control), kill: () => {} };
    const run = Object.assign(async () => ({ text: "unused", sessionId: "s", isError: false, details: {} }), { hosted: () => ({ pid: null, peer: "runner", startedAt: Date.now() }) });
    const job = jobs.start("claude", "old-model", "task", run, undefined, { permission_mode: "manual" });
    expect(jobs.setSettings(job.name, { model: "new-model", permission_mode: "bypassPermissions" })).toBe(true);
    expect(sent).toEqual([{ type: "settings", settings: { model: "new-model", permission_mode: "bypassPermissions" } }]);
    expect(job.status).toBe("running");
    expect(job.model).toBe("old-model");
    expect(job.controller.signal.aborted).toBe(false);
  });

  it("replaces generic access with exact permission settings, including false auto-approval", () => {
    expect(changedJobArgs({ access: "read", model: "old" }, { sandbox: "danger-full-access" })).toEqual({ model: "old", sandbox: "danger-full-access" });
    expect(changedJobArgs({ access: "edit", auto_approve: true }, { auto_approve: false })).toEqual({ auto_approve: false });
    expect(changedJobArgs({ permission_mode: "bypassPermissions", auto_approve: true }, { access: "ask" })).toEqual({ access: "ask" });
  });
});

describe("opencode resumed settings", () => {
  it("changes model and approval flags while retaining the same session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-opencode-settings-"));
    const script = join(dir, "fake.mjs");
    writeFileSync(script, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(new URL("calls.jsonl", import.meta.url), JSON.stringify({ args, config: process.env.OPENCODE_CONFIG_CONTENT }) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => console.log(JSON.stringify({ type: "text", sessionID: "same-session", part: { messageID: "m", text: "done" } })));
`);
    const bin = process.platform === "win32" ? join(dir, "opencode.cmd") : script;
    if (process.platform === "win32") writeFileSync(bin, '@ECHO off\r\n"%dp0%\\fake.mjs" %*\r\n');
    else chmodSync(script, 0o755);
    try {
      const first = { prompt: "task", title: "opencode test", model: "provider/old-model", auto_approve: true };
      const run = (a: DelegateArgs, sessionId: string | null) => delegateToOpencode({ bin, cwd: dir, prompt: a.prompt, sessionId, model: a.model, autoApprove: a.auto_approve ?? false, timeoutSec: 30, log: nullLogger });
      const result = await run(first, null);
      const saved = changedJobArgs(first, { model: "provider/new-model", auto_approve: false });
      const next = resumeArgs(first, "opencode-job-test", "continue", result.sessionId!, dir, null, saved);
      await run(next, next.session_id!);
      const calls = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls[0].args).toContain("--auto");
      expect(calls[1].args).toEqual(expect.arrayContaining(["-m", "provider/new-model", "-s", "same-session"]));
      expect(calls[1].args).not.toContain("--auto");
      expect(JSON.parse(calls[1].config).permission).toMatchObject({ edit: "ask", bash: "ask" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings from the dashboard", () => {
  it("accepts the values message_subagent accepts", () => {
    expect(parseJobSettings({ model: "gpt-6-luna", effort: "low", sandbox: "read-only" }, "codex")).toEqual({ model: "gpt-6-luna", effort: "low", sandbox: "read-only" });
    expect(parseJobSettings({ permission_mode: "plan", access: "read" }, "claude")).toEqual({ permission_mode: "plan", access: "read" });
    expect(parseJobSettings({ auto_approve: false }, "opencode")).toEqual({ auto_approve: false });
  });

  it("rejects other agents' permission keys, bad values, unknown keys and nothing", () => {
    expect(parseJobSettings({ sandbox: "read-only" }, "claude")).toBe("sandbox applies only to codex jobs.");
    expect(parseJobSettings({ auto_approve: "yes" }, "opencode")).toBe("invalid auto_approve");
    expect(parseJobSettings({ model: "a b" }, "codex")).toBe("invalid model");
    expect(parseJobSettings({ effort: "x".repeat(21) }, "codex")).toBe("invalid effort");
    expect(parseJobSettings({ sandbox: "everything" }, "codex")).toBe("invalid sandbox");
    expect(parseJobSettings({ prompt: "x" }, "codex")).toBe("unknown setting: prompt");
    expect(parseJobSettings({}, "codex")).toBe("no settings given");
    expect(parseJobSettings(null, "codex")).toBe("settings must be an object");
  });
});
