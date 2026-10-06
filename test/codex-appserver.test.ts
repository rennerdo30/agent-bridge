import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { delegateToCodexAppServer, innerCommand, type Steering } from "../src/core/codex-appserver.js";
import { nullLogger } from "../src/core/logger.js";

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

describe("Codex job thread names", () => {
  let dir: string;
  beforeEach(() => {
    vi.stubEnv("AGENT_BRIDGE_DELEGATE_DEPTH", "0");
    dir = mkdtempSync(join(tmpdir(), "ab-thread-name-"));
    writeFileSync(join(dir, "app-server"), FAKE_CODEX_APPSERVER);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
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
