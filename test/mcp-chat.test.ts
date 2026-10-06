import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startUi } from "../src/cli/ui.js";
import { nullLogger } from "../src/core/logger.js";
import { resolvePipePath } from "../src/core/paths.js";
import { pidAlive } from "../src/core/delegate.js";

const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
const OWNER = "claude-dashboard-test";
const TEST_TIMEOUT_MS = 60_000;
const POLL_MS = 20;
const CLEANUP_TIMEOUT_MS = 10_000;
const textOf = (r: any): string => r.content.map((c: any) => c.text).join("\n");

/** Holds each turn until a steer, and records names across resumed app-server processes. */
const FAKE_CODEX = `
const { appendFileSync, existsSync } = require("node:fs");
const { createInterface } = require("node:readline");
const FINISH_DELAY_MS = 20;
const write = (m) => console.log(JSON.stringify(m));
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  appendFileSync("requests.jsonl", JSON.stringify({ ...m, pid: process.pid }) + "\\n");
  if (!m.id) return;
  let result = {};
  if (m.method === "account/rateLimits/read") result = {
    ordinaryUsageAllowed: false,
    rateLimits: { limitId: "codex", planType: "pro", secondary: { usedPercent: 100, windowDurationMins: 10080 }, credits: { hasCredits: true, balance: "45914" }, rateLimitReachedType: "rate_limit_reached" },
  };
  if (m.method === "thread/start" || m.method === "thread/resume") result = { thread: { id: m.params.threadId || "thread-test" } };
  if (m.method === "turn/start") result = { turn: { id: "turn-test" } };
  write({ id: m.id, result });
  if (m.method === "turn/start") {
    const finish = setInterval(() => {
      if (!existsSync("finish-turn")) return;
      clearInterval(finish);
      write({ method: "item/completed", params: { turnId: "turn-test", item: { type: "agentMessage", text: "fake answer" } } });
      write({ method: "turn/completed", params: { turn: { id: "turn-test", status: "completed" } } });
    }, FINISH_DELAY_MS);
  }
  if (m.method === "turn/steer") setTimeout(() => {
    write({ method: "item/completed", params: { turnId: "turn-test", item: { type: "agentMessage", text: "fake answer" } } });
    write({ method: "turn/completed", params: { turn: { id: "turn-test", status: "completed" } } });
  }, FINISH_DELAY_MS);
});
`;

describe.skipIf(!existsSync(SERVER))("dashboard and Codex jobs through the bundled MCP server", () => {
  let home: string;
  let client: Client;
  let transport: StdioClientTransport;
  let ui: Awaited<ReturnType<typeof startUi>> | undefined;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "ab-mcp-chat-"));
    writeFileSync(join(home, "app-server"), FAKE_CODEX);
    writeFileSync(join(home, "config.json"), JSON.stringify({ codexModel: "configured-codex" }));
    writeFileSync(join(home, "models-codex.json"), JSON.stringify({ at: Date.now(), bin: process.execPath, effort: null, report: { agent: "codex", defaultModel: "default-codex", models: ["first-codex", "second-codex"], lines: ["Codex models (2):", "- first-codex", "- second-codex"] } }));
    client = new Client({ name: "test-chat", version: "0.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath, args: [SERVER, "--agent=claude"], cwd: home,
      env: { ...process.env, AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_PIPE: resolvePipePath(home, {}), AGENT_BRIDGE_NAME: OWNER, AGENT_BRIDGE_CODEX_BIN: process.execPath, AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_JOB_RUNNER: "0", AGENT_BRIDGE_DELEGATE_DEPTH: "0", CLAUDE_PROJECT_DIR: home, AGENT_BRIDGE_PARENT_URL: "", AGENT_BRIDGE_PARENT_TOKEN: "" } as Record<string, string>, stderr: "ignore",
    });
    await client.connect(transport);
    await call("peers");
  });
  afterEach(async () => {
    await ui?.close();
    ui = undefined;
    const pid = transport?.pid;
    const children = new Set(requests().map((r) => r.pid));
    await client?.close();
    if (pid) await waitFor(() => !pidAlive(pid));
    await waitFor(() => [...children].every((p) => !pidAlive(p)));
    // Windows can briefly refuse even the initial directory stat after the last child exits.
    await waitFor(() => {
      try {
        rmSync(home, { recursive: true, force: true });
        return true;
      } catch (err) {
        if (["EPERM", "EBUSY", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code ?? "")) return false;
        throw err;
      }
    }, CLEANUP_TIMEOUT_MS);
  });
  const requests = (): any[] => {
    try { return readFileSync(join(home, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; }
  };
  const waitFor = async (fn: () => boolean | Promise<boolean>, timeoutMs = TEST_TIMEOUT_MS): Promise<void> => {
    const end = Date.now() + timeoutMs;
    while (!(await fn())) {
      if (Date.now() >= end) throw new Error("job did not reach the expected state");
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };
  const call = async (name: string, args = {}) => textOf(await client.callTool({ name, arguments: args }));

  it("includes a cached model list and the configured default on both delegation tools", async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ["ask_codex", "spawn_codex"]) {
      const tool = tools.find((t) => t.name === name)!;
      const description = (tool.inputSchema.properties!.model as { description: string }).description;
      expect(description).toContain("Default: configured-codex.");
      expect(description).toContain("Available: first-codex, second-codex.");
    }
    expect(requests()).toEqual([]);
  });

  it("reports credit-backed availability through usage_limits (AB-71)", async () => {
    const report = await call("usage_limits", { agent: "codex" });
    expect(report).toContain("usable, plan limit reached, running on credits (45,914 left)");
    expect(report).not.toMatch(/unusable|LIMIT REACHED|does not allow ordinary usage/);
  }, TEST_TIMEOUT_MS);

  it("keeps one ask call blocked until its Codex run finishes and returns its identity (AB-74)", async () => {
    let settled = false;
    const answer = client.callTool({ name: "ask_codex", arguments: { prompt: "wait for completion", title: "Blocking relay", cwd: home } }).then((r) => {
      settled = true;
      return r;
    });
    await waitFor(() => requests().some((r) => r.method === "turn/start"));
    const peers = await call("peers");
    const job = /codex-ask-[\da-f]+/.exec(peers)![0];
    expect(settled).toBe(false);
    expect(await call("inbox")).not.toContain("fake answer");
    writeFileSync(join(home, "finish-turn"), "finish");
    const result = await answer;
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain(`Job: ${job}`);
    expect(textOf(result)).toContain("thread-test");
    expect(textOf(result)).toContain("fake answer");
    expect(requests().filter((r) => r.method === "thread/start")).toHaveLength(1);
    expect(requests().filter((r) => r.method === "turn/start")).toHaveLength(1);
    expect(requests().some((r) => r.method === "thread/resume")).toBe(false);
    expect(await call("inbox")).not.toContain("fake answer"); // No duplicate completion mail.
  }, TEST_TIMEOUT_MS);

  it("returns the same job and session on a cancelled ask without starting a replacement (AB-74)", async () => {
    const answer = client.callTool({ name: "ask_codex", arguments: { prompt: "wait for cancellation", title: "Cancelled relay", cwd: home } });
    await waitFor(() => requests().some((r) => r.method === "turn/start"));
    const job = /codex-ask-[\da-f]+/.exec(await call("peers"))![0];
    await call("cancel_subagent", { job });
    const result = await answer;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`Job: ${job}`);
    expect(textOf(result)).toContain("codex session_id: thread-test");
    expect(requests().filter((r) => r.method === "thread/start")).toHaveLength(1);
    expect(requests().some((r) => r.method === "thread/resume")).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("renames a running and a finished Codex job when message_subagent changes its title", async () => {
    const spawned = await call("spawn_codex", { prompt: "wait for a message", title: "First job title", cwd: home });
    const job = /Subagent (codex-job-[\da-f]+) started/.exec(spawned)![1]!;
    await waitFor(() => requests().some((r) => r.method === "turn/start"));
    expect(requests().find((r) => r.method === "thread/name/set").params).toEqual({ threadId: "thread-test", name: "First job title" });
    expect(await call("message_subagent", { job, title: "Running job title", message: "finish this turn" })).toContain("gets your message at its next step");
    await waitFor(async () => (await call("peers")).includes(`${job} "Running job title": done`));
    expect(requests().filter((r) => r.method === "thread/name/set").map((r) => r.params.name)).toContain("Running job title");
    await call("message_subagent", { job, title: "Finished job title", message: "continue" });
    await waitFor(() => requests().some((r) => r.method === "thread/resume"));
    await waitFor(() => requests().filter((r) => r.method === "turn/start").length === 2);
    expect(requests().filter((r) => r.method === "thread/name/set").map((r) => r.params.name)).toContain("Finished job title");
    await call("message_subagent", { job, message: "finish again" });
    await waitFor(async () => (await call("peers")).includes(`${job} "Finished job title": done`));
  }, TEST_TIMEOUT_MS);

  it("routes dashboard messages through the owner to a live job and then continues its finished thread", async () => {
    const spawned = await call("spawn_codex", { prompt: "wait for dashboard input", title: "Dashboard job", cwd: home });
    const job = /Subagent (codex-job-[\da-f]+) started/.exec(spawned)![1]!;
    await waitFor(() => requests().some((r) => r.method === "turn/start"));
    ui = await startUi({ home, pipe: resolvePipePath(home, {}), port: 0, log: nullLogger });
    const first = await fetch(ui.url, { redirect: "manual" });
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const base = ui.url.replace(/\/\?t=.*$/, "");
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    const run = state.runs.find((r: any) => r.job === job).name;
    const post = async (body: string) => {
      const r = await fetch(`${base}/api/subagents/message`, { method: "POST", headers: { cookie, "x-agent-bridge": "1", "content-type": "application/json" }, body: JSON.stringify({ run, body }) });
      const data = await r.json();
      expect(r.status, JSON.stringify(data)).toBe(200);
      return data;
    };
    expect(await post("finish from the dashboard")).toMatchObject({ outcome: "delivered" });
    await waitFor(async () => (await call("peers")).includes(`${job} "Dashboard job": done`));
    expect(await post("continue the finished thread")).toMatchObject({ outcome: "started" });
    await waitFor(() => requests().filter((r) => r.method === "turn/start").length === 2);
    expect(await post("finish the continuation")).toMatchObject({ outcome: "delivered" });
    await waitFor(async () => (await call("peers")).includes(`${job} "Dashboard job": done`));
    expect(requests().find((r) => r.method === "thread/resume").params.threadId).toBe("thread-test");
    expect((await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()).messages.every((m: any) => !m.body.includes('"requestId"'))).toBe(true);
  }, TEST_TIMEOUT_MS);
});
