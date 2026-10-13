import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readArchivedJobs } from "../src/core/job-archive.js";
import * as jobArchive from "../src/core/job-archive.js";
import { openJobArchive, readJobVersions } from "../src/core/job-archive-index.js";
import { writeJsonStore } from "../src/core/json-store.js";
import { nullLogger, type Logger } from "../src/core/logger.js";
import { recordStorePeer } from "../src/core/store-compatibility.js";
import { JobManager, readStore } from "../src/mcp/jobs.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
const managers: JobManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.setDormant(true);
  if (env) await env.cleanup();
  env = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function records(owner: string, index: number) {
  return [0, 1].map(turn => ({
    id: `fixture-${index}-${turn}`, name: `codex-job-fixture-${index}-${turn}`,
    agent: "codex", model: null, owner, prompt: "isolated archive regression",
    status: "done", startedAt: 1 + index * 2 + turn, finishedAt: 100,
    sessionId: null, workdir: null, worktree: null, host: null,
    args: { title: "fixture", future: { nullable: null, flags: [false, 0, ""] } },
    futureEnvelope: { retain: true, nested: { value: "original" } },
    queuedMessages: [], deliveryHistory: [],
  }));
}

function archiveRows(path: string) {
  const db = openJobArchive(path)!;
  try { return db.prepare("SELECT id,sha256,payload,observed_at FROM job_versions ORDER BY id,sha256").all(); }
  finally { db.close(); }
}

it("does not republish unchanged persisted records across ten sessions; retains changed accepted bytes", async () => {
  vi.stubEnv("AGENT_BRIDGE_JOB_STORE_LIMIT", "1");
  vi.stubEnv("AGENT_BRIDGE_ARCHIVE_AGE_MS", "1");
  env = makeEnv();
  const path = join(env.home, "jobs.json");
  const nodes = Array.from({ length: 10 }, (_, i) => env!.node(`archive-session-${i}`, "codex"));
  // Sequential connections to the owned fixture broker, never the live endpoint.
  for (const node of nodes) await node.start();
  const seeded = nodes.flatMap((node, i) => records(node.name, i));
  writeJsonStore(path, { jobs: seeded }, null);
  // Observe invocations while executing the real durable archive implementation.
  const archiveCalls = vi.spyOn(jobArchive, "archiveJobs");
  let publications = 0;
  const warnings: string[] = [];
  const log: Logger = { ...nullLogger,
    info(message) { if (message === "archived finished jobs") publications++; },
    warn(message) { warnings.push(message); }, child() { return this; },
  };
  nodes.forEach(node => {
    const manager = new JobManager(node, log, path);
    managers.push(manager);
    manager.restore(() => undefined);
    for (const record of seeded.filter(record => record.owner === node.name)) {
      expect(manager.setTitle(record.name, "fixture")).toBe(true);
    }
    manager.persist();
  });
  expect(readArchivedJobs(path)).toHaveLength(20);
  expect(warnings).toEqual([]);
  const before = archiveRows(path);
  const publishedBefore = publications;
  const callsBefore = archiveCalls.mock.calls.length;
  const durations: number[] = [];
  // Profiling attaches only to this CI-owned test process and its fixture broker.
  // Local regression runs do not open an inspector or collect load profiles.
  const profileDir = process.env.AB319_PROFILE_DIR;
  if (profileDir && process.env.CI !== "true") throw new Error("AB319 profiling requires an isolated CI runner");
  const inspector = profileDir ? new Session() : undefined;
  if (inspector) {
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const cpu = process.cpuUsage(), started = performance.now();
  try {
    for (let round = 0; round < 20; round++) for (const manager of managers) {
      const at = performance.now();
      manager.persist();
      durations.push(performance.now() - at);
    }
  } finally {
    const elapsedMs = performance.now() - started, cpuMicros = process.cpuUsage(cpu);
    if (inspector) {
      const { profile } = await inspector.post("Profiler.stop");
      inspector.disconnect();
      mkdirSync(resolve(profileDir!), { recursive: true });
      writeFileSync(join(profileDir!, "archive-persist.cpuprofile"), JSON.stringify(profile));
      writeFileSync(join(profileDir!, "archive-persist.json"), JSON.stringify({
        scope: "isolated JobManager unchanged persist loop; not overall P0 acceptance",
        revision: process.env.GITHUB_SHA, sessions: 10, jobs: 20, rounds: 20,
        persistCalls: durations.length, storeLimit: 1, archiveAgeMs: 1,
        archivePublications: publications - publishedBefore, elapsedMs, cpuMicros,
        archiveCalls: archiveCalls.mock.calls.length - callsBefore,
        immutableVersionsBefore: before.length, immutableVersionsAfter: archiveRows(path).length,
        persistDurationsMs: durations, warnings,
      }, null, 2) + "\n");
    }
  }
  // Rows can remain identical even when needless transactions are repeated.
  expect(archiveRows(path)).toEqual(before);
  expect(warnings).toEqual([]);
  expect(publications - publishedBefore).toBe(0);
  expect(archiveCalls.mock.calls.length - callsBefore).toBe(0);

  const target = seeded[0]!;
  const versionsBefore = readJobVersions(path, target.id);
  const original = readArchivedJobs(path).find(record => record.id === target.id)!;
  expect(original.futureEnvelope).toEqual(target.futureEnvelope);
  expect(managers[0]!.setSettings(target.name, {
    model: "changed-model",
  })).toBe(true);
  const modelVersions = readJobVersions(path, target.id);
  expect(modelVersions).toHaveLength(versionsBefore.length + 1);
  const modelChanged = readArchivedJobs(path).find(record => record.id === target.id)!;
  expect(modelVersions).toContainEqual(modelChanged);
  // New accepted fields arrive from a compatible writer's active projection.
  const accepted = { ...readArchivedJobs(path).find(record => record.id === target.id)!,
    futureEnvelope: { retain: true, nested: { value: "changed", added: [null, false, 0] } },
    newAcceptedField: { exact: "new bytes" },
  };
  const previous = JSON.parse(readFileSync(path, "utf8"));
  writeJsonStore(path, { ...previous, jobs: [accepted] }, previous);
  expect(readJobVersions(path, target.id)).toHaveLength(modelVersions.length + 1);
  managers[0]!.persist();
  const changed = readArchivedJobs(path).find(record => record.id === target.id)!;
  expect(changed.model).toBe("changed-model");
  expect(changed.futureEnvelope).toEqual(accepted.futureEnvelope);
  expect(changed.newAcceptedField).toEqual(accepted.newAcceptedField);
  const versions = readJobVersions(path, target.id);
  for (const version of [...versionsBefore, accepted]) expect(versions).toContainEqual(version);
  expect(versions).toContainEqual(changed);
  expect(versions).toHaveLength(modelVersions.length + 1);
  expect(readStore(path, undefined, true).find(record => record.id === target.id)).toEqual(changed);
  const afterChange = archiveRows(path), publishedAfterChange = publications;
  managers[0]!.persist();
  expect(archiveRows(path)).toEqual(afterChange);
  expect(publications).toBe(publishedAfterChange);
  expect(warnings).toEqual([]);
});

it("keeps live compatibility rows while suppressing identical archive publications", () => {
  vi.stubEnv("AGENT_BRIDGE_JOB_STORE_LIMIT", "1");
  vi.stubEnv("AGENT_BRIDGE_ARCHIVE_AGE_MS", "1");
  env = makeEnv();
  const path = join(env.home, "jobs.json"), node = env.node("compatibility-owner", "codex");
  const seeded = records(node.name, 0);
  writeJsonStore(path, { jobs: seeded }, null);
  const archiveCalls = vi.spyOn(jobArchive, "archiveJobs");
  // This is a real, currently alive process with old reader capabilities in the
  // isolated fixture. Do not force removal of its compatibility projection.
  recordStorePeer(env.home, { pid: process.pid, name: "fixture-legacy-reader", version: "0.30.0",
    storeCapabilities: { json: 4, sqlite: 9 } }, { authoritative: true });
  let publications = 0;
  const warnings: string[] = [];
  const log: Logger = { ...nullLogger, child() { return this; },
    info(message) { if (message === "archived finished jobs") publications++; },
    warn(message) { warnings.push(message); },
  };
  const manager = new JobManager(node, log, path);
  managers.push(manager);
  manager.restore(() => undefined);
  expect(manager.setTitle(seeded[0]!.name, "fixture")).toBe(true);
  manager.persist();
  const before = archiveRows(path), publishedBefore = publications;
  const callsBefore = archiveCalls.mock.calls.length;
  for (let i = 0; i < 3; i++) manager.persist();
  expect(archiveRows(path)).toEqual(before);
  expect(JSON.parse(readFileSync(path, "utf8")).jobs.map((record: { id: string }) => record.id).sort())
    .toEqual(seeded.map(record => record.id).sort());
  expect(readStore(path, undefined, true)).toHaveLength(2);
  expect(warnings).toEqual([]);
  expect(publications).toBe(publishedBefore);
  expect(archiveCalls.mock.calls.length).toBe(callsBefore);
});
