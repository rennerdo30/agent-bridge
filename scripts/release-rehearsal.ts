/** Opt-in release rehearsal. Synthetic fixtures and results are retained under the checkout only.
 * Bundle with esbuild (--bundle --platform=node --format=esm --packages=external).
 * Seed: node .agent-bridge-test/release-rehearsal.mjs --seed-only --bytes 20GiB
 * Run:  node .agent-bridge-test/release-rehearsal.mjs --home <printed fixture> --io 8MiB
 * Never included in the normal test suite at production scale.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants as priorities, getPriority, setPriority } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector";
import { EventEmitter } from "node:events";
import { build } from "esbuild";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { resolvePipePath } from "../src/core/paths.js";
import { APP_VERSION } from "../src/core/constants.js";
import { JobManager, type Run } from "../src/mcp/jobs.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { createWorktree } from "../src/core/worktree.js";
import { historyDbPath, type HistoryMigrationProgress } from "../src/core/history-store.js";
import { listRuns, readDashboard } from "../src/core/dashboard-read.js";
import { worktreeLease } from "../src/core/worktree-state.js";
import type { Broker } from "../src/core/broker.js";
import type { HistoryBackground } from "../src/core/history-background.js";
import type { Worker } from "node:worker_threads";

const argumentsList = process.argv.slice(2);
function option(name: string): string | undefined { const i = argumentsList.indexOf(name); return i < 0 ? undefined : argumentsList[i + 1]; }
export function rehearsalBytes(value: string): number {
  const match = /^(\d+)(B|KiB|MiB|GiB)?$/i.exec(value);
  if (!match) throw new Error("Bytes must be an integer optionally followed by B, KiB, MiB, or GiB");
  const unit = ["b", "kib", "mib", "gib"].indexOf((match[2] ?? "B").toLowerCase());
  const n = Number(match[1]) * 1024 ** unit;
  if (!Number.isSafeInteger(n) || n < 1024 || n > 64 * 1024 ** 3) throw new Error("Fixture bytes must be 1 KiB through 64 GiB");
  return n;
}
const checkout = realpathSync.native(process.cwd());
const fixtureRoot = join(checkout, ".agent-bridge-test");
const token = "synthetic-rehearsal-token";
const sourceId = "synthetic-rehearsal-source";
const cliDirectories = { CODEX_HOME: "codex", CLAUDE_CONFIG_DIR: "claude", XDG_DATA_HOME: "xdg", ANTIGRAVITY_CLI_HOME: "antigravity" };
interface Seed { schema: 1; home: string; oldVersion: string; oldSha: string; payloadBytes: number; rows: number; rawSha256: string; sourceBytes: number; archiveFiles: number; archiveBytes: number; runs: number; createdAt: string }
function physicalHome(path: string): string {
  const result = resolve(path), rel = relative(fixtureRoot, result);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Fixture must be strictly below this checkout's .agent-bridge-test");
  for (let current = result; current !== checkout; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Fixture paths must not traverse links");
    if (dirname(current) === current) throw new Error("Fixture containment failed");
  }
  return realpathSync.native(result);
}
function isolate(home: string): void {
  process.env.AGENT_BRIDGE_HOME = home;
  process.env.AGENT_BRIDGE_BACKUP_INTERVAL_MS = "0";
  for (const [key, child] of Object.entries(cliDirectories)) { const path = join(home, "empty-cli", child); mkdirSync(path, { recursive: true }); process.env[key] = path; }
  try { setPriority(0, priorities.priority.PRIORITY_BELOW_NORMAL); } catch { /* Reported by the caller; no elevation. */ }
}
async function oldRuntime(home: string): Promise<typeof import("../src/core/node.js") & { MessageStore: typeof import("../src/core/store.js").MessageStore; APP_VERSION: string; JSON_STORE_VERSION: number }> {
  const old = join(fixtureRoot, "rehearsal-old");
  const output = join(home, "cache", "old-runtime.mjs"); mkdirSync(dirname(output), { recursive: true });
  if (!existsSync(output)) {
    await build({ stdin: { contents: [
      `export { BridgeNode } from ${JSON.stringify(join(old, "src/core/node.ts"))};`,
      `export { MessageStore } from ${JSON.stringify(join(old, "src/core/store.ts"))};`,
      `export { APP_VERSION } from ${JSON.stringify(join(old, "src/core/constants.ts"))};`,
      `export { JSON_STORE_VERSION } from ${JSON.stringify(join(old, "src/core/json-store.ts"))};`,
    ].join("\n"), resolveDir: checkout }, outfile: output, bundle: true, platform: "node", format: "esm", target: "node22", nodePaths: [join(checkout, "node_modules")], packages: "external", logLevel: "silent" });
  }
  const runtime = await import(pathToFileURL(output).href);
  if (runtime.APP_VERSION !== "0.29.17") throw new Error("Rehearsal requires genuine 0.29.17 source");
  return runtime;
}
export async function seedRehearsal(bytes: number): Promise<Seed> {
  if (!existsSync(join(checkout, "src/core/node.ts"))) throw new Error("Run from the isolated source checkout");
  mkdirSync(fixtureRoot, { recursive: true });
  const home = physicalHome(mkdtempSync(join(fixtureRoot, "release-rehearsal-"))); isolate(home);
  writeFileSync(join(home, "token"), token, { flag: "wx" });
  writeFileSync(join(home, "config.json"), JSON.stringify({ history: { ingest: false }, notifications: { approvals: false, finish: false, fail: false } }), { flag: "wx" });
  const old = await oldRuntime(home);
  const oldSha = execFileSync("git", ["-C", join(fixtureRoot, "rehearsal-old"), "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
  const initial = new old.MessageStore(join(home, "bridge.db"), nullLogger); initial.close();
  const db = new DatabaseSync(join(home, "bridge.db"));
  const hash = createHash("sha256"); let payloadBytes = 0, rows = 0;
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192");
    db.prepare("INSERT INTO conversations(id,agent,session,project,kind) VALUES(?,?,?,?,?)").run(sourceId, "codex", "synthetic-rehearsal-session", home, "transcript");
    db.prepare("INSERT INTO conversation_sources(id,path,conversation,format,offset) VALUES(?,?,?,?,0)").run(sourceId, join(home, "synthetic-source.jsonl"), sourceId, "codex");
    const insert = db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body,part) VALUES(?,0,?,?,?,?,?,NULL)");
    while (payloadBytes < bytes) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let batch = 0; batch < 8 && payloadBytes < bytes; batch++) {
          const size = Math.min(1024 * 1024, bytes - payloadBytes);
          const body = `Synthetic retained transcript record ${rows}`;
          const empty = JSON.stringify({ type: "response_item", synthetic: true, index: rows, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: body }] }, metadata: { padding: "" } });
          const raw = Buffer.from(empty.replace('"padding":""', `"padding":"${"x".repeat(size - Buffer.byteLength(empty))}"`));
          insert.run(sourceId, payloadBytes, sourceId, 1_700_000_000_000 + rows, raw, body);
          hash.update(raw); payloadBytes += raw.length; rows++;
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      if (rows % 256 === 0 || payloadBytes === bytes) console.log(JSON.stringify({ phase: "seed", home, payloadBytes, rows, percent: 100 * payloadBytes / bytes }));
      await delay(5);
    }
    db.exec("PRAGMA wal_checkpoint(FULL)");
  } finally { db.close(); }
  mkdirSync(join(home, "archive")); mkdirSync(join(home, "runs"));
  let archiveBytes = 0;
  for (let file = 0; file < 307; file++) {
    // Repeated IDs model retained duplicate archives without changing or removing any file.
    const jobs = Array.from({ length: 75 }, (_, n) => { const id = `archived-${file % 209}-${n}`; return { id, name: `codex-job-${id}`, agent: "codex", owner: "old-session-0", supervisor: "synthetic-root", status: "done", sessionId: `synthetic-${id}`, prompt: "Synthetic retained completed job. ".repeat(18), startedAt: 1_700_000_000_000, finishedAt: 1_700_000_001_000, args: { title: id }, workdir: home, worktree: null }; });
    const raw = JSON.stringify({ version: old.JSON_STORE_VERSION, jobs }); archiveBytes += Buffer.byteLength(raw);
    writeFileSync(join(home, "archive", `jobs-${1_700_000_000_000 + file}-synthetic.json`), raw, { flag: "wx" });
    if (file % 16 === 0) await delay(5);
  }
  for (let n = 0; n < 1_024; n++) {
    const name = `synthetic-run-${n}`;
    writeFileSync(join(home, "runs", `${name}.json`), JSON.stringify({ id: name, agent: "codex", model: null, prompt: "Synthetic retained run", startedAt: 1_700_000_000_000 + n, endedAt: 1_700_000_001_000 + n, status: "done", sessionId: `synthetic-session-${n}`, cwd: home, worktree: null }), { flag: "wx" });
    writeFileSync(join(home, "runs", `${name}.log`), "Synthetic retained output\n", { flag: "wx" });
    if (n % 32 === 0) await delay(5);
  }
  writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: old.JSON_STORE_VERSION, jobs: [] }), { flag: "wx" });
  const seed: Seed = { schema: 1, home, oldVersion: old.APP_VERSION, oldSha, payloadBytes, rows, rawSha256: hash.digest("hex"), sourceBytes: statSync(join(home, "bridge.db")).size, archiveFiles: 307, archiveBytes, runs: 1_024, createdAt: new Date().toISOString() };
  writeFileSync(join(home, "seed.json"), JSON.stringify(seed, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ phase: "seed-complete", ...seed })); return seed;
}

type Reply = { rid?: string; ready?: boolean; result?: unknown; error?: string };
type Role = "old-session" | "old-runner" | "current-session" | "lease-owner";
type NodeInternals = { broker: Broker | null; client: { request(op: string, args: unknown): Promise<unknown> } | null };
type BrokerInternals = { historyBackground: HistoryBackground | null };
interface FixtureChild { process: ChildProcess; role: Role; index: number; request(op: string, data?: Record<string, unknown>): Promise<any>; stop(): Promise<void> }
const children: FixtureChild[] = [];
async function childMain(home: string, role: Role, index: number): Promise<void> {
  isolate(home);
  if (role === "lease-owner") {
    const path = option("--worktree"); if (!path || !relative(home, path) || relative(home, path).startsWith("..")) throw new Error("Lease fixture must be below the synthetic home");
    worktreeLease(home, { path }); process.send?.({ ready: true, result: { pid: process.pid } });
    setInterval(() => {}, 1000); return;
  }
  const legacy = role.startsWith("old-");
  const constructor = legacy ? (await oldRuntime(home)).BridgeNode : BridgeNode;
  const name = role === "old-runner" ? `codex-job-rehearsal-${index}` : `old-session-${index}`;
  const node = new constructor({ pipePath: resolvePipePath(home, {}), dbPath: join(home, "bridge.db"), token, agent: role === "old-runner" ? "other" : "codex", name, cwd: home, autoWake: false, log: nullLogger,
    ...(role === "old-runner" ? { canHostBroker: false, id: `job:rehearsal-${index}`, jobAgent: "codex" as const, jobParent: "old-session-0", jobOwner: "synthetic-root", rootName: "old-session-0", rootSession: "synthetic-root" } : {}) });
  node.on("message", message => node.markRead([message.id]));
  await node.start();
  if (role !== "old-runner") await node.setSessionId(`synthetic-session-${index}`);
  const internals = node as unknown as NodeInternals;
  process.send?.({ ready: true, result: { pid: process.pid, name: node.name, version: legacy ? "0.29.17" : APP_VERSION } });
  let profiling = false;
  let toolJobs: JobManager | undefined, subagent: string | undefined, delivered = 0;
  const callbacks = new Map<string, (args: Record<string, unknown>, extra: any) => Promise<any>>();
  const prepareSubagent = () => {
    if (legacy || !internals.broker) throw new Error("Tool fixture requires the current broker session");
    if (toolJobs) return;
    const lane = join(home, "mcp-tool-fixture"); mkdirSync(lane, { recursive: true });
    toolJobs = new JobManager(node, nullLogger, join(lane, "jobs.json"));
    const fakeMcp = { registerTool: (name: string, _config: unknown, callback: (args: Record<string, unknown>, extra: any) => Promise<any>) => { callbacks.set(name, callback); } };
    registerTools(fakeMcp as Parameters<typeof registerTools>[0], { node, jobs: toolJobs, cfg: DEFAULT_CONFIG, home, cwd: () => home, agent: "codex", log: nullLogger, channelActive: () => false } as ServerContext, []);
    const run: Run = async signal => new Promise(resolve => { signal.addEventListener("abort", () => resolve({ text: "Synthetic held run stopped", sessionId: "synthetic-held-tool-session", isError: false, details: {} }), { once: true }); });
    const job = toolJobs.start("codex", null, "Synthetic held runner; no proprietary CLI", run);
    job.live = { post: () => { delivered++; } }; subagent = job.name;
  };
  process.on("message", (raw: { rid: string; op: string; data?: Record<string, unknown> }) => {
    const answer = async (): Promise<unknown> => {
      if (raw.op === "stop") { toolJobs?.cancelAll(); await node.stop(); return { stopped: true }; }
      if (raw.op === "probe") {
        const before = performance.now();
        const sent = await node.send({ to: "old-session-0", body: "Synthetic continuity probe", dedupeKey: randomUUID() });
        const sendMs = performance.now() - before, at = performance.now(); await node.peers();
        return { sendMs, peersMs: performance.now() - at, id: sent.messages[0]?.id };
      }
      if (raw.op === "status") {
        const broker = internals.broker as unknown as BrokerInternals | null;
        return { broker: Boolean(broker), pid: process.pid, priority: getPriority(0), migration: broker?.historyBackground?.status() ?? null, version: legacy ? "0.29.17" : APP_VERSION, name: node.name, id: node.id, sessionId: node.currentSessionId };
      }
      if (raw.op === "interrupt-history") {
        const background = (internals.broker as unknown as BrokerInternals | null)?.historyBackground;
        if (!background) throw new Error("The selected session is not hosting the history worker");
        const worker = (background as unknown as { worker: Worker }).worker;
        const progress = background.status(); await worker.terminate(); return { progress, interrupted: true };
      }
      if (raw.op === "profile") {
        if (!internals.broker || profiling) throw new Error("Profile requires this session's broker main thread");
        profiling = true; const inspector = new Session(); inspector.connect();
        const post = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => inspector.post(method as any, params, (error, value) => error ? reject(error) : resolve(value)));
        try {
          await post("Profiler.enable"); await post("Profiler.setSamplingInterval", { interval: 1000 }); await post("Profiler.start");
          const cpu = process.cpuUsage(); await delay(Number(raw.data?.milliseconds ?? 8000));
          const value = await post("Profiler.stop"); const path = join(home, `broker-${String(raw.data?.phase ?? "migration")}-${randomUUID()}.cpuprofile`);
          writeFileSync(path, JSON.stringify(value.profile), { flag: "wx" });
          const frames = new Map<number, { name: string; samples: number; micros: number }>();
          for (const frame of value.profile.nodes) frames.set(frame.id, { name: frame.callFrame.functionName, samples: 0, micros: 0 });
          for (let i = 0; i < (value.profile.samples?.length ?? 0); i++) { const frame = frames.get(value.profile.samples[i]); if (frame) { frame.samples++; frame.micros += value.profile.timeDeltas?.[i] ?? 0; } }
          return { phase: raw.data?.phase, path, pid: process.pid, cpuMicros: process.cpuUsage(cpu), samples: value.profile.samples?.length ?? 0, hottestFrames: [...frames.values()].sort((a, b) => b.micros - a.micros).slice(0, 12) };
        } finally { inspector.disconnect(); profiling = false; }
      }
      if (raw.op === "runs") { const at = performance.now(); const runs = listRuns(home); return { milliseconds: performance.now() - at, count: runs.length }; }
      if (raw.op === "dashboard") {
        if (!internals.broker || legacy) throw new Error("Dashboard poll must execute on the current broker main thread");
        const at = performance.now(), runs = listRuns(home), listRunsMs = performance.now() - at, pollAt = performance.now();
        const value = await readDashboard({ home, log: nullLogger, peers: () => node.peers() }, { path: "/api/state" });
        if (value.status !== 200 || runs.length < 1000) throw new Error("Dashboard fixture did not load its retained run corpus");
        return { listRunsMs, dashboardMs: performance.now() - pollAt, runCount: runs.length };
      }
      if (raw.op === "message-subagent") {
        prepareSubagent(); const at = performance.now(), before = delivered;
        const value = await callbacks.get("message_subagent")!({ job: subagent!, message: "Synthetic sustained tool probe" }, {});
        if (value.isError || delivered !== before + 1) throw new Error(`Actual message_subagent handler did not deliver: ${JSON.stringify(value)}`);
        return { messageSubagentMs: performance.now() - at, delivered, actualRegisteredHandler: true, fakeHeldRunner: true };
      }
      throw new Error(`Unknown rehearsal operation ${raw.op}`);
    };
    void answer().then(result => {
      process.send?.({ rid: raw.rid, result }, () => { if (raw.op === "stop") process.exit(0); });
    }, error => process.send?.({ rid: raw.rid, error: String(error) }));
  });
}
async function startChild(home: string, role: Role, index: number, extra: string[] = []): Promise<FixtureChild> {
  const processChild = fork(fileURLToPath(import.meta.url), ["--home", home, "--role", role, "--index", String(index), ...extra], { cwd: checkout, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  const waiters = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const child: FixtureChild = {
    process: processChild, role, index,
    request: (op, data) => new Promise((resolve, reject) => {
      const rid = randomUUID(), timer = setTimeout(() => { waiters.delete(rid); reject(new Error(`Owned ${role} ${index} request timed out: ${op}`)); }, op === "profile" ? 30_000 : 60_000);
      waiters.set(rid, { resolve, reject, timer }); processChild.send({ rid, op, data }, error => { if (error) { clearTimeout(timer); waiters.delete(rid); reject(error); } });
    }),
    stop: async () => { if (processChild.exitCode !== null || processChild.signalCode !== null) return; try { await child.request("stop"); } catch { if (processChild.exitCode === null) processChild.kill(); } await until(() => processChild.exitCode !== null || processChild.signalCode !== null, 15_000); },
  };
  children.push(child);
  const output = { stdout: "", stderr: "" };
  for (const key of ["stdout", "stderr"] as const) processChild[key]?.on("data", data => { output[key] = (output[key] + String(data)).slice(-65_536); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Owned ${role} did not start: ${output.stderr}`)), 90_000);
    processChild.on("message", (message: Reply) => {
      if (message.ready) { clearTimeout(timer); resolve(); }
      if (message.rid) { const pending = waiters.get(message.rid); if (!pending) return; clearTimeout(pending.timer); waiters.delete(message.rid); if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result); }
    });
    processChild.once("exit", (code, signal) => {
      clearTimeout(timer); writeFileSync(join(home, `child-${role}-${index}-${processChild.pid}.json`), JSON.stringify({ pid: processChild.pid, code, signal, ...output }));
      for (const pending of waiters.values()) { clearTimeout(pending.timer); pending.reject(new Error(`Owned ${role} exited: ${code}/${signal}`)); }
      waiters.clear(); if (code !== 0) reject(new Error(`Owned ${role} failed to start: ${output.stderr}`));
    });
  });
  return child;
}
async function until(check: () => boolean | Promise<boolean>, timeout = 60_000): Promise<void> { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error("Rehearsal condition timed out"); await delay(100); } }
function cursor(progress: HistoryMigrationProgress): Record<string, unknown> {
  if (!progress.snapshot || !existsSync(`${progress.snapshot}.progress.db`)) return {};
  const db = new DatabaseSync(`${progress.snapshot}.progress.db`, { readOnly: true, timeout: 100 });
  try { return db.prepare("SELECT generation,snapshot_after,snapshot_rows,snapshot_verify_after,snapshot_verify_rows,copy_after,copy_rows,verify_after,verify_rows FROM table_state WHERE table_name='conversation_records'").get() ?? {}; }
  finally { db.close(); }
}
async function rawHash(file: string): Promise<{ rows: number; bytes: number; sha256: string }> {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 100 }), hash = createHash("sha256"), start = performance.now(); let rows = 0, bytes = 0;
  const rate = Number(process.env.AGENT_BRIDGE_HISTORY_MIGRATION_IO_BYTES_PER_SECOND ?? 8 * 1024 * 1024);
  try {
    for (const row of db.prepare("SELECT * FROM conversation_records WHERE source=? ORDER BY offset").iterate(sourceId)) {
      if (Number(row.id) !== rows + 1 || Number(row.generation) !== 0 || Number(row.offset) !== bytes || row.conversation !== sourceId || Number(row.at) !== 1_700_000_000_000 + rows || row.body !== `Synthetic retained transcript record ${rows}` || row.part !== null) throw new Error("Seeded history row metadata changed");
      const raw = Buffer.from(row.raw as Uint8Array); hash.update(raw); bytes += raw.length; rows++;
      while (performance.now() - start < bytes * 1000 / rate) await delay(Math.min(50, Math.max(1, bytes * 1000 / rate - (performance.now() - start))));
      if (rows % 8 === 0) await delay(5);
    }
    return { rows, bytes, sha256: hash.digest("hex") };
  } finally { db.close(); }
}
async function continuation(home: string, identity: { name: string; id: string; sessionId: string }): Promise<unknown> {
  // Copy public Git objects into an independent fixture repository. No source commit or live ref moves.
  const repository = join(home, "synthetic-git-project");
  execFileSync("git", ["clone", "--no-local", "--quiet", checkout, repository], { stdio: "pipe", windowsHide: true });
  const worktree = await createWorktree({ cwd: repository, home, jobId: `rehearsal-${randomUUID().slice(0, 8)}`, log: nullLogger });
  const context = join(worktree.cwd, "synthetic-context.txt"), retained = "Synthetic context preserved across runner interruption.\n";
  writeFileSync(context, retained, { flag: "wx" });
  const owner = await startChild(home, "lease-owner", 0, ["--worktree", worktree.path]);
  owner.process.kill("SIGKILL"); await until(() => owner.process.signalCode !== null || owner.process.exitCode !== null);
  const lane = join(home, "continuation-fixture"); mkdirSync(lane); const path = join(lane, "jobs.json");
  const id = "abcdef123456", name = `codex-job-${id}`, sessionId = "synthetic-native-resume-session";
  writeFileSync(path, JSON.stringify({ version: 3, jobs: [{ id, name, agent: "codex", model: null, prompt: "Synthetic interrupted work", owner: identity.name, supervisor: identity.sessionId, status: "running", startedAt: Date.now(), sessionId, workdir: worktree.cwd, worktree, args: { title: "Synthetic managed continuation" } }] }), { flag: "wx" });
  const coordinator = Object.assign(new EventEmitter(), { name: identity.name, id: identity.id, currentSessionId: identity.sessionId, cwd: home, deliverLocal: () => {} });
  const manager = new JobManager(coordinator, nullLogger, path);
  let witnessed: unknown;
  manager.restore(() => (message, retainedSession, cwd, retainedWorktree) => {
    const run: Run = async () => {
      if (retainedSession !== sessionId || cwd !== worktree.cwd || retainedWorktree?.path !== worktree.path || readFileSync(context, "utf8") !== retained) throw new Error("Managed job lost its retained native session/context/worktree");
      const release = worktreeLease(home, retainedWorktree);
      try { witnessed = { message, sessionId: retainedSession, workdir: cwd, worktree: retainedWorktree.path, contextSha256: createHash("sha256").update(readFileSync(context)).digest("hex"), deadOwnerPid: owner.process.pid }; return { text: "Synthetic restored continuation completed", sessionId: retainedSession, isError: false, details: {}, workdir: cwd, worktree: retainedWorktree }; }
      finally { release(); }
    }; return run;
  });
  const result = manager.followUp(name, "Resume synthetic retained context");
  if (result.outcome !== "started") throw new Error(`Managed job continuation did not start: ${result.outcome}`);
  await until(() => Boolean(witnessed)); await until(() => manager.runningCount() === 0);
  if (readFileSync(context, "utf8") !== retained) throw new Error("Managed continuation changed retained context bytes");
  manager.cancelAll(); return { restored: true, fakeRun: true, proprietaryCliLaunched: false, ...witnessed as Record<string, unknown> };
}
export async function rehearse(home: string): Promise<void> {
  home = physicalHome(home); isolate(home);
  // Prevent canonical project discovery from resolving the fixture through the outer checkout.
  // Every project mirror and restored-job path therefore stays inside this synthetic home.
  execFileSync("git", ["init", "--quiet", home], { stdio: "ignore", windowsHide: true });
  const seed = JSON.parse(readFileSync(join(home, "seed.json"), "utf8")) as Seed;
  // Genuine old brokers must begin with ingestion disabled even after a retained failed attempt.
  writeFileSync(join(home, "config.json"), JSON.stringify({ history: { ingest: false }, notifications: { approvals: false, finish: false, fail: false } }));
  const output = join(home, `rehearsal-${Date.now()}.json`);
  const workerOutput = join(dirname(fileURLToPath(import.meta.url)), "history-worker.mjs");
  await build({ entryPoints: [join(checkout, "src/core/history-worker.ts")], outfile: workerOutput, bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", logLevel: "silent" });
  process.env.AGENT_BRIDGE_HISTORY_MIGRATION_IO_BYTES_PER_SECOND = String(rehearsalBytes(option("--io") ?? "8MiB"));
  const samples: { at: number; phase: string; sendMs: number; peersMs: number; listRunsMs?: number; dashboardMs?: number; messageSubagentMs?: number }[] = [], failures: string[] = [], phases: { at: number; progress: HistoryMigrationProgress; cursor: Record<string, unknown> }[] = [];
  const report: Record<string, unknown> = { schema: 1, seed, currentVersion: APP_VERSION, runtimeSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"), workerSha256: createHash("sha256").update(readFileSync(workerOutput)).digest("hex"), sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8", windowsHide: true }).trim(), fixtureOnly: true, ownerDataAccessed: false, success: false, mainPriority: getPriority(0), startedAt: new Date().toISOString(), oldRunnerCount: 10, limitations: ["Old runner fixtures use genuine 0.29.17 BridgeNode job identities, not proprietary CLI turns", "Managed continuation uses actual JobManager.restore with a synthetic Run", "message_subagent uses the actual registered guarded MCP handler and a held synthetic Run without an MCP transport", "Current sessions join before old sessions retire; broker transition latency and errors are measured rather than a zero-gap socket guarantee"] };
  let sampling = false, sampler: Promise<void> | undefined, phase = "old-baseline";
  const profiles: unknown[] = []; let activeProfile: Promise<void> | undefined;
  let pollingHost: FixtureChild | undefined;
  try {
    const oldSessions = [await startChild(home, "old-session", 0), await startChild(home, "old-session", 1)];
    const runners: FixtureChild[] = [];
    for (let i = 0; i < 10; i++) { runners.push(await startChild(home, "old-runner", i)); await delay(250); }
    sampling = true;
    sampler = (async () => {
      while (sampling) {
        try {
          const sampledPhase = phase;
          const probe = await runners[0]!.request("probe");
          const polls = pollingHost ? { ...await pollingHost.request("dashboard"), ...await pollingHost.request("message-subagent") } : {};
          samples.push({ at: Date.now(), phase: sampledPhase, ...probe, ...polls });
        }
        catch (error) { failures.push(`${phase}: ${String(error)}`); }
        await delay(250);
      }
    })();
    await delay(1000);
    phase = "sessions-reload";
    const reloadAt = performance.now();
    const current = [await startChild(home, "current-session", 0), await startChild(home, "current-session", 1)];
    report.handoffCandidates = await Promise.all(current.map(child => child.request("status")));
    await Promise.all(oldSessions.map(child => child.stop()));
    let host: FixtureChild | undefined;
    await until(async () => { for (const child of current) if ((await child.request("status")).broker) { host = child; return true; } return false; });
    report.brokerRecoveryMs = performance.now() - reloadAt;
    const hostStatus = await host!.request("status"); report.brokerPid = hostStatus.pid;
    report.coldDashboard = await host!.request("dashboard"); report.warmDashboard = await host!.request("dashboard");
    pollingHost = host;
    report.retainedOldRunners = await Promise.all(runners.map(child => child.request("status")));
    const bridge = new DatabaseSync(join(home, "bridge.db"), { readOnly: true });
    try { report.schemaWhileLegacyRunnersLive = bridge.prepare("PRAGMA user_version").get()!.user_version; } finally { bridge.close(); }
    phase = "ingest-disabled";
    await delay(2500);
    const beforeEnable = (await host!.request("status")).migration as HistoryMigrationProgress;
    if (beforeEnable?.completedRows) throw new Error("Ingestion progressed while startup history.ingest=false");
    const config = (enabled: boolean) => writeFileSync(join(home, "config.json"), JSON.stringify({ history: { ingest: enabled }, notifications: { approvals: false, finish: false, fail: false } }));
    config(true);
    const timeout = Number(option("--timeout-ms") ?? 24 * 60 * 60 * 1000), deadline = Date.now() + timeout;
    let interrupted = false, toggled = false, lastProgress = "";
    const phaseStarted = new Map<string, number>(), phaseEnded = new Map<string, number>();
    const profiled = new Set<string>();
    while (Date.now() < deadline) {
      if (runners.some(child => child.process.exitCode !== null || child.process.signalCode !== null)) throw new Error("A genuine old runner died during the migration rehearsal; inspect retained child evidence");
      const progress = (await host!.request("status")).migration as HistoryMigrationProgress;
      if (!progress) throw new Error("New broker has no history monitor");
      phase = progress.phase; const signature = `${progress.phase}:${progress.completedRows}:${progress.paused}`;
      if (!phaseStarted.has(phase)) phaseStarted.set(phase, Date.now()); phaseEnded.set(phase, Date.now());
      if (signature !== lastProgress) {
        lastProgress = signature; const point = { at: Date.now(), progress, cursor: cursor(progress) }; phases.push(point);
        console.log(JSON.stringify({ phase: "migration", progress, cursor: point.cursor }));
      }
      if (!activeProfile && !profiled.has(phase) && ["snapshot", "copy", "verify"].includes(phase)) {
        profiled.add(phase); activeProfile = host!.request("profile", { phase, milliseconds: Number(option("--profile-ms") ?? 8000) }).then(value => { profiles.push(value); }, error => { failures.push(`profile: ${String(error)}`); }).finally(() => { activeProfile = undefined; });
      }
      if (progress.phase === "failed" || progress.error) throw new Error(`Migration failed: ${progress.error}`);
      const checkpoint = cursor(progress);
      if (!toggled && Number(checkpoint.snapshot_rows ?? 0) > 0 && progress.phase !== "verified") {
        config(false); await delay(1500);
        const first = cursor((await host!.request("status")).migration); await delay(1250);
        const second = cursor((await host!.request("status")).migration);
        if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("History cursor advanced while ingest=false");
        report.pauseWitness = { first, second, pausedForMs: 1250 }; toggled = true; config(true);
      }
      if (toggled && !interrupted && Number(checkpoint.copy_rows ?? 0) > 0 && progress.phase !== "verified") {
        const before = cursor(progress), snapshot = progress.snapshot;
        const stopped = await host!.request("interrupt-history");
        await delay(2250);
        const after = cursor((await host!.request("status")).migration);
        if (Number(after.copy_rows ?? 0) < Number(before.copy_rows ?? 0)) throw new Error("Importer restart lost its durable copy cursor");
        report.interruptionWitness = { before, after, snapshot, stopped }; interrupted = true;
      }
      if (progress.phase === "verified") { report.snapshot = progress.snapshot; report.verifiedProgress = progress; break; }
      await delay(250);
    }
    if (!report.verifiedProgress) throw new Error("Timed out before completed verified migration");
    if (!toggled || !interrupted) throw new Error("Rehearsal finished before both pause and importer restart witnesses; use slower --io");
    await activeProfile;
    report.phaseTimings = Object.fromEntries([...phaseStarted].map(([name, start]) => [name, { firstAt: start, lastAt: phaseEnded.get(name), observedMs: (phaseEnded.get(name) ?? start) - start }]));
    phase = "post-migration";
    report.runPoll = await host!.request("runs");
    const identity = await current[0]!.request("status");
    report.managedContinuation = await continuation(home, identity);
    const hashes: Record<string, unknown> = {};
    for (const [name, file] of [["source", join(home, "bridge.db")], ["backup", String(report.snapshot)], ["target", historyDbPath(join(home, "bridge.db"))]] as const) {
      const hash = await rawHash(file); hashes[name] = { ...hash, fileBytes: statSync(file).size, walBytes: existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0 };
      if (hash.rows !== seed.rows || hash.bytes !== seed.payloadBytes || hash.sha256 !== seed.rawSha256) throw new Error(`${name} raw history hash/count differs from seed`);
    }
    report.hashes = hashes;
    report.finalOldRunners = await Promise.all(runners.map(child => child.request("status")));
    report.success = true;
  } catch (error) { report.error = String(error); throw error; }
  finally {
    sampling = false; await sampler; await activeProfile?.catch(error => { failures.push(`profile: ${String(error)}`); });
    for (const child of [...children].reverse()) await child.stop().catch(error => { failures.push(`stop: ${String(error)}`); });
    const percentile = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) * .95)] ?? null; };
    const metrics = (group: typeof samples) => Object.fromEntries(["sendMs", "peersMs", "listRunsMs", "dashboardMs", "messageSubagentMs"].map(key => [key.replace("Ms", "P95Ms"), percentile(group.map(s => s[key as keyof typeof s]).filter((value): value is number => typeof value === "number"))]));
    const byPhase = Object.fromEntries([...new Set(samples.map(s => s.phase))].map(name => { const group = samples.filter(s => s.phase === name); return [name, { samples: group.length, ...metrics(group) }]; }));
    report.latency = { samples: samples.length, ...metrics(samples), sendMaxMs: Math.max(0, ...samples.map(s => s.sendMs)), byPhase };
    report.samples = samples; report.failures = failures; report.progress = phases; report.profiles = profiles;
    report.ownedProcessesStopped = children.every(child => child.process.exitCode !== null || child.process.signalCode !== null);
    report.finishedAt = new Date().toISOString();
    if (failures.length || Object.values(metrics(samples)).some(value => value !== null && value >= 1000) || Object.values(byPhase).some(group => Object.entries(group).some(([key, value]) => key.endsWith("P95Ms") && value !== null && value >= 1000))) report.success = false;
    writeFileSync(output, JSON.stringify(report, null, 2), { flag: "wx" }); console.log(JSON.stringify({ phase: "rehearsal-complete", output, success: report.success, latency: report.latency, failures, ownedProcessesStopped: report.ownedProcessesStopped }));
    if (!report.success) process.exitCode = 1;
  }
}

if (process.argv[1] && /release-rehearsal\.(?:mjs|ts)$/.test(process.argv[1])) {
  const main = async () => {
    const home = option("--home");
    const role = option("--role");
    if (role) { if (!home || !["old-session", "old-runner", "current-session", "lease-owner"].includes(role)) throw new Error("Unknown child role"); await childMain(physicalHome(home), role as Role, Number(option("--index") ?? 0)); return; }
    if (argumentsList.includes("--seed-only")) { if (home) throw new Error("Seeding always creates a fresh fixture; --home is execution only"); await seedRehearsal(rehearsalBytes(option("--bytes") ?? "8MiB")); return; }
    const fixture = home ? { home: physicalHome(home) } : await seedRehearsal(rehearsalBytes(option("--bytes") ?? "8MiB"));
    await rehearse(fixture.home);
  };
  void main().catch((error) => { console.error(error); process.exitCode = 1; });
}
