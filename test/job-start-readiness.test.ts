import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import { readPendingRunnerSpec } from "../src/core/runner-store.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { APP_VERSION } from "../src/core/constants.js";
import * as identity from "../src/core/process-identity.js";
import { assertStoreUpgrade, liveStorePeers, recordStorePeer, refreshStorePeerIdentities } from "../src/core/store-compatibility.js";
import { JobRunners } from "../src/mcp/job-host.js";
import type { Job } from "../src/mcp/jobs.js";
import type { BridgeNode } from "../src/core/node.js";
import { until } from "./helpers.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn }));
let home: string;
let nextPid = process.pid + 1_000_000;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "abrdy-"));
  vi.spyOn(process, "kill").mockReturnValue(true);
  spawn.mockReset().mockImplementation(() => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), pid: 123, unref() {} }));
  vi.spyOn(identity, "readProcessIdentities").mockImplementation(async pids => new Map(pids.map(pid => [pid, `generation-${pid}`])));
});
afterEach(() => { closeMetadataDbs(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
function peer(json = 4) {
  const pid = ++nextPid;
  mkdirSync(join(home, "storage-capabilities"), { recursive: true });
  const value = { schemaVersion: 1, pid, name: `runner-${pid}`, version: APP_VERSION, explicit: true, json, sqlite: 9, processIdentity: `generation-${pid}` };
  writeFileSync(join(home, "storage-capabilities", `${pid}.json`), JSON.stringify(value));
  return value;
}
function job(id: string): Job {
  return { id, name: `codex-job-${id}`, agent: "codex", prompt: "retained prompt", owner: "owner", model: null,
    startedAt: Date.now(), controller: new AbortController(), queue: [], status: "running", progress: null, sessionId: null, workdir: home, worktree: null };
}
function args() { return { target: "codex" as const, args: { prompt: "retained prompt", title: "Readiness" }, base: { prompt: "retained prompt", title: "Readiness" }, owner: "owner", byAgent: "codex" as const, cwd: home, cfg: DEFAULT_CONFIG }; }
function runners() { return new JobRunners({} as BridgeNode, home, "fixture-cli", nullLogger); }

it("primes a cold identical explicit observation without rewriting its authoritative bytes", async () => {
  const value = peer(); const path = join(home, "storage-capabilities", `${value.pid}.json`), bytes = readFileSync(path);
  recordStorePeer(home, { pid: value.pid, name: value.name, version: value.version, storeCapabilities: { json: 4, sqlite: 9 } });
  await refreshStorePeerIdentities(home);
  expect(identity.readProcessIdentities).toHaveBeenCalledWith([value.pid]);
  expect(liveStorePeers(home)).toMatchObject([{ pid: value.pid, json: 4 }]);
  expect(readFileSync(path)).toEqual(bytes);
});

it("warms a cold second runner and an expired cache before writing each detached specification", async () => {
  const first = peer(); const host = runners();
  expect(await host.startAsync(job("first"), args())).not.toBeNull();
  const second = peer();
  expect(await host.startAsync(job("second"), args())).not.toBeNull();
  expect(identity.readProcessIdentities).toHaveBeenCalledWith([second.pid]);
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 10_001);
  expect(await host.startAsync(job("third"), args())).not.toBeNull();
  expect(identity.readProcessIdentities).toHaveBeenCalledWith([first.pid, second.pid]);
  expect(spawn).toHaveBeenCalledTimes(3);
  for (const id of ["first", "second", "third"]) expect(readPendingRunnerSpec(home, id)).toMatchObject({ version: 4, job: { id } });
});

it("an awaited refresh covers a PID added while the first batch is in flight", async () => {
  const first = peer(); let release!: (value: Map<number, string>) => void;
  vi.mocked(identity.readProcessIdentities).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const warm = refreshStorePeerIdentities(home);
  const second = peer(); const joined = refreshStorePeerIdentities(home);
  release(new Map([[first.pid, first.processIdentity]]));
  await Promise.all([warm, joined]);
  expect(liveStorePeers(home)).toMatchObject([{ pid: first.pid, json: 4 }, { pid: second.pid, json: 4 }]);
  expect(identity.readProcessIdentities).toHaveBeenCalledWith([second.pid]);
});

it("a reused PID's newly published incompatible reader cannot disappear behind the old identity TTL", async () => {
  const value = peer(), path = join(home, "storage-capabilities", `${value.pid}.json`);
  await refreshStorePeerIdentities(home); expect(liveStorePeers(home)[0]?.json).toBe(4);
  let release!: (value: Map<number, string>) => void;
  vi.mocked(identity.readProcessIdentities).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const replacement = { ...value, json: 3, version: "0.29.12", processIdentity: `reused-generation-${value.pid}` };
  writeFileSync(path, JSON.stringify(replacement));
  expect(liveStorePeers(home)).toMatchObject([{ pid: value.pid, json: 0 }]);
  expect(() => assertStoreUpgrade(home, "json", 3, 4)).toThrow("Waiting to upgrade");
  release(new Map([[value.pid, replacement.processIdentity]])); await refreshStorePeerIdentities(home);
  expect(liveStorePeers(home)).toMatchObject([{ pid: value.pid, json: 3 }]);
  expect(() => assertStoreUpgrade(home, "json", 3, 4)).toThrow("Waiting to upgrade");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(replacement);
});

it("requeries a generation republished during an in-flight OS identity scan", async () => {
  const value = peer(), path = join(home, "storage-capabilities", `${value.pid}.json`);
  let release!: (value: Map<number, string>) => void;
  vi.mocked(identity.readProcessIdentities).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValueOnce(new Map([[value.pid, "replacement-generation"]]));
  const warm = refreshStorePeerIdentities(home);
  writeFileSync(path, JSON.stringify({ ...value, json: 3, processIdentity: "replacement-generation" }));
  release(new Map([[value.pid, value.processIdentity]])); await warm;
  expect(identity.readProcessIdentities).toHaveBeenCalledTimes(2);
  expect(liveStorePeers(home)).toMatchObject([{ pid: value.pid, json: 3 }]);
});

it("genuinely incompatible readers wait visibly without archiving previous turn files or falling back inline", async () => {
  peer(3); const host = runners(), turn = job("held");
  mkdirSync(join(home, "jobs"), { recursive: true });
  for (const file of ["held.json", "held.spec.json"]) writeFileSync(join(home, "jobs", file), JSON.stringify({ version: 4, retained: file }));
  const before = readFileSync(join(home, "jobs", "held.spec.json"));
  const outcome = host.startAsync(turn, args()); const rejected = expect(outcome).rejects.toMatchObject({ name: "AbortError", cause: { message: "cancelled admission" } });
  await until(() => Boolean(turn.progress?.startsWith("queued: Waiting to upgrade")));
  expect(spawn).not.toHaveBeenCalled(); expect(existsSync(join(home, "jobs", "archive"))).toBe(false);
  expect(readFileSync(join(home, "jobs", "held.spec.json"))).toEqual(before);
  turn.controller.abort(new Error("cancelled admission")); await rejected;
});

it("aborts a never-resolving identity query promptly and never launches after its late completion", async () => {
  const value = peer(); let release!: (value: Map<number, string>) => void;
  vi.mocked(identity.readProcessIdentities).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const turn = job("cancelled"), host = runners();
  const outcome = host.startAsync(turn, args()); const rejected = expect(outcome).rejects.toThrow("cancelled admission");
  await until(() => Boolean(release)); turn.controller.abort(new Error("cancelled admission")); await rejected;
  release(new Map([[value.pid, value.processIdentity]])); await refreshStorePeerIdentities(home);
  expect(spawn).not.toHaveBeenCalled(); expect(existsSync(join(home, "jobs", "cancelled.spec.json"))).toBe(false);
});
