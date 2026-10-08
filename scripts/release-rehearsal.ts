/** Opt-in release rehearsal. Synthetic fixtures and results are retained under the checkout only.
 * Bundle with esbuild (--bundle --platform=node --format=esm --packages=external).
 * Seed: node .agent-bridge-test/release-rehearsal.mjs --seed-only --bytes 20GiB
 * Clone: node .agent-bridge-test/release-rehearsal.mjs --source-home <stopped fixture> --seed-only --io 256MiB
 * Run:  node .agent-bridge-test/release-rehearsal.mjs --home <printed fixture> --io 8MiB
 * Never included in the normal test suite at production scale.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
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
import { JobRunners } from "../src/mcp/job-host.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { createWorktree } from "../src/core/worktree.js";
import { historyDbPath, type HistoryMigrationProgress } from "../src/core/history-store.js";
import { listRuns, readDashboard } from "../src/core/dashboard-read.js";
import { worktreeLease } from "../src/core/worktree-state.js";
import type { Broker } from "../src/core/broker.js";
import type { HistoryBackground } from "../src/core/history-background.js";
import type { Worker } from "node:worker_threads";
import { startOldRunnerFixtures, continueNativeRunnerFixture, settleNativeFixtureOwners, type OldRunnerFixtures } from "./release-runner-fixture.js";
import { listMessageBackups, type MessageBackupManifest } from "../src/core/message-backups.js";
import type { BackupHealth } from "../src/core/backup-background.js";

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
function fixtureIdentities(home: string): { sessions: string[]; rootSession: string } {
  return JSON.parse(readFileSync(join(home, "rehearsal-identities.json"), "utf8"));
}
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
  const archiveBytes = await seedCorpus(home, old.JSON_STORE_VERSION);
  const seed: Seed = { schema: 1, home, oldVersion: old.APP_VERSION, oldSha, payloadBytes, rows, rawSha256: hash.digest("hex"), sourceBytes: statSync(join(home, "bridge.db")).size, archiveFiles: 307, archiveBytes, runs: 1_024, createdAt: new Date().toISOString() };
  writeFileSync(join(home, "seed.json"), JSON.stringify(seed, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ phase: "seed-complete", ...seed })); return seed;
}
async function seedCorpus(home: string, jsonVersion: number): Promise<number> {
  mkdirSync(join(home, "archive")); mkdirSync(join(home, "runs"));
  let archiveBytes = 0;
  for (let file = 0; file < 307; file++) {
    // Repeated IDs model retained duplicate archives without changing or removing any file.
    const jobs = Array.from({ length: 75 }, (_, n) => { const id = `archived-${file % 209}-${n}`; return { id, name: `codex-job-${id}`, agent: "codex", owner: "old-session-0", supervisor: "synthetic-root", status: "done", sessionId: `synthetic-${id}`, prompt: "Synthetic retained completed job. ".repeat(18), startedAt: 1_700_000_000_000, finishedAt: 1_700_000_001_000, args: { title: id }, workdir: home, worktree: null }; });
    const raw = JSON.stringify({ version: jsonVersion, jobs }); archiveBytes += Buffer.byteLength(raw);
    writeFileSync(join(home, "archive", `jobs-${1_700_000_000_000 + file}-synthetic.json`), raw, { flag: "wx" });
    if (file % 16 === 0) await delay(5);
  }
  for (let n = 0; n < 1_024; n++) {
    const name = `synthetic-run-${n}`;
    writeFileSync(join(home, "runs", `${name}.json`), JSON.stringify({ id: name, agent: "codex", model: null, prompt: "Synthetic retained run", startedAt: 1_700_000_000_000 + n, endedAt: 1_700_000_001_000 + n, status: "done", sessionId: `synthetic-session-${n}`, cwd: home, worktree: null }), { flag: "wx" });
    writeFileSync(join(home, "runs", `${name}.log`), "Synthetic retained output\n", { flag: "wx" });
    if (n % 32 === 0) await delay(5);
  }
  writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: jsonVersion, jobs: [] }), { flag: "wx" });
  return archiveBytes;
}

/** Copy only a stopped synthetic source DB+WAL into an entirely fresh namespace.
 * Original snapshots/reports/worktrees and all original table rows remain retained.
 */
export async function cloneRehearsal(sourceHome: string): Promise<Seed> {
  sourceHome = physicalHome(sourceHome);
  const original = JSON.parse(readFileSync(join(sourceHome, "seed.json"), "utf8")) as Seed;
  if (original.schema !== 1 || original.oldVersion !== "0.29.17" || original.home !== sourceHome || !/^[a-f0-9]{64}$/.test(original.rawSha256)) throw new Error("Clone source is not an identified synthetic rehearsal fixture");
  const sourceReports = (await import("node:fs")).readdirSync(sourceHome).filter(name => /^rehearsal-\d+\.json$/.test(name)).sort();
  const stopped = sourceReports.length ? JSON.parse(readFileSync(join(sourceHome, sourceReports.at(-1)!), "utf8")) : undefined;
  if (!stopped?.ownedProcessesStopped) throw new Error("Clone requires the prior rehearsal's explicit owned-process shutdown witness");
  const home = physicalHome(mkdtempSync(join(fixtureRoot, "release-rehearsal-"))); isolate(home);
  writeFileSync(join(home, "token"), token, { flag: "wx" });
  writeFileSync(join(home, "config.json"), JSON.stringify({ history: { ingest: false }, notifications: { approvals: false, finish: false, fail: false } }), { flag: "wx" });
  process.env.AGENT_BRIDGE_HISTORY_MIGRATION_IO_BYTES_PER_SECOND = String(rehearsalBytes(option("--io") ?? "256MiB"));
  const source = new DatabaseSync(join(sourceHome, "bridge.db"), { readOnly: true, timeout: 100 });
  const copied: Record<string, unknown>[] = [];
  try {
    if (Number(source.prepare("PRAGMA user_version").get()!.user_version) !== 8) throw new Error("Clone source must retain genuine old SQLite schema8");
    source.exec("BEGIN");
    const count = Number(source.prepare("SELECT count(*) n FROM conversation_records WHERE source=?").get(sourceId)!.n);
    if (count !== original.rows) throw new Error("Synthetic source row count changed before clone");
    const files = ["bridge.db", ...(existsSync(join(sourceHome, "bridge.db-wal")) ? ["bridge.db-wal"] : [])];
    const before = files.map(name => {
      const path = join(sourceHome, name);
      if (lstatSync(path).isSymbolicLink()) throw new Error("Synthetic source DB/WAL must not be linked");
      const state = statSync(path);
      return { name, size: state.size, mtimeMs: state.mtimeMs, ctimeMs: state.ctimeMs, ino: state.ino };
    });
    for (const file of before) {
      const input = await openFile(join(sourceHome, file.name), "r"), output = await openFile(join(home, file.name), "wx", 0o600);
      const buffer = Buffer.alloc(4 * 1024 * 1024), hash = createHash("sha256"), started = performance.now(); let offset = 0;
      try {
        while (offset < file.size) {
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, file.size - offset), offset);
          if (!bytesRead) throw new Error(`Synthetic source file shrank during clone: ${file.name}`);
          let written = 0;
          while (written < bytesRead) { const value = await output.write(buffer, written, bytesRead - written, offset + written); if (!value.bytesWritten) throw new Error("Synthetic clone write made no progress"); written += value.bytesWritten; }
          hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
          const rate = Number(process.env.AGENT_BRIDGE_HISTORY_MIGRATION_IO_BYTES_PER_SECOND);
          while (performance.now() - started < offset * 1000 / rate) await delay(5);
          await delay(5);
          if (offset % (256 * 1024 * 1024) === 0 || offset === file.size) console.log(JSON.stringify({ phase: "clone", home, file: file.name, copiedBytes: offset, sourceBytes: file.size }));
        }
        await output.sync(); copied.push({ name: file.name, bytes: offset, sha256: hash.digest("hex") });
      } finally { await input.close(); await output.close(); }
    }
    for (const file of before) { const after = statSync(join(sourceHome, file.name)); if (after.size !== file.size || after.mtimeMs !== file.mtimeMs || after.ctimeMs !== file.ctimeMs || after.ino !== file.ino) throw new Error("Synthetic source changed while copying its DB/WAL; partial copy retained and not used"); }
    source.exec("ROLLBACK");
    const restored = await rawHash(join(home, "bridge.db"));
    if (restored.rows !== original.rows || restored.bytes !== original.payloadBytes || restored.sha256 !== original.rawSha256) throw new Error("Fresh clone does not preserve the original synthetic source hash/count");
    const old = await oldRuntime(home), archiveBytes = await seedCorpus(home, old.JSON_STORE_VERSION);
    const seed: Seed = { ...original, home, archiveBytes, sourceBytes: statSync(join(home, "bridge.db")).size, createdAt: new Date().toISOString() };
    writeFileSync(join(home, "clone-witness.json"), JSON.stringify({ sourceHome, sourceReport: sourceReports.at(-1), copied, restored, previousSnapshotsPreserved: true, freshMigrationNamespace: true }, null, 2), { flag: "wx" });
    writeFileSync(join(home, "seed.json"), JSON.stringify(seed, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ phase: "clone-complete", ...seed })); return seed;
  } catch (error) { writeFileSync(join(home, "clone-failed.json"), JSON.stringify({ sourceHome, copied, error: String(error), stack: (error as Error).stack }), { flag: "wx" }); throw error; }
  finally { source.close(); }
}

type Reply = { rid?: string; ready?: boolean; launcherChildExit?: boolean; result?: unknown; error?: string };
type Role = "old-session" | "old-runner" | "current-session" | "lease-owner" | "session-launcher";
type NodeInternals = { broker: Broker | null; client: { request(op: string, args: unknown): Promise<unknown> } | null };
type BrokerInternals = { historyBackground: HistoryBackground | null; store: { backupStatus?: () => BackupHealth | null } };
interface FixtureChild { process: ChildProcess; role: Role; index: number; ownedChildExit?: boolean; request(op: string, data?: Record<string, unknown>): Promise<any>; stop(): Promise<void> }
const children: FixtureChild[] = [];
async function childMain(home: string, role: Role, index: number): Promise<void> {
  isolate(home);
  if (role === "session-launcher") {
    const childRole = option("--child-role");
    if (childRole !== "old-session" && childRole !== "current-session") throw new Error("Unknown owned launcher session role");
    const owned = fork(fileURLToPath(import.meta.url), ["--role", childRole, "--index", String(index), "--home", home], { cwd: checkout, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    owned.stdout?.on("data", value => process.stdout.write(value)); owned.stderr?.on("data", value => process.stderr.write(value));
    owned.on("message", value => process.send?.(value));
    process.on("message", (value: { op?: string }) => {
      if (value.op === "launcher-stop") owned.kill();
      else if (owned.connected) owned.send(value);
    });
    owned.once("exit", (code, signal) => process.send?.({ launcherChildExit: true, result: { pid: owned.pid, code, signal } }, () => process.exit(code ?? (signal ? 1 : 0))));
    return;
  }
  if (role === "lease-owner") {
    const path = option("--worktree"); if (!path || !relative(home, path) || relative(home, path).startsWith("..")) throw new Error("Lease fixture must be below the synthetic home");
    worktreeLease(home, { path }); process.send?.({ ready: true, result: { pid: process.pid } });
    setInterval(() => {}, 1000); return;
  }
  const legacy = role.startsWith("old-");
  if (!legacy) { process.env.AGENT_BRIDGE_AUTO_BACKUP = "1"; process.env.AGENT_BRIDGE_BACKUP_INTERVAL_MS = "3600000"; }
  const constructor = legacy ? (await oldRuntime(home)).BridgeNode : BridgeNode;
  const name = role === "old-runner" ? `codex-job-rehearsal-${index}` : `old-session-${index}`;
  const node = new constructor({ pipePath: resolvePipePath(home, {}), dbPath: join(home, "bridge.db"), token, agent: role === "old-runner" ? "other" : "codex", name, cwd: home, autoWake: false, log: nullLogger,
    ...(role === "old-runner" ? { canHostBroker: false, id: `job:rehearsal-${index}`, jobAgent: "codex" as const, jobParent: "old-session-0", jobOwner: fixtureIdentities(home).rootSession, rootName: "old-session-0", rootSession: fixtureIdentities(home).rootSession } : {}) });
  node.on("message", message => node.markRead([message.id]));
  const connectionWitnesses: Record<string, unknown>[] = [];
  node.on("connected", (value: { isBroker?: boolean }) => connectionWitnesses.push({ at: Date.now(), pid: process.pid, parentPid: process.ppid, name: node.name, sessionId: node.currentSessionId, isBroker: value.isBroker }));
  // Distinct synthetic sessions share this harness parent PID. Publish their known session
  // identity before hello so launch reconciliation cannot treat them as one host session.
  if (role !== "old-runner") await node.setSessionId(fixtureIdentities(home).sessions[index]!);
  await node.start();
  const internals = node as unknown as NodeInternals;
  process.send?.({ ready: true, result: { pid: process.pid, parentPid: process.ppid, name: node.name, sessionId: node.currentSessionId, version: legacy ? "0.29.17" : APP_VERSION } });
  let profiling = false;
  let outcomePolls = 0;
  let toolJobs: JobManager | undefined, subagent: string | undefined, delivered = 0, nativeTool = false;
  const callbacks = new Map<string, (args: Record<string, unknown>, extra: any) => Promise<any>>();
  let nativeAdoption: Record<string, unknown> | undefined;
  const prepareSubagent = async () => {
    if (legacy) throw new Error("Tool fixture requires a current supervisor session");
    // The hosting candidate may listen before this replacement session finishes reauthentication.
    // A real MCP tool first ensures its authenticated connection, then restores under the final name.
    await node.ensureConnected();
    if (toolJobs) return;
    const manifestFile = join(home, "native-runner-fixture", "manifest.json");
    const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : undefined;
    const lane = join(home, "mcp-tool-fixture"); mkdirSync(lane, { recursive: true });
    nativeTool = Boolean(manifest);
    toolJobs = new JobManager(node, nullLogger, manifest ? join(home, "jobs.json") : join(lane, "jobs.json"), 16, undefined, {
      canRestore: () => node.isConnected && (!manifest || node.currentSessionId === manifest.supervisor),
      canReceiveHandoff: () => node.isConnected,
    });
    if (manifest) toolJobs.runners = new JobRunners(node, home, manifest.currentCli, nullLogger);
    const fakeMcp = { registerTool: (name: string, _config: unknown, callback: (args: Record<string, unknown>, extra: any) => Promise<any>) => { callbacks.set(name, callback); } };
    registerTools(fakeMcp as Parameters<typeof registerTools>[0], { node, jobs: toolJobs, cfg: { ...DEFAULT_CONFIG, ...(manifest ? { claudeBin: manifest.claudeBin } : {}) }, home, cwd: () => home, agent: "codex", log: nullLogger, channelActive: () => false, launchKnown: Promise.resolve() } as ServerContext, []);
    await Promise.resolve();
    if (manifest) {
      subagent = manifest.descriptors[1].name;
      nativeAdoption = await settleNativeFixtureOwners(home, node, toolJobs);
      return;
    }
    const run: Run = async signal => new Promise(resolve => { signal.addEventListener("abort", () => resolve({ text: "Synthetic held run stopped", sessionId: "synthetic-held-tool-session", isError: false, details: {} }), { once: true }); });
    const job = toolJobs.start("codex", null, "Synthetic held runner; no proprietary CLI", run);
    job.live = { post: () => { delivered++; } }; subagent = job.name;
  };
  process.on("message", (raw: { rid: string; op: string; data?: Record<string, unknown> }) => {
    const answer = async (): Promise<unknown> => {
      if (raw.op === "stop") { toolJobs?.cancelAll(); await node.stop(); return { stopped: true }; }
      if (raw.op === "probe") {
        const startedAt = Date.now(), before = performance.now(), key = randomUUID(), body = `Synthetic continuity probe ${key}`;
        const connectedBeforeSend = node.isConnected;
        let sendMs = 0, probeOperation = "send";
        let acknowledgedMessageIds: string[] = [];
        try {
          const sent = await node.send({ to: "old-session-0", body, dedupeKey: key });
          sendMs = performance.now() - before;
          acknowledgedMessageIds = sent.messages.map(message => message.id);
          probeOperation = "peers";
          const at = performance.now(); await node.peers();
          return { startedAt, finishedAt: Date.now(), connectedBeforeSend, sendMs, peersMs: performance.now() - at, id: sent.messages[0]?.id, storageOutcome: { state: "stored", ids: sent.messages.map(message => message.id) } };
        } catch (error) {
          let copies: Record<string, unknown>[] = [], lookupError: string | undefined;
          try { const db = new DatabaseSync(join(home, "bridge.db"), { readOnly: true, timeout: 100 }); try { copies = db.prepare("SELECT id,recipient,read_at FROM messages WHERE body=? AND from_name=?").all(body, node.name); } finally { db.close(); } }
          catch (lookup) { lookupError = String(lookup); }
          return { startedAt, finishedAt: Date.now(), connectedBeforeSend, sendMs: sendMs || performance.now() - before, probeOperation, acknowledgedMessageIds, probeError: String(error), storageOutcome: { state: copies.length ? "stored" : "unknown", localState: copies.length ? "stored" : lookupError ? "unknown" : "not_stored", checkedAt: Date.now(), copies, lookupError, legacyOperationHasNoDurableRetryId: true } };
        }
      }
      if (raw.op === "status") {
        const broker = internals.broker as unknown as BrokerInternals | null;
        return { broker: Boolean(broker), pid: process.pid, parentPid: process.ppid, priority: getPriority(0), migration: broker?.historyBackground?.status() ?? null, backup: broker?.store?.backupStatus?.() ?? null, version: legacy ? "0.29.17" : APP_VERSION, name: node.name, id: node.id, sessionId: node.currentSessionId, connectionWitnesses };
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
          return { phase: raw.data?.phase, path, pid: process.pid, cpuMicros: process.cpuUsage(cpu), cpuScope: "process including history worker", sampleScope: "broker main thread", samples: value.profile.samples?.length ?? 0, hottestFrames: [...frames.values()].sort((a, b) => b.micros - a.micros).slice(0, 12) };
        } finally { inspector.disconnect(); profiling = false; }
      }
      if (raw.op === "runs") { const at = performance.now(); const runs = listRuns(home); return { milliseconds: performance.now() - at, count: runs.length }; }
      if (raw.op === "dashboard") {
        if (!internals.broker || legacy) throw new Error("Dashboard poll must execute on the current broker main thread");
        const dashboardStartedAt = Date.now();
        const at = performance.now(), runs = listRuns(home), listRunsMs = performance.now() - at, pollAt = performance.now();
        const listRunsFinishedAt = Date.now();
        // These are distinct production requests; let pending mail run between them.
        await delay(0);
        const value = await readDashboard({ home, log: nullLogger, peers: () => node.peers() }, { path: "/api/state" });
        if (value.status !== 200 || runs.length < 1000) throw new Error("Dashboard fixture did not load its retained run corpus");
        return { dashboardStartedAt, listRunsFinishedAt, dashboardFinishedAt: Date.now(), listRunsMs, dashboardMs: performance.now() - pollAt, runCount: runs.length };
      }
      if (raw.op === "message-subagent" || raw.op === "tool-preflight") {
        await prepareSubagent(); const at = performance.now(), before = delivered;
        if (raw.op === "tool-preflight") {
          const known = toolJobs!.find(subagent!);
          return { name: node.name, sessionId: node.currentSessionId, target: subagent, targetKnown: Boolean(known), owner: known?.owner, status: known?.status, adoption: nativeAdoption };
        }
        const value = await callbacks.get("message_subagent")!({ job: subagent!, message: "Synthetic sustained tool probe" }, {});
        if (value.isError || !nativeTool && delivered !== before + 1) throw new Error(`Actual message_subagent handler did not deliver: ${JSON.stringify({ value, name: node.name, sessionId: node.currentSessionId, target: subagent, adoption: nativeAdoption, targetRecord: toolJobs!.hookJobs().find(job => job.name === subagent), knownJobs: toolJobs!.hookJobs().map(job => ({ name: job.name, owner: job.owner, status: job.status })) })}`);
        return { messageSubagentMs: performance.now() - at, delivered, actualRegisteredHandler: true, genuineOldJobRunner: nativeTool, syntheticCli: nativeTool, fakeHeldRunner: !nativeTool, proprietaryCliLaunched: false };
      }
      if (raw.op === "native-continuation") {
        if (legacy || node.currentSessionId !== fixtureIdentities(home).sessions[0]) throw new Error("Native continuation requires its retained current supervisor session");
        return continueNativeRunnerFixture({ checkout, home, node, index: 0 });
      }
      if (raw.op === "outcomes") {
        if (legacy || !internals.broker) throw new Error("Outcome polling requires the current broker main thread");
        const fixture = JSON.parse(readFileSync(join(home, "outcome-fixture.json"), "utf8")), run = fixture.runs[outcomePolls++ % fixture.runs.length];
        const at = performance.now(), value = await readDashboard({ home, log: nullLogger, peers: () => node.peers() }, { path: "/api/job-outcomes", query: { run } });
        if (value.status !== 200) throw new Error("Finished-run outcome fixture could not be loaded");
        const outcome = (value.body as { runs: Record<string, { observation?: { state?: string } }> }).runs[run];
        return { outcomesMs: performance.now() - at, outcomeObservation: outcome?.observation?.state ?? "missing", run };
      }
      throw new Error(`Unknown rehearsal operation ${raw.op}`);
    };
    void answer().then(result => {
      process.send?.({ rid: raw.rid, result }, () => { if (raw.op === "stop") process.exit(0); });
    }, error => process.send?.({ rid: raw.rid, error: String(error) }));
  });
}
async function startChild(home: string, role: Role, index: number, extra: string[] = []): Promise<FixtureChild> {
  const wrapped = role === "old-session" || role === "current-session";
  const processChild = fork(fileURLToPath(import.meta.url), ["--home", home, "--role", wrapped ? "session-launcher" : role, ...(wrapped ? ["--child-role", role] : []), "--index", String(index), ...extra], { cwd: checkout, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  const waiters = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const child: FixtureChild = {
    process: processChild, role, index,
    request: (op, data) => new Promise((resolve, reject) => {
      const rid = randomUUID(), timer = setTimeout(() => { waiters.delete(rid); reject(new Error(`Owned ${role} ${index} request timed out: ${op}`)); }, op === "profile" ? 30_000 : op === "native-continuation" ? 180_000 : 60_000);
      waiters.set(rid, { resolve, reject, timer }); processChild.send({ rid, op, data }, error => { if (error) { clearTimeout(timer); waiters.delete(rid); reject(error); } });
    }),
    stop: async () => { if (processChild.exitCode !== null || processChild.signalCode !== null) return; try { await child.request("stop"); } catch { if (wrapped && processChild.connected) processChild.send({ op: "launcher-stop" }); else if (processChild.exitCode === null) processChild.kill(); } await until(() => processChild.exitCode !== null || processChild.signalCode !== null, 15_000); },
  };
  children.push(child);
  const output = { stdout: "", stderr: "" };
  for (const key of ["stdout", "stderr"] as const) processChild[key]?.on("data", data => { output[key] = (output[key] + String(data)).slice(-65_536); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Owned ${role} did not start: ${output.stderr}`)), 90_000);
    processChild.on("message", (message: Reply) => {
      if (message.launcherChildExit) { child.ownedChildExit = true; return; }
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
const checkpointReadWitnesses: Record<string, unknown>[] = [];
export async function readRehearsalCursor(progress: Pick<HistoryMigrationProgress, "snapshot">, retryMs = 3000): Promise<Record<string, unknown>> {
  if (!progress.snapshot || !existsSync(`${progress.snapshot}.progress.db`)) return {};
  const path = `${progress.snapshot}.progress.db`, started = performance.now(); let attempts = 0;
  while (true) {
    let db: DatabaseSync | undefined;
    try {
      attempts++; db = new DatabaseSync(path, { readOnly: true, timeout: 100 });
      const value = db.prepare("SELECT generation,snapshot_after,snapshot_rows,snapshot_verify_after,snapshot_verify_rows,copy_after,copy_rows,verify_after,verify_rows FROM table_state WHERE table_name='conversation_records'").get() ?? {};
      if (attempts > 1) checkpointReadWitnesses.push({ path, attempts, elapsedMs: performance.now() - started, recovered: true });
      return value;
    } catch (error) {
      if (!/database is (?:locked|busy)/i.test(String(error))) throw error;
      if (performance.now() - started >= retryMs) {
        checkpointReadWitnesses.push({ path, attempts, elapsedMs: performance.now() - started, recovered: false, error: String(error) });
        throw new Error(`Checkpoint inspection remained busy after ${attempts} bounded read attempts: ${path}`, { cause: error });
      }
    } finally { db?.close(); }
    await delay(50);
  }
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
  const identities = { sessions: [0, 1].map(index => `synthetic-session-${randomUUID()}-${index}`), rootSession: `synthetic-root-${randomUUID()}` };
  writeFileSync(join(home, "rehearsal-identities.json"), JSON.stringify(identities), { flag: "wx" });
  const outcomeRuns = Array.from({ length: 5 }, (_, index) => `synthetic-finished-${randomUUID()}-${index}`);
  for (const name of outcomeRuns) {
    writeFileSync(join(home, "runs", `${name}.json`), JSON.stringify({ job: `codex-job-${name}`, jobStartedAt: 1_700_000_000_000, startedAt: 1_700_000_000_000, by: "old-session-0", workdir: home }), { flag: "wx" });
    writeFileSync(join(home, "runs", `${name}.log`), `10:00:00 codex by old-session-0 in ${home}, access read\nSynthetic retained finished run\n---\n10:00:01 finished after 1s · done\n`, { flag: "wx" });
  }
  writeFileSync(join(home, "outcome-fixture.json"), JSON.stringify({ runs: outcomeRuns }), { flag: "wx" });
  const output = join(home, `rehearsal-${Date.now()}.json`);
  const workerOutput = join(dirname(fileURLToPath(import.meta.url)), "history-worker.mjs");
  await build({ entryPoints: [join(checkout, "src/core/history-worker.ts")], outfile: workerOutput, bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", logLevel: "silent" });
  await build({ entryPoints: [join(checkout, "src/core/backup-worker.ts")], outfile: join(dirname(workerOutput), "backup-worker.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", logLevel: "silent" });
  await build({ entryPoints: [join(checkout, "src/core/outcome-worker.ts")], outfile: join(dirname(workerOutput), "outcome-worker.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", logLevel: "silent" });
  process.env.AGENT_BRIDGE_HISTORY_MIGRATION_IO_BYTES_PER_SECOND = String(rehearsalBytes(option("--io") ?? "8MiB"));
  const samples: { at: number; phase: string; sendMs: number; peersMs: number; listRunsMs?: number; dashboardMs?: number; messageSubagentMs?: number; outcomesMs?: number; outcomeObservation?: string }[] = [], failures: string[] = [], phases: { at: number; progress: HistoryMigrationProgress; cursor: Record<string, unknown> }[] = [];
  const report: Record<string, unknown> = { schema: 1, seed, currentVersion: APP_VERSION, runtimeSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"), workerSha256: createHash("sha256").update(readFileSync(workerOutput)).digest("hex"), sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8", windowsHide: true }).trim(), fixtureOnly: true, ownerDataAccessed: false, success: false, mainPriority: getPriority(0), startedAt: new Date().toISOString(), oldRunnerCount: 10, limitations: ["Old runner fixtures use genuine 0.29.17 BridgeNode job identities, not proprietary CLI turns", "Managed continuation uses actual JobManager.restore with a synthetic Run", "message_subagent uses the actual registered guarded MCP handler and a held synthetic Run without an MCP transport", "Current sessions join before old sessions retire; broker transition latency and errors are measured rather than a zero-gap socket guarantee"] };
  let sampling = false, sampler: Promise<void> | undefined, phase = "old-baseline";
  let samplingInvariantFailures = 0, fatalSamplingError: Error | undefined;
  const profiles: unknown[] = []; let activeProfile: Promise<void> | undefined;
  let pollingHost: FixtureChild | undefined;
  let toolSession: FixtureChild | undefined;
  let native: OldRunnerFixtures | undefined;
  const backupProgress: { at: number; phase: string; backup: BackupHealth }[] = [];
  try {
    const oldSessions = [await startChild(home, "old-session", 0), await startChild(home, "old-session", 1)];
    const runners: FixtureChild[] = [];
    for (let i = 0; i < 10; i++) { runners.push(await startChild(home, "old-runner", i)); await delay(250); }
    native = await startOldRunnerFixtures({ checkout, home, count: 11, owner: "old-session-0", rootSession: identities.rootSession, supervisor: identities.sessions[0] });
    report.nativeOldRunners = native.assertLive(); report.oldProtocolIdentityCount = 10; report.oldRunnerCount = 11;
    report.limitations = ["Native fixtures run genuine old/current JobRunner source with synthetic Claude CLI; no proprietary CLI launches", "Sustained message_subagent invokes the actual registered guarded MCP handler without an MCP transport", "Separate dead-lease continuation uses actual JobManager.restore with a synthetic Run", "Current sessions join before old sessions retire; broker transition latency/errors remain strict phase gates"];
    sampling = true;
    sampler = (async () => {
      while (sampling) {
        try {
          const sampledPhase = phase;
          const probe = await runners[0]!.request("probe");
          if (probe.probeError) failures.push(`${sampledPhase}: ${probe.probeError}; storage outcome ${JSON.stringify(probe.storageOutcome)}`);
          const sample = { at: Date.now(), phase: sampledPhase, ...probe };
          samples.push(sample);
          if (pollingHost) {
            Object.assign(sample, await pollingHost.request("dashboard"));
            Object.assign(sample, await toolSession!.request("message-subagent"));
            Object.assign(sample, await pollingHost.request("outcomes"));
          }
          samplingInvariantFailures = 0;
        }
        catch (error) {
          failures.push(`${phase}: ${String(error)}`);
          if (/No subagent named|Native supervisor identity is unsettled/.test(String(error)) && ++samplingInvariantFailures >= 3) {
            fatalSamplingError = new Error(`Repeated native ownership invariant failed; measurements are invalid: ${String(error)}`);
            return;
          }
        }
        await delay(250);
      }
    })();
    await delay(1000);
    phase = "sessions-reload";
    const reloadAt = performance.now();
    const current = [await startChild(home, "current-session", 0), await startChild(home, "current-session", 1)];
    report.handoffCandidates = await Promise.all(current.map(child => child.request("status")));
    const retirementStartedAt = Date.now();
    await Promise.all(oldSessions.map(child => child.stop()));
    const oldCoordinatorsStoppedAt = Date.now();
    let host: FixtureChild | undefined;
    await until(async () => { for (const child of current) if ((await child.request("status")).broker) { host = child; return true; } return false; });
    report.brokerRecoveryMs = performance.now() - reloadAt;
    const hostStatus = await host!.request("status"); report.brokerPid = hostStatus.pid;
    report.listenerHandoff = { retirementStartedAt, oldCoordinatorsStoppedAt, currentBrokerObservedAt: Date.now(), current: await Promise.all(current.map(child => child.request("status"))), hostConnections: hostStatus.connectionWitnesses };
    report.coldDashboard = await host!.request("dashboard"); report.warmDashboard = await host!.request("dashboard");
    report.nativeToolPreflight = await current[0]!.request("tool-preflight");
    if (!(report.nativeToolPreflight as { targetKnown: boolean }).targetKnown) throw new Error(`Native tool target is not restored after authenticated reload: ${JSON.stringify(report.nativeToolPreflight)}`);
    toolSession = current[0]; pollingHost = host;
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
      if (fatalSamplingError) throw fatalSamplingError;
      if (runners.some(child => child.process.exitCode !== null || child.process.signalCode !== null)) throw new Error("A genuine old runner died during the migration rehearsal; inspect retained child evidence");
      native.assertLive();
      const status = await host!.request("status"), progress = status.migration as HistoryMigrationProgress;
      if (status.backup) backupProgress.push({ at: Date.now(), phase, backup: status.backup });
      if (!progress) throw new Error("New broker has no history monitor");
      phase = progress.phase; const signature = `${progress.phase}:${progress.completedRows}:${progress.paused}`;
      if (!phaseStarted.has(phase)) phaseStarted.set(phase, Date.now()); phaseEnded.set(phase, Date.now());
      if (signature !== lastProgress) {
        lastProgress = signature; const point = { at: Date.now(), progress, cursor: await readRehearsalCursor(progress) }; phases.push(point);
        console.log(JSON.stringify({ phase: "migration", progress, cursor: point.cursor }));
      }
      if (!activeProfile && !profiled.has(phase) && ["snapshot", "copy", "verify"].includes(phase)) {
        profiled.add(phase); activeProfile = host!.request("profile", { phase, milliseconds: Number(option("--profile-ms") ?? 8000) }).then(value => { profiles.push(value); }, error => { failures.push(`profile: ${String(error)}`); }).finally(() => { activeProfile = undefined; });
      }
      if (progress.phase === "failed" || progress.error) throw new Error(`Migration failed: ${progress.error}`);
      const checkpoint = await readRehearsalCursor(progress);
      if (!toggled && Number(checkpoint.snapshot_rows ?? 0) > 0 && progress.phase !== "verified") {
        config(false); await delay(1500);
        const first = await readRehearsalCursor((await host!.request("status")).migration); await delay(1250);
        const second = await readRehearsalCursor((await host!.request("status")).migration);
        if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("History cursor advanced while ingest=false");
        report.pauseWitness = { first, second, pausedForMs: 1250 }; toggled = true; config(true);
      }
      if (toggled && !interrupted && Number(checkpoint.copy_rows ?? 0) > 0 && progress.phase !== "verified") {
        const before = await readRehearsalCursor(progress), snapshot = progress.snapshot;
        const stopped = await host!.request("interrupt-history");
        await delay(2250);
        const after = await readRehearsalCursor((await host!.request("status")).migration);
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
    await until(async () => {
      if (fatalSamplingError) throw fatalSamplingError;
      native!.assertLive(); const status = await host!.request("status");
      if (status.backup) backupProgress.push({ at: Date.now(), phase, backup: status.backup });
      if (status.backup?.phase === "failed") throw new Error(`Automatic message backup failed: ${status.backup.lastError}`);
      return Boolean(status.backup?.lastVerifiedAt);
    }, 180_000);
    const automatic = listMessageBackups(home)[0]; if (!automatic) throw new Error("Automatic daily backup verified without a published message manifest");
    const manifest = JSON.parse(readFileSync(join(automatic.path, "manifest.json"), "utf8")) as MessageBackupManifest;
    const backupBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
    if (manifest.kind !== "message-tables" || !manifest.excludes.includes("conversation-history") || backupBytes > 8 * 1024 * 1024) throw new Error("Automatic daily backup copied unrelated synthetic history or exceeded its message fixture bound");
    const allowed = new Set(["messages", "archived_messages", "job_delivery_routes"]);
    for (const file of manifest.files) {
      const path = physicalHome(join(automatic.path, file.path));
      if (statSync(path).size !== file.bytes || createHash("sha256").update(readFileSync(path)).digest("hex") !== file.sha256) throw new Error("Automatic daily backup file hash/bytes failed");
      const db = new DatabaseSync(path, { readOnly: true });
      try { if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().some(row => !allowed.has(String(row.name)))) throw new Error("Automatic daily backup contains a non-message table"); }
      finally { db.close(); }
    }
    report.automaticDailyBackup = { path: automatic.path, bytes: backupBytes, manifest, conversationHistoryAbsent: true };
    report.runPoll = await host!.request("runs");
    const identity = await current[0]!.request("status");
    report.managedContinuation = await continuation(home, identity);
    report.nativeBeforeContinuation = native.assertLive();
    if (!samples.some(sample => sample.outcomeObservation === "ready")) throw new Error("Finished-run outcome worker remained pending without any fresh observation");
    if (!native.inspect()[1]?.receivedLive.length) throw new Error("Actual guarded message_subagent did not reach the genuine old native runner's synthetic CLI");
    report.nativeContinuation = await current[0]!.request("native-continuation");
    const hashes: Record<string, unknown> = {};
    for (const [name, file] of [["source", join(home, "bridge.db")], ["backup", String(report.snapshot)], ["target", historyDbPath(join(home, "bridge.db"))]] as const) {
      const hash = await rawHash(file); hashes[name] = { ...hash, fileBytes: statSync(file).size, walBytes: existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0 };
      if (hash.rows !== seed.rows || hash.bytes !== seed.payloadBytes || hash.sha256 !== seed.rawSha256) throw new Error(`${name} raw history hash/count differs from seed`);
    }
    report.hashes = hashes;
    report.finalOldRunners = await Promise.all(runners.map(child => child.request("status")));
    report.success = true;
  } catch (error) { report.error = String(error); report.errorStack = (error as Error).stack; throw error; }
  finally {
    sampling = false; await sampler; await activeProfile?.catch(error => { failures.push(`profile: ${String(error)}`); });
    if (native) await native.stop().catch(error => { failures.push(`native stop: ${String(error)}`); });
    for (const child of [...children].reverse()) await child.stop().catch(error => { failures.push(`stop: ${String(error)}`); });
    const percentile = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(sorted.length * .95) - 1] ?? null; };
    const metrics = (group: typeof samples) => Object.fromEntries(["sendMs", "peersMs", "listRunsMs", "dashboardMs", "messageSubagentMs", "outcomesMs"].map(key => [key.replace("Ms", "P95Ms"), percentile(group.map(s => s[key as keyof typeof s]).filter((value): value is number => typeof value === "number"))]));
    const byPhase = Object.fromEntries([...new Set(samples.map(s => s.phase))].map(name => { const group = samples.filter(s => s.phase === name); return [name, { samples: group.length, ...metrics(group) }]; }));
    report.latency = { samples: samples.length, percentileMethod: "nearest rank", ...metrics(samples), sendMaxMs: Math.max(0, ...samples.map(s => s.sendMs)), peersMaxMs: Math.max(0, ...samples.map(s => s.peersMs)), byPhase };
    report.samples = samples; report.failures = failures; report.progress = phases; report.profiles = profiles; report.backupProgress = backupProgress;
    report.checkpointReadWitnesses = checkpointReadWitnesses;
    report.ownedProcessesStopped = children.every(child => (child.process.exitCode !== null || child.process.signalCode !== null) && (!(child.role === "old-session" || child.role === "current-session") || child.ownedChildExit === true)) && (!native || native.inspect().every(info => info.status !== "running"));
    report.finishedAt = new Date().toISOString();
    if (!report.ownedProcessesStopped || failures.length || Object.values(metrics(samples)).some(value => value !== null && value >= 1000) || Object.values(byPhase).some(group => Object.entries(group).some(([key, value]) => key.endsWith("P95Ms") && value !== null && value >= 1000))) report.success = false;
    writeFileSync(output, JSON.stringify(report, null, 2), { flag: "wx" }); console.log(JSON.stringify({ phase: "rehearsal-complete", output, success: report.success, latency: report.latency, failures, ownedProcessesStopped: report.ownedProcessesStopped }));
    if (!report.success) process.exitCode = 1;
  }
}

if (process.argv[1] && /release-rehearsal\.(?:mjs|ts)$/.test(process.argv[1])) {
  const main = async () => {
    const home = option("--home");
    const sourceHome = option("--source-home");
    const role = option("--role");
    if (role) { if (!home || !["old-session", "old-runner", "current-session", "lease-owner", "session-launcher"].includes(role)) throw new Error("Unknown child role"); await childMain(physicalHome(home), role as Role, Number(option("--index") ?? 0)); return; }
    if (home && sourceHome) throw new Error("Choose existing --home or fresh --source-home clone");
    if (argumentsList.includes("--seed-only")) { if (home) throw new Error("Seeding always creates a fresh fixture; --home is execution only"); if (sourceHome) await cloneRehearsal(sourceHome); else await seedRehearsal(rehearsalBytes(option("--bytes") ?? "8MiB")); return; }
    const fixture = home ? { home: physicalHome(home) } : sourceHome ? await cloneRehearsal(sourceHome) : await seedRehearsal(rehearsalBytes(option("--bytes") ?? "8MiB"));
    await rehearse(fixture.home);
  };
  void main().catch((error) => { console.error(error); process.exitCode = 1; });
}
