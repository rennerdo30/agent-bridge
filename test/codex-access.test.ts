import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CODEX_FULL_ACCESS_APPROVAL_POLICY, delegateToCodexAppServer } from "../src/core/codex-appserver.js";
import { delegateToCodex } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";

const TIMEOUT_SEC = 10;
const FAKE_APPROVAL_SERVER = `
const { createInterface } = require("node:readline");
const { appendFileSync } = require("node:fs");
const send = (m) => console.log(JSON.stringify(m));
const replies = [];
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  appendFileSync("requests.jsonl", line + "\\n");
  if (m.id >= 100 && m.result) {
    replies.push(m.result);
    if (replies.length === 3) {
      send({ method: "item/completed", params: { turnId: "turn", item: { type: "agentMessage", text: JSON.stringify(replies) } } });
      send({ method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } });
    }
    return;
  }
  if (!m.method || m.id === undefined) return;
  let result = {};
  if (m.method === "thread/start" || m.method === "thread/resume") result = { thread: { id: "thread" } };
  if (m.method === "turn/start") result = { turn: { id: "turn" } };
  send({ id: m.id, result });
  if (m.method === "turn/start") {
    send({ id: 100, method: "item/commandExecution/requestApproval", params: { command: "powershell -Command 'Start-Process helper -WindowStyle Hidden'" } });
    send({ id: 101, method: "item/fileChange/requestApproval", params: { reason: "cleanup job files" } });
    send({ id: 102, method: "mcpServer/elicitation/request", params: { serverName: "pair-desk", message: 'Allow the server to run tool "set_build"?' } });
  }
});
`;

describe("Codex full-access approvals", () => {
  it.each([false, true])("never declines full-access commands/edits but retains MCP checks (resume=%s)", async (resume) => {
    const dir = mkdtempSync(join(tmpdir(), "ab-full-access-"));
    writeFileSync(join(dir, "app-server"), FAKE_APPROVAL_SERVER);
    const approve = vi.fn(async () => ({ allow: false as const, message: "MCP write needs approval" }));
    try {
      const result = await delegateToCodexAppServer({ bin: process.execPath, cwd: dir, prompt: "task", sandbox: "danger-full-access", askMode: true, sessionId: resume ? "thread" : undefined, approve, timeoutSec: TIMEOUT_SEC, log: nullLogger });
      const decisions = JSON.parse(result.text);
      expect(decisions.filter((d: any) => d.decision)).toEqual([{ decision: "accept" }, { decision: "accept" }]);
      expect(decisions.find((d: any) => d.action)).toEqual({ action: "decline", content: null });
      expect(approve).toHaveBeenCalledTimes(1);
      expect(approve.mock.calls[0]).toEqual([expect.objectContaining({ tool: "mcp:pair-desk" })]);
      const calls = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s));
      expect(calls.find((c) => c.method === "initialize").params.capabilities.experimentalApi).toBe(true);
      for (const method of [resume ? "thread/resume" : "thread/start", "turn/start"]) {
        expect(calls.find((c) => c.method === method).params.approvalPolicy).toEqual(CODEX_FULL_ACCESS_APPROVAL_POLICY);
      }
      expect(calls.find((c) => c.method === "turn/start").params.input[0].text).not.toContain("workspace is read-only");
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it("forwards workspace cleanup approvals instead of silently declining them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-cleanup-approval-"));
    writeFileSync(join(dir, "app-server"), FAKE_APPROVAL_SERVER);
    const seen: string[] = [];
    try {
      const result = await delegateToCodexAppServer({ bin: process.execPath, cwd: dir, prompt: "cleanup", sandbox: "workspace-write", timeoutSec: TIMEOUT_SEC, log: nullLogger,
        approve: async (r) => { seen.push(r.tool); return { allow: true }; } });
      expect(seen).toEqual(["command", "edit", "mcp:pair-desk"]);
      expect(JSON.parse(result.text)).toEqual([{ decision: "accept" }, { decision: "accept" }, { action: "accept", content: {} }]);
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it("overrides inherited exec approval policy for full access even when a relay was requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-exec-full-"));
    writeFileSync(join(dir, "exec"), `require("node:fs").writeFileSync("args.json", JSON.stringify(process.argv.slice(2))); process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })));`);
    try {
      await delegateToCodex({ bin: process.execPath, cwd: dir, prompt: "task", sandbox: "danger-full-access", relayApprovals: true, timeoutSec: TIMEOUT_SEC, log: nullLogger });
      const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
      expect(args).toContain('approval_policy="never"');
      expect(args).toContain('approvals_reviewer="user"');
      expect(args).not.toContain('approvals_reviewer="auto_review"');
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
});
