import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRunLog, watchRunLog } from "../src/cli/watch.js";
import { describeCodexEvent, progressEventHandler } from "../src/core/progress.js";
import { startRunFeed } from "../src/core/runfeed.js";

describe("progress lines", () => {
  it("counts native Antigravity steps once and retains denied tool completions", () => {
    const out: string[] = [], handle = progressEventHandler("antigravity", (message) => out.push(message), () => 0)!;
    const step = { step_index: 1, tool_name: "run_command", tool_info: { parameters: { CommandLine: "npm test" } } };
    handle({ event: "step_update", step_update: { ...step, state: "ACTIVE" } });
    handle({ event: "step_update", step_update: { ...step, state: "DONE" } });
    handle({ event: "step_update", step_update: { ...step, state: "ERROR", tool_info: { error: { message: "pre-tool hook denied" } } } });
    expect(out).toEqual(["0s · step 1 (1 cmds) · run_command: npm test", "0s · step 1 (1 cmds) · run_command failed: pre-tool hook denied"]);
  });
  it("count steps, show elapsed time and what the agent says", () => {
    let t = 0;
    const out: string[] = [];
    const handle = progressEventHandler("opencode", (m) => out.push(m), () => t)!;
    handle({ type: "tool_use", part: { id: "p1", tool: "bash", state: { input: { command: "npm test" } } } });
    t = 125_000;
    handle({ type: "tool_use", part: { id: "p2", tool: "edit", state: { input: { filePath: "src/a.ts" } } } });
    handle({ type: "tool_use", part: { id: "p2", tool: "edit", state: { input: { filePath: "src/a.ts" } } } }); // same part again
    handle({ type: "text", part: { id: "t1", text: "Rooms are in, now the furniture kit." } });
    expect(out).toEqual([
      "0s · step 1 (1 cmds) · bash: npm test",
      "2m · step 2 (1 cmds, 1 edits) · edit: src/a.ts",
      "2m · step 2 (1 cmds, 1 edits) · says: Rooms are in, now the furniture kit.",
    ]);
  });

  it("work for codex and claude streams too", () => {
    const out: string[] = [];
    const codex = progressEventHandler("codex", (m) => out.push(m), () => 0)!;
    codex({ type: "item.started", item: { id: "i1", type: "command_execution", command: "cargo test" } });
    codex({ type: "item.completed", item: { type: "agent_message", text: "All green." } });
    const claude = progressEventHandler("claude", (m) => out.push(m), () => 0)!;
    claude({ type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Edit", input: { file_path: "x.ts" } }] } });
    expect(out).toEqual(["0s · step 1 (1 cmds) · running: cargo test", "0s · step 1 (1 cmds) · says: All green.", "0s · step 1 (1 edits) · Edit: x.ts"]);
  });

  it("retains a silent failed completion once without double-counting its command", () => {
    const out: { short: string; full?: string }[] = [];
    const handle = progressEventHandler("codex", (short, full) => out.push({ short, full }), () => 0)!;
    const item = { id: "exec-incident", type: "command_execution", command: "pwsh -File wrapper.ps1", status: "failed", exitCode: 1, durationMs: 7538, aggregatedOutput: "" };
    handle({ type: "item.started", item });
    handle({ type: "item.completed", item });
    handle({ type: "item.completed", item });
    expect(out).toHaveLength(2);
    const failure = out[1]!;
    expect(failure.short).toContain("step 1 (1 cmds)");
    expect(failure.short).toContain("command failed [exec-incident]: exit=1, status=failed, duration=7538ms; termination cause not reported");
    expect(failure.full).toContain("No command output was reported.");
    expect(failure.full).toContain("finally/cleanup");
    expect(failure.full).not.toContain("timeout reported");
  });

  it("reports native timeout evidence without treating arbitrary timeout text or exit 124 as proof", () => {
    const event = (item: object) => describeCodexEvent({ type: "item.completed", item: { id: "timeout", type: "command_execution", command: "test", ...item } });
    expect(event({ exit_code: 1, status: "failed", aggregated_output: "Command failed because it timed out.\npartial output" })?.full).toContain("timeout reported by Codex command tool");
    expect(event({ timedOut: true, exitCode: null })?.text).toContain("timeout reported");
    expect(event({ exit_code: 124, status: "failed", aggregated_output: "application timed out" })?.text).toContain("termination cause not reported");
    expect(event({ exitCode: 0, status: "completed", aggregatedOutput: "timeout test passed" })).toBeNull();
    expect(event({ exitCode: 0, status: "completed" })).toBeNull();
    expect(event({ exitCode: null, status: "declined" })?.text).toContain("declined by Codex");
    expect(event({ exitCode: null, status: "failed" })?.text).toContain("exit=unknown");
  });

  it("writes failure evidence and output tail to a retained run feed", () => {
    const home = mkdtempSync(join(tmpdir(), "ab-failure-feed-"));
    const feed = startRunFeed({ home, name: "incident", header: "incident" });
    try {
      const handle = progressEventHandler("codex", feed.report, () => 0)!;
      handle({ type: "item.completed", item: { id: "exec-incident", type: "command_execution", command: "wrapper", exit_code: 1, status: "failed", aggregated_output: "x".repeat(5000) + "last evidence" } });
      const log = readFileSync(feed.logPath, "utf8");
      expect(log).toContain("exec-incident");
      expect(log).toContain("last evidence");
      expect(log).toContain("termination cause not reported");
      expect(log.length).toBeLessThan(5000);
    } finally {
      feed.end("done");
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("run feed", () => {
  it("logs every line, reports quiet phases and can be watched", async () => {
    const home = mkdtempSync(join(tmpdir(), "ab-feed-"));
    try {
      const forwarded: string[] = [];
      const feed = startRunFeed({ home, name: "opencode-test1", header: "opencode task", forward: (m) => forwarded.push(m), heartbeatMs: 50, now: () => Date.now() - 0 });
      feed.report("0s · step 1 · bash: npm test");
      expect(forwarded[0]).toContain("agent-bridge watch opencode-test1");
      feed.end("done");
      const log = readFileSync(feed.logPath, "utf8");
      expect(log).toContain("opencode task");
      expect(log).toContain("bash: npm test");
      expect(log).toMatch(/finished after \d+s · done/);
      expect(findRunLog(home, "test1")).toBe(feed.logPath);
      const lines: string[] = [];
      await watchRunLog(feed.logPath, (l) => lines.push(l));
      expect(lines.at(-1)).toContain("finished after");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports a quiet phase", async () => {
    const home = mkdtempSync(join(tmpdir(), "ab-feed-"));
    let t = 0;
    const forwarded: string[] = [];
    const feed = startRunFeed({ home, name: "x", header: "h", forward: (m) => forwarded.push(m), heartbeatMs: 20, now: () => t });
    feed.report("0s · step 1 · bash: long test run");
    t = 3 * 60_000;
    await new Promise((r) => setTimeout(r, 60));
    feed.end("done");
    expect(forwarded.some((m) => m.startsWith("still working, no new step for 3m (last: bash: long test run)"))).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});
