/** AB-206 opt-in native rehearsal. Generates and retains only checkout-local data. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeNode } from "../src/core/node.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { nullLogger } from "../src/core/logger.js";
import { readDashboard } from "../src/core/dashboard-read.js";
import { writeJsonStore } from "../src/core/json-store.js";
import { archiveIndexCounters, readIndexedJobs, readJobVersions } from "../src/core/job-archive-index.js";
import { extractBundle } from "../src/core/archive-bundle.js";
import type { JobArchiveBackground } from "../src/core/job-archive-background.js";

const root = join(process.cwd(), ".agent-bridge-test"); mkdirSync(root, { recursive: true });
const home = mkdtempSync(join(root, "ab206-rehearsal-")), archive = join(home, "archive"); mkdirSync(archive);
const digest = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const originalHashes = new Map<string, string>();
const retained = Array.from({ length: 309 }, (_, id) => ({ id: `fixture-${id}`, name: `codex-job-fixture-${id}`,
  status: "done", owner: "fixture-owner", startedAt: 1, finishedAt: 2, prompt: "Synthetic retained context. ".repeat(80) }));
for (let i = 0; i < 5000; i++) {
  const name = `jobs-${1700000000000 + i}-fixture.json`;
  const raw = JSON.stringify({ version: 4, jobs: Array.from({ length: 25 }, (_, n) => retained[(i + n) % retained.length]) }) + "\n";
  writeFileSync(join(archive, name), raw); originalHashes.set(name, digest(raw));
}
const path = join(home, "jobs.json"); writeFileSync(path, '{"version":4,"jobs":[]}\n');
process.env.AGENT_BRIDGE_HISTORY_INGEST = "false"; process.env.AGENT_BRIDGE_BACKUP_INTERVAL_MS = "0";
const node = new BridgeNode({ name: "fixture-owner", agent: "claude", cwd: home, pipePath: resolvePipePath(home, {}),
  dbPath: resolveDbPath(home), token: loadOrCreateToken(home), autoWake: false, log: nullLogger });
const times: number[] = [], accepted: Record<string, unknown>[] = [], rejected: string[] = [];
try {
  await node.start();
  for (let i = 0; i < 50; i++) {
    const job = { ...retained[0], id: "writer", name: "codex-job-writer", revision: i };
    try { writeJsonStore(path, { version: 4, jobs: [job] }, { version: 4, jobs: accepted.length ? [accepted.at(-1)!] : [] }); accepted.push(job); }
    catch (error) { rejected.push(String(error)); }
    const started = performance.now();
    await node.peers();
    const result = await readDashboard({ home, log: nullLogger, peers: () => [] }, { path: "/api/state" });
    if (result.status !== 200) throw new Error(`fixture dashboard failed: ${result.status}`);
    times.push(performance.now() - started);
  }
  const worker = (node as unknown as { broker: { jobArchiveBackground: JobArchiveBackground } }).broker.jobArchiveBackground;
  await worker.finished;
  const cold = join(home, "cold-storage", "jobs-v1"), manifests = readdirSync(cold).filter(name => name.endsWith(".manifest.json"));
  const restored = new Map<string, Buffer>();
  for (const manifest of manifests) for (const [name, bytes] of extractBundle(join(cold, manifest))) restored.set(name, bytes);
  for (const [name, hash] of originalHashes) if (digest(restored.get(name)!) !== hash || digest(readFileSync(join(cold, "archive-originals", name))) !== hash) throw new Error("legacy round-trip mismatch");
  const versions = readJobVersions(path, "writer");
  if (accepted.some(job => !versions.some(version => digest(JSON.stringify(version)) === digest(JSON.stringify(job))))) throw new Error("accepted fixture update missing");
  readIndexedJobs(path, { metadata: true });
  await readDashboard({ home, log: nullLogger, peers: () => [] }, { path: "/api/state" });
  const reads = { ...archiveIndexCounters };
  for (let i = 0; i < 30; i++) { await node.peers(); await readDashboard({ home, log: nullLogger, peers: () => [] }, { path: "/api/state" }); }
  const steadyDecoded = archiveIndexCounters.decoded - reads.decoded;
  const cpu = process.cpuUsage(), idleStarted = performance.now(); await delay(2000);
  const elapsed = performance.now() - idleStarted, usage = process.cpuUsage(cpu);
  const cpuPercent = (usage.user + usage.system) / (elapsed * 1000) * 100;
  const memoryBytes = process.platform === "win32" ? Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${process.pid}).PrivateMemorySize64`], { encoding: "utf8", windowsHide: true }).trim()) : process.memoryUsage().rss;
  const p95 = times.sort((a, b) => a - b)[Math.ceil(times.length * .95) - 1]!;
  const evidence = { home, files: 5000, jobs: 309, acceptedUpdates: accepted.length, rejectedUpdates: rejected,
    p95Ms: p95, maxMs: times.at(-1), steadyDecoded, memoryBytes, memoryKind: process.platform === "win32" ? "private" : "rss", idleCpuPercent: cpuPercent,
    originalsVerified: restored.size, accepted: p95 < 1000 && steadyDecoded === 0 && memoryBytes < 250 * 1024 * 1024 && cpuPercent < 5 && !rejected.length };
  writeFileSync(join(home, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
  if (!evidence.accepted) process.exitCode = 1;
} finally { await node.stop(); }
