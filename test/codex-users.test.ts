import { describe, expect, it } from "vitest";
import { classifyCodexProcesses } from "../src/cli/codex-users.js";

const p = (ProcessId: number, ParentProcessId: number, Name: string, CommandLine: string) => ({ ProcessId, ParentProcessId, Name, CommandLine, CreationDate: null });

describe("Codex processes that block a plugin update", () => {
  it("tells the app, terminal sessions and agent-bridge subagents apart, and skips helpers", () => {
    const users = classifyCodexProcesses([
      p(1, 0, "ChatGPT.exe", "ChatGPT.exe"),
      p(2, 1, "codex.exe", "codex.exe app-server"),
      p(3, 1, "codex.exe", "codex.exe exec-server --remote x"),
      p(10, 0, "claude.exe", "claude"),
      p(11, 10, "node.exe", "node C:/Users/x/.claude/plugins/cache/agent-bridge/agent-bridge/0.15.1/dist/server.mjs --agent=claude"),
      p(12, 11, "codex.exe", "codex.exe app-server"),
      p(13, 12, "codex.exe", "codex.exe sandbox helper"),
      p(20, 0, "pwsh.exe", "pwsh"),
      p(21, 20, "codex.exe", "codex.exe"),
    ]);
    expect(users.map((u) => [u.pid, u.kind, u.startedBy])).toEqual([
      [2, "app", undefined],
      [12, "subagent", "claude"],
      [21, "session", undefined],
    ]);
  });
});
