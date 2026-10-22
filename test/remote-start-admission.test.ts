import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import * as delegate from "../src/core/delegate.js";
import * as identity from "../src/core/process-identity.js";
import * as worktree from "../src/core/worktree.js";
import { APP_VERSION, PROTOCOL_VERSION } from "../src/core/constants.js";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { MessageStore } from "../src/core/store.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { refreshStorePeerIdentities } from "../src/core/store-compatibility.js";
import { nullLogger } from "../src/core/logger.js";
import { JobRunners, readRunnerState, writeRunnerState } from "../src/mcp/job-host.js";
import type { RunnerControl } from "../src/mcp/jobs.js";
import { RemoteJobs } from "../src/network/remote-jobs.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { until } from "./helpers.js";
import { fixtureRemotePeer } from "./owned-mail.js";
vi.mock("../src/core/usage.js", async original => ({ ...await original<typeof import("../src/core/usage.js")>(), checkUsagePreflight: async () => ({ type: "allow", reason: "fixture: provider probes outside storage admission contract" }) }));

let home: string, remote: RemoteJobs;
let nextPid = process.pid + 2_000_000;
const pair = { id: "pair", name: "paired" } as any;
const peer = { id: "supervisor", name: "sender", supervisor: "session" };
let control: ReturnType<typeof vi.fn<(record: { owner: string; name: string; id: string }, control: RunnerControl) => Promise<void>>>;
beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-remote-admission-")));
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 4, maxJobs: 16,
    network: { ...DEFAULT_NETWORK_CONFIG, remoteJobs: { enabled: true, allowRoots: [home], agents: ["codex"], allowPeers: ["paired"] } } }));
  vi.spyOn(delegate, "bundledCli").mockReturnValue("fixture-cli");
  vi.spyOn(delegate, "pidAlive").mockReturnValue(false);
  vi.spyOn(worktree, "gitDirsOutside").mockResolvedValue([]);
  control = vi.fn(async () => {});
  remote = new RemoteJobs({ registerExtension() {}, peers: () => [fixtureRemotePeer(home, pair, { ...peer, sessionId: peer.supervisor })] } as any, home, nullLogger, control);
});
afterEach(() => { closeMetadataDbs(); remote.close(); vi.useRealTimers(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
function request(id: string, prompt = "retained prompt") { return { op: "spawn", job: id, target: "codex", args: { cwd: home, prompt, title: "Queued" } } as const; }
function handle(request: unknown) { return (remote as any).handle(pair, peer, request) as Promise<any>; }
function neverQuery() {
  const pid = ++nextPid; mkdirSync(join(home, "storage-capabilities"));
  writeFileSync(join(home, "storage-capabilities", `${pid}.json`), JSON.stringify({ schemaVersion: 1, pid, name: "current-reader", version: APP_VERSION,
    explicit: true, json: 4, sqlite: 9, processIdentity: `generation-${pid}` }));
  let resolve!: (ids: Map<number, string>) => void;
  vi.spyOn(identity, "readProcessIdentities").mockImplementation(() => new Promise(ready => { resolve = ready; }));
  return { started: () => Boolean(resolve), release: async () => { resolve(new Map([[pid, `generation-${pid}`]])); await refreshStorePeerIdentities(home); } };
}
const host = { pid: null, peer: "detached-fixture", startedAt: Date.now() };

it("refuses unsettled remote terminal snapshots and continuation before stripping pending evidence", async () => {
  const start = vi.spyOn(JobRunners.prototype, "startAsync").mockResolvedValue(host);
  const id = "1234abcd";
  await handle(request(id));
  const state = { pid: process.pid, peer: `codex-job-${id}`, status: "done" as const, updatedAt: Date.now(),
    report: "Exact final held behind original note", reportId: "original-final-id", delivered: false,
    pendingDeliveryRetention: [{ messageId: "11111111-1111-4111-8111-111111111111", record: "Exact original note and intent" }],
    deliveryRetentionFailure: "attempts-exhausted" as const };
  writeRunnerState(home, id, state);
  const original = readFileSync(join(home, "remote-jobs.json"));
  await expect((remote as any).handle(pair, { ...peer, supervisor: "replacement-session" }, { op: "state", job: id })).rejects.toThrow("Remote job belongs to another supervisor");
  await expect(handle({ op: "state", job: id })).rejects.toThrow("Remote runner retention is unsettled");
  await expect(handle(request(id, "must not replace pending evidence"))).rejects.toThrow("Remote runner retention is unsettled");
  expect(start).toHaveBeenCalledOnce(); expect(readRunnerState(home, id)).toMatchObject(state);
  expect(readFileSync(join(home, "remote-jobs.json"))).toEqual(original);
  writeRunnerState(home, id, { ...state, pendingDeliveryRetention: [], deliveryRetentionFailure: undefined });
  expect(await handle({ op: "state", job: id })).toMatchObject({ alive: false, state: { report: state.report, reportId: state.reportId, delivered: false } });
});

it("retains admitted paired-host job authority when the local job registry has no copy", async () => {
  vi.spyOn(JobRunners.prototype, "startAsync").mockResolvedValue(host);
  await handle(request("1234abcd"));
  const record = remote.jobForRegistration("1234abcd")!, originalParent = `${pair.name}/${peer.name}`;
  expect(record.supervisor).toBe(`${pair.id}/${peer.supervisor}`);
  const token = loadOrCreateToken(home), pipe = resolvePipePath(home, {});
  const store = new MessageStore(resolveDbPath(home), nullLogger), broker = new Broker(pipe, store, nullLogger, token, Date.now, join(home, "jobs.json"));
  const clients: BridgeClient[] = [];
  try {
    await broker.listen(); (broker as any).remoteJobs = remote;
    const reader = await BridgeClient.connect(pipe, nullLogger); clients.push(reader);
    await reader.request("hello", { protocol: PROTOCOL_VERSION, token, peer: { id: "reader", name: "local-reader", agent: "codex", cwd: home,
      pid: process.pid, agentPid: null, sessionId: "local-session", startedAt: Date.now(), autoWake: false } });
    const runner = await BridgeClient.connect(pipe, nullLogger); clients.push(runner);
    await runner.request("hello", { protocol: PROTOCOL_VERSION, token, peer: { id: "job:1234abcd", name: String(record.name), agent: "other", jobAgent: "codex",
      jobOwner: record.supervisor, jobParent: originalParent, cwd: home, pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false } });
    expect(existsSync(join(home, "jobs.json"))).toBe(false);
    const sent = await runner.request("trackedSend", { messageId: "11111111-1111-4111-8111-111111111111", to: "local-reader", body: "Explicit local context from admitted remote-owned job" });
    expect(sent.messages).toHaveLength(1);
    expect((await reader.request("pending", {})).map(m => m.id)).toContain(sent.messages[0]!.id);
    expect(store.jobRoutingGrant(sent.messages[0]!.id)).toBeNull();
    await handle(request("abcdef12"));
    for (const spoof of [{ id: "job:abcdef12", owner: String(record.supervisor) }, { id: "job:1234abcd", owner: "pair/other-session" }]) {
      const impostor = await BridgeClient.connect(pipe, nullLogger); clients.push(impostor);
      await expect(impostor.request("hello", { protocol: PROTOCOL_VERSION, token, peer: { id: spoof.id, name: String(record.name), agent: "other", jobAgent: "codex",
        jobOwner: spoof.owner, jobParent: originalParent, cwd: home, pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false } })).rejects.toMatchObject({ code: "unauthorized" });
    }
  } finally { for (const client of clients) client.close(); await broker.close(); }
});

it("bounds eight never-resolving admissions below the network timeout and prevents every late launch", async () => {
  const query = neverQuery(); vi.useFakeTimers();
  const outcomes = Array.from({ length: 8 }, (_, i) => handle(request(`held-${i}`)));
  const rejected = Promise.all(outcomes.map(outcome => expect(outcome).rejects.toThrow("not_started: store reader admission exceeded 10 seconds")));
  for (let i = 0; i < 20 && !query.started(); i++) await Promise.resolve();
  expect(query.started()).toBe(true); await vi.advanceTimersByTimeAsync(10_000); await rejected;
  expect((remote as any).pendingStarts.size).toBe(0); expect((remote as any).records.size).toBe(0);
  await query.release();
  for (let i = 0; i < 8; i++) expect(existsSync(join(home, "jobs", `held-${i}.spec.json`))).toBe(false);
});

it.each(["cancel", "close"])("%s interrupts a pending identity query without files or late runner startup", async action => {
  const query = neverQuery(); const outcome = handle(request("pending")); const rejected = expect(outcome).rejects.toThrow(/not_started/);
  await until(query.started);
  if (action === "close") remote.close();
  else expect(await handle({ op: "control", job: "pending", control: { type: "cancel" } })).toMatchObject({ state: null, alive: true });
  await rejected; await query.release();
  expect(existsSync(join(home, "jobs", "pending.spec.json"))).toBe(false); expect((remote as any).records.has("pending")).toBe(false);
  expect(control).not.toHaveBeenCalled();
});

it("retains an actual late host and routes explicit cancellation to that exact owned runner", async () => {
  let resolve!: (value: typeof host) => void;
  vi.spyOn(JobRunners.prototype, "startAsync").mockImplementation(() => new Promise(ready => { resolve = ready; }));
  const outcome = handle(request("late", "complete retained prompt")); await until(() => Boolean(resolve));
  expect(await handle({ op: "control", job: "late", control: { type: "cancel" } })).toMatchObject({ state: null, alive: true });
  resolve(host); await outcome;
  const advertised = fixtureRemotePeer(home, pair, { ...peer, sessionId: peer.supervisor });
  expect(control).toHaveBeenCalledWith({ owner: "paired/sender", name: "codex-job-late", id: "late" }, { type: "cancel" },
    { kind: "remote-job-control", operation: "late", owner: `native:${advertised.nativeOwner}`, source: { kind: "remote", hostId: pair.id, hostFingerprint: pair.fingerprint } });
  const stored = JSON.parse(readFileSync(join(home, "remote-jobs.json"), "utf8"));
  expect(stored.jobs[0].job).toMatchObject({ id: "late", prompt: "complete retained prompt", host });
});

it("does not commit another job's provisional generation during an unrelated persist", async () => {
  const previous = { pair: pair.id, peer: peer.supervisor, owner: "paired/sender", args: { prompt: "original complete context", cwd: home, title: "Original" },
    job: { id: "previous", name: "codex-job-previous", agent: "codex", prompt: "original complete context", owner: "paired/sender", model: null,
      startedAt: 1, status: "done", sessionId: "saved-session", workdir: home, worktree: null, host: null, progress: null } };
  remote.close(); writeFileSync(join(home, "remote-jobs.json"), JSON.stringify({ version: 4, jobs: [previous] }));
  mkdirSync(join(home, "jobs")); writeFileSync(join(home, "jobs", "previous.json"), JSON.stringify({ version: 4, pid: 0, peer: previous.job.name,
    status: "done", sessionId: "saved-session", workdir: home, updatedAt: Date.now() }));
  remote = new RemoteJobs({ registerExtension() {} } as any, home, nullLogger, control);
  let admission: any;
  vi.spyOn(JobRunners.prototype, "startAsync").mockImplementation(async (job, _spec, gate) => {
    if (job.id !== "previous") return host;
    admission = gate;
    return new Promise((_ready, reject) => gate!.signal.addEventListener("abort", () => reject(gate!.signal.reason), { once: true }));
  });
  const pending = handle(request("previous", "uncommitted next context")); const rejected = expect(pending).rejects.toThrow(/not_started/);
  await until(() => Boolean(admission)); await handle(request("other", "other committed prompt"));
  expect(JSON.parse(readFileSync(join(home, "remote-jobs.json"), "utf8")).jobs.find((entry: any) => entry.job.id === "previous")).toEqual(previous);
  await handle({ op: "control", job: "previous", control: { type: "cancel" } }); await rejected;
  expect(JSON.parse(readFileSync(join(home, "remote-jobs.json"), "utf8")).jobs.find((entry: any) => entry.job.id === "previous")).toEqual(previous);
  expect((remote as any).records.get("previous").job.prompt).toBe("original complete context");
});
