import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existingMetadataDb, metadataDb, saveMetadataValue } from "../src/core/metadata-db.js";
import { readProcessIdentity } from "../src/core/process-identity.js";
import { refreshStorePeerIdentities } from "../src/core/store-compatibility.js";
import { importMetadataDomain, readRetainedMetadataFile } from "../src/core/metadata-import.js";
import {
  importRunnerFiles, legacyRunnerPeers, publishRunnerSpec, readPendingRunnerSpec, readRunnerStateRecord, resetRunnerStoreCache,
  runnerFilesImported, runnerStoreStats, takeRunnerSpec, writeRunnerStateRecord,
} from "../src/core/runner-store.js";
import { readRunnerState, writeRunnerState } from "../src/mcp/job-host.js";
import { JobArchiveBackground } from "../src/core/job-archive-background.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

/** Every fs call that touches a path under `<home>/jobs` while a test counts. */
const io = vi.hoisted(() => ({ counting: false, calls: [] as string[] }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const wrap = <T extends (...args: never[]) => unknown>(name: string, fn: T) => ((...args: Parameters<T>) => {
    if (io.counting && typeof args[0] === "string" && /[\\/]jobs(?:[\\/]|$)/.test(args[0])) io.calls.push(`${name} ${args[0]}`);
    return fn(...args);
  }) as T;
  return { ...fs, readFileSync: wrap("readFileSync", fs.readFileSync), readdirSync: wrap("readdirSync", fs.readdirSync), statSync: wrap("statSync", fs.statSync),
    lstatSync: wrap("lstatSync", fs.lstatSync), existsSync: wrap("existsSync", fs.existsSync), openSync: wrap("openSync", fs.openSync) };
});

let env: TestEnv;
const children: ChildProcess[] = [];
beforeEach(() => { env = makeEnv(); resetRunnerStoreCache(); io.counting = false; io.calls = []; });
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  resetRunnerStoreCache();
  await env.cleanup();
});

const jobs = () => join(env.home, "jobs");
/** An empty home with the store created and its (empty) runner import complete. */
async function ready(): Promise<void> {
  metadataDb(env.home);
  expect(await importRunnerFiles(env.home)).toMatchObject({ deferred: false, remaining: 0 });
  expect(runnerFilesImported(env.home)).toBe(true);
}
const state = (pid: number, updatedAt: number, extra: Record<string, unknown> = {}) => ({ pid, peer: "codex-job-a", status: "running", updatedAt, ...extra });

/** A live process recorded as an older (0.30.0) bridge reader, as the store capability gate sees it. */
async function oldRunnerProcess(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  children.push(child);
  await new Promise(resolve => child.once("spawn", resolve));
  importMetadataDomain(env.home, "storage-capabilities");
  const identity = await readProcessIdentity(child.pid!);
  saveMetadataValue(env.home, "storage-capabilities", String(child.pid), { schemaVersion: 1, json: 4, sqlite: 9, pid: child.pid, name: "old-runner", version: "0.30.0", explicit: true, observedAt: Date.now(), ...(identity ? { processIdentity: identity } : {}) });
  await refreshStorePeerIdentities(env.home);
  resetRunnerStoreCache();
  return child;
}

async function stop(child: ChildProcess): Promise<void> {
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill();
  await exited;
  resetRunnerStoreCache();
}

function coldFiles(): Map<string, Buffer> {
  const out = new Map<string, Buffer>(), root = join(env.home, "cold", "originals");
  if (!existsSync(root)) return out;
  const visit = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) visit(path);
      else out.set(path.slice(root.length + 1).split(sep).slice(1).join("/"), readFileSync(path));
    }
  };
  visit(root);
  return out;
}

it("imports runner files byte-exact into a verified bundle, rows and cold storage", async () => {
  mkdirSync(join(jobs(), "archive"), { recursive: true });
  const files: Record<string, string> = {
    "jobs/a.json": JSON.stringify(state(101, 1_000, { status: "done", report: "final", future: { kept: true } }), null, 2) + "\n",
    "jobs/a.spec.json": JSON.stringify({ version: 4, cwd: env.home, job: { id: "a", name: "codex-job-a" }, unknown: [1, 2] }),
    "jobs/archive/a.json-123-0f0f": JSON.stringify(state(99, 500, { status: "done" })),
    "jobs/archive/a.spec.json-123-0f0f": JSON.stringify({ version: 4, cwd: env.home, earlier: true }),
    "jobs/b.json": "{ not json but kept äöü",
    "jobs/b.json.corrupt-1-x": "\u0000\u0001binary-ish",
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(env.home, path), text);

  const result = await importRunnerFiles(env.home);
  expect(result).toMatchObject({ imported: 6, deferred: false, remaining: 0 });
  expect(runnerFilesImported(env.home)).toBe(true);
  // Nothing is left in the scanned folder; every original sits byte-identical in cold storage and in the bundle.
  expect(readdirSync(jobs()).filter(name => name !== "archive")).toEqual([]);
  expect(readdirSync(join(jobs(), "archive"))).toEqual([]);
  const cold = coldFiles();
  for (const [path, text] of Object.entries(files)) {
    expect(cold.get(path)?.equals(Buffer.from(text))).toBe(true);
    expect(readRetainedMetadataFile(env.home, path)?.equals(Buffer.from(text))).toBe(true);
  }
  // Rows carry the projection, unknown fields included.
  expect(readRunnerStateRecord(env.home, "a")).toEqual(state(101, 1_000, { status: "done", report: "final", future: { kept: true } }));
  expect(readPendingRunnerSpec(env.home, "a")).toMatchObject({ unknown: [1, 2], job: { id: "a" } });
  const db = existingMetadataDb(env.home)!;
  expect(db.prepare("SELECT COUNT(*) AS n FROM bridge_metadata WHERE domain IN ('job-state-archive','job-spec-archive')").get()!.n).toBe(2);
  expect(db.prepare("SELECT COUNT(*) AS n FROM bridge_imports WHERE path LIKE 'jobs/%'").get()!.n).toBe(6);
});

it("polls imported rows without touching a single runner file", async () => {
  await ready();
  writeRunnerState(env.home, "poll", state(process.pid, Date.now(), { progress: "working" }) as never);
  const before = { ...runnerStoreStats };
  io.counting = true;
  for (let i = 0; i < 50; i++) expect(readRunnerState(env.home, "poll")?.progress).toBe("working");
  for (let i = 0; i < 10; i++) expect(readPendingRunnerSpec(env.home, "poll")).toBeNull();
  writeRunnerState(env.home, "poll", state(process.pid, Date.now(), { progress: "later" }) as never);
  expect(readRunnerState(env.home, "poll")?.progress).toBe("later");
  io.counting = false;
  expect(io.calls).toEqual([]);
  expect(runnerStoreStats.fileReads).toBe(before.fileReads);
  expect(runnerStoreStats.rowReads).toBeGreaterThan(before.rowReads);
  expect(existsSync(join(jobs(), "poll.json"))).toBe(false);
});

it("keeps a file projection for a live older runner and never loses the state it writes", async () => {
  await ready();
  const old = await oldRunnerProcess();
  expect(legacyRunnerPeers(env.home)).toBe(true);
  // The gate reopens the file paths: they must be imported again after the old process is gone.
  expect(runnerFilesImported(env.home)).toBe(false);

  // A new runner keeps the file an old server reads.
  writeRunnerState(env.home, "mixed", state(4242, 1_000, { progress: "new runner" }) as never);
  expect(JSON.parse(readFileSync(join(jobs(), "mixed.json"), "utf8"))).toMatchObject({ pid: 4242, progress: "new runner", version: 4 });

  // An older runner (another turn) rewrites its whole file; the row takes it and archives the earlier runner's row.
  writeFileSync(join(jobs(), "mixed.json"), JSON.stringify(state(old.pid!, 2_000, { progress: "old runner" })));
  expect(readRunnerState(env.home, "mixed")).toMatchObject({ pid: old.pid, progress: "old runner" });
  expect(readRunnerState(env.home, "mixed")?.reportId).toBeUndefined();
  const db = existingMetadataDb(env.home)!;
  expect(JSON.parse(String(db.prepare("SELECT value FROM bridge_metadata WHERE domain='job-state' AND key='mixed'").get()!.value))).toMatchObject({ progress: "old runner" });
  expect(db.prepare("SELECT COUNT(*) AS n FROM bridge_metadata WHERE domain='job-state-archive' AND key LIKE 'mixed/%'").get()!.n).toBe(1);

  // Its final write lands after the last poll; then it exits.
  const final = state(old.pid!, 3_000, { status: "done", report: "old final", delivered: true });
  writeFileSync(join(jobs(), "mixed.json"), JSON.stringify(final));
  await stop(old);
  expect(legacyRunnerPeers(env.home)).toBe(false);
  // Not imported yet: readers still check this job's file and take the final state.
  expect(readRunnerState(env.home, "mixed")).toMatchObject({ status: "done", report: "old final" });

  const result = await importRunnerFiles(env.home);
  expect(result).toMatchObject({ deferred: false, remaining: 0 });
  expect(runnerFilesImported(env.home)).toBe(true);
  expect(existsSync(join(jobs(), "mixed.json"))).toBe(false);
  expect(readRunnerState(env.home, "mixed")).toMatchObject({ status: "done", report: "old final", delivered: true });
  expect([...coldFiles().values()].some(raw => raw.equals(Buffer.from(JSON.stringify(final))))).toBe(true);
});

it("defers the import while an older process lives and leaves its files in place", async () => {
  mkdirSync(jobs(), { recursive: true });
  writeFileSync(join(jobs(), "held.json"), JSON.stringify(state(1, 1)));
  expect(await importRunnerFiles(env.home)).toMatchObject({ imported: 1, deferred: false });
  const old = await oldRunnerProcess();
  writeFileSync(join(jobs(), "later.json"), JSON.stringify(state(2, 2)));
  const result = await importRunnerFiles(env.home);
  expect(result.deferred).toBe(true);
  expect(existsSync(join(jobs(), "later.json"))).toBe(true);
  await stop(old);
  expect(await importRunnerFiles(env.home)).toMatchObject({ deferred: false, remaining: 0 });
  expect(readRunnerState(env.home, "later")).toMatchObject({ pid: 2 });
});

it("resumes an import interrupted between batches or before its file moves, without loss or duplicates", async () => {
  mkdirSync(jobs(), { recursive: true });
  const originals = new Map<string, string>();
  for (let i = 0; i < 7; i++) {
    const text = JSON.stringify(state(1_000 + i, 10 + i, { n: i }));
    originals.set(`jobs/j${i}.json`, text);
    writeFileSync(join(jobs(), `j${i}.json`), text);
  }
  // Crash after the first committed batch.
  await expect(importRunnerFiles(env.home, { batch: 3, afterBatch: () => { throw new Error("simulated crash"); } })).rejects.toThrow("simulated crash");
  expect(runnerFilesImported(env.home)).toBe(false);
  expect(readdirSync(jobs()).filter(name => name.endsWith(".json"))).toHaveLength(4);
  // Every state stays readable meanwhile: rows for the imported batch, files for the rest.
  for (let i = 0; i < 7; i++) expect(readRunnerState(env.home, `j${i}`)).toMatchObject({ pid: 1_000 + i, n: i });

  // Crash after the import transaction but before a file reached cold storage: put one original back.
  const cold = join(env.home, "cold", "originals");
  const batchDir = readdirSync(cold)[0]!;
  const moved = readdirSync(join(cold, batchDir, "jobs"))[0]!;
  renameSync(join(cold, batchDir, "jobs", moved), join(jobs(), moved));

  expect(await importRunnerFiles(env.home, { batch: 3 })).toMatchObject({ deferred: false, remaining: 0 });
  expect(runnerFilesImported(env.home)).toBe(true);
  expect(readdirSync(jobs()).filter(name => name.endsWith(".json"))).toEqual([]);
  const db = existingMetadataDb(env.home)!;
  expect(db.prepare("SELECT COUNT(*) AS n FROM bridge_imports WHERE path LIKE 'jobs/%'").get()!.n).toBe(7);
  const restored = coldFiles();
  for (const [path, text] of originals) {
    expect(restored.get(path)?.toString()).toBe(text);
    expect(readRetainedMetadataFile(env.home, path)?.toString()).toBe(text);
  }
  for (let i = 0; i < 7; i++) expect(readRunnerState(env.home, `j${i}`)).toMatchObject({ pid: 1_000 + i, n: i });
});

it("publishes a turn's spec as a row, hands it to the runner once and archives the previous turn", async () => {
  await ready();
  mkdirSync(jobs(), { recursive: true });
  const path = publishRunnerSpec(env.home, "turn", { home: env.home, job: { id: "turn" }, cwd: env.home });
  expect(path).toBe(join(jobs(), "turn.spec.json"));
  expect(existsSync(path)).toBe(false);
  expect(readPendingRunnerSpec(env.home, "turn")).toMatchObject({ cwd: env.home, version: 4 });
  expect(takeRunnerSpec(path)).toMatchObject({ home: env.home, job: { id: "turn" } });
  expect(readPendingRunnerSpec(env.home, "turn")).toBeNull();
  expect(takeRunnerSpec(path)).toBeNull();
  writeRunnerStateRecord(env.home, "turn", state(7, 50, { status: "done", reportId: "first" }));
  expect(readRunnerState(env.home, "turn")).toMatchObject({ reportId: "first" });
  // The next turn must not see the previous turn's final state; both are archived rows.
  publishRunnerSpec(env.home, "turn", { home: env.home, job: { id: "turn" }, cwd: env.home, second: true });
  expect(readRunnerState(env.home, "turn")).toBeNull();
  writeRunnerStateRecord(env.home, "turn", state(8, Date.now()));
  expect(readRunnerState(env.home, "turn")).not.toHaveProperty("reportId");
  const db = existingMetadataDb(env.home)!;
  expect(db.prepare("SELECT COUNT(*) AS n FROM bridge_metadata WHERE domain='job-state-archive' AND key LIKE 'turn/%'").get()!.n).toBe(1);
  expect(db.prepare("SELECT COUNT(*) AS n FROM bridge_metadata WHERE domain='job-spec-archive' AND key LIKE 'turn/%'").get()!.n).toBe(1);
});

it("still runs a spec file written by an older server or a fixture", () => {
  mkdirSync(jobs(), { recursive: true });
  const file = join(jobs(), "legacy.spec.json");
  writeFileSync(file, JSON.stringify({ version: 4, home: env.home, job: { id: "legacy" } }));
  expect(takeRunnerSpec(file)).toMatchObject({ job: { id: "legacy" } });
  expect(existsSync(file)).toBe(false);
  expect(readdirSync(join(jobs(), "archive"))).toHaveLength(1);
});

it("imports runner files in the broker's background worker, off the broker thread", async () => {
  vi.stubEnv("AGENT_BRIDGE_RUNNER_IMPORT_DELAY_MS", "0");
  mkdirSync(jobs(), { recursive: true });
  const raw = JSON.stringify(state(55, 5, { status: "done", report: "kept" }));
  writeFileSync(join(jobs(), "bg.json"), raw);
  const background = new JobArchiveBackground(join(env.home, "jobs.json"), nullLogger);
  try {
    const end = Date.now() + 60_000;
    while (!runnerFilesImported(env.home) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
  } finally { await background.close(); vi.unstubAllEnvs(); }
  expect(runnerFilesImported(env.home)).toBe(true);
  expect(existsSync(join(jobs(), "bg.json"))).toBe(false);
  expect(readRetainedMetadataFile(env.home, "jobs/bg.json")?.toString()).toBe(raw);
  expect(readRunnerState(env.home, "bg")).toMatchObject({ pid: 55, report: "kept" });
});

it("does not treat a reused PID of a gone older reader as a live legacy process", async () => {
  await ready();
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  children.push(child);
  await new Promise(resolve => child.once("spawn", resolve));
  importMetadataDomain(env.home, "storage-capabilities");
  // The recorded generation is another process that once had this PID.
  saveMetadataValue(env.home, "storage-capabilities", String(child.pid), { schemaVersion: 1, json: 4, sqlite: 9, pid: child.pid, name: "gone-runner", version: "0.30.0", explicit: true, observedAt: Date.now(), processIdentity: "1" });
  // The OS identity query can be slow under load; until it answers, the reader conservatively counts as old.
  let legacy = true;
  for (let attempt = 0; legacy && attempt < 20; attempt++) {
    await refreshStorePeerIdentities(env.home);
    resetRunnerStoreCache();
    legacy = legacyRunnerPeers(env.home);
  }
  expect(legacy).toBe(false);
  expect(await importRunnerFiles(env.home)).toMatchObject({ deferred: false });
  expect(runnerFilesImported(env.home)).toBe(true);
});
