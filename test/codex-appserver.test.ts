import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexTurnSandbox, delegateToCodexAppServer, innerCommand } from "../src/core/codex-appserver.js";
import { nullLogger } from "../src/core/logger.js";
import { delegateToCodex } from "../src/core/delegate.js";

describe("innerCommand", () => {
  it("strips the shell wrapper Codex puts around commands", () => {
    expect(innerCommand(`"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\pwsh.exe" -Command 'Set-Content asked.txt hi'`)).toBe("Set-Content asked.txt hi");
    expect(innerCommand(`/bin/bash -lc "ls -la"`)).toBe("ls -la");
    expect(innerCommand(`cmd /c dir`)).toBe("dir");
    expect(innerCommand("git status")).toBe("git status");
  });
});

describe("next-turn Codex settings", () => {
  it("forwards workspace network access to exec without enabling it for read-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-exec-network-"));
    writeFileSync(join(dir, "exec"), `
require("node:fs").writeFileSync("args.json", JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "same-thread" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }));
});
`);
    try {
      for (const sandbox of ["workspace-write", "read-only"] as const) {
        await delegateToCodex({ bin: process.execPath, cwd: dir, prompt: "continue", sessionId: "same-thread", model: "new-model", sandbox, networkAccess: true, timeoutSec: 30, log: nullLogger });
        const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
        expect(args).toEqual(expect.arrayContaining(["resume", "-m", "new-model", `sandbox_mode="${sandbox}"`, "same-thread"]));
        expect(args.includes("sandbox_workspace_write.network_access=true")).toBe(sandbox === "workspace-write");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps read-only network restrictions and preserves workspace network settings and roots", () => {
    expect(codexTurnSandbox("read-only", "/repo", [], { networkAccess: true }, true)).toEqual({ type: "readOnly", networkAccess: false });
    expect(codexTurnSandbox("danger-full-access", "/repo")).toEqual({ type: "dangerFullAccess" });
    expect(codexTurnSandbox("workspace-write", "/repo", ["/git"], { type: "workspaceWrite", networkAccess: true, writableRoots: ["/repo", "/cache"], excludeSlashTmp: true })).toEqual({
      type: "workspaceWrite", networkAccess: true, writableRoots: ["/repo", "/git", "/cache"], excludeSlashTmp: true,
    });
    expect(codexTurnSandbox("workspace-write", "/repo", [], { type: "workspaceWrite", networkAccess: true }, false).networkAccess).toBe(false);
  });

  it.each(["workspace-write", "danger-full-access", "read-only"] as const)("resumes the same thread with model and %s policy on turn/start", async (sandbox) => {
    const dir = mkdtempSync(join(tmpdir(), "ab-turn-settings-"));
    const requests = join(dir, "requests.jsonl");
    const fake = `
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (value) => console.log(JSON.stringify(value));
rl.on("line", (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(requests)}, line + "\\n");
  if (m.id === undefined) return;
  let result = {};
  if (m.method === "thread/resume") result = { thread: { id: m.params.threadId }, model: "old-model", sandbox: { type: "workspaceWrite", networkAccess: false } };
  if (m.method === "turn/start") result = { turn: { id: "turn-1" } };
  send({ id: m.id, result });
  if (m.method === "turn/start") {
    send({ method: "item/completed", params: { turnId: "turn-1", item: { type: "agentMessage", text: "done" } } });
    send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
  }
});
`;
    writeFileSync(join(dir, "app-server"), fake);
    try {
      const info: object[] = [];
      const result = await delegateToCodexAppServer({ bin: process.execPath, cwd: dir, prompt: "continue", sessionId: "same-thread", model: "new-model", effort: "high", sandbox, networkAccess: true, timeoutSec: 30, log: nullLogger, onInfo: (value) => info.push(value) });
      expect(result).toMatchObject({ sessionId: "same-thread", text: "done", isError: false });
      const calls = readFileSync(requests, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const turn = calls.find((call) => call.method === "turn/start").params;
      expect(turn).toMatchObject({ threadId: "same-thread", model: "new-model", effort: "high", sandboxPolicy: { type: sandbox === "workspace-write" ? "workspaceWrite" : sandbox === "read-only" ? "readOnly" : "dangerFullAccess" } });
      if (sandbox === "workspace-write") {
        expect(turn.sandboxPolicy.networkAccess).toBe(true);
        expect(calls.find((call) => call.method === "thread/resume").params.config.sandbox_workspace_write.network_access).toBe(true);
      }
      if (sandbox === "read-only") expect(turn.sandboxPolicy.networkAccess).toBe(false);
      expect(info.at(-1)).toMatchObject({ model: "new-model", permission: sandbox });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex denial explanations", () => {
  for (const askMode of [true, false]) it(`delivers reasons as live input after protocol declines (askMode=${askMode})`, async () => {
    const root = join(process.cwd(), ".agent-bridge-test");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "denials-"));
    writeFileSync(join(dir, "app-server"), `
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const replies = []; const reasons = [];
function finish() {
  if (replies.length !== 3 || reasons.length !== 3) return;
  send({ method: "item/completed", params: { turnId: "turn", item: { type: "agentMessage", text: JSON.stringify({ replies: replies.sort((a, b) => a.id - b.id).map((r) => r.result), reasons }) } } });
  send({ method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.result && m.id >= 100) { replies.push({ id: m.id, result: m.result }); finish(); return; }
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "session" }, model: "gpt-6-sol" } });
  if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "turn" } } });
    send({ id: 100, method: "mcpServer/elicitation/request", params: { serverName: "pair-desk", message: 'Allow the pair-desk MCP server to run tool "set_build"?' } });
    send({ id: 101, method: "item/commandExecution/requestApproval", params: { command: "npm test" } });
    send({ id: 102, method: "item/fileChange/requestApproval", params: { reason: "edit files" } });
  }
  if (m.method === "turn/steer") { reasons.push(m.params.input[0].text); send({ id: m.id, result: {} }); finish(); }
});
`);
    const asked: string[] = [];
    try {
      const res = await delegateToCodexAppServer({ bin: process.execPath, cwd: dir, prompt: "task", timeoutSec: 10, sandbox: "read-only", askMode, log: nullLogger,
        approve: async (r) => { asked.push(r.tool); return { allow: false, message: "Denied by supervisor parent: publish only from merged master" }; },
      });
      const output = JSON.parse(res.text);
      expect(output.replies).toEqual([{ action: "decline", content: null }, { decision: "decline" }, { decision: "decline" }]);
      expect(output.reasons.find((s: string) => s.includes("mcp:pair-desk"))).toContain("Denied by supervisor parent: publish only from merged master");
      if (askMode) {
        expect(asked).toEqual(["mcp:pair-desk", "command", "edit"]);
        expect(output.reasons.every((s: string) => s.includes("Denied by supervisor parent"))).toBe(true);
      } else {
        expect(asked).toEqual(["mcp:pair-desk"]);
        expect(output.reasons.filter((s: string) => !s.includes("mcp:pair-desk")).every((s: string) => s.includes("Denied by agent-bridge") && s.includes("supervisor was not asked"))).toBe(true);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 15_000);
});
