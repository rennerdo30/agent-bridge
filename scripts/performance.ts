/** Opt-in load profile. Bundle with esbuild, then run with node; never part of Vitest.
 * All writes are confined to a fresh synthetic home. Owner storage is never opened.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { Session } from "node:inspector";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { historyReady, historyDbPath } from "../src/core/history-store.js";
import { backfillBytes, primeLargeHistoryBackfill, seedLargeHistoryBackfill } from "./history-backfill-fixture.js";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger, createLogger } from "../src/core/logger.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { resolvePipePath } from "../src/core/paths.js";
import { startUi } from "../src/cli/ui.js";
import { listRuns } from "../src/core/dashboard-read.js";
import { JobManager, acquireLock, type Job, type Run } from "../src/mcp/jobs.js";
import { EventEmitter } from "node:events";
import { NetworkService } from "../src/network/link.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { decodePairingCode } from "../src/network/pairing.js";
import type { PeerInfo, BridgeMessage } from "../src/core/protocol.js";

const duration = Number(process.env.AB_PERF_SECONDS ?? 20);
const jobCount = Number(process.env.AB_PERF_JOBS ?? 30);
if (!Number.isInteger(jobCount) || jobCount < 1 || jobCount > 50) throw new Error("AB_PERF_JOBS must be 1..50");
const launchCwd = process.cwd();
const home = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "abp-")));
process.env.GIT_CEILING_DIRECTORIES = home;
for (const name of Object.keys(process.env)) {
  if (name.startsWith("AGENT_BRIDGE_PARENT_") || ["AGENT_BRIDGE_INTERNAL", "AGENT_BRIDGE_DELEGATE_DEPTH", "AGENT_BRIDGE_PARENT_JOB", "AGENT_BRIDGE_ROOT_SESSION", "AGENT_BRIDGE_ROOT_NAME"].includes(name)) delete process.env[name];
}
execFileSync("git", ["init", home], { stdio: "ignore", windowsHide: true });
process.chdir(home);
process.env.AGENT_BRIDGE_HOME = home;
process.env.AGENT_BRIDGE_HISTORY_INGEST = "1";
const pipe = resolvePipePath(home, {}), token = "synthetic-load-token";
if (process.platform !== "win32" && Buffer.byteLength(pipe) >= 104) throw new Error("socket path too long");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const samples: Record<string, number[]> = {};
const io: Record<string, { calls: number; ms: number; bytes: number }> = {};
const timed = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
  const start = performance.now();
  try { return await fn(); }
  catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  finally { (samples[name] ??= []).push(performance.now() - start); }
};
// Measure actual synchronous read/write cost, rather than infer it from request latency.
for (const name of ["readFileSync", "writeFileSync", "statSync", "realpathSync", "readdirSync"] as const) {
  const original = fs[name] as (...args: any[]) => any;
  const wrapper = (...args: any[]) => {
    const start = performance.now(); let value;
    try { return value = original(...args); }
    finally {
      const record = io[name] ??= { calls: 0, ms: 0, bytes: 0 };
      record.calls++; record.ms += performance.now() - start;
      const data = name === "writeFileSync" ? args[1] : value;
      if (typeof data === "string" || Buffer.isBuffer(data)) record.bytes += Buffer.byteLength(data);
    }
  };
  Object.assign(wrapper, original);
  (fs as any)[name] = wrapper;
}
syncBuiltinESMExports();

const inspector = new Session(); inspector.connect();
const post = (method: string) => new Promise<any>((resolve, reject) => inspector.post(method as any, (err, value) => err ? reject(err) : resolve(value)));
const clients: BridgeClient[] = [];
let ui: Awaited<ReturnType<typeof startUi>> | undefined;
let store: MessageStore | undefined, broker: Broker | undefined;
let a: NetworkService | undefined, b: NetworkService | undefined;
const managers: JobManager[] = [];
const lag = monitorEventLoopDelay({ resolution: 10 });
let failures = 0, delivered = 0, quietCopies = 0;
const failureDetails: string[] = [];
try {
  // No discovery of the owner's CLI transcripts in a synthetic load profile.
  process.env.CODEX_HOME = join(home, "codex-fixture");
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude-fixture");
  process.env.XDG_DATA_HOME = join(home, "xdg-fixture");
  process.env.ANTIGRAVITY_CLI_HOME = join(home, "antigravity-fixture");
  for (const name of ["codex-fixture", "claude-fixture", "xdg-fixture", "antigravity-fixture"]) fs.mkdirSync(join(home, name));
  const backfillFixture = seedLargeHistoryBackfill(home);
  fs.mkdirSync(join(home, "runs", "archive"), { recursive: true });
  fs.mkdirSync(join(home, "archive"));
  fs.writeFileSync(join(home, "token"), token);
  fs.writeFileSync(join(home, "config.json"), JSON.stringify({ notifications: { approvals: false, finish: false, fail: false } }));
  const jobs = Array.from({ length: 400 }, (_, i) => ({ id: i.toString(16).padStart(8, "0"), name: `codex-job-${i.toString(16).padStart(8, "0")}`, agent: "codex", supervisor: "load-root", owner: "load-owner", prompt: "synthetic task ".repeat(140), startedAt: Date.now() - i * 1000, status: i < jobCount ? "running" : "done", args: { title: `Load job ${i}` }, sessionId: null, workdir: home, worktree: null }));
  fs.writeFileSync(join(home, "jobs.json"), JSON.stringify({ jobs }));
  for (let i = 0; i < 164; i++) fs.writeFileSync(join(home, "archive", `jobs-${i}.json`), JSON.stringify({ jobs: [jobs[i]] }));
  for (let i = 0; i < 680; i++) {
    const name = `2026-10-01-00-00-00-codex-${i.toString(16).padStart(8, "0")}`;
    const root = join(home, "runs", i % 2 ? "archive" : "");
    fs.writeFileSync(join(root, `${name}.log`), `00:00:00 codex by load-owner in ${home}, access full\nsynthetic task\n---\n${"00:00:01 synthetic progress\n".repeat(3400)}00:00:02 finished after 2s · done\n`);
    fs.writeFileSync(join(root, `${name}.json`), JSON.stringify({ job: jobs[i % jobs.length]!.name, title: `Run ${i}` }));
  }
  process.env.AGENT_BRIDGE_BACKUP_INTERVAL_MS = "0";
  store = new MessageStore(join(home, "bridge.db"), nullLogger);
  // Large, retained message history exercises the real dashboard query.
  for (let i = 0; i < 8000; i++) store.insert({ id: randomUUID(), from: { id: "seed", name: "load-owner", agent: "codex" }, to: "load-owner", recipient: "load-owner", conversationId: `seed-${i}`, replyTo: null, hop: 0, body: "synthetic history ".repeat(80), createdAt: Date.now() - i, readAt: Date.now() });
  const peers: PeerInfo[] = [];
  const networkCfg = { ...DEFAULT_NETWORK_CONFIG, enabled: true, bind: "127.0.0.1", port: 0, discovery: false };
  a = new NetworkService(join(home, "pc-a"), { ...networkCfg, name: "pc-a" }, { peers: () => peers, receive: () => ({ delivered: true }) }, nullLogger);
  b = new NetworkService(join(home, "pc-b"), { ...networkCfg, name: "pc-b" }, { peers: () => peers.slice(jobCount), receive: () => ({ delivered: true }) }, nullLogger);
  await a.start(); await b.start();
  const invitation = b.keys.invite();
  // Profile an established pairing. Initial Windows ACL subprocesses run before the handshake clock.
  b.keys.accept(decodePairingCode(invitation).key, a.keys.identity);
  await a.link(invitation, "127.0.0.1", b.port);
  broker = new Broker(pipe, store, createLogger({ home, component: "load-fixture" }), token, Date.now, join(home, "jobs.json"));
  await broker.listen();
  const history = new DatabaseSync(historyDbPath(join(home,"bridge.db")),{timeout:3000});
  try {
    // Fixture setup includes paced, verified copying of 64k history rows. It is
    // outside the timed load window; request/latency assertions stay unchanged.
    const deadline = Date.now() + 120_000;
    while (!historyReady(history)) { if (Date.now()>deadline) throw new Error("history migration did not finish: " + JSON.stringify((broker as unknown as {historyBackground?: {status():unknown}}).historyBackground?.status())); await pause(100); }
    primeLargeHistoryBackfill(history,home,backfillFixture);
  } finally { history.close(); }
  const measureBackfill = () => {
    const history = new DatabaseSync(historyDbPath(join(home,"bridge.db")),{readOnly:true,timeout:100});
    try { return backfillBytes(history,backfillFixture); } finally { history.close(); }
  };
  const legacyCounts = () => {
    const bridge = new DatabaseSync(join(home,"bridge.db"),{readOnly:true,timeout:100});
    try { return ["history_documents","conversation_records","history_files"].map(table => Number(bridge.prepare(`SELECT count(*) n FROM ${table}`).get()!.n)); } finally { bridge.close(); }
  };
  const legacyBefore = legacyCounts(), backfillProgress: number[] = [];
  for (let i = 0; i < jobCount + 6; i++) {
    const job = i < jobCount ? jobs[i]! : undefined;
    const p: PeerInfo = { id: job ? `job:${job.id}` : randomUUID(), name: job?.name ?? (i === jobCount ? "load-owner" : `load-session-${i}`), agent: "codex", cwd: home, pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false, ...(job ? { jobAgent: "codex", jobOwner: "load-root", jobParent: "load-owner" } : {}) };
    const client = await BridgeClient.connect(pipe, nullLogger);
    client.on("event", (_ev, data) => { if (_ev === "message") { delivered++; if ((data as BridgeMessage).conversationId.endsWith(":note")) quietCopies++; } });
    await client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: p }).catch((err) => { client.close(); throw new Error(`hello ${p.name}: ${(err as Error).message}`, { cause: err }); });
    clients.push(client); peers.push(p);
  }
  ui = await startUi({ home, pipe, port: 0, log: nullLogger });
  const secret = new URL(ui.url).searchParams.get("t");
  let progressStart = performance.now();
  for (let i = 0; i < 6; i++) {
    const coordinator = Object.assign(new EventEmitter(), { name: i === 0 ? "load-owner" : `load-session-${jobCount + i}`, id: `root-${i}`, cwd: home, currentSessionId: `root-${i}`, send: async () => ({}), deliverLocal: () => {} });
    const count = Math.floor(jobCount / 6) + (i < jobCount % 6 ? 1 : 0);
    const manager = new JobManager(coordinator as any, nullLogger, join(home, "jobs.json"), count);
    manager.runners = {
      state: (job: Job) => ({ pid: process.pid, peer: job.name, status: "running", updatedAt: Date.now(), percent: Math.floor((performance.now() - progressStart) / 1000), progressNote: "synthetic progress" }),
      alive: () => true, send: () => {}, kill: () => {},
    };
    const run = Object.assign(async () => new Promise<never>(() => {}), { hosted: (job: Job) => ({ pid: process.pid, peer: job.name, startedAt: Date.now() }) }) as Run;
    for (let j = 0; j < count; j++) manager.start("codex", null, "synthetic progress task", run);
    managers.push(manager);
  }
  progressStart = performance.now();
  for (const key of Object.keys(io)) delete io[key];
  lag.enable();
  await post("Profiler.enable"); await post("Profiler.start");
  const cpu = process.cpuUsage(), started = performance.now();
  backfillProgress.push(measureBackfill());
  for (let i = 0; i < 5; i++) await timed("listRuns", () => listRuns(home));
  const finishAt = performance.now() + duration * 1000;
  const loop = async (interval: number, fn: () => Promise<unknown>) => {
    while (performance.now() < finishAt) {
      try { await fn(); }
      catch (error) { failures++; failureDetails.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error)); }
      await pause(interval);
    }
  };
  // Six sessions each poll hooks. A hook uses a fresh authenticated pipe.
  const hook = () => timed("hook", async () => {
    const c = await BridgeClient.connect(pipe, nullLogger);
    try { await c.request("auth", { protocol: PROTOCOL_VERSION, token }); await c.request("dashboardPeers", {}); }
    finally { c.close(); }
  });
  let sendIteration = 0;
  await Promise.all([
    loop(2000, async () => { backfillProgress.push(measureBackfill()); }),
    loop(2000, () => timed("state", async () => { const res = await fetch(`http://127.0.0.1:${ui!.port}/api/state`, { headers: { cookie: `ab_ui=${secret}` } }); if (res.status !== 200) throw new Error(`HTTP ${res.status}`); await res.json(); })),
    ...Array.from({ length: 6 }, () => loop(1000, hook)),
    ...Array.from({ length: jobCount }, (_, i) => loop(2000, () => timed("sibling", () => clients[i]!.request("sendSibling", { to: jobs[(i + 1) % jobCount]!.name, body: "synthetic coordination", maxHops: 32 })))),
    loop(1000, () => timed("peers", () => clients[jobCount]!.request("peers", {}))),
    loop(1000, () => timed("send", async () => {
      const args = { to: `load-session-${jobCount + 1}`, body: "synthetic direct message" };
      if (sendIteration++ % 2) return clients[jobCount]!.request("send", args);
      const id = randomUUID(), result = await clients[jobCount]!.request("trackedSend", { ...args, messageId: id });
      const state = await timed("sendStatus", () => clients[jobCount]!.request("sendState", { id }));
      if (result.storage?.state !== "stored" || state.state !== "stored" || state.message?.id !== id) throw new Error("tracked send storage mismatch");
      return result;
    })),
    loop(1000, () => timed("pairedPing", () => a!.verify(b!.keys.identity.id))),
  ]);
  for (const manager of managers) manager.setDormant(true);
  const usage = process.cpuUsage(cpu), elapsed = performance.now() - started;
  const profile = (await post("Profiler.stop")).profile;
  const hits = new Map<number, number>(); for (const id of profile.samples ?? []) hits.set(id, (hits.get(id) ?? 0) + 1);
  const parents = new Map<number, any>();
  for (const n of profile.nodes) for (const child of n.children ?? []) parents.set(child, n);
  const ancestry = (n: any): string[] => { const frames: string[] = []; for (let p = parents.get(n.id); p && frames.length < 8; p = parents.get(p.id)) frames.push(p.callFrame.functionName); return frames; };
  const hot = profile.nodes.map((n: any) => ({ fn: n.callFrame.functionName, file: n.callFrame.url.split("/").at(-1), samples: hits.get(n.id) ?? 0, callers: ancestry(n) })).filter((n: any) => n.samples).sort((x: any, y: any) => y.samples - x.samples).slice(0, 12);
  // Another SQLite writer holds the real primary database while send and peers share the broker.
  const sqlWorker = new Worker(`const { DatabaseSync } = require('node:sqlite'); const { workerData, parentPort } = require('node:worker_threads');
    const db = new DatabaseSync(workerData, { timeout: 3000 }); db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); parentPort.postMessage('released'); }, 500);`,
    { eval: true, workerData: join(home, "bridge.db") });
  await new Promise<void>((resolve, reject) => { sqlWorker.once("message", () => resolve()); sqlWorker.once("error", reject); });
  const sqlStart = performance.now();
  let sqlHeartbeat = 0;
  const sqlBeat = setTimeout(() => { sqlHeartbeat = performance.now() - sqlStart; }, 20);
  await Promise.all([
    timed("sqliteContendedSend", () => clients[jobCount]!.request("trackedSend", { to: `load-session-${jobCount + 1}`, body: "sqlite contention probe", messageId: randomUUID(), dedupeKey: "sqlite-probe" })),
    timed("peersDuringSqliteLock", () => clients[jobCount]!.request("peers", {})),
  ]);
  clearTimeout(sqlBeat); await sqlWorker.terminate();
  // Isolated cross-process store contention: release from another thread after 300ms.
  const coordinator = Object.assign(new EventEmitter(), { name: "load-owner", cwd: home, sessionId: "load-root", send: async () => ({}), deliverLocal: () => {} });
  const manager = new JobManager(coordinator as any, nullLogger, join(home, "jobs.json"));
  managers.push(manager);
  const tracked = manager.track("codex", null, "synthetic progress");
  const lockPath = join(home, "jobs.json.lock");
  const release = acquireLock(lockPath);
  // The actual owner releases/archives its lease. Renaming just one hard link
  // from another thread would deliberately leave a live, unreconciled lease.
  const worker = new Worker(`const { parentPort } = require('node:worker_threads'); setTimeout(() => parentPort.postMessage('release-owner-lease'), 300);`, { eval: true });
  const workerDone = new Promise<void>((resolve) => worker.once("message", () => { release(); resolve(); }));
  let heartbeat = 0; const heartbeatStart = performance.now();
  const beat = setTimeout(() => { heartbeat = performance.now() - heartbeatStart; }, 20);
  await timed("contendedPersist", () => manager.persist());
  await workerDone; manager.persist(); await pause(30); clearTimeout(beat); tracked.end();
  lag.disable();
  const stats = Object.fromEntries(Object.entries(samples).map(([key, values]) => { const sorted = [...values].sort((x, y) => x - y); return [key, { count: values.length, meanMs: values.reduce((x, y) => x + y, 0) / values.length, p95Ms: sorted[Math.floor((sorted.length - 1) * .95)], maxMs: sorted.at(-1) }]; }));
  backfillProgress.push(measureBackfill());
  const legacyAfter = legacyCounts();
  const backfill = { inputBytes: backfillFixture.bytes, rawBytesBySample: backfillProgress, legacyBefore, legacyAfter };
  if (backfillProgress.at(-1)! <= backfillProgress[0]! || backfillProgress.at(-1)! >= backfillFixture.bytes || JSON.stringify(legacyBefore)!==JSON.stringify(legacyAfter)) { failures++; failureDetails.push("backfill inactive/complete or worker wrote legacy history tables"); }
  const sendP95 = (stats.send as {p95Ms:number}|undefined)?.p95Ms ?? Infinity;
  if (sendP95 > 1000) { failures++; failureDetails.push(`send p95 ${sendP95}ms exceeds 1000ms gate`); }
  const report = { backfill, durationSeconds: duration, peers: peers.length, jobs: jobCount, logs: 680, retainedMessages: 8000, elapsedMs: elapsed, cpuMs: (usage.user + usage.system) / 1000, cpuPercent: (usage.user + usage.system) / (elapsed * 10), eventLoop: { p95Ms: lag.percentile(95) / 1e6, p99Ms: lag.percentile(99) / 1e6, maxMs: lag.max / 1e6 }, heartbeatMsUnderSqliteContention: sqlHeartbeat, heartbeatMsUnderStoreContention: heartbeat, failures, failureDetails, delivered, quietCopies, stats, io, hot };
  fs.writeFileSync(join(home, "performance-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (failures) process.exitCode = 1;
} finally {
  lag.disable(); inspector.disconnect();
  await ui?.close(); await a?.close(); await b?.close();
  for (const manager of managers) manager.setDormant(true);
  for (const c of clients) c.close();
  await broker?.close(); store?.close();
  // Retain generated evidence even on failure; the caller owns fixture retention.
  process.chdir(launchCwd);
  console.error(`Retained synthetic load fixture: ${home}`);
  console.error("Remaining fixture resources: " + process.getActiveResourcesInfo().join(", "));
}
