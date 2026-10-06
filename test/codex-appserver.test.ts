import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexTurnSandbox, delegateToCodexAppServer, innerCommand, type Steering } from "../src/core/codex-appserver.js";
import { nullLogger } from "../src/core/logger.js";
import { delegateToCodex } from "../src/core/delegate.js";

const TIMEOUT_SEC = 10;
const FAKE_REPLY_DELAY_MS = 20;
const FAKE_APP_SERVER = `
const { createInterface } = require("node:readline");
const { writeFileSync } = require("node:fs");
const output = (value) => console.log(JSON.stringify(value));
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "thread/start") result = { thread: { id: "thread" } };
  if (request.method === "turn/start") result = { turn: { id: "turn" } };
  output({ id: request.id, result });
  if (request.method === "turn/steer") {
    writeFileSync("steered.txt", request.params.input[0].text);
    setTimeout(() => {
      output({ method: "item/completed", params: { turnId: "turn", item: { type: "agentMessage", text: "Received" } } });
      output({ method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } });
    }, ${FAKE_REPLY_DELAY_MS});
  }
});
`;

/** Records the app-server protocol without a model call. */
export const FAKE_CODEX_APPSERVER = `
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const FINISH_DELAY_MS = 20;
const write = (m) => console.log(JSON.stringify(m));
const finish = () => {
  write({ method: "item/completed", params: { turnId: "turn-1", item: { type: "agentMessage", text: "finished" } } });
  write({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (process.env.AB_TEST_REQUESTS) appendFileSync(process.env.AB_TEST_REQUESTS, line + "\\n");
  if (!m.id) return;
  if (m.method === "thread/name/set" && process.env.AB_TEST_REJECT_NAME) return write({ id: m.id, error: { message: "not supported" } });
  let result = {};
  if (m.method === "thread/start" || m.method === "thread/resume") result = { thread: { id: m.params.threadId || "thread-new" } };
  if (m.method === "turn/start") result = { turn: { id: "turn-1" } };
  write({ id: m.id, result });
  if (m.method === "turn/steer" || (m.method === "turn/start" && !process.env.AB_TEST_HOLD)) setTimeout(finish, FINISH_DELAY_MS);
});
`;

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
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 15_000);
});

describe("native Codex message steering", () => {
  it("preserves the final deliverable before a later sibling acknowledgement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-final-deliverable-"));
    const fake = FAKE_APP_SERVER.replace('output({ id: request.id, result });', `
      output({ id: request.id, result });
      if (request.method === "turn/start") {
        output({ method: "item/completed", params: { turnId: "turn", item: { id: "progress", type: "agentMessage", phase: "commentary", text: "Reading inventory" } } });
        output({ method: "item/completed", params: { turnId: "turn", item: { id: "inventory", type: "agentMessage", phase: "final_answer", text: "Full inventory table" } } });
      }
    `).replace('type: "agentMessage", text: "Received"', 'id: "ack", type: "agentMessage", phase: "final_answer", text: "Received"');
    writeFileSync(join(dir, "app-server"), fake);
    try {
      const answers: string[] = [];
      const result = await delegateToCodexAppServer({ bin: process.execPath, cwd: dir, prompt: "Inventory", timeoutSec: TIMEOUT_SEC,
        sandbox: "read-only", log: nullLogger,
        live: { from: "claude-supervisor", onAnswer: (answer) => answers.push(answer), onSteering: (steering) => {
          if (steering) void steering.send("Sibling scope confirmed", true);
        } } });
      expect(result.text).toBe("Full inventory table\n\nReceived");
      expect(answers).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it.each([false, true])("preserves sibling=%s attribution and parent answer behavior", async (sibling) => {
    const dir = mkdtempSync(join(tmpdir(), "ab-sibling-steer-"));
    writeFileSync(join(dir, "app-server"), FAKE_APP_SERVER);
    const answers: string[] = [];
    try {
      const result = await delegateToCodexAppServer({ bin: process.execPath, cwd: dir, prompt: "Task", timeoutSec: TIMEOUT_SEC,
        sandbox: "read-only", log: nullLogger,
        live: { from: "claude-supervisor", onAnswer: (answer) => answers.push(answer), onSteering: (steering) => {
          if (steering) void steering.send("Message body", sibling);
        } } });
      expect(result.text).toBe("Received");
      const input = readFileSync(join(dir, "steered.txt"), "utf8");
      if (sibling) {
        expect(input).toContain("sibling job");
        expect(input).not.toContain("who gave you this task");
        expect(answers).toEqual([]);
      } else {
        expect(input).toContain("claude-supervisor, who gave you this task");
        expect(answers).toEqual(["Received"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("Codex job thread names", () => {
  let dir: string;
  beforeEach(() => {
    vi.stubEnv("AGENT_BRIDGE_DELEGATE_DEPTH", "0");
    dir = mkdtempSync(join(tmpdir(), "ab-thread-name-"));
    writeFileSync(join(dir, "app-server"), FAKE_CODEX_APPSERVER);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const requests = (path: string): any[] => readFileSync(join(path, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const run = (path: string, extra = {}) => delegateToCodexAppServer({ bin: process.execPath, cwd: path, log: nullLogger, sandbox: "read-only", timeoutSec: 10, prompt: "task", title: "Build castle gates", extraEnv: { AB_TEST_REQUESTS: join(path, "requests.jsonl") }, ...extra });

  it("names a new thread before starting its turn and renames it while it runs", async () => {
    let operation: Promise<void> | undefined;
    await run(dir, {
      extraEnv: { AB_TEST_REQUESTS: join(dir, "requests.jsonl"), AB_TEST_HOLD: "1" },
      live: {
        from: "parent",
        onAnswer: () => {},
        onSteering: (s: Steering | null) => {
          if (s) operation = (async () => { await s.rename!("Check castle gate tests"); await s.send("finish"); })();
        },
      },
    });
    await operation;
    const calls = requests(dir);
    expect(calls.filter((c) => c.method === "thread/name/set").map((c) => c.params)).toEqual([{ threadId: "thread-new", name: "Build castle gates" }, { threadId: "thread-new", name: "Check castle gate tests" }]);
    expect(calls.findIndex((c) => c.method === "thread/name/set")).toBeLessThan(calls.findIndex((c) => c.method === "turn/start"));
  });

  it("names a resumed thread with the job's current title", async () => {
    await run(dir, { sessionId: "thread-old", title: "Continue castle gates" });
    expect(requests(dir).find((c) => c.method === "thread/name/set").params).toEqual({ threadId: "thread-old", name: "Continue castle gates" });
  });

  it("keeps the task working if an older app-server rejects names", async () => {
    expect(await run(dir, { extraEnv: { AB_TEST_REJECT_NAME: "1" } })).toMatchObject({ text: "finished", isError: false });
  });
});
