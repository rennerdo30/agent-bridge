import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killPid, pidAlive } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { readRunnerState } from "../src/mcp/job-host.js";
import { readStore } from "../src/mcp/jobs.js";

/**
 * Background subagents in detached job runners (bundled server and CLI: npm run build first). A fake
 * `claude` stands in for the subagent: it answers once its release file exists.
 */
const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
const SESSION = "codex-host";
const TEST_TIMEOUT_MS = 90_000;

const FAKE_CLAUDE = `
import { appendFileSync, existsSync } from "node:fs";
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", async () => {
  const args = process.argv.slice(2);
  const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const session = value("--resume") || "fake-" + process.pid;
  appendFileSync(new URL("calls.jsonl", import.meta.url), JSON.stringify({ args, session }) + "\\n");
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session, model: value("--model") || "fake" }));
  const release = /release=(\\S+)/.exec(prompt)?.[1];
  while (release && !existsSync(release)) await new Promise((r) => setTimeout(r, 100));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "fake answer: finished", session_id: session }));
});
`;

let home: string;
let claudeBin: string;
const releases: string[] = [];
const sessions: { client: Client; transport: StdioClientTransport }[] = [];
const nodes: BridgeNode[] = [];

/** The fake as Claude Code's CLI would be installed: an npm .cmd shim on Windows, an executable script elsewhere. */
function installFakeClaude(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fake-claude.mjs"), `#!/usr/bin/env node\n${FAKE_CLAUDE}`);
  if (process.platform === "win32") {
    writeFileSync(join(dir, "claude.cmd"), `@ECHO off\r\n"%dp0%\\fake-claude.mjs" %*\r\n`);
    return join(dir, "claude.cmd");
  }
  chmodSync(join(dir, "fake-claude.mjs"), 0o755);
  return join(dir, "fake-claude.mjs");
}

/** One server of the session (a Codex session: it spawns Claude subagents). */
async function startSession(): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, "--agent=codex"],
    env: { ...process.env, AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_NAME: SESSION, AGENT_BRIDGE_CLAUDE_BIN: claudeBin, AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_LOG_LEVEL: "debug" } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "test-codex", version: "0.0.0" });
  await client.connect(transport);
  const s = { client, transport };
  sessions.push(s);
  return s;
}

/** Like /reload-plugins: the server goes away (and is gone) before the next one starts. */
async function stopSession(s: { client: Client; transport: StdioClientTransport }): Promise<void> {
  const pid = s.transport.pid;
  await s.client.close();
  if (pid) await waitFor(() => !pidAlive(pid));
}

const textOf = (r: any): string => r.content.map((c: any) => c.text).join("\n");
const call = async (s: { client: Client }, name: string, args: Record<string, unknown> = {}) => textOf(await s.client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }));

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Spawn a subagent that runs until its release file exists; resolves once its runner reported in. */
async function spawnHeld(s: { client: Client }): Promise<{ job: string; id: string; release: string; pid: number }> {
  const release = join(home, `release-${releases.length}`);
  releases.push(release);
  const out = await call(s, "spawn_claude", { prompt: `release=${release} build the castle`, title: "Runner test" });
  const job = /Subagent (claude-job-([0-9a-f]+)) started/.exec(out);
  expect(job, out).not.toBeNull();
  const id = job![2]!;
  await waitFor(() => readRunnerState(home, id)?.sessionId?.startsWith("fake-") === true);
  return { job: job![1]!, id, release, pid: readRunnerState(home, id)!.pid };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-bridge-runner-"));
  claudeBin = installFakeClaude(join(home, "bin"));
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.client.close().catch(() => {});
  for (const n of nodes.splice(0)) await n.stop().catch(() => {});
  // Let every fake finish, and stop runners a test left behind.
  for (const r of releases.splice(0)) writeFileSync(r, "");
  await new Promise((r) => setTimeout(r, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

describe.skipIf(!existsSync(SERVER))("background subagents in job runners", () => {
  it("applies model and permission changes on the next turn after a takeover, with matching metadata", async () => {
    const a = await startSession();
    const { job, id, release, pid } = await spawnHeld(a);
    await stopSession(a);
    const b = await startSession();
    const reply = await call(b, "message_subagent", { job, model: "new-model", permission_mode: "bypassPermissions", message: "finish with the new settings" });
    expect(reply).toContain("the turn running now keeps its settings");
    await waitFor(() => (readRunnerState(home, id)?.seen?.length ?? 0) === 1);
    const metadata = () => readdirSync(join(home, "runs")).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(join(home, "runs", file), "utf8"))).filter((meta) => meta.job === job);
    expect(metadata()).toContainEqual(expect.objectContaining({ model: "fake", permission: "default" }));
    expect(metadata().some((meta) => meta.model === "new-model")).toBe(false);
    writeFileSync(release, "");
    expect(await call(b, "wait_for_message", { from: job, timeout_sec: 60 })).toContain("Your queued follow-up was sent to it");
    expect(await call(b, "wait_for_message", { from: job, timeout_sec: 60 })).toContain("fake answer: finished");
    await waitFor(() => !pidAlive(pid));
    const calls = readFileSync(join(home, "bin", "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(expect.arrayContaining(["--model", "new-model", "--permission-mode", "bypassPermissions", "--resume", calls[0].session]));
    expect(calls[1].session).toBe(calls[0].session);
    expect(metadata()).toContainEqual(expect.objectContaining({ model: "new-model", permission: "bypassPermissions", continues: calls[0].session }));
    await waitFor(async () => (await call(b, "peers")).includes(`${job} "Runner test": done`));
    const saved = readStore(join(home, "jobs.json"));
    expect(saved.find((entry) => entry.id === id)!.args).toMatchObject({ model: "new-model", permission_mode: "bypassPermissions" });
    expect(saved.find((entry) => entry.id === id)!.model).toBe("new-model");
    const invalid = await b.client.callTool({ name: "message_subagent", arguments: { job, sandbox: "read-only" } });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain("sandbox applies only to codex jobs");
  }, TEST_TIMEOUT_MS);

  it("keep running across a restart of the session's server, which takes them over and gets the result", async () => {
    const a = await startSession();
    const { job, id, release, pid } = await spawnHeld(a);
    expect(pid).not.toBe(a.transport.pid);

    await stopSession(a);
    expect(pidAlive(pid)).toBe(true);
    expect(readRunnerState(home, id)?.status).toBe("running");

    const b = await startSession();
    // The new server lists it as running (taken over), not as interrupted.
    expect(await call(b, "peers")).toMatch(new RegExp(`${job}.*running`));
    writeFileSync(release, "");
    const message = await call(b, "wait_for_message", { from: job, timeout_sec: 60 });
    // Exactly like a job run inside the server: from the job, as its agent, in the job's conversation.
    expect(message).toContain(`from="${job}" agent="claude" conversation="job-${id}"`);
    expect(message).toContain(`Subagent ${job} (claude`);
    expect(message).toContain("done after");
    expect(message).toContain("fake answer: finished");
    // The runner exits once its job is done, and the session sees the job finished.
    await waitFor(() => !pidAlive(pid));
    await waitFor(async () => (await call(b, "peers")).match(new RegExp(`${job} "Runner test": done`)) !== null);
  }, TEST_TIMEOUT_MS);

  it("forwards message_subagent to the runner after a takeover; what the subagent did not see continues it there", async () => {
    const a = await startSession();
    const { job, id, release, pid } = await spawnHeld(a);
    await stopSession(a);
    const b = await startSession();
    expect(await call(b, "message_subagent", { job, message: "also paint the walls" })).toContain("is still working");
    // The runner took it (it reconnects to the bridge the new server hosts).
    await waitFor(() => (readRunnerState(home, id)?.seen?.length ?? 0) === 1);
    writeFileSync(release, "");
    // The fake never reads live messages: the runner sends it as a follow-up into the same session.
    const first = await call(b, "wait_for_message", { from: job, timeout_sec: 60 });
    expect(first).toContain("Your queued follow-up was sent to it");
    const second = await call(b, "wait_for_message", { from: job, timeout_sec: 60 });
    expect(second).toContain("fake answer: finished");
    expect(second).not.toContain("follow-up was sent");
    await waitFor(() => !pidAlive(pid));
    await waitFor(async () => (await call(b, "peers")).match(new RegExp(`${job} "Runner test": done`)) !== null);
  }, TEST_TIMEOUT_MS);

  it("delivers a result that arrived while no server of the session was running", async () => {
    // Another session hosts the bridge meanwhile: the result waits in its store for this session.
    const other = new BridgeNode({ pipePath: resolvePipePath(home, {}), token: loadOrCreateToken(home), dbPath: resolveDbPath(home), agent: "claude", name: "claude-other", cwd: home, autoWake: false, log: nullLogger });
    await other.start();
    nodes.push(other);
    const a = await startSession();
    const { job, release, pid } = await spawnHeld(a);
    await stopSession(a);
    writeFileSync(release, "");
    await waitFor(() => !pidAlive(pid));
    const b = await startSession();
    const message = await call(b, "wait_for_message", { from: job, timeout_sec: 60 });
    expect(message).toContain("fake answer: finished");
    await waitFor(async () => (await call(b, "peers")).match(new RegExp(`${job} "Runner test": done`)) !== null);
  }, TEST_TIMEOUT_MS);

  it("cancel_subagent stops a runner-hosted subagent and its runner", async () => {
    const a = await startSession();
    const { job, pid } = await spawnHeld(a);
    expect(await call(a, "cancel_subagent", { job })).toContain(`Cancelled subagent ${job}`);
    await waitFor(() => !pidAlive(pid), 20_000);
    expect(await call(a, "wait_for_message", { from: job, timeout_sec: 30 })).toContain("failed");
    await waitFor(async () => (await call(a, "peers")).match(new RegExp(`${job} "Runner test": failed`)) !== null);
  }, TEST_TIMEOUT_MS);

  it("marks a job interrupted when its runner died while the server was gone", async () => {
    const a = await startSession();
    const { job, id, pid } = await spawnHeld(a);
    await stopSession(a);
    // Dies hard (no chance to report): taskkill /F on Windows, SIGKILL elsewhere.
    if (process.platform === "win32") killPid(pid);
    else process.kill(pid, "SIGKILL");
    await waitFor(() => !pidAlive(pid));
    const b = await startSession();
    expect(await call(b, "peers")).toMatch(new RegExp(`${job} "Runner test": interrupted .*can be continued`));
    const stored = (JSON.parse(readFileSync(join(home, "jobs.json"), "utf8")) as { jobs: { id: string; host?: unknown }[] }).jobs;
    expect(stored.find((j) => j.id === id)?.host).toBeTruthy();
  }, TEST_TIMEOUT_MS);
});
