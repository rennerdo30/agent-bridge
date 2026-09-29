import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRunLog, watchRunLog } from "../src/cli/watch.js";
import { progressEventHandler } from "../src/core/progress.js";
import { startRunFeed } from "../src/core/runfeed.js";

describe("progress lines", () => {
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
