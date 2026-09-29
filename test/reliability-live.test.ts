import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finalStatusOf, hostFor, jobNameIn, leftovers, messageBody, processTree, serverBundle, type Proc } from "../src/cli/reliability-live.js";

describe("reliability live helpers", () => {
  it("runs each target on a host of another kind", () => {
    expect(hostFor("codex")).toBe("claude");
    expect(hostFor("claude")).toBe("codex");
    expect(hostFor("opencode")).toBe("codex");
  });

  it("finds the bundled server of each plugin in the checkout", () => {
    const from = join(import.meta.dirname, "..", "src", "cli", "reliability-live.ts");
    expect(serverBundle("codex", from)).toBe(join(import.meta.dirname, "..", "plugins", "codex", "dist", "server.mjs"));
    expect(serverBundle("claude", from)).toBe(join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs"));
  });

  it("reads job names from spawn and ask results", () => {
    expect(jobNameIn('Subagent claude-job-1a2b3c4d started. Keep working; its result will arrive as a message from "claude-job-1a2b3c4d".')).toBe("claude-job-1a2b3c4d");
    expect(jobNameIn('claude finished (session_id: s1).\nFollow up with its full context: message_subagent(job="claude-ask-9f8e7d6c", message=...).')).toBe("claude-ask-9f8e7d6c");
    expect(jobNameIn("Too many subagents running")).toBeNull();
  });

  it("tells a job's final result from a live answer", () => {
    expect(finalStatusOf("claude-job-1a", "Subagent claude-job-1a (claude, model haiku) done after 12s. Continue it ...\n\nsummary")).toBe("done");
    expect(finalStatusOf("codex-job-2b", "Subagent codex-job-2b (codex) failed after 3s.")).toBe("failed");
    expect(finalStatusOf("claude-job-1a", "I have read 4 of the 12 files so far.")).toBeNull();
    expect(finalStatusOf("claude-job-1a", "Subagent claude-job-1a asks for approval: edit")).toBeNull();
  });

  it("unwraps the message a wait_for_message result carries", () => {
    const text = '[agent-bridge] Message received.\n\nnote\n\n<agent-bridge-message id="1" from="x">\nline one\nline two\n</agent-bridge-message>\n\nTo answer, ...';
    expect(messageBody(text)).toBe("line one\nline two");
  });

  it("finds processes of a closed server's tree that are still alive", () => {
    const procs: Proc[] = [
      { pid: 1, ppid: 0, started: "a" },
      { pid: 10, ppid: 1, started: "b" },
      { pid: 11, ppid: 10, started: "c" },
      { pid: 12, ppid: 11, started: "d" },
      { pid: 20, ppid: 1, started: "e" },
    ];
    const tree = processTree(procs, 10);
    expect(tree.map((p) => p.pid).sort()).toEqual([10, 11, 12]);
    // 12 survived; 11's pid was reused by another process (other start time).
    expect(leftovers(tree, [{ pid: 12, ppid: 11, started: "d" }, { pid: 11, ppid: 1, started: "z" }]).map((p) => p.pid)).toEqual([12]);
  });

  it("counts members of a delegate's process group on POSIX, not the suite's own group", () => {
    const tree: Proc[] = [
      { pid: 10, ppid: 1, pgid: 5 },
      { pid: 11, ppid: 10, pgid: 11 },
    ];
    const now: Proc[] = [
      { pid: 30, ppid: 1, pgid: 11 },
      { pid: 31, ppid: 1, pgid: 5 },
    ];
    expect(leftovers(tree, now, 5).map((p) => p.pid)).toEqual([30]);
  });
});
