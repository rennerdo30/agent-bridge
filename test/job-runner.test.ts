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
import { listPendingApprovals } from "../src/core/relay.js";
import { CONTROL_CONVERSATION_PREFIX } from "../src/mcp/job-host.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { parentFromEnv } from "../src/core/parent-link.js";
import { readRunnerState } from "../src/mcp/job-host.js";
import { readStore } from "../src/mcp/jobs.js";
import { RootConcurrency } from "../src/core/root-concurrency.js";
import { startUi } from "../src/cli/ui.js";

/**
 * Background subagents in detached job runners (bundled server and CLI: npm run build first). A fake
 * `claude` stands in for the subagent: it answers once its release file exists.
 */
const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
const SESSION = "codex-host";
const TEST_TIMEOUT_MS = 90_000;

const FAKE_CLAUDE = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
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
let ui: Awaited<ReturnType<typeof startUi>> | undefined;

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
  // The MCP handshake precedes broker registration and session recovery.
  // This fixture represents a connected supervisor, including on replacement.
  await call(s, "peers");
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
async function spawnHeld(s: { client: Client; transport: StdioClientTransport }, runner = true, sendTo: string[] = []): Promise<{ job: string; id: string; release: string; pid: number; link: string }> {
  const release = join(home, `release-${releases.length}`);
  const link = `${release}.link.json`;
  releases.push(release);
  const out = await call(s, "spawn_claude", { prompt: `release=${release} link=${link} build the castle`, title: "Runner test", send_to: sendTo });
  const job = /Subagent (claude-job-([0-9a-f]+)) started/.exec(out);
  expect(job, out).not.toBeNull();
  const id = job![2]!;
  await waitFor(() => existsSync(link) && (!runner || readRunnerState(home, id)?.sessionId?.startsWith("fake-") === true));
  return { job: job![1]!, id, release, pid: runner ? readRunnerState(home, id)!.pid : s.transport.pid!, link };
}

beforeEach(() => {
  // Leave room for the broker socket under macOS's 104-byte Unix socket path limit.
  home = mkdtempSync(join(tmpdir(), "abj-"));
  claudeBin = installFakeClaude(join(home, "bin"));
});

afterEach(async () => {
  await ui?.close();
  ui = undefined;
  // Let every fake finish, and stop runners a test left behind.
  for (const r of releases.splice(0)) writeFileSync(r, "");
  const runners = join(home, "jobs");
  const pids = existsSync(runners) ? readdirSync(runners)
    .filter((file) => file.endsWith(".json") && !file.endsWith(".spec.json"))
    .map((file) => readRunnerState(home, file.slice(0, -5))?.pid).filter((pid): pid is number => Boolean(pid)) : [];
  for (const pid of pids) if (pidAlive(pid)) killPid(pid);
  await waitFor(() => pids.every((pid) => !pidAlive(pid)));
  for (const s of sessions.splice(0)) await stopSession(s).catch(() => {});
  for (const n of nodes.splice(0)) await n.stop().catch(() => {});
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

describe.skipIf(!existsSync(SERVER))("background subagents in job runners", () => {
  it.skipIf(process.platform !== "win32")("stops orphaned tools before publishing done without stopping a sibling job", async () => {
    const marker = join(home, "owned-orphan.pid");
    const detached = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);";
    const intermediate = "require('node:child_process').spawn(process.execPath,['-e'," + JSON.stringify(detached) + ",process.argv[1]],{detached:true,windowsHide:true,stdio:'ignore'}).unref();";
    const setup = `
      const background=/background=(\\S+)/.exec(prompt)?.[1];
      if (background) {
        const child=spawn(process.execPath,['-e',${JSON.stringify(intermediate)},background],{windowsHide:true,stdio:'ignore'});
        await new Promise(resolve=>child.once('exit',resolve));
        while(!existsSync(background)) await new Promise(resolve=>setTimeout(resolve,20));
      }
    `;
    writeFileSync(join(home, "bin", "fake-claude.mjs"), "#!/usr/bin/env node\nimport { spawn } from 'node:child_process';\n" + FAKE_CLAUDE.replace('  const args = process.argv.slice(2);', setup + '  const args = process.argv.slice(2);'));
    const session = await startSession();
    const sibling = await spawnHeld(session);
    const output = await call(session, "spawn_claude", { prompt: "background=" + marker, title: "Orphan cleanup test" });
    const id = /claude-job-([0-9a-f]+)/.exec(output)![1]!;
    await waitFor(() => readRunnerState(home, id)?.status === "done");
    const state = readRunnerState(home, id)!;
    const orphan = Number(readFileSync(marker, "utf8"));
    expect(pidAlive(orphan)).toBe(false);
    expect(state.report).toContain("Background process cleanup: stopped 1 surviving job-owned processes (PIDs " + orphan + "); 0 still running.");
    expect(readRunnerState(home, sibling.id)?.status).toBe("running");
    expect(pidAlive(sibling.pid)).toBe(true);
    writeFileSync(sibling.release, "");
    await waitFor(() => !pidAlive(state.pid) && !pidAlive(sibling.pid));
  });

  it("counts detached jobs in the root budget and forwards descendant approval escalation", async () => {
    const session = await startSession();
    const held = await spawnHeld(session);
    const stored = readStore(join(home, "jobs.json")).find((job) => job.name === held.job)!;
    expect(stored).toMatchObject({ metadataVersion: 2, rootSession: expect.any(String), rootName: SESSION });
    const budget = new RootConcurrency(home, stored.rootSession!);
    const extra = { id: "nested-test-child", pid: process.pid };
    try {
      budget.setLimit(1);
      expect(budget.acquire(extra)).toBe(false);
      const child = parentFromEnv(JSON.parse(readFileSync(held.link, "utf8")))!;
      await child.escalate!("Nested child requests owner approval");
      expect(await call(session, "wait_for_message", { from: held.job, timeout_sec: 10 })).toContain("Nested child requests owner approval");
      writeFileSync(held.release, "");
      await waitFor(() => readRunnerState(home, held.id)?.status === "done" && !pidAlive(held.pid));
      expect(budget.acquire(extra)).toBe(true);
    } finally { budget.release(extra); budget.close(); }
  }, TEST_TIMEOUT_MS);

  it("keeps explicit session reply grants across a detached job continuation", async () => {
    const session = await startSession();
    const external = new BridgeNode({ pipePath: resolvePipePath(home), token: loadOrCreateToken(home), dbPath: resolveDbPath(home),
      name: "claude-reviewer", agent: "claude", cwd: home, autoWake: false, log: nullLogger });
    nodes.push(external);
    await external.start();
    const request = (await external.send({ to: SESSION, body: "Review the contract" })).messages[0]!;
    const a = await spawnHeld(session, true, [external.name]);
    const first = parentFromEnv(JSON.parse(readFileSync(a.link, "utf8")))!;
    const reply = (await first.siblings.send(external.name, "Contract deliverable", request.id)).messages[0]!;
    expect(reply).toMatchObject({ conversationId: request.conversationId, replyTo: request.id });
    expect((await first.siblings.policy!()).sendTo).toEqual([external.name]);
    writeFileSync(a.release, "");
    await waitFor(() => readRunnerState(home, a.id)?.status === "done" && !pidAlive(a.pid));
    await stopSession(session);
    const replacement = await startSession();
    const release = join(home, "release-continued");
    const link = `${release}.link.json`;
    releases.push(release);
    await call(replacement, "message_subagent", { job: a.job, message: `release=${release} link=${link} continue the review` });
    await waitFor(() => existsSync(link));
    const continued = parentFromEnv(JSON.parse(readFileSync(link, "utf8")))!;
    expect((await continued.siblings.policy!()).sendTo).toEqual([external.name]);
    // The broker moved with the replaced session: the external session reconnects on its own schedule (slow CI runners).
    await waitFor(async () => external.isConnected && (await external.peers().catch(() => [])).some((p) => p.name === external.name));
    expect((await continued.siblings.send(external.name, "Follow-up deliverable", reply.id)).deliveredTo).toEqual([external.name]);
    writeFileSync(release, "");
    // A final state is saved before report delivery and broker disconnect finish.
    await waitFor(() => {
      const state = readRunnerState(home, a.id);
      return state?.status === "done" && !pidAlive(state.pid);
    });
  }, TEST_TIMEOUT_MS);

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
    expect(await call(replacement, "inbox")).not.toContain("Sibling message to");
    const copies = await call(replacement, "inbox", { include_quiet: true });
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

  it("routes dashboard messages through the owning session to its detached runner and continues it later", async () => {
    const s = await startSession();
    const { job, id, release, pid } = await spawnHeld(s);
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
    expect((await post("also paint the walls")).outcome).toMatch(/delivered|queued/);
    await waitFor(() => (readRunnerState(home, id)?.seen?.length ?? 0) === 1);
    writeFileSync(release, "");
    expect(await call(s, "wait_for_message", { from: job, timeout_sec: 60 })).toContain("Your queued follow-up was sent to it");
    expect(await call(s, "wait_for_message", { from: job, timeout_sec: 60 })).toContain("fake answer: finished");
    await waitFor(() => !pidAlive(pid));
    expect(await post("continue the finished job")).toMatchObject({ outcome: "started" });
    expect(await call(s, "wait_for_message", { from: job, timeout_sec: 60 })).toContain("fake answer: finished");
    await waitFor(() => readRunnerState(home, id)?.status === "done");
    const resumedPid = readRunnerState(home, id)!.pid;
    await waitFor(() => !pidAlive(resumedPid));
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

  it("continues a cancelled runner despite legacy cancellation mail", async () => {
    const session = await startSession();
    const first = await spawnHeld(session);
    await call(session, "cancel_subagent", { job: first.job });
    await waitFor(() => !pidAlive(first.pid));
    await call(session, "wait_for_message", { from: first.job, timeout_sec: 10 });
    await stopSession(session);
    // An authorized legacy supervisor leaves cancellation mail for the stable job peer name.
    const sender = new BridgeNode({ pipePath: resolvePipePath(home), token: loadOrCreateToken(home), dbPath: resolveDbPath(home), agent: "codex", name: SESSION, cwd: home, autoWake: false, log: nullLogger });
    nodes.push(sender); await sender.start();
    await sender.send({ to: first.job, body: JSON.stringify({ type: "cancel" }), conversationId: CONTROL_CONVERSATION_PREFIX + first.id });
    await sender.stop();
    const replacement = await startSession();
    const release = join(home, "release-resumed"), link = release + ".link.json";
    releases.push(release);
    expect(await call(replacement, "message_subagent", { job: first.job, message: `release=${release} link=${link} Continue` })).toContain("Sent to");
    await waitFor(() => existsSync(link));
    const state = readRunnerState(home, first.id)!;
    await new Promise(resolve => setTimeout(resolve, 5_100));
    expect(pidAlive(state.pid)).toBe(true);
    writeFileSync(release, "");
    expect(await call(replacement, "wait_for_message", { from: first.job, timeout_sec: 10 })).toContain("fake answer: finished");
    await waitFor(() => !pidAlive(state.pid));
  });

  it("delivers plain messages during a detached approval and requires an explicit decide", async () => {
    const fake = FAKE_CLAUDE.replace('  const args = process.argv.slice(2);', `
      if (/ask-approval/.test(prompt)) {
        const response = await fetch(process.env.AGENT_BRIDGE_RELAY_URL, { method: "POST", headers: { authorization: "Bearer " + process.env.AGENT_BRIDGE_RELAY_TOKEN }, body: JSON.stringify({ agent: "claude", tool: "shell", detail: "test permission" }) });
        const decision = await response.json();
        if (!decision.allow) throw new Error("Unexpected denial");
      }
      const args = process.argv.slice(2);`);
    writeFileSync(join(home, "bin", "fake-claude.mjs"), "#!/usr/bin/env node\n" + fake);
    const session = await startSession();
    const output = await call(session, "spawn_claude", { prompt: "ask-approval", title: "Approval test", access: "edit" });
    const job = /claude-job-[a-f0-9]+/.exec(output)![0];
    await waitFor(() => listPendingApprovals(home).length === 1);
    const approval = listPendingApprovals(home)[0]!;
    const response = await call(session, "message_subagent", { job, message: "Wind down now" });
    expect(response).toContain("approval is still pending");
    expect(listPendingApprovals(home)).toHaveLength(1);
    expect(await call(session, "decide", { approval_id: approval.id, decision: "allow" })).toBe("Approval answered.");
    await waitFor(() => listPendingApprovals(home).length === 0);
    await waitFor(() => readRunnerState(home, job.split("-").at(-1)!)?.status === "done");
    const calls = readFileSync(join(home, "bin", "calls.jsonl"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
  });

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
