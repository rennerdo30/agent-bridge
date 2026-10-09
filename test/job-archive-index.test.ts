import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { archiveJobs, readArchivedJobs, readArchivedJobSnapshot } from "../src/core/job-archive.js";
import { archiveIndexCounters, openJobArchive, readIndexedJobs, readJobVersions } from "../src/core/job-archive-index.js";
import { migrateJobArchives } from "../src/core/job-archive-migration.js";
import { extractBundle } from "../src/core/archive-bundle.js";
import { writeJsonStore } from "../src/core/json-store.js";
import { readHistoryJobs, selectHistoryJobs } from "../src/core/run-history.js";
import { recordStorePeer } from "../src/core/store-compatibility.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const discovery = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readdirSync: (...args: Parameters<typeof fs.readdirSync>) => { discovery.calls.push(String(args[0])); return fs.readdirSync(...args); } };
});
let env: TestEnv, path: string;
beforeEach(() => { env = makeEnv(); path = join(env.home, "jobs.json"); });
afterEach(async () => { await env.cleanup(); });
const job = { id: "one", name: "codex-job-one", owner: "owner", status: "done", startedAt: 1, prompt: "private fixture prompt", future: { keep: true } };

it("writes only changed per-job rows and retains every distinct version without archive copies", () => {
  const original = { version: 4, jobs: [job] };
  writeJsonStore(path, original, null);
  for (let i = 0; i < 10; i++) writeJsonStore(path, original, original);
  const changed = { ...job, future: { keep: false } };
  writeJsonStore(path, { version: 4, jobs: [changed] }, original);
  expect(readJobVersions(path, job.id)).toEqual([job, changed]);
  expect(readArchivedJobs(path)).toEqual([changed]);
  expect(readdirSync(env.home).filter(n => n === "archive")).toEqual([]);
  expect(readdirSync(join(env.home, ".migration-snapshots"))).toHaveLength(1);
  const db = openJobArchive(path)!;
  try {
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_records").get()!.n).toBe(1);
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
    expect(db.prepare("SELECT typeof(payload) AS storage FROM job_versions").all().every(row => row.storage === "text")).toBe(true);
    expect(JSON.parse(String(db.prepare("SELECT job_json FROM current_jobs WHERE id=?").get(job.id)!.job_json))).toEqual(changed);
  }
  finally { db.close(); }
});

it("retains same-turn completion authority and stale record bytes in version history", () => {
  const done = { ...job, completionReceipt: { version: 1 } }, stale = { ...job, status: "running" };
  archiveJobs(path, [done]); archiveJobs(path, [stale]);
  expect(readArchivedJobs(path)).toEqual([done]);
  expect(readJobVersions(path, job.id)).toEqual([done, stale]);
  const continued = { ...stale, startedAt: 2 }; archiveJobs(path, [continued]);
  expect(readArchivedJobs(path)).toEqual([continued]);
});

it("imports 5000 copies once, verifies every byte and moves originals outside poll discovery", async () => {
  const dir = join(env.home, "archive"); mkdirSync(dir);
  const originals = new Map<string, string>();
  for (let i = 0; i < 5000; i++) {
    const name = `jobs-${1000 + i}-fixture.json`, raw = JSON.stringify({ version: 4, jobs: [{ ...job, prompt: "retained ".repeat(1000), revision: i % 7 }] }) + "\n";
    writeFileSync(join(dir, name), raw); originals.set(name, raw);
  }
  const result = await migrateJobArchives(path);
  expect(result).toMatchObject({ imported: 5000, moved: 5000, kept: 0, deferred: false });
  expect(readJobVersions(path, job.id)).toHaveLength(7);
  expect(readArchivedJobs(path)[0]!.revision).toBe(4999 % 7);
  const restored = extractBundle(result.manifests[0]!);
  for (const [name, raw] of originals) {
    expect(restored.get(name)!.toString()).toBe(raw);
    expect(readFileSync(join(env.home, "cold-storage", "jobs-v1", "archive-originals", name), "utf8")).toBe(raw);
  }
  expect(readdirSync(dir)).toEqual([]);
  readArchivedJobSnapshot(path, { metadata: true }); selectHistoryJobs(env.home, new Set([job.name]));
  discovery.calls = []; const before = { ...archiveIndexCounters };
  for (let i = 0; i < 30; i++) {
    expect(readArchivedJobSnapshot(path, { metadata: true }).jobs).toHaveLength(1);
    expect(selectHistoryJobs(env.home, new Set([job.name])).size).toBe(1);
  }
  expect(discovery.calls).toEqual([]); expect(archiveIndexCounters).toEqual(before);
  expect(await migrateJobArchives(path)).toMatchObject({ imported: 0, moved: 0 });
});

it("keeps older readers' files and resumes cold retirement after their gate clears", async () => {
  const dir = join(env.home, "archive"); mkdirSync(dir);
  const file = join(dir, "jobs-1-fixture.json"), raw = JSON.stringify({ version: 4, jobs: [job] }); writeFileSync(file, raw);
  recordStorePeer(env.home, { pid: process.pid, name: "old-reader", version: "0.30.0", storeCapabilities: { json: 4, sqlite: 9 } });
  expect(await migrateJobArchives(path)).toMatchObject({ deferred: true, moved: 0 });
  expect(readFileSync(file, "utf8")).toBe(raw); expect(readArchivedJobs(path)).toEqual([job]);
  recordStorePeer(env.home, { pid: process.pid, name: "new-reader", version: "0.30.4", storeCapabilities: { json: 4, sqlite: 9, jobArchive: 1 } }, { authoritative: true });
  expect(await migrateJobArchives(path)).toMatchObject({ deferred: false, moved: 1 });
});

it("leaves damaged originals in place and resumes verified import after repair", async () => {
  const dir = join(env.home, "archive"); mkdirSync(dir);
  const file = join(dir, "jobs-1-fixture.json"); writeFileSync(file, "damaged-owner-fixture");
  await expect(migrateJobArchives(path)).rejects.toThrow(); expect(readFileSync(file, "utf8")).toBe("damaged-owner-fixture");
  writeFileSync(file, JSON.stringify({ version: 4, jobs: [job] }));
  expect(await migrateJobArchives(path)).toMatchObject({ moved: 1 }); expect(readHistoryJobs(env.home).get(job.name)).toEqual(job);
});

it("selects only requested IDs and invalidates warm selections after an external write", () => {
  archiveJobs(path, [job, { ...job, id: "huge", name: "codex-job-huge", prompt: "x".repeat(5_000_000) }]);
  const before = archiveIndexCounters.decoded;
  const selected = readIndexedJobs(path, { ids: new Set([job.id]) });
  expect(archiveIndexCounters.decoded - before).toBe(1); expect(selected.jobs).toEqual([job]);
  archiveJobs(path, [{ ...job, owner: "new-owner" }]);
  expect(readIndexedJobs(path, { ids: new Set([job.id]) }).jobs[0]!.owner).toBe("new-owner");
});
