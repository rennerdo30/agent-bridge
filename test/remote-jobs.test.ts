import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { codexHost } from "./helpers.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { pidAlive } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { BridgeNode } from "../src/core/node.js";
import { MessageStore } from "../src/core/store.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { answerPendingApproval, listPendingApprovals } from "../src/core/relay.js";
import { parentFromEnv } from "../src/core/parent-link.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { listRuns, startUi } from "../src/cli/ui.js";
import { readRunnerState } from "../src/mcp/job-host.js";
import { RUNNER_DIR } from "../src/core/runner-store.js";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import { readMetadataLeaseOwner } from "../src/core/metadata-file-lease.js";
import { readStore } from "../src/mcp/jobs.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { NetworkService } from "../src/network/link.js";
import { allowedRemoteDirectory, RemoteJobs } from "../src/network/remote-jobs.js";
import { REMOTE_JOB_RATE_LIMIT, remoteSpawnArgsSchema } from "../src/network/remote-job-protocol.js";
import { ownProcessIdentity, readProcessIdentities } from "../src/core/process-identity.js";
import { fixtureProcessExists, fixtureProcessGeneration } from "./fixture-process-generation.js";
import { jobWaitSnapshot } from "./job-wait-diagnostics.js";
import { fixtureOwner, fixturePeer } from "./owned-mail.js";

const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
const TEST_TIMEOUT_MS = 90_000;
const LOOPBACK = "127.0.0.1";
let root: string;
let cleanup: (() => Promise<unknown> | void)[];
let remoteHome: string;
let localHome: string;
let repo: string;
const pids = new Set<number>();
let diagnosticResponses: { at: number; name: string; args: Record<string, unknown>; text?: string; error?: string }[];
let diagnosticStages: { stage: string; at: number }[] = [];
const diagnosticJobs = new Set<string>();
const activeCalls = new Map<symbol, { name: string; at: number }>();
const stage = (label: string) => { diagnosticStages.push({ stage: label, at: Date.now() }); diagnosticStages = diagnosticStages.slice(-64); };
function printWaitDiagnostics() {
  try { console.error(`Remote job wait diagnostics: ${JSON.stringify({ version: 1, stages: diagnosticStages, activeCalls: [...activeCalls.values()].slice(0, 8),
    local: jobWaitSnapshot(localHome, [...diagnosticJobs]), remote: jobWaitSnapshot(remoteHome, [...diagnosticJobs]) }).slice(0, 65_536)}`); }
  catch { console.error("Remote job wait diagnostics unavailable"); }
}
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
  // Failed cleanup keeps its own fixture evidence; those PIDs never belong to the next fixture.
  pids.clear();
  // Transfer fixtures must have no linked ancestors (/var on macOS); native also expands Windows 8.3 names.
  // Short names: macOS caps Unix socket paths at 104 bytes, and its real temp path (/private/var/folders/…) is long.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "abr-")));
  localHome = join(root, "w"); remoteHome = join(root, "m"); repo = join(root, "allowed");
  for (const path of [localHome, remoteHome, repo]) mkdirSync(path, { recursive: true });
  cleanup = [];
  diagnosticResponses = [];
  diagnosticStages = []; diagnosticJobs.clear(); activeCalls.clear();
});
function diagnosticSnapshot(stage: string): void {
  const files = (home: string, directory: string) => {
    const path = join(home, directory);
    return existsSync(path) ? Object.fromEntries(readdirSync(path).filter(file => file.endsWith(".json") && !file.endsWith(".spec.json")).map(file => {
      try { return [file, JSON.parse(readFileSync(join(path, file), "utf8"))]; }
      catch (error) { return [file, { inspectionError: String(error) }]; }
    })) : {};
  };
  const registry = (home: string, file: string) => {
    try { return existsSync(join(home, file)) ? JSON.parse(readFileSync(join(home, file), "utf8")) : null; }
    catch (error) { return { inspectionError: String(error) }; }
  };
  writeFileSync(join(root, `diagnostics-${stage}.json`), JSON.stringify({ stage, root, repo, localHome, remoteHome,
    cwd: process.cwd(), gitCeiling: process.env.GIT_CEILING_DIRECTORIES, diagnosticResponses, observedRunnerPids: [...pids],
    local: { jobs: registry(localHome, "jobs.json"), states: files(localHome, "remote-job-states"), runs: files(localHome, "runs") },
    remote: { jobs: registry(remoteHome, "remote-jobs.json"), states: files(remoteHome, "jobs"), runs: files(remoteHome, "runs") },
  }, null, 2));
}
afterEach(async context => {
  let failed = context.task.result?.state === "fail";
  let cleanupError: unknown;
  if (failed) {
    printWaitDiagnostics();
    try { diagnosticSnapshot("before-cleanup"); }
    catch (error) { cleanupError = error; }
  }
  try { await stopFixtureRunners(); }
  catch (error) { failed = true; cleanupError ??= error; }
  finally {
    // Closing owned transports must still happen when an identity check refuses a PID signal.
    for (const close of cleanup.reverse()) {
      try { await close(); }
      catch (error) { failed = true; cleanupError ??= error; }
    }
    // A broker can launch a runner after the first inventory, or a runner can publish its state row only now:
    // inventory again once every broker has exited, with the same PID-plus-creation-identity check.
    try { await stopFixtureRunners(); }
    catch (error) { failed = true; cleanupError ??= error; }
    vi.useRealTimers();
    closeMetadataDbs();
    // Every fixture process has exited now: a lease that still names a live owner means something outside the
    // recorded set still writes here, so nothing is deleted.
    let leases: { path: string; pid: number }[] = [];
    if (!failed) try { await waitFor(async () => (leases = await liveFixtureLeases(root)).length === 0); }
    catch (error) {
      failed = true;
      cleanupError ??= new Error(`Fixture metadata leases still have live owners: ${JSON.stringify(leases)}; retained at ${root}`, { cause: error });
    }
    if (failed) {
      try { diagnosticSnapshot("after-cleanup"); }
      catch (error) { cleanupError ??= error; }
      console.error(`Retained failed remote-job fixture: ${root}`);
      // CI keeps only the job log, not the retained fixture: print the broker/runner timeline of both PCs.
      for (const home of [localHome, remoteHome]) {
        const log = join(home, "logs", "agent-bridge.log");
        try { if (existsSync(log)) console.error(`--- ${log} (last 120 lines)\n${readFileSync(log, "utf8").split("\n").slice(-120).join("\n")}`); }
        catch (error) { cleanupError ??= error; }
      }
    }
    else rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (cleanupError) throw cleanupError;
});
/** Stop every runner of this fixture (recorded PIDs plus a fresh read-only inventory) and wait for each to exit. */
async function stopFixtureRunners(): Promise<void> {
  // Read-only inventory. runnerStateIds would create bridge.db and take its migration lease in a home no fixture
  // process ever opened, which needs this worker's own creation identity (a PowerShell probe on Windows).
  const stateIdentities = fixtureRunnerIdentities(remoteHome);
  for (const pid of stateIdentities.keys()) pids.add(pid);
  // Only this freshly created fixture's published process generation authorizes a kill. A runner still in startup
  // (store admission, Windows job ownership) has published only its state row, which carries its own creation identity.
  const generations = await readProcessIdentities([...pids]);
  for (const pid of [...pids]) if (fixtureProcessExists(pid, `Unable to verify fixture runner ${pid}; retained at ${root}`)) {
    const recorded = storePresence(remoteHome, pid)?.processIdentity ?? stateIdentities.get(pid);
    const refusal = `Fixture runner ${pid} has no matching owned process identity; retained at ${root}`;
    if (!recorded) throw new Error(refusal);
    // A different creation identity proves the recorded runner exited and its PID was reused: never ours to stop or await.
    const current = generations.get(pid);
    if (current !== undefined && current !== recorded) { pids.delete(pid); continue; }
    if (!await fixtureProcessGeneration(pid, recorded, refusal, {
      identities: async () => generations, exists: pid => { process.kill(pid, 0); },
    })) continue;
    await stopFixtureRunner(pid, recorded);
  }
  await waitFor(() => [...pids].every((pid) => !fixtureProcessExists(pid, `Unable to verify fixture runner exit ${pid}; retained at ${root}`)));
  pids.clear();
}
/** AB-208: a process's presence is a bridge.db metadata row; the file remains only while the store is deferred. */
function storePresence(home: string, pid: number): Record<string, any> | null {
  const path = resolveDbPath(home);
  if (existsSync(path)) {
    const db = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_metadata'").get()) {
        const row = db.prepare("SELECT value FROM bridge_metadata WHERE domain='storage-capabilities' AND key=?").get(String(pid));
        if (row) return JSON.parse(String(row.value));
      }
    } finally { db.close(); }
  }
  const file = join(home, "storage-capabilities", `${pid}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}
/**
 * Runner PIDs with the creation identity each runner wrote into its own state, from job-state rows (AB-208) and
 * older runners' files. Read only: no store is created or migrated.
 */
function fixtureRunnerIdentities(home: string): Map<number, string | undefined> {
  const values: string[] = [];
  const path = resolveDbPath(home);
  if (existsSync(path)) {
    const db = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_metadata'").get()) {
        for (const row of db.prepare("SELECT value FROM bridge_metadata WHERE domain='job-state'").all()) values.push(String(row.value));
      }
    } finally { db.close(); }
  }
  const dir = join(home, RUNNER_DIR);
  if (existsSync(dir)) for (const file of readdirSync(dir)) {
    if (file.endsWith(".json") && !file.endsWith(".spec.json")) values.push(readFileSync(join(dir, file), "utf8"));
  }
  const runners = new Map<number, string | undefined>();
  for (const value of values) {
    const { pid, identity } = JSON.parse(value) as { pid?: unknown; identity?: unknown };
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) continue;
    runners.set(pid, typeof identity === "string" && identity ? identity : runners.get(pid));
  }
  return runners;
}
/**
 * Canonical metadata leases under the fixture whose recorded owner generation is still running. ESRCH or a different
 * creation identity (PID reuse) proves an owner gone; a failed identity query proves nothing and keeps the lease live.
 */
async function liveFixtureLeases(directory: string): Promise<{ path: string; pid: number }[]> {
  const owners: { path: string; pid: number; identity: string }[] = [];
  for (const entry of readdirSync(directory, { recursive: true }) as string[]) {
    if (basename(entry) !== ".metadata-leases") continue;
    const parent = dirname(join(directory, entry));
    const registries = new Set(readdirSync(join(directory, entry)));
    for (const name of readdirSync(parent)) {
      const path = join(parent, name);
      if (!registries.has(createHash("sha256").update(name).digest("hex")) || !lstatSync(path).isFile()) continue;
      const owner = readMetadataLeaseOwner(path);
      if (owner && fixtureProcessExists(owner.pid, `Unable to verify lease owner ${owner.pid} of ${path}; retained at ${root}`)) owners.push({ path, ...owner });
    }
  }
  if (!owners.length) return [];
  let identities: Map<number, string> | undefined;
  try { identities = await readProcessIdentities(owners.map(owner => owner.pid)); } catch { /* unknown: every owner stays live */ }
  return owners.filter(owner => {
    if (!identities) return true;
    const current = identities.get(owner.pid);
    // Unlisted: exited after the existence check, unless the PID still answers (identity unreadable).
    if (current === undefined) return fixtureProcessExists(owner.pid, `Unable to verify lease owner ${owner.pid}; retained at ${root}`);
    return current === owner.identity;
  }).map(({ path, pid }) => ({ path, pid }));
}
async function stopFixtureRunner(pid: number, identity: string): Promise<void> {
  const refusal = `Refusing to signal changed fixture runner ${pid}; retained at ${root}`;
  const sameGeneration = () => fixtureProcessGeneration(pid, identity, refusal);
  if (!await sameGeneration()) return;
  if (process.platform === "win32") {
    // No numeric-PID fallback is allowed when taskkill cannot start or fails.
    try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
    catch (error) { if (fixtureProcessExists(pid, refusal)) throw error; }
    return;
  }
  try { process.kill(pid, "SIGTERM"); }
  catch (error) { if (fixtureProcessExists(pid, refusal)) throw error; return; }
  await new Promise(resolve => setTimeout(resolve, 3_000));
  // The initial proof never authorizes a delayed signal after PID reuse.
  if (await sameGeneration()) {
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (fixtureProcessExists(pid, refusal)) throw error; }
  }
}
async function waitFor(test: () => boolean | Promise<boolean>, ms = 30_000, label = "unspecified"): Promise<void> {
  stage(`wait:${label}`);
  const deadline = Date.now() + ms;
  while (!await test()) { if (Date.now() > deadline) throw new Error("Remote test timed out"); await new Promise((r) => setTimeout(r, 50)); }
  stage(`settled:${label}`);
}
/** The remote broker reads config.json concurrently: replace it whole, never truncate it in place. */
function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}
function config(home: string, name: string, allowed = false): void {
  const bin = join(remoteHome, "fake-claude.mjs");
  writeFileSync(bin, FAKE); chmodSync(bin, 0o755);
  let claudeBin = bin;
  if (process.platform === "win32") { claudeBin = join(remoteHome, "claude.cmd"); writeFileSync(claudeBin, '@ECHO off\r\n"%dp0%\\fake-claude.mjs" %*\r\n'); }
  writeAtomic(join(home, "config.json"), JSON.stringify({ dashboard: false, claudeBin, network: { ...DEFAULT_NETWORK_CONFIG, enabled: true, name, bind: LOOPBACK, port: 0, remoteJobs: { enabled: allowed, allowRoots: [repo], agents: ["claude"], allowPeers: allowed ? ["windows"] : [] } } }));
}
async function session(home: string, name: string, agent = "codex"): Promise<Client> {
  const client = new Client({ name: "remote-test", version: "1" });
  const codexHome = codexHost(client, home, agent, name);
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, `--agent=${agent}`],
    env: { ...process.env, CODEX_HOME: codexHome, AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_LOG_LEVEL: "debug" } as Record<string, string>, stderr: "pipe" });
  const stderrPath = join(root, `session-${name}-${agent}.stderr.log`);
  let stderrError: unknown;
  transport.stderr?.on("data", data => {
    try { appendFileSync(stderrPath, data); }
    catch (error) { stderrError ??= error; }
  });
  // The child's own close event (exit plus closed stdio) is the exit barrier for this session and the broker it may host;
  // Protocol.connect chains this handler. The SDK's close returns right after a forced kill without awaiting it.
  const exited = new Promise<void>(resolve => { transport.onclose = resolve; });
  cleanup.push(async () => {
    const pid = transport.pid;
    try { await client.close(); }
    finally { await transport.close(); }
    // A grandchild that inherited the stdio pipes can hold close back: bound the wait so the rest of teardown
    // (runner inventory, lease barrier, retained message and log tails) still runs.
    if (pid) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([exited, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`session ${pid} did not close; retained at ${root}`)), 30_000);
        })]);
      } finally { clearTimeout(timer); }
    }
    if (stderrError) throw stderrError;
  });
  await client.connect(transport);
  await call(client, "peers", {});
  return client;
}
async function admin(home: string): Promise<BridgeClient> {
  const client = await BridgeClient.connect(resolvePipePath(home, {}), nullLogger);
  await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
  cleanup.push(() => client.close()); return client;
}
async function paired(agent = "codex"): Promise<{ local: Client; admin: BridgeClient; inspector: BridgeNode }> {
  config(localHome, "windows"); config(remoteHome, "mac", true);
  const local = await session(localHome, "codex-supervisor", agent);
  const remote = await session(remoteHome, "codex-remote");
  if (agent === "claude") {
    await local.callTool({ name: "peers", arguments: {} });
    await remote.callTool({ name: "peers", arguments: {} });
  }
  const a = await admin(localHome); const b = await admin(remoteHome);
  const invitation = await b.request("networkPair", {});
  const status = await b.request("networkStatus", {});
  await a.request("networkLink", { code: invitation.code, host: LOOPBACK, port: status.port! });
  const inspector = new BridgeNode({ pipePath: resolvePipePath(localHome, {}), token: loadOrCreateToken(localHome), dbPath: resolveDbPath(localHome), name: "test-inspector", agent: "claude", cwd: root, autoWake: false, canHostBroker: false, log: nullLogger });
  await inspector.start(); cleanup.push(() => inspector.stop());
  // Pairing can precede the remote MCP session's registration. Wait for its real advertisement;
  // networkVerify only refreshes our outgoing peers, not the remote session's startup.
  await a.request("networkVerify", { id: status.identity!.id });
  await waitFor(async () => (await call(local, "peers", {})).includes("mac/codex-remote"), 30_000, "paired-peer-advertisement");
  return { local, admin: a, inspector };
}
const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");
async function call(client: Client, name: string, args: Record<string, unknown>, requireSuccess = false): Promise<string> {
  const request = Symbol(name); activeCalls.set(request, { name, at: Date.now() });
  try {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: TEST_TIMEOUT_MS });
    const text = textOf(response);
    diagnosticResponses.push({ at: Date.now(), name, args, text });
    if (requireSuccess) expect(response.isError, `${name} must be accepted before waiting for its effect`).not.toBe(true);
    return text;
  } catch (error) { diagnosticResponses.push({ at: Date.now(), name, args, error: String(error) }); throw error; }
  finally { activeCalls.delete(request); }
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
async function cancelledRemoteJob(local: Client, id: string, title: string, prompt: string): Promise<void> {
  diagnosticJobs.add(id);
  const saved = () => readStore(join(localHome, "jobs.json")).find(job => job.id === id);
  await waitFor(() => saved()?.status === "cancelled", 30_000, "cancel-durable-local-status");
  expect(saved()!.prompt).toBe(prompt);
  const state = readRunnerState(remoteHome, id);
  if (state) {
    // A real launched runner retains the original native cancellation and process-exit gates.
    expect(state.status).toBe("cancelled");
    expect(state.pid).toBeGreaterThan(0);
    expect(state.report).toContain("cancelled");
    pids.add(state.pid);
    await waitFor(() => !pidAlive(state.pid), 30_000, "cancel-owned-runner-exit");
  } else {
    // Cancellation before admission launches nothing; no synthetic remote PID/state is appropriate.
    expect(saved()!.host).toBeNull();
    expect(saved()!.deliveryHistory?.some(message => message.body.includes("cancelled"))).toBe(true);
    const registry = join(remoteHome, "remote-jobs.json");
    const records = existsSync(registry) ? JSON.parse(readFileSync(registry, "utf8")).jobs : [];
    expect(records.some((record: { job: { id: string } }) => record.job.id === id)).toBe(false);
    expect(readRunnerState(remoteHome, id)).toBeNull();
  }
  await waitFor(async () => {
    const inbox = await call(local, "inbox", { mark_read: false });
    return inbox.includes(`claude-job-${id}`) && inbox.includes("cancelled");
  }, 30_000, "cancel-original-supervisor-report");
  // The remote state file and the requester's cached job state settle independently.
  await waitFor(async () => {
    const peers = await call(local, "peers", {});
    return peers.includes(`claude-job-${id} "${title}": cancelled`) &&
      (!state || peers.includes(`Remote job claude-job-${id}: mac/claude-job-${id}`));
  }, 30_000, "cancel-remote-status-cache");
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
    await ownProcessIdentity();
    const identities = new MessageStore(resolveDbPath(localHome), nullLogger);
    cleanup.push(() => identities.close());
    const a = new NetworkService(localHome, { ...DEFAULT_NETWORK_CONFIG, enabled: true, name: "windows", bind: LOOPBACK, port: 0, discovery: false }, { peers: () => peers, receive: () => ({ delivered: true }) }, nullLogger);
    const b = new NetworkService(remoteHome, { ...DEFAULT_NETWORK_CONFIG, enabled: true, name: "mac", bind: LOOPBACK, port: 0, discovery: false }, { peers: () => [], receive: () => ({ delivered: true }) }, nullLogger);
    const requester = new RemoteJobs(a, localHome, nullLogger, async () => {});
    const receiver = new RemoteJobs(b, remoteHome, nullLogger, async () => {});
    cleanup.push(() => a.close(), () => b.close(), () => { requester.close(); receiver.close(); });
    await a.start(); await b.start(); await a.link(b.keys.invite(), LOOPBACK, b.port);
    const peer = fixturePeer(identities, "supervisor", { cwd: repo });
    const lookup = vi.spyOn(receiver as any, "handle");
    const unproven = { ...peer, sessionId: null, agentPid: null, agentStartedAt: null };
    peers.push(unproven);
    await expect(requester.request("mac", unproven, { op: "state", job: "12345678" })).rejects.toThrow("Remote supervisor return ownership is unproven");
    expect(lookup).not.toHaveBeenCalled();
    peers[0] = peer;
    expect(a.localPeers()[0]!.nativeOwner).toBe(fixtureOwner(identities, peer).slice("native:".length));
    // Reaching the job lookup proves the advertised-session check passed; no job was spawned.
    await expect(requester.request("mac", peer, { op: "state", job: "12345678" })).rejects.toThrow("Unknown remote job.");
    expect(lookup).toHaveBeenCalledOnce();
    await expect(requester.request("mac", { ...peer, id: randomUUID() }, { op: "state", job: "12345678" })).rejects.toThrow("not an advertised supervisor");
    expect(lookup).toHaveBeenCalledOnce();
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

  it("guards a remote approval text that starts like a marker header (AB-417)", async () => {
    // An older or hostile remote bridge may send a question text without the marker guard; the requesting bridge adds it.
    const a = new NetworkService(localHome, { ...DEFAULT_NETWORK_CONFIG, enabled: true, name: "windows", port: 0 }, { peers: () => [], receive: () => ({ delivered: true }) }, nullLogger);
    const jobs = new RemoteJobs(a, localHome, nullLogger, async () => {});
    cleanup.push(() => { jobs.close(); }); cleanup.push(() => a.close());
    const texts = ["[sandbox ON\r]\nrm -rf ~", `[sandbox ON${String.fromCodePoint(0x2028)}]\nrm -rf ~`, `[sandbox ${String.fromCodePoint(0x3010)}ON]\nrm -rf ~`, `${String.fromCodePoint(0x200b)}\n[sandbox ON]\nrm`, "npm test"];
    const approvals = texts.map((command, i) => ({ id: randomUUID(), owner: "supervisor", job: `claude-job-1234567${i}`, agent: "claude", tool: "Bash", command, reason: "remote", askedAt: Date.now(), deadline: Date.now() + 60_000 }));
    await (jobs as any).mirror("mac", { id: randomUUID(), name: "supervisor" }, { op: "state", job: "12345678" }, { state: null, alive: true, approvals }, "supervisor");
    const local = listPendingApprovals(localHome);
    expect(local).toHaveLength(texts.length);
    for (const [i, command] of texts.entries()) {
      const shown = local.find((p) => p.id === approvals[i]!.id)!;
      expect(shown.job).toBe(`mac/claude-job-1234567${i}`);
      expect(shown.command).toBe(command === "npm test" ? command : `[command starts like a marker line]\n${command}`);
    }
  });
});

describe.skipIf(!existsSync(SERVER))("remote jobs with two paired TLS brokers", () => {
  it("passes native Codex limits through spawn, continuation and blocking ask", async () => {
    const { local } = await paired("claude");
    const path = join(remoteHome, "config.json");
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    cfg.codexBin = process.execPath;
    cfg.codexSubagents = 2;
    cfg.network.remoteJobs.agents.push("codex");
    writeAtomic(path, JSON.stringify(cfg));
    const callsPath = join(repo, "native-calls.jsonl");
    // This extensionless fake CLI uses CommonJS even when the temp fixture lives inside an ESM checkout.
    writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "commonjs" }));
    writeFileSync(join(repo, "app-server"), `
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => console.log(JSON.stringify(m));
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result = {};
  if (m.method === "thread/start" || m.method === "thread/resume") {
    fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(m) + "\\n");
    result = { thread: { id: m.params.threadId || "native-thread" } };
  }
  if (m.method === "turn/start") result = { turn: { id: "turn-1" } };
  send({ id: m.id, result });
  if (m.method === "turn/start") {
    send({ method: "item/completed", params: { turnId: "turn-1", item: { type: "agentMessage", text: "native fake finished" } } });
    send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
  }
});
`);
    const result = await call(local, "spawn_codex", { host: "mac", cwd: repo, title: "Native default", prompt: "finish" });
    const match = /codex-job-([0-9a-f]{8})/.exec(result);
    expect(match, result).not.toBeNull();
    const id = match![1]!;
    diagnosticJobs.add(id);
    const name = `codex-job-${id}`;
    await waitFor(async () => (await call(local, "peers", {})).includes(`${name} "Native default": done`), 30_000, "native-initial-done-cache");
    // Final status precedes report delivery and runner teardown. This settings test needs
    // a new runner, rather than a message queued to the previous runner while it closes.
    await waitFor(() => {
      const state = readRunnerState(remoteHome, id);
      return Boolean(state?.pid && !pidAlive(state.pid));
    }, 30_000, "native-initial-runner-exit");
    await waitFor(async () => {
      await call(local, "peers", {});
      const cached = join(localHome, "remote-job-states", `${id}.json`);
      return existsSync(cached) && JSON.parse(readFileSync(cached, "utf8")).snapshot.alive === false;
    }, 30_000, "native-initial-cache-exit");
    stage("native-continuation-rpc");
    const continued = await call(local, "message_subagent", { job: name, message: "continue", native_subagents: 0 });
    expect(continued).toContain("continues in its own session");
    const calls = () => readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    await waitFor(() => calls().length === 2 && readRunnerState(remoteHome, id)?.status === "done", 30_000, "native-continuation-done");
    expect(calls()[0].params.config).toMatchObject({ "agents.max_threads": 2, "agents.enabled": true });
    expect(calls()[1]).toMatchObject({ method: "thread/resume", params: { threadId: "native-thread", config: { "agents.max_threads": 1, "agents.enabled": false, "features.multi_agent_v2": false } } });
    stage("native-blocking-ask-rpc");
    const ask = await call(local, "ask_codex", { host: "mac", cwd: repo, title: "Native ask", prompt: "finish", native_subagents: 32 });
    expect(ask).toContain("native fake finished");
    expect(calls()[2].params.config["agents.max_threads"]).toBe(32);
    expect(readStore(join(localHome, "jobs.json")).find((j) => j.id === id)!.args).toMatchObject({ native_subagents: 0 });
    const remote = JSON.parse(readFileSync(join(remoteHome, "remote-jobs.json"), "utf8"));
    expect(remote.jobs.find((j: any) => j.job.id === id).job.args.native_subagents).toBe(0);
  }, TEST_TIMEOUT_MS);

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
    writeAtomic(policyFile, JSON.stringify(deniedPair));
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
    const child = parentFromEnv(JSON.parse(readFileSync(job.marker, "utf8")))!;
    await child.progress(40, "ETA integration", 12);
    await waitFor(async () => (await call(local, "peers", {})).includes("~12 min left"));
    const remoteEta = readRunnerState(remoteHome, job.id)!;
    expect(remoteEta.etaAt! - remoteEta.etaReportedAt!).toBe(720_000);
    await waitFor(() => listRuns(localHome).some((r) => r.etaAt === remoteEta.etaAt));

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
    expect(readRunnerState(remoteHome, job.id)!.etaAt).toBeUndefined();
    expect(listRuns(localHome).filter((r) => r.remote?.name === job.name).every((r) => r.etaAt === undefined)).toBe(true);
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
    diagnosticJobs.add(job.id);
    await waitFor(() => listPendingApprovals(localHome).length === 1, 30_000, "approval-requester-queue");
    const approval = listPendingApprovals(localHome)[0]!;
    expect(approval).toMatchObject({ owner: "codex-supervisor", job: `mac/${job.name}`, tool: "Bash", command: "fake build" });
    const outcome = await answerPendingApproval(localHome, approval.id, { decision: "allow", reason: "supervisor approved" });
    if (outcome !== "answered") console.error("Remote approval stage diagnostics: " + JSON.stringify({ outcome, deadlinePassed: Date.now() >= approval.deadline,
      requesterPending: listPendingApprovals(localHome).some(a => a.id === approval.id), executorPending: listPendingApprovals(remoteHome).some(a => a.id === approval.id),
      requester: jobWaitSnapshot(localHome, [job.id]), executor: jobWaitSnapshot(remoteHome, [job.id]) }));
    expect(outcome).toBe("answered");
    await waitFor(() => listPendingApprovals(localHome).length === 0 && listPendingApprovals(remoteHome).length === 0, 30_000, "approval-both-queues-cleared");
    expect(await answerPendingApproval(localHome, approval.id, { decision: "allow" })).toBe("expired");
    stage("approval-cancel-rpc"); await call(local, "cancel_subagent", { job: job.name }, true); stage("settled:approval-cancel-rpc");
    await waitFor(() => readRunnerState(remoteHome, job.id)?.status === "cancelled", 30_000, "approval-cancel-executor-state");
    await waitFor(() => !pidAlive(readRunnerState(remoteHome, job.id)!.pid), 30_000, "approval-cancel-original-pid-exit");
  }, TEST_TIMEOUT_MS);

  it("cancels a job while the remote spawn is still starting", async () => {
    const { local } = await paired();
    const prompt = `release=${join(repo, "never-release")}`;
    const text = await call(local, "spawn_claude", { host: "mac", cwd: repo, title: "Cancel during startup", prompt });
    const id = /claude-job-([0-9a-f]{8})/.exec(text)![1]!;
    await call(local, "cancel_subagent", { job: `claude-job-${id}` });
    await cancelledRemoteJob(local, id, "Cancel during startup", prompt);
  }, TEST_TIMEOUT_MS);

  it("cancels an observed remote runner during startup and retains its real cancelled state", async () => {
    const { local } = await paired();
    const prompt = `release=${join(repo, "never-release")}`;
    const title = "Cancel observed startup";
    const text = await call(local, "spawn_claude", { host: "mac", cwd: repo, title, prompt });
    const id = /claude-job-([0-9a-f]{8})/.exec(text)![1]!;
    // Published native runner state is the barrier; no sleep or synthesized PID stands in for launch.
    await waitFor(() => {
      const state = readRunnerState(remoteHome, id);
      return Boolean(state?.status === "running" && state.pid > 0 && pidAlive(state.pid));
    });
    pids.add(readRunnerState(remoteHome, id)!.pid);
    await call(local, "cancel_subagent", { job: `claude-job-${id}` });
    await waitFor(() => readRunnerState(remoteHome, id)?.status === "cancelled");
    await cancelledRemoteJob(local, id, title, prompt);
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
    await waitFor(() => {
      const continued = readRunnerState(remoteHome, match[1]!);
      return continued?.status === "done" && continued.finishedAt !== oldFinishedAt && continued.pid !== state.pid && !pidAlive(continued.pid);
    });
    expect(readRunnerState(remoteHome, match[1]!)?.worktree?.path).toBe(state.worktree?.path);
  }, TEST_TIMEOUT_MS);
});
