import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { APP_VERSION, PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import type { AgentKind } from "../src/core/protocol.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { readProcessIdentity } from "../src/core/process-identity.js";
import { SHUTDOWN_DEADLINE_MS, watchParent } from "../src/mcp/server-lifecycle.js";
import { codexHost, makeEnv, until, type TestEnv } from "./helpers.js";
import { killPid, pidAlive } from "../src/core/delegate.js";
import { readRunnerState } from "../src/mcp/job-host.js";
import { readStore } from "../src/mcp/jobs.js";

/** AB-385: a retired stdio server must leave within this budget (graceful shutdown deadline plus process exit). */
const EXIT_BUDGET_MS = SHUTDOWN_DEADLINE_MS + 2_000;
const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");

let env: TestEnv;
/** Only processes this test started; nothing else is ever signalled. */
const started: ChildProcess[] = [];
const clients: Client[] = [];
const rawClients: BridgeClient[] = [];

beforeEach(() => { env = makeEnv(); });
afterEach(async () => {
  for (const c of rawClients.splice(0)) c.close();
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  for (const child of started.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill();
  await env.cleanup();
});

function serverEnv(name: string): Record<string, string> {
  return { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_DELIVERY: "hooks", AGENT_BRIDGE_WAKE_ON_DIRECT: "off",
    AGENT_BRIDGE_AUTO_WAKE: "off", AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_DELEGATE_DEPTH: "0" } as Record<string, string>;
}
const logText = () => { try { return readFileSync(join(env.home, "logs", "agent-bridge.log"), "utf8"); } catch { return ""; } };
const logged = (pid: number, text: string) => logText().split(/\r?\n/).some((line) => line.includes(`pid=${pid} `) && line.includes(text));
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function exitsWithin(pid: number, budgetMs: number): Promise<number> {
  const startedAt = Date.now();
  await until(() => !running(pid), budgetMs, 50);
  return Date.now() - startedAt;
}

/**
 * Registers like a server that /reload-plugins started for the same session. By default it claims this test
 * process as its host (the same parent PID and creation identity as the server under test, which this test spawned).
 */
async function registerReplacement(env: TestEnv, opts: { sessionId: string; version: string; name?: string; agent?: string; agentPid?: number; agentStartedAt?: string }): Promise<void> {
  const raw = await BridgeClient.connect(env.pipe, nullLogger);
  rawClients.push(raw);
  const agentStartedAt = opts.agentStartedAt ?? await readProcessIdentity(process.pid);
  expect(agentStartedAt).toBeTruthy();
  await raw.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: { id: `replacement-${opts.version}-${opts.sessionId}`, name: opts.name ?? "old-srv",
    agent: (opts.agent ?? "other") as AgentKind, cwd: env.home, pid: process.pid, agentPid: opts.agentPid ?? process.pid, agentStartedAt, sessionId: opts.sessionId, startedAt: Date.now(), autoWake: false, version: opts.version } });
}

describe.skipIf(!existsSync(SERVER))("AB-385 stale MCP servers exit", () => {
  it("exits within budget when stdin closes while it hosts the broker, and queued mail survives the handover", async () => {
    const child = spawn(process.execPath, [SERVER, "--agent=other"], { cwd: env.home, env: serverEnv("old-srv"), stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    started.push(child);
    child.stdout!.resume();
    const pid = child.pid!;
    await until(() => logged(pid, '"isBroker":true'), 30_000, 50);

    const watcher = env.node("watcher", "other");
    await watcher.start();
    expect(watcher.isBroker).toBe(false);
    await watcher.send({ to: "later", body: "queued before the reload" });

    // The host drops the server's stdin (a reload that does close it): the server must not linger as the broker.
    child.stdin!.end();
    const took = await exitsWithin(pid, EXIT_BUDGET_MS);
    expect(took).toBeLessThan(EXIT_BUDGET_MS);
    expect(logged(pid, '"reason":"stdin ended"')).toBe(true);

    // A remaining server takes the broker over; the queued mail is still delivered.
    await until(() => watcher.isConnected && watcher.isBroker, 10_000);
    const later = env.node("later", "other");
    await later.start();
    await until(() => later.unread().length === 1);
    expect(later.unread()[0]!.body).toBe("queued before the reload");
  });

  async function oldServerWithSession(sessionId: string) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, "--agent=other"], cwd: env.home, env: serverEnv("old-srv"), stderr: "ignore" });
    const client = new Client({ name: "ab385", version: "1" });
    clients.push(client);
    await client.connect(transport);
    const pid = transport.pid!;
    await until(() => logged(pid, '"isBroker":true'), 30_000, 50);
    await client.callTool({ name: "hook_event", arguments: { event: "Stop", session_id: sessionId } });
    const watcher = env.node("watcher", "other");
    await watcher.start();
    let registered = false;
    const deadline = Date.now() + 5_000;
    while (!(registered = (await watcher.peers()).some((p) => p.name === "old-srv" && p.sessionId === sessionId)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(registered).toBe(true);
    return { pid, watcher };
  }


  it("an older server yields and exits when a newer version registers for its session, though its stdin stays open", async () => {
    const { pid, watcher } = await oldServerWithSession("session-ab385");
    await watcher.send({ to: "absent", body: "mail kept across the yield" });
    await registerReplacement(env, { sessionId: "session-ab385", version: "999.0.0" });
    const took = await exitsWithin(pid, EXIT_BUDGET_MS);
    expect(took).toBeLessThan(EXIT_BUDGET_MS);
    expect(logged(pid, "replaced by newer server v999.0.0 of the same host")).toBe(true);
    await until(() => watcher.isConnected && watcher.isBroker, 10_000);
    const absent = env.node("absent", "other");
    await absent.start();
    await until(() => absent.unread().length === 1);
    expect(absent.unread()[0]!.body).toBe("mail kept across the yield");
  });

  it.each([
    ["a same-version replacement of the same host (reclaim path)", { version: APP_VERSION }],
    ["a newer replacement from another host process of the same session (a second terminal)", { version: "999.0.0", agentPid: 999_999, agentStartedAt: "another-host" }],
    ["a newer replacement whose host PID matches but whose creation identity does not (PID reuse)", { version: "999.0.0", agentStartedAt: "another-start" }],
  ] as const)("the server stays after %s", async (_label, replacement) => {
    const sessionId = `session-stays-${replacement.version}-${"agentPid" in replacement ? "pid" : "same"}`;
    const { pid } = await oldServerWithSession(sessionId);
    await registerReplacement(env, { sessionId, ...replacement });
    await until(() => logged(pid, "replaced by a newer server of this session"), 10_000, 50);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(running(pid)).toBe(true);
    expect(logged(pid, "shutting down")).toBe(false);
  });
});

describe("AB-385 parent watchdog against a real process", () => {
  it("reports a parent that has exited", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    started.push(child);
    const pid = child.pid!;
    await new Promise((r) => child.once("exit", r));
    const reasons: string[] = [];
    const stop = watchParent({ ppid: pid, identity: Promise.resolve(null), onGone: (r) => reasons.push(r), checkMs: 20, currentPpid: () => pid });
    try {
      await until(() => reasons.length > 0, 5_000);
      expect(reasons).toEqual([`parent ${pid} ended`]);
    } finally { stop(); }
  });
});

describe.skipIf(!existsSync(SERVER))("AB-385 jobs across a yield", () => {
  let bin: string;
  const runnerIds: string[] = [];
  beforeEach(() => {
    const dir = join(env.home, "bin");
    mkdirSync(dir);
    const file = join(dir, "fake.mjs");
    // A minimal Codex app-server: each turn completes once its release file exists.
    writeFileSync(file, `#!/usr/bin/env node
import {existsSync,appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
appendFileSync(${JSON.stringify(join(env.home, "fixture-pids"))}, String(process.pid)+'\\n');
const send=value=>console.log(JSON.stringify(value));
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(!m.method||m.id===undefined)return;
 let result={};
 if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'fixture-'+process.pid}};
 if(m.method==='turn/start')result={turn:{id:'turn-1'}};
 send({id:m.id,result});
 if(m.method!=='turn/start')return;
 const release=/release=(\\S+)/.exec((m.params.input||[]).map(x=>x.text||'').join(' '))?.[1];
 const timer=setInterval(()=>{
  if(release&&!existsSync(release))return;
  clearInterval(timer);
  send({method:'item/completed',params:{turnId:'turn-1',item:{type:'agentMessage',text:'Fixture result '+release}}});
  send({method:'turn/completed',params:{turn:{id:'turn-1',status:'completed'}}});
 },20);
});`);
    if (process.platform === "win32") { bin = join(dir, "codex.cmd"); writeFileSync(bin, '@ECHO off\r\n"%dp0%\\fake.mjs" %*\r\n'); }
    else { chmodSync(file, 0o755); bin = file; }
  });
  afterEach(async () => {
    for (const release of ["runner-release", "inline-release"]) writeFileSync(join(env.home, release), "");
    const runners = runnerIds.splice(0).map((id) => readRunnerState(env.home, id)?.pid).filter((pid): pid is number => Boolean(pid));
    for (const pid of runners) if (pidAlive(pid)) killPid(pid);
    const fixtures = existsSync(join(env.home, "fixture-pids")) ? readFileSync(join(env.home, "fixture-pids"), "utf8").trim().split(/\s+/).map(Number) : [];
    for (const pid of fixtures) if (pidAlive(pid)) killPid(pid);
    await until(() => [...runners, ...fixtures].every((pid) => !pidAlive(pid)), 5_000);
  });

  async function codexSession(name: string) {
    const client = new Client({ name: "ab385-jobs", version: "1" });
    clients.push(client);
    const codexHome = codexHost(client, env.home, "codex", name);
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, "--agent=codex"], cwd: env.home, env: {
      ...serverEnv(name), CODEX_HOME: codexHome, CLAUDE_PROJECT_DIR: env.home, AGENT_BRIDGE_CODEX_BIN: bin, AGENT_BRIDGE_CODEX_EXEC: "0", AGENT_BRIDGE_JOB_RUNNER: "1", AGENT_BRIDGE_MAX_JOBS: "8",
    }, stderr: "ignore" });
    await client.connect(transport);
    const call = async (tool: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name: tool, arguments: args, _meta: { threadId: "yield-thread" } });
      return { text: (r.content as { text: string }[]).map((c) => c.text ?? "").join("\n"), error: Boolean(r.isError) };
    };
    await call("peers");
    return { pid: transport.pid!, call };
  }
  const stored = (prefix: string) => readStore(join(env.home, "jobs.json")).find((job) => job.name.startsWith(prefix));

  it("a runner-hosted job keeps running and finishes; the inline ask is settled interrupted (resumable) by the new server", async () => {
    const old = await codexSession("codex-yield");
    const watcher = env.node("watcher", "other");
    await watcher.start();
    const runner = await old.call("spawn", { agent: "codex", prompt: `release=${join(env.home, "runner-release")} runner work`, title: "Runner work", sandbox: "danger-full-access" });
    expect(runner.error, runner.text).toBe(false);
    const runnerName = /codex-job-[a-f0-9]+/.exec(runner.text)![0], runnerId = runnerName.split("-").at(-1)!;
    runnerIds.push(runnerId);
    await until(() => Boolean(readRunnerState(env.home, runnerId)?.pid && readRunnerState(env.home, runnerId)?.live), 60_000, 50);
    const runnerPid = readRunnerState(env.home, runnerId)!.pid!;
    // The blocking ask runs inline, inside the old server.
    const ask = old.call("spawn", { wait: true, agent: "codex", prompt: `release=${join(env.home, "inline-release")} inline work`, title: "Inline work", sandbox: "danger-full-access" }).catch((err) => ({ text: String(err), error: true }));
    await until(() => stored("codex-ask-")?.status === "running", 30_000, 50);

    const registered = (await watcher.peers()).find((p) => p.name === "codex-yield");
    expect(registered?.sessionId).toBeTruthy();
    await registerReplacement(env, { sessionId: registered!.sessionId!, version: "999.0.0", name: "codex-yield", agent: "codex" });
    await exitsWithin(old.pid, EXIT_BUDGET_MS);
    expect(logged(old.pid, "replaced by newer server v999.0.0 of the same host")).toBe(true);
    expect(logged(old.pid, "inline subagent turns recorded as interrupted")).toBe(true);
    expect((await ask).error).toBe(true);
    // The runner outlives the yielded server.
    expect(pidAlive(runnerPid)).toBe(true);
    // The dormant old server wrote no cancellation over the new server's job store.
    expect(stored("codex-ask-")?.status).toBe("running");
    for (const raw of rawClients.splice(0)) raw.close();

    // The session's new server takes the jobs over.
    const next = await codexSession("codex-yield");
    writeFileSync(join(env.home, "runner-release"), "");
    await until(() => readRunnerState(env.home, runnerId)?.status === "done", 60_000, 50);
    await expect.poll(async () => (await next.call("inbox")).text, { timeout: 20_000 }).toContain(runnerName);
    // The inline turn whose executor yielded is listed as interrupted (continuable with message_subagent)...
    expect((await next.call("peers")).text).toMatch(/codex-ask-[a-f0-9]+ "Inline work": interrupted/);
    // ... and durably: the yielded server left it in the pending-job journal, which the new server merged.
    await until(() => stored("codex-ask-")?.status === "interrupted", 30_000, 100);
  });
});
