import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killPid, pidAlive } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { parentFromEnv } from "../src/core/parent-link.js";
import { readRunnerState } from "../src/mcp/job-host.js";

/**
 * Background subagents in detached job runners (bundled server and CLI: npm run build first). A fake
 * `claude` stands in for the subagent: it answers once its release file exists.
 */
const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
const SESSION = "codex-host";
const TEST_TIMEOUT_MS = 90_000;

const FAKE_CLAUDE = `
import { existsSync, writeFileSync } from "node:fs";
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", async () => {
  const session = "fake-" + process.pid;
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session, model: "fake" }));
  const release = /release=(\\S+)/.exec(prompt)?.[1];
  const link = /link=(\\S+)/.exec(prompt)?.[1];
  if (link) writeFileSync(link, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("AGENT_BRIDGE_PARENT_")))));
  if (link) writeFileSync(link + ".prompt", prompt);
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
async function startSession(inProcess = false): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, "--agent=codex"],
    env: { ...process.env, AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_NAME: SESSION, AGENT_BRIDGE_CLAUDE_BIN: claudeBin, AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_LOG_LEVEL: "debug", AGENT_BRIDGE_JOB_RUNNER: inProcess ? "0" : "1" } as Record<string, string>,
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
async function spawnHeld(s: { client: Client; transport: StdioClientTransport }, runner = true): Promise<{ job: string; id: string; release: string; pid: number; link: string }> {
  const release = join(home, `release-${releases.length}`);
  const link = `${release}.link.json`;
  releases.push(release);
  const out = await call(s, "spawn_claude", { prompt: `release=${release} link=${link} build the castle`, title: "Runner test" });
  const job = /Subagent (claude-job-([0-9a-f]+)) started/.exec(out);
  expect(job, out).not.toBeNull();
  const id = job![2]!;
  await waitFor(() => existsSync(link) && (!runner || readRunnerState(home, id)?.sessionId?.startsWith("fake-") === true));
  return { job: job![1]!, id, release, pid: runner ? readRunnerState(home, id)!.pid : s.transport.pid!, link };
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
  it("lets detached sibling runners discover and message each other directly", async () => {
    const session = await startSession();
    const a = await spawnHeld(session);
    await stopSession(session);
    const replacement = await startSession();
    const b = await spawnHeld(replacement);
    const first = parentFromEnv(JSON.parse(readFileSync(a.link, "utf8")))!;
    const second = parentFromEnv(JSON.parse(readFileSync(b.link, "utf8")))!;
    expect(await first.siblings.peers()).toEqual([{ name: b.job, title: "Runner test", agent: "claude", status: "running" }]);
    expect(readFileSync(a.link + ".prompt", "utf8")).toContain("call peers to find sibling jobs");
    const message = (await first.siblings.send(b.job, "The shared lock is free")).messages[0]!;
    expect(await second.inbox()).toMatchObject([{ sibling: { from: { name: a.job }, body: "The shared lock is free" } }]);
    await second.siblings.send(a.job, "Capture folder saved", message.id);
    expect(await first.inbox()).toMatchObject([{ sibling: { from: { name: b.job }, hop: 1, body: "Capture folder saved" } }]);
    // Chat is distinct from supervisor control: neither runner changes its owner or control history.
    expect(readRunnerState(home, a.id)?.seen).toEqual([]);
    expect(readRunnerState(home, b.id)?.seen).toEqual([]);
    await waitFor(async () => (await call(replacement, "inbox", { mark_read: false })).includes("Capture folder saved"));
    const copies = await call(replacement, "inbox");
    expect(copies).toContain(":note");
    expect(copies).toContain("Sibling message to");
    writeFileSync(a.release, "");
    writeFileSync(b.release, "");
    await waitFor(() => !pidAlive(a.pid) && !pidAlive(b.pid));
  }, TEST_TIMEOUT_MS);

  it("also connects sibling jobs hosted inside the supervisor's MCP server", async () => {
    const session = await startSession(true);
    const a = await spawnHeld(session, false);
    const b = await spawnHeld(session, false);
    const first = parentFromEnv(JSON.parse(readFileSync(a.link, "utf8")))!;
    const second = parentFromEnv(JSON.parse(readFileSync(b.link, "utf8")))!;
    expect(await first.siblings.peers()).toEqual([{ name: b.job, title: "Runner test", agent: "claude", status: "running" }]);
    const message = (await first.siblings.send(b.job, "In-process handover")).messages[0]!;
    expect(await second.inbox()).toMatchObject([{ sibling: { from: { name: a.job }, body: "In-process handover" } }]);
    await second.siblings.send(a.job, "Received", message.id);
    await waitFor(async () => (await call(session, "inbox", { mark_read: false })).includes("In-process handover"));
    writeFileSync(a.release, "");
    writeFileSync(b.release, "");
    await waitFor(async () => (await call(session, "peers")).includes(`${b.job} "Runner test": done`));
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
    const stored = JSON.parse(readFileSync(join(home, "jobs.json"), "utf8")) as { id: string; host?: unknown }[];
    expect(stored.find((j) => j.id === id)?.host).toBeTruthy();
  }, TEST_TIMEOUT_MS);
});
