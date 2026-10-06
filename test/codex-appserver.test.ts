import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { delegateToCodexAppServer, innerCommand } from "../src/core/codex-appserver.js";
import { nullLogger } from "../src/core/logger.js";

describe("innerCommand", () => {
  it("strips the shell wrapper Codex puts around commands", () => {
    expect(innerCommand(`"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\pwsh.exe" -Command 'Set-Content asked.txt hi'`)).toBe("Set-Content asked.txt hi");
    expect(innerCommand(`/bin/bash -lc "ls -la"`)).toBe("ls -la");
    expect(innerCommand(`cmd /c dir`)).toBe("dir");
    expect(innerCommand("git status")).toBe("git status");
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
