import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { delegateToCodexAppServer, innerCommand } from "../src/core/codex-appserver.js";
import { nullLogger } from "../src/core/logger.js";

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

describe("innerCommand", () => {
  it("strips the shell wrapper Codex puts around commands", () => {
    expect(innerCommand(`"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\pwsh.exe" -Command 'Set-Content asked.txt hi'`)).toBe("Set-Content asked.txt hi");
    expect(innerCommand(`/bin/bash -lc "ls -la"`)).toBe("ls -la");
    expect(innerCommand(`cmd /c dir`)).toBe("dir");
    expect(innerCommand("git status")).toBe("git status");
  });
});

describe("native Codex message steering", () => {
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
