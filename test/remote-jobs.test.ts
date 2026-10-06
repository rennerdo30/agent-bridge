import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { killPid, pidAlive } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { BridgeNode } from "../src/core/node.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { answerPendingApproval, listPendingApprovals } from "../src/core/relay.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { listRuns, startUi } from "../src/cli/ui.js";
import { readRunnerState } from "../src/mcp/job-host.js";
import { readStore } from "../src/mcp/jobs.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { NetworkService } from "../src/network/link.js";
import { allowedRemoteDirectory, RemoteJobs } from "../src/network/remote-jobs.js";
import { REMOTE_JOB_RATE_LIMIT, remoteSpawnArgsSchema } from "../src/network/remote-job-protocol.js";

const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
const TEST_TIMEOUT_MS = 90_000;
const LOOPBACK = "127.0.0.1";
let root: string;
let cleanup: (() => Promise<unknown> | void)[];
let remoteHome: string;
let localHome: string;
let repo: string;
const pids = new Set<number>();
const FAKE = `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',d=>prompt+=d);
process.stdin.on('end',async()=>{
 const args=process.argv.slice(2); const flag=k=>args[args.indexOf(k)+1];
 const session=args.includes('--resume')?flag('--resume'):'fake-'+process.pid;
 appendFileSync(new URL('calls.jsonl',import.meta.url),JSON.stringify({args,session,cwd:process.cwd(),prompt})+'\\n');
 console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,model:args.includes('--model')?flag('--model'):'fake'}));
 const marker=/marker=(\\S+)/.exec(prompt)?.[1];
 if(marker)writeFileSync(marker,JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('AGENT_BRIDGE_PARENT_')))));
 if(prompt.includes('approve=yes')){
  const response=await fetch(process.env.AGENT_BRIDGE_RELAY_URL,{method:'POST',headers:{authorization:'Bearer '+process.env.AGENT_BRIDGE_RELAY_TOKEN,'content-type':'application/json'},body:JSON.stringify({agent:'claude',tool:'Bash',detail:'fake build',reason:'test approval'})});
  const decision=await response.json(); console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'approval '+decision.allow}]}}));
 }
 const release=/release=(\\S+)/.exec(prompt)?.[1];
 while(release&&!existsSync(release))await new Promise(r=>setTimeout(r,50));
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'remote fake finished '+session,session_id:session}));
});
`;

beforeEach(() => {
  // Transfer fixtures must have no linked ancestors (/var on macOS); native also expands Windows 8.3 names.
  // Short names: macOS caps Unix socket paths at 104 bytes, and its real temp path (/private/var/folders/…) is long.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "abr-")));
  localHome = join(root, "w"); remoteHome = join(root, "m"); repo = join(root, "allowed");
  for (const path of [localHome, remoteHome, repo]) mkdirSync(path, { recursive: true });
  cleanup = [];
});
afterEach(async () => {
  if (existsSync(join(remoteHome, "jobs"))) for (const file of readdirSync(join(remoteHome, "jobs"))) {
    const state = readRunnerState(remoteHome, file.replace(/\.json$/, ""));
    if (state?.pid) pids.add(state.pid);
  }
  for (const pid of pids) if (pidAlive(pid)) killPid(pid);
  await waitFor(() => [...pids].every((pid) => !pidAlive(pid)));
  pids.clear();
  for (const close of cleanup.reverse()) await close();
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function waitFor(test: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await test()) { if (Date.now() > deadline) throw new Error("Remote test timed out"); await new Promise((r) => setTimeout(r, 50)); }
}
function config(home: string, name: string, allowed = false): void {
  const bin = join(remoteHome, "fake-claude.mjs");
  writeFileSync(bin, FAKE); chmodSync(bin, 0o755);
  let claudeBin = bin;
  if (process.platform === "win32") { claudeBin = join(remoteHome, "claude.cmd"); writeFileSync(claudeBin, '@ECHO off\r\n"%dp0%\\fake-claude.mjs" %*\r\n'); }
  writeFileSync(join(home, "config.json"), JSON.stringify({ dashboard: false, claudeBin, network: { ...DEFAULT_NETWORK_CONFIG, enabled: true, name, bind: LOOPBACK, port: 0, remoteJobs: { enabled: allowed, allowRoots: [repo], agents: ["claude"], allowPeers: allowed ? ["windows"] : [] } } }));
}
async function session(home: string, name: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, "--agent=codex"],
    env: { ...process.env, AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_LOG_LEVEL: "debug" } as Record<string, string>, stderr: "ignore" });
  const client = new Client({ name: "remote-test", version: "1" }); await client.connect(transport);
  cleanup.push(() => client.close());
  return client;
}
async function admin(home: string): Promise<BridgeClient> {
  const client = await BridgeClient.connect(resolvePipePath(home, {}), nullLogger);
  await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
  cleanup.push(() => client.close()); return client;
}
async function paired(): Promise<{ local: Client; admin: BridgeClient; inspector: BridgeNode }> {
  config(localHome, "windows"); config(remoteHome, "mac", true);
  const local = await session(localHome, "codex-supervisor"); await session(remoteHome, "codex-remote");
  const a = await admin(localHome); const b = await admin(remoteHome);
  const invitation = await b.request("networkPair", {});
  const status = await b.request("networkStatus", {});
  await a.request("networkLink", { code: invitation.code, host: LOOPBACK, port: status.port! });
  const inspector = new BridgeNode({ pipePath: resolvePipePath(localHome, {}), token: loadOrCreateToken(localHome), dbPath: resolveDbPath(localHome), name: "test-inspector", agent: "claude", cwd: root, autoWake: false, canHostBroker: false, log: nullLogger });
  await inspector.start(); cleanup.push(() => inspector.stop());
  // Refresh the advertised peers after the inspector registers.
  await a.request("networkVerify", { id: status.identity!.id });
  return { local, admin: a, inspector };
}
const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  return textOf(await client.callTool({ name, arguments: args }, undefined, { timeout: TEST_TIMEOUT_MS }));
}
async function held(client: Client, extra: Record<string, unknown> = {}): Promise<{ name: string; id: string; release: string; marker: string }> {
  const defaultRelease = join(repo, `release-${randomUUID()}`);
  const release = typeof extra.prompt === "string" ? /release=(\S+)/.exec(extra.prompt)![1]! : defaultRelease;
  const marker = typeof extra.prompt === "string" ? /marker=(\S+)/.exec(extra.prompt)![1]! : `${release}.marker`;
  const text = await call(client, "spawn_claude", { host: "mac", cwd: repo, prompt: `marker=${marker} release=${release}`, title: "Remote fake runner", ...extra });
  const match = /claude-job-([0-9a-f]{8})/.exec(text); expect(match, text).not.toBeNull();
  const id = match![1]!;
  await waitFor(() => existsSync(marker) && Boolean(readRunnerState(remoteHome, id)?.sessionId));
  pids.add(readRunnerState(remoteHome, id)!.pid);
  return { name: `claude-job-${id}`, id, release, marker };
}

describe("remote jobs security", () => {
  it("canonicalizes allowed-root aliases without allowing sibling folders or linked escapes", () => {
    const alias = join(root, "repo-alias"); symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
    expect(allowedRemoteDirectory(repo, [alias])).toBe(repo);
    expect(allowedRemoteDirectory(alias, [repo])).toBe(repo);
    if (process.platform === "win32") {
      // CI's RUNNER~1 temp root uses this spelling; JS realpath retains it while native realpath expands it.
      const short = execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "for %I in (.) do @echo %~fsI"], { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
      expect(allowedRemoteDirectory(repo, [short])).toBe(repo);
      expect(allowedRemoteDirectory(short, [repo])).toBe(repo);
    }
    const sibling = `${repo}-sibling`; mkdirSync(sibling);
    expect(() => allowedRemoteDirectory(sibling, [alias])).toThrow(/outside/);
    const escape = join(repo, "outside"); symlinkSync(remoteHome, escape, process.platform === "win32" ? "junction" : "dir");
    expect(() => allowedRemoteDirectory(escape, [alias])).toThrow(/outside/);
  });

  it("authorizes a newly joined supervisor before the periodic peer refresh", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    config(localHome, "windows"); config(remoteHome, "mac", true);
    const peers: PeerInfo[] = [];
    const a = new NetworkService(localHome, { ...DEFAULT_NETWORK_CONFIG, enabled: true, name: "windows", bind: LOOPBACK, port: 0, discovery: false }, { peers: () => peers, receive: () => ({ delivered: true }) }, nullLogger);
    const b = new NetworkService(remoteHome, { ...DEFAULT_NETWORK_CONFIG, enabled: true, name: "mac", bind: LOOPBACK, port: 0, discovery: false }, { peers: () => [], receive: () => ({ delivered: true }) }, nullLogger);
    const requester = new RemoteJobs(a, localHome, nullLogger, async () => {});
    const receiver = new RemoteJobs(b, remoteHome, nullLogger, async () => {});
    cleanup.push(() => a.close(), () => b.close(), () => { requester.close(); receiver.close(); });
    await a.start(); await b.start(); await a.link(b.keys.invite(), LOOPBACK, b.port);
    const peer: PeerInfo = { id: randomUUID(), name: "supervisor", agent: "codex", cwd: repo, pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false };
    peers.push(peer);
    // Reaching the job lookup proves the advertised-session check passed; no job was spawned.
    await expect(requester.request("mac", peer, { op: "state", job: "12345678" })).rejects.toThrow("Unknown remote job.");
    await expect(requester.request("mac", { ...peer, id: randomUUID() }, { op: "state", job: "12345678" })).rejects.toThrow("not an advertised supervisor");
  });

  it("is off by default and rejects arbitrary runner arguments and folder escapes", () => {
    expect(DEFAULT_NETWORK_CONFIG.remoteJobs).toEqual({ enabled: false, allowRoots: [], agents: [], allowPeers: [] });
    expect(remoteSpawnArgsSchema.safeParse({ prompt: "test", title: "test", cwd: repo, bin: "anything" }).success).toBe(false);
    expect(allowedRemoteDirectory(repo, [repo])).toBe(repo);
    expect(() => allowedRemoteDirectory(root, [repo])).toThrow(/outside/);
    expect(() => allowedRemoteDirectory("relative", [repo])).toThrow(/absolute/);
    const escape = join(repo, "escape"); symlinkSync(remoteHome, escape, process.platform === "win32" ? "junction" : "dir");
    expect(() => allowedRemoteDirectory(escape, [repo])).toThrow(/outside/);
  });

  it("returns update needed before sending to an older paired TLS peer", async () => {
    const a = new NetworkService(localHome, { ...DEFAULT_NETWORK_CONFIG, enabled: true, name: "windows", port: 0 }, { peers: () => [], receive: () => ({ delivered: true }) }, nullLogger);
    const b = new NetworkService(remoteHome, { ...DEFAULT_NETWORK_CONFIG, enabled: true, name: "old-mac", port: 0 }, { peers: () => [], receive: () => ({ delivered: true }) }, nullLogger);
    const jobs = new RemoteJobs(a, localHome, nullLogger, async () => {});
    cleanup.push(() => { jobs.close(); }); cleanup.push(() => a.close()); cleanup.push(() => b.close());
    await a.start(); await b.start(); await a.link(b.keys.invite(), LOOPBACK, b.port);
    await expect(jobs.request("old-mac", { id: randomUUID(), name: "supervisor" }, { op: "state", job: "12345678" })).rejects.toThrow(/update needed/);
  });
});

describe.skipIf(!existsSync(SERVER))("remote jobs with two paired TLS brokers", () => {
  it("denies disabled pairs, roots, agents and another supervisor, and rate limits requests", async () => {
    const { inspector } = await paired();
    const spawn = { op: "spawn", job: "a1234567", target: "claude", args: { prompt: "done", title: "test", cwd: root } } as const;
    await expect(inspector.remoteJob("mac", spawn)).rejects.toThrow(/outside/);
    await expect(inspector.remoteJob("mac", { ...spawn, target: "codex", args: { ...spawn.args, cwd: repo } })).rejects.toThrow(/not allowed/);
    await expect(inspector.remoteJob("mac", { ...spawn, args: { ...spawn.args, cwd: repo, session_id: "unrelated-session" } })).rejects.toThrow(/owned by this supervisor/);
    config(remoteHome, "mac", false);
    await expect(inspector.remoteJob("mac", { ...spawn, args: { ...spawn.args, cwd: repo } })).rejects.toThrow(/disabled for this pair/);
    config(remoteHome, "mac", true);
    const policyFile = join(remoteHome, "config.json");
    const deniedPair = JSON.parse(readFileSync(policyFile, "utf8"));
    deniedPair.network.remoteJobs.allowPeers = ["another-pc"];
    writeFileSync(policyFile, JSON.stringify(deniedPair));
    await expect(inspector.remoteJob("mac", { ...spawn, args: { ...spawn.args, cwd: repo } })).rejects.toThrow(/disabled for this pair/);
    config(remoteHome, "mac", true);
    const escape = join(repo, "remote-escape");
    symlinkSync(remoteHome, escape, process.platform === "win32" ? "junction" : "dir");
    await expect(inspector.remoteJob("mac", { ...spawn, args: { ...spawn.args, cwd: escape } })).rejects.toThrow(/outside/);
    const marker = join(repo, "security.marker"); const release = join(repo, "security.release");
    await inspector.remoteJob("mac", { ...spawn, args: { ...spawn.args, cwd: repo, prompt: `marker=${marker} release=${release}` } });
    await waitFor(() => existsSync(marker)); pids.add(readRunnerState(remoteHome, spawn.job)!.pid);
    const other = new BridgeNode({ pipePath: resolvePipePath(localHome, {}), token: loadOrCreateToken(localHome), dbPath: resolveDbPath(localHome), name: "another-supervisor", agent: "claude", cwd: root, autoWake: false, log: nullLogger });
    await other.start(); cleanup.push(() => other.stop());
    await expect(other.remoteJob("mac", { op: "control", job: spawn.job, control: { type: "cancel" } })).rejects.toThrow(/another supervisor|advertised/);
    // One request per iteration, bounded by the pair-wide named rate constant.
    let limited = false;
    for (let i = 0; i <= REMOTE_JOB_RATE_LIMIT; i++) {
      try { await inspector.remoteJob("mac", { op: "state", job: "bad12345" }); }
      catch (err) { if ((err as Error).message.includes("rate limit")) { limited = true; break; } }
    }
    expect(limited).toBe(true); writeFileSync(release, "");
  }, TEST_TIMEOUT_MS);

  it("starts remotely, applies follow-up settings, returns results, logs on both PCs and shows remote dashboard runs", async () => {
    const { local } = await paired(); const job = await held(local);
    expect(readRunnerState(localHome, job.id)).toBeNull();
    // The detached runner survives a requester reload, and the saved supervisor id authorizes the new peer.
    await local.close();
    const replacement = await session(localHome, "codex-supervisor");
    await waitFor(async () => (await call(replacement, "peers", {})).includes(`mac/${job.name}`));
    await call(replacement, "message_subagent", { job: job.name, message: "continue", model: "remote-model" });
    await waitFor(() => (readRunnerState(remoteHome, job.id)?.seen?.length ?? 0) === 1);
    writeFileSync(job.release, "");
    await waitFor(() => readRunnerState(remoteHome, job.id)?.status === "done");
    await waitFor(async () => (await call(replacement, "inbox", { mark_read: false })).includes("remote fake finished"));
    await waitFor(async () => (await call(replacement, "peers", {})).includes(`${job.name} "Remote fake runner": done`));
    const calls = readFileSync(join(remoteHome, "calls.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s));
    expect(calls).toHaveLength(2); expect(calls[1].session).toBe(calls[0].session); expect(calls[1].args).toContain("remote-model");
    const saved = readStore(join(localHome, "jobs.json")).find((j) => j.id === job.id)!;
    expect(saved.remote).toEqual({ host: "mac", name: job.name });
    expect(listRuns(localHome)).toContainEqual(expect.objectContaining({ remote: { host: "mac", name: job.name }, by: "codex-supervisor" }));
    expect(listRuns(remoteHome).some((r) => r.job === job.name)).toBe(true);
    const ui = await startUi({ home: localHome, pipe: resolvePipePath(localHome, {}), port: 0, log: nullLogger }); cleanup.push(() => ui.close());
    const first = await fetch(ui.url, { redirect: "manual" }); const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const base = ui.url.replace(/\/\?t=.*$/, "");
    expect((await fetch(`${base}/api/state`)).status).toBe(403);
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    expect(state.runs.some((r: any) => r.remote?.host === "mac" && r.remote.name === job.name)).toBe(true);
    expect(state.jobs[job.name].remote).toEqual({ host: "mac", name: job.name });
  }, TEST_TIMEOUT_MS);

  it("round trips an approval through the requesting registry and cancels the remote process", async () => {
    const { local } = await paired();
    const release = join(repo, "approval-release"); const marker = join(repo, "approval-marker");
    const job = await held(local, { access: "edit", prompt: `marker=${marker} release=${release} approve=yes` });
    await waitFor(() => listPendingApprovals(localHome).length === 1);
    const approval = listPendingApprovals(localHome)[0]!;
    expect(approval).toMatchObject({ owner: "codex-supervisor", job: `mac/${job.name}`, tool: "Bash", command: "fake build" });
    expect(await answerPendingApproval(localHome, approval.id, { decision: "allow", reason: "supervisor approved" })).toBe("answered");
    await waitFor(() => listPendingApprovals(localHome).length === 0 && listPendingApprovals(remoteHome).length === 0);
    expect(await answerPendingApproval(localHome, approval.id, { decision: "allow" })).toBe("expired");
    await call(local, "cancel_subagent", { job: job.name });
    await waitFor(() => readRunnerState(remoteHome, job.id)?.status === "failed");
    await waitFor(() => !pidAlive(readRunnerState(remoteHome, job.id)!.pid));
  }, TEST_TIMEOUT_MS);

  it("cancels a job while the remote spawn is still starting", async () => {
    const { local } = await paired();
    const text = await call(local, "spawn_claude", { host: "mac", cwd: repo, title: "Cancel during startup", prompt: `release=${join(repo, "never-release")}` });
    const id = /claude-job-([0-9a-f]{8})/.exec(text)![1]!;
    await call(local, "cancel_subagent", { job: `claude-job-${id}` });
    await waitFor(() => readRunnerState(remoteHome, id)?.status === "failed");
    expect(await call(local, "peers", {})).toContain("remote");
    const state = readRunnerState(remoteHome, id)!; pids.add(state.pid);
    await waitFor(() => !pidAlive(state.pid));
  }, TEST_TIMEOUT_MS);

  it("creates and continues an allowed worktree on the remote repository and supports blocking asks", async () => {
    execFileSync("git", ["init", repo], { stdio: "ignore" }); writeFileSync(join(repo, "readme.txt"), "remote repo");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "-c", "user.name=rennerdo30", "-c", "user.email=9086097+rennerdo30@users.noreply.github.com", "commit", "-m", "Fixture"], { stdio: "ignore" });
    const { local } = await paired();
    const result = await call(local, "ask_claude", { host: "mac", cwd: repo, prompt: "finish", title: "Remote worktree ask", worktree: true });
    expect(result).toContain("remote fake finished");
    const match = /claude-ask-([0-9a-f]{8})/.exec(result)!; expect(match).not.toBeNull();
    const state = readRunnerState(remoteHome, match[1]!)!;
    expect(resolve(state.worktree!.repoRoot)).toBe(repo); expect(resolve(state.worktree!.path).startsWith(repo)).toBe(true);
    expect(state.workdir).toBe(state.worktree?.cwd);
    const oldFinishedAt = state.finishedAt;
    await call(local, "message_subagent", { job: `claude-ask-${match[1]}`, message: "continue remote worktree" });
    await waitFor(() => readRunnerState(remoteHome, match[1]!)?.status === "done" && readRunnerState(remoteHome, match[1]!)?.finishedAt !== oldFinishedAt);
    expect(readRunnerState(remoteHome, match[1]!)?.worktree?.path).toBe(state.worktree?.path);
  }, TEST_TIMEOUT_MS);
});
