import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureRemotePeer } from "./owned-mail.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import * as delegate from "../src/core/delegate.js";
import * as museContext from "../src/core/muse-context.js";
import { readJsonStore } from "../src/core/json-store.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { JobRunners, writeRunnerState } from "../src/mcp/job-host.js";
import { JobManager, readStore, type Job } from "../src/mcp/jobs.js";
import { RemoteJobHost } from "../src/mcp/remote-job-host.js";
import { runRemoteAsk } from "../src/mcp/remote-ask.js";
import { registerTools } from "../src/mcp/server.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { REMOTE_RUNNER_LEDGER_CAPABILITY, remoteSpawnArgsSchema, type RemoteJobRequest } from "../src/network/remote-job-protocol.js";
import { RemoteJobs } from "../src/network/remote-jobs.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let bin: string;
const managers: JobManager[] = [];
const connections: { client: Client; server: McpServer }[] = [];
const remotes: RemoteJobs[] = [];
const steps: string[] = [];
const fixtureLog = { ...nullLogger,
  debug: (message: string) => { steps.push(message); },
  info: (message: string) => { steps.push(message); },
  warn: (message: string) => { steps.push(message); },
  child: () => fixtureLog,
};
beforeEach(() => {
  steps.length = 0;
  vi.stubEnv("AGENT_BRIDGE_MUSE_EXEC", "1");
  env = makeEnv();
  const script = join(env.home, "muse.cjs");
  writeFileSync(script, String.raw`#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), flag = key => args[args.indexOf(key) + 1];
const session = args.includes("--session-id") ? flag("--session-id") : "muse-saved-session";
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({args, session, prompt:fs.readFileSync(flag("--prompt-file"), "utf8"), cwd:process.cwd()}) + "\n");
process.stdin.resume(); process.stdin.once("end",()=>console.log(JSON.stringify({stream:{kind:"session",id:session},payload_type:"run.terminal.completed",payload:{kind:"run_terminal",terminal:"completed",text:"fixture done"}})));
`);
  bin = process.platform === "win32" ? join(env.home, "muse.cmd") : script;
  if (process.platform === "win32") writeFileSync(bin, '@ECHO off\r\n"%dp0%\\muse.cjs" %*\r\n');
  else chmodSync(script, 0o755);
});
afterEach(async () => {
  for (const jobs of managers.splice(0)) jobs.cancelAll();
  for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); }
  for (const remote of remotes.splice(0)) remote.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await env.cleanup();
});
function calls(): { args: string[]; session: string; prompt: string; cwd: string }[] {
  return readFileSync(join(env.home, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}
async function session(node: BridgeNode) {
  const jobs = new JobManager(node, fixtureLog, join(env.home, "jobs.json"));
  managers.push(jobs);
  const server = new McpServer({ name: "muse-jobs", version: "1" });
  registerTools(server, { agent: "claude", cfg: { ...DEFAULT_CONFIG, museBin: bin }, log: fixtureLog, node,
    home: env.home, cwd: () => env.home, channelActive: () => false, jobs }, ["muse"]);
  const client = new Client({ name: "muse-jobs-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  connections.push({ client, server });
  return { client, jobs };
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { error: result.isError, text: (result.content as { text?: string }[]).map(c => c.text ?? "").join("\n") };
}

describe("Muse legacy exec profile persistence", () => {
  // These contracts exercise the real CLI argv and durable job transitions.
  // Windows identity/DPAPI setup is covered by muse-context.test.ts; its cold
  // helper processes must not consume this contract's job-completion budget.
  beforeEach(() => { vi.spyOn(museContext, "registerMuseContextAsync").mockResolvedValue(() => {}); });
  it("shows that slow context admission consumes the completion wait before the profile CLI can finish", async () => {
    const node = env.node("claude-slow-context"); await node.start();
    const { client, jobs } = await session(node);
    let release!: (cleanup: () => void) => void;
    const entered = vi.mocked(museContext.registerMuseContextAsync).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const spawned = await call(client, "spawn_muse", { prompt: "initial", title: "Slow context", permission_profile: "initial-profile" });
    expect(spawned.error).toBeFalsy();
    const name = /muse-job-[0-9a-f]{8}/.exec(spawned.text)![0];
    await until(() => entered.mock.calls.length === 1);
    try {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const completion = until(() => jobs.find(name)?.status === "done").catch(error => error);
      await vi.advanceTimersByTimeAsync(5_020);
      expect(await completion).toMatchObject({ message: "condition not met in time" });
      expect(jobs.find(name)?.status).toBe("running");
    } finally { vi.useRealTimers(); release(() => {}); }
    await until(() => jobs.find(name)?.status === "done");
    expect(calls()[0]!.args).toEqual(expect.arrayContaining(["--permission-profile", "initial-profile"]));
  });
  it("keeps the initial profile through continuation and reload, and replaces exact profiles with access", async () => {
    const node = env.node("claude-muse-jobs"); await node.start();
    let { client, jobs } = await session(node);
    const spawned = await call(client, "spawn_muse", { prompt: "initial", title: "Profile persistence", permission_profile: "initial-profile" });
    expect(spawned.error).toBeFalsy();
    const name = /muse-job-[0-9a-f]{8}/.exec(spawned.text)![0];
    await until(() => jobs.find(name)?.status === "done");
    expect(readStore(join(env.home, "jobs.json")).find(job => job.name === name)?.args?.permission_profile).toBe("initial-profile");
    await call(client, "message_subagent", { job: name, message: "same profile" });
    await until(() => jobs.find(name)?.status === "done" && calls().length === 2);
    expect(calls()[1]!.args).toEqual(expect.arrayContaining(["--permission-profile", "initial-profile", "--session-id", "muse-saved-session"]));
    const changed = await call(client, "message_subagent", { job: name, message: "new profile", permission_profile: "review-profile", effort: "high" });
    expect(changed.text).toContain("permission_profile=review-profile");
    await until(() => jobs.find(name)?.status === "done" && calls().length === 3);
    expect(calls()[2]!.args).toEqual(expect.arrayContaining(["--permission-profile", "review-profile", "--reasoning-effort", "high"]));
    jobs.setDormant(true);
    ({ client, jobs } = await session(node));
    expect(jobs.find(name)?.args?.permission_profile).toBe("review-profile");
    await call(client, "message_subagent", { job: name, message: "after reload" });
    await until(() => jobs.find(name)?.status === "done" && calls().length === 4);
    expect(calls()[3]!.args).toEqual(expect.arrayContaining(["--permission-profile", "review-profile", "--session-id", "muse-saved-session"]));
    await call(client, "message_subagent", { job: name, message: "edit without profile", access: "edit" });
    expect(jobs.find(name)?.args?.permission_profile).toBeUndefined();
    await until(() => jobs.find(name)?.status === "done" && calls().length === 5);
    expect(calls()[4]!.args).not.toContain("--permission-profile");
    expect(calls()[4]!.args).toContain("--disable-approval");
    expect(jobs.find(name)?.args?.permission_profile).toBeUndefined();
    jobs.setDormant(true);
    ({ client, jobs } = await session(node));
    expect(jobs.find(name)?.args).toMatchObject({ access: "edit" });
    expect(jobs.find(name)?.args?.permission_profile).toBeUndefined();
    const finalTurn = await call(client, "message_subagent", { job: name, message: "exact replaces edit", permission_profile: "safe-profile" });
    expect(finalTurn.error, finalTurn.text).toBeFalsy();
    try { await until(() => jobs.find(name)?.status === "done" && calls().length === 6); }
    catch (error) {
      const job = jobs.find(name);
      console.info("Muse final profile continuation", { receipt: finalTurn.text, status: job?.status, progress: job?.progress,
        args: job?.args, calls: calls().length, steps });
      throw error;
    }
    expect(jobs.find(name)?.args?.access).toBeUndefined();
    expect(calls()[5]!.args).toEqual(expect.arrayContaining(["--permission-profile", "safe-profile", "--disable-write", "--disable-shell"]));
    const before = calls().length;
    const rejected = await call(client, "message_subagent", { job: name, permission_mode: "plan" });
    expect(rejected.error).toBe(true); expect(rejected.text).toContain("permission_mode applies only to claude");
    expect(calls()).toHaveLength(before);
  });

  it("rejects Muse profile changes for another target without altering its saved permissions", async () => {
    const node = env.node("claude-profile-owner"); await node.start();
    const { client, jobs } = await session(node);
    const job = jobs.start("codex", null, "saved", async () => ({ text: "done", sessionId: "codex-session", isError: false, details: {} }), undefined, { sandbox: "read-only" });
    await until(() => job.status === "done");
    const rejected = await call(client, "message_subagent", { job: job.name, permission_profile: "muse-only" });
    expect(rejected.error).toBe(true); expect(rejected.text).toContain("permission_profile applies only to muse");
    expect(job.args).toEqual({ sandbox: "read-only" });
  });
});

describe("Muse legacy exec remote profile contracts", () => {
  function receiver(pair = { id: randomUUID(), name: "paired", fingerprint: "a".repeat(64) }) {
    let receive!: (payload: Record<string, unknown>, pair: any) => Promise<void>;
    const responses: any[] = [];
    const advertised = fixtureRemotePeer(env.home, pair, { id: "supervisor", name: "sender", sessionId: "supervisor" });
    const remote = new RemoteJobs({ registerExtension: (_frame: string, _capability: string, handler: typeof receive) => { receive = handler; },
      peers: () => [advertised], peerSupports: () => true,
      sendExtension: async (_host: string, _frame: string, payload: unknown) => { responses.push(payload); } } as any,
    env.home, nullLogger, async () => {});
    remotes.push(remote);
    return { remote, pair, request: async (request: RemoteJobRequest, supervisor = "supervisor") => {
      await receive({ kind: "request", rid: randomUUID(), peer: { id: "supervisor", name: "sender", supervisor }, request }, pair);
      return responses.at(-1);
    } };
  }
  function setupReceiver() {
    writeFileSync(join(env.home, "config.json"), JSON.stringify({ museBin: bin, maxJobs: 8,
      network: { ...DEFAULT_NETWORK_CONFIG, remoteJobs: { enabled: true, allowRoots: [env.home], agents: ["muse", "codex"], allowPeers: ["paired"] } } }));
    vi.spyOn(delegate, "bundledCli").mockReturnValue("fixture-runner");
    vi.spyOn(JobRunners.prototype, "alive").mockReturnValue(false);
    return vi.spyOn(JobRunners.prototype, "startAsync").mockImplementation(async (job, spec) => {
      const result = await DELEGATION_TARGETS.muse.run(spec.cfg, { cwd: spec.cwd, prompt: spec.args.prompt, sessionId: spec.args.session_id,
        timeoutSec: 10, log: nullLogger, effort: spec.args.effort }, spec.args);
      writeRunnerState(env.home, job.id, { pid: 0, peer: job.name, status: "done", updatedAt: Date.now(), sessionId: result.sessionId, workdir: env.home, report: result.text });
      return { pid: null, peer: job.name, startedAt: Date.now() };
    });
  }

  it("launches a profile across the wire, reloads remote settings, and preserves supervisor ownership", async () => {
    const launch = setupReceiver();
    let remote = receiver();
    const spawn = (args: Record<string, unknown> = {}): Extract<RemoteJobRequest, { op: "spawn" }> => ({ op: "spawn", job: "abcdef12", target: "muse",
      args: remoteSpawnArgsSchema.parse({ prompt: "remote turn", title: "Remote profile", cwd: env.home, ...args }) });
    expect((await remote.request(spawn({ permission_profile: "initial" }))).error).toBeUndefined();
    expect(calls()[0]!.args).toEqual(expect.arrayContaining(["--permission-profile", "initial"]));
    expect((await remote.request({ op: "control", job: "abcdef12", control: { type: "settings", settings: { permission_profile: "remote-review" } } })).error).toBeUndefined();
    remote.remote.close(); remote = receiver(remote.pair);
    expect((await remote.request(spawn())).error).toBeUndefined();
    expect(calls()[1]!.args).toEqual(expect.arrayContaining(["--permission-profile", "remote-review", "--session-id", "muse-saved-session"]));
    expect((readJsonStore(join(env.home, "remote-jobs.json")) as any).jobs[0].args.permission_profile).toBe("remote-review");
    expect((await remote.request(spawn({ access: "edit" }))).error).toBeUndefined();
    expect(calls()[2]!.args).not.toContain("--permission-profile"); expect(calls()[2]!.args).toContain("--disable-approval");
    expect((await remote.request(spawn({ permission_profile: "exact" }))).error).toBeUndefined();
    expect(calls()[3]!.args).toEqual(expect.arrayContaining(["--permission-profile", "exact", "--disable-write"]));
    const count = launch.mock.calls.length;
    const foreignHost = receiver({ ...remote.pair, id: randomUUID() });
    expect((await foreignHost.request(spawn())).error).toContain("another supervisor");
    foreignHost.remote.close();
    expect((await remote.request(spawn(), "another-owner")).error).toContain("another supervisor");
    expect((await remote.request({ ...spawn({ permission_profile: "wrong-agent" }), job: "abcdef13", target: "codex" })).error).toContain("only to muse");
    expect((await remote.request({ ...spawn({ session_id: "unowned" }), job: "abcdef14" })).error).toContain("owned by this supervisor");
    expect(launch).toHaveBeenCalledTimes(count);
  });

  it("keeps profile arguments in both requesting launch paths and rejects internal wire fields", async () => {
    const snapshot = { state: { pid: 0, peer: "muse-job-abcdef12", status: "done", updatedAt: Date.now(), report: "remote done", sessionId: "remote-session" }, alive: false, approvals: [] };
    const remoteJob = vi.fn(async () => snapshot);
    const node = { remoteJob } as unknown as BridgeNode;
    const job = { id: "abcdef12", name: "muse-job-abcdef12", controller: new AbortController(), workdir: env.home } as Job;
    const args = { prompt: "remote", title: "Remote launch", cwd: env.home, host: "paired", permission_profile: "named" };
    const host = new RemoteJobHost(node, env.home, nullLogger);
    host.start(job, "paired", "muse", { ...args, _job: job.name });
    await until(() => remoteJob.mock.calls.length === 1);
    await runRemoteAsk(node, "muse", args, job, new AbortController().signal, () => {});
    expect(remoteJob).toHaveBeenCalledTimes(2);
    for (const [paired, request] of remoteJob.mock.calls as unknown as [string, RemoteJobRequest][]) {
      expect(paired).toBe("paired");
      expect(request).toMatchObject({ op: "spawn", target: "muse", args: { permission_profile: "named" } });
      expect(request.op === "spawn" && "_job" in request.args).toBe(false);
    }
    const publicArgs = { prompt: "task", title: "wire", cwd: env.home, permission_profile: "named" };
    expect(remoteSpawnArgsSchema.parse(publicArgs)).toEqual(publicArgs);
    for (const profile of ["", " ", "x".repeat(81)]) expect(remoteSpawnArgsSchema.safeParse({ ...publicArgs, permission_profile: profile }).success).toBe(false);
    for (const key of ["bin", "env", "_job", "_worktree", "send_to"]) expect(remoteSpawnArgsSchema.safeParse({ ...publicArgs, [key]: "injected" }).success).toBe(false);
  });
});
