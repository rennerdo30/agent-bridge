import { metadataDb, METADATA_STORE_VERSION } from "../src/core/metadata-db.js";
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
import { publishRunnerSpec, readOriginalRunnerSpec, runnerLedgerNamespace } from "../src/core/runner-store.js";
import { projectRunnerInputs, runnerLedgerPrincipal } from "../src/mcp/runner-delivery-retention.js";
import { completionMessageId } from "../src/core/completion.js";
import { randomUUID } from "node:crypto";
import { RemoteJobHost } from "../src/mcp/remote-job-host.js";
import type { Job } from "../src/mcp/jobs.js";
import { remoteJobWireSchema, type RemoteJobRequest } from "../src/network/remote-job-protocol.js";
import * as jsonStore from "../src/core/json-store.js";
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
  remote = new RemoteJobs({ registerExtension() {}, peerSupports: () => true, peers: () => [fixtureRemotePeer(home, pair, { ...peer, sessionId: peer.supervisor })] } as any, home, nullLogger, control);
});
afterEach(() => { closeMetadataDbs(); remote.close(); vi.useRealTimers(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
function request(id: string, prompt = "retained prompt") { return { op: "spawn", job: id, target: "codex", args: { cwd: home, prompt, title: "Queued" } } as const; }
function handle(request: unknown) { return (remote as any).handle(pair, peer, request) as Promise<any>; }
it.each(["input", "note"])("observes a proven live %s ledger as running without recovering it or exposing a staged final", async kind => {
  let state: any, alive = true;
  vi.spyOn(JobRunners.prototype, "alive").mockImplementation(() => alive);
  const recover = vi.spyOn(JobRunners.prototype, "recoverRetention").mockRejectedValue(new Error("controlled dead-generation retention pending"));
  vi.spyOn(JobRunners.prototype, "startAsync").mockImplementation(async (job, spec) => {
    const original = { ...spec, home, job: { ...job, controller: undefined, allowedServers: undefined } };
    publishRunnerSpec(home, job.id, original);
    const generation = randomUUID(), namespace = runnerLedgerNamespace(home, true), dedupeKey = randomUUID();
    const messageId = completionMessageId(`send:${job.name}`, dedupeKey);
    const item = { messageId, record: JSON.stringify({ version: 1, kind: "accepted-runner-delivery", authority: "evidence-only-no-replay", generation, namespace,
      job: job.id, messageId, dedupeKey, senderName: job.name, intendedSender: { kind: "job", agent: job.agent, id: `job:${job.id}` },
      body: "Original live note", wireBody: "Original live note", to: spec.owner, note: true, question: false, final: false, conversationId: `job-${job.id}:note`,
      supervisor: job.supervisor ?? null, parentJob: job.parentJob ?? null, rootSession: job.rootSession ?? null }) };
    state = { pid: process.pid, peer: job.name, status: "done", updatedAt: Date.now(), report: "Staged final must not escape", reportId: randomUUID(), delivered: false,
      deliveryLedger: { version: 1, job: job.id, generation, namespace, principal: runnerLedgerPrincipal(original), entries: kind === "note" ? [item] : [] },
      ...(kind === "input" ? { retainedRunnerInputs: projectRunnerInputs(generation, [{ batch: randomUUID(), generation, phase: "provider-admitted", bodies: ["Original live input"],
        controls: [{ cid: "original-cid", body: "Original live input" }], admission: { startedAt: job.startedAt, sessionId: null } }]) } : {}) };
    writeRunnerState(home, job.id, state); return host;
  });
  const result = await handle(request("1234abcd"));
  expect(result).toMatchObject({ alive: true, state: { status: "running", delivered: false } });
  expect(result.state.report).toBeUndefined(); expect(result.state.reportId).toBeUndefined();
  expect((await handle({ op: "state", job: "1234abcd" })).state.status).toBe("running");
  expect(recover).not.toHaveBeenCalled(); expect(readRunnerState(home, "1234abcd")).toMatchObject(state);
  const db = metadataDb(home), raw = String(db.prepare("SELECT value FROM bridge_metadata WHERE domain='job-state' AND key='1234abcd'").get()!.value);
  for (const field of ["principal", "namespace", "generation"]) {
    const corrupt = JSON.parse(raw); corrupt.deliveryLedger[field] = "unproven-replacement";
    db.prepare("UPDATE bridge_metadata SET value=? WHERE domain='job-state' AND key='1234abcd'").run(JSON.stringify(corrupt));
    await expect(handle({ op: "state", job: "1234abcd" })).rejects.toMatchObject({ code: "RUNNER_RETENTION_UNSETTLED", reason: "invalid-evidence" });
    expect(recover).not.toHaveBeenCalled();
    db.prepare("UPDATE bridge_metadata SET value=? WHERE domain='job-state' AND key='1234abcd'").run(raw);
  }
  alive = false;
  await expect(handle({ op: "state", job: "1234abcd" })).rejects.toThrow(/retention is unsettled/);
  expect(recover).toHaveBeenCalledOnce(); expect(readRunnerState(home, "1234abcd")).toMatchObject(state);
});
function neverQuery() {
  const pid = ++nextPid; mkdirSync(join(home, "storage-capabilities"));
  writeFileSync(join(home, "storage-capabilities", `${pid}.json`), JSON.stringify({ schemaVersion: 1, pid, name: "current-reader", version: APP_VERSION,
    explicit: true, json: 4, sqlite: 9, metadata: METADATA_STORE_VERSION, processIdentity: `generation-${pid}` }));
  let resolve!: (ids: Map<number, string>) => void;
  vi.spyOn(identity, "readProcessIdentities").mockImplementation(() => new Promise(ready => { resolve = ready; }));
  return { started: () => Boolean(resolve), release: async () => { resolve(new Map([[pid, `generation-${pid}`]])); await refreshStorePeerIdentities(home); } };
}
const host = { pid: null, peer: "detached-fixture", startedAt: Date.now() };

it.each(["reader", "pre-record", "duplicate", "foreign", "restart", "held-control", "failed-retention"])("wire cancellation aborts original suspended admission before publication and cannot launch after release: %s", async phase => {
  remote.close(); metadataDb(home);
  const paired = { id: randomUUID(), name: "paired", fingerprint: "a".repeat(64) };
  const advertised = fixtureRemotePeer(home, paired, { ...peer, sessionId: peer.supervisor });
  let receive!: (payload: any, pair: any) => Promise<void>;
  const responses = new Map<string, (response: any) => void>();
  remote = new RemoteJobs({ peerSupports: () => true, peers: () => [advertised],
    registerExtension: (_type: string, _cap: string, handler: typeof receive) => { receive = handler; },
    sendExtension: async (_host: string, _type: string, raw: unknown) => {
      const frame = remoteJobWireSchema.parse(raw); expect(frame.kind).toBe("response"); responses.get(frame.rid)!(frame);
    } } as any, home, nullLogger, control);
  const wire = (request: RemoteJobRequest, sender = peer) => new Promise<any>((resolve, reject) => {
    const rid = randomUUID(); responses.set(rid, resolve); void receive({ kind: "request", rid, peer: sender, request }, paired).catch(reject);
  });
  let releasePreflight!: () => void;
  const query = phase === "pre-record" ? undefined : neverQuery();
  if (!query) vi.mocked(worktree.gitDirsOutside).mockImplementationOnce(() => new Promise(resolve => { releasePreflight = () => resolve([]); }));
  const actualStart = JobRunners.prototype.start;
  const launch = vi.spyOn(JobRunners.prototype, "start").mockImplementation((job, spec) => {
    publishRunnerSpec(home, job.id, { ...spec, home, job: { ...job, controller: undefined } }); return host;
  });
  const spawned = wire(request("1234abcd", "Exact original cancelled-before-start context"));
  let cancelled: Promise<any> | undefined, duplicate: Promise<any> | undefined, held: Promise<any> | undefined;
  try {
    await until(query?.started ?? (() => Boolean(releasePreflight)));
    const admission = query ? (remote as any).pendingStarts.get("1234abcd") : (remote as any).starting.get("1234abcd"); expect(admission).toBeTruthy();
    if (phase === "foreign") {
      const rejected = await wire({ op: "control", job: "1234abcd", control: { type: "cancel" } }, { ...peer, supervisor: "foreign-session" });
      expect(rejected.error).toContain("another supervisor"); expect(admission.controller.signal.aborted).toBe(false);
      expect(existsSync(join(home, "remote-job-states", "1234abcd.json"))).toBe(false);
    }
    if (phase === "held-control") held = wire({ op: "control", job: "1234abcd", control: { type: "message", cid: randomUUID(), body: "Exact queued original C2 must not execute" } });
    if (phase === "failed-retention") {
      const write = jsonStore.writeJsonStore;
      vi.spyOn(jsonStore, "writeJsonStore").mockImplementation((file, value, previous) => {
        if (value.admissionCancellation) throw new Error("controlled evidence storage unavailable");
        return write(file, value, previous);
      });
    }
    cancelled = wire({ op: "control", job: "1234abcd", control: { type: "cancel" } });
    await Promise.resolve(); await Promise.resolve();
    if (phase === "failed-retention") {
      expect((await cancelled).error).toBe("controlled evidence storage unavailable"); expect(admission.controller.signal.aborted).toBe(false);
      expect(existsSync(join(home, "remote-job-states", "1234abcd.json"))).toBe(false);
      remote.close(); await query!.release(); expect((await spawned).value).toBeUndefined();
      expect(launch).not.toHaveBeenCalled(); expect(control).not.toHaveBeenCalled(); return;
    }
    expect(admission.controller.signal.aborted).toBe(true);
    const file = join(home, "remote-job-states", "1234abcd.json"), bytes = readFileSync(file), evidence = JSON.parse(bytes.toString());
    expect(evidence.operations.map((operation: any) => operation.state)).toEqual(["blocked", "blocked"]);
    expect(evidence.admissionCancellation).toMatchObject({ pair: paired.id, peer: peer.id, supervisor: peer.supervisor,
      spawn: request("1234abcd", "Exact original cancelled-before-start context"), cancel: { op: "control", job: "1234abcd", control: { type: "cancel" } },
      route: { destination: { hostId: paired.id, hostFingerprint: paired.fingerprint, native: advertised.nativeOwner } } });
    if (phase === "duplicate") {
      duplicate = wire({ op: "control", job: "1234abcd", control: { type: "cancel" } });
      await Promise.resolve(); expect(readFileSync(file)).toEqual(bytes);
    }
    if (query) await query.release(); else releasePreflight();
    const replies = await Promise.all([spawned, cancelled, ...(duplicate ? [duplicate] : [])]);
    if (held) expect((await held).error).toContain("Original remote spawn did not retain its admitted generation");
    expect(replies.map(reply => reply.value)).toEqual(Array(replies.length).fill(expect.objectContaining({ alive: false, state: expect.objectContaining({ peer: "codex-job-1234abcd", status: "cancelled" }) })));
    expect(launch).not.toHaveBeenCalled(); expect(readOriginalRunnerSpec(home, "1234abcd")).toBeNull();
    expect(existsSync(join(home, "jobs", "1234abcd.spec.json"))).toBe(false);
    expect(control).not.toHaveBeenCalled(); expect((remote as any).pendingStarts.size).toBe(0); expect((remote as any).starting.size).toBe(0);
    // The unchanged v2 preclaim/publication fence understands blocked evidence,
    // even without interpreting the additive audit proof. Never reopen/reset it.
    expect(() => publishRunnerSpec(home, "1234abcd", { owner: "replacement", job: { id: "1234abcd" } })).toThrow(/invalid-evidence/);
    const attempted: Job = { id: "1234abcd", name: "codex-job-1234abcd", agent: "codex", startedAt: evidence.admissionCancellation.turn,
      controller: new AbortController(), model: null, prompt: "must not replay retained cancellation", progress: null, status: "running", sessionId: null, workdir: home, worktree: null, queue: [] };
    expect(() => actualStart.call((remote as any).runners, attempted, { target: "codex", args: { prompt: attempted.prompt, title: "Refused restart", cwd: home } } as any)).toThrow();
    expect(readFileSync(file)).toEqual(bytes);
    if (phase === "restart") {
      remote.close();
      remote = new RemoteJobs({ peerSupports: () => true, peers: () => [advertised], registerExtension: (_type: string, _cap: string, handler: typeof receive) => { receive = handler; },
        sendExtension: async (_host: string, _type: string, raw: any) => { const frame = remoteJobWireSchema.parse(raw); responses.get(frame.rid)!(frame); } } as any, home, nullLogger, control);
      const retry = await wire(request("1234abcd", "must not reexecute")); expect(retry.error).toMatch(/invalid-evidence/);
      expect(launch).not.toHaveBeenCalled(); expect(readFileSync(file)).toEqual(bytes);
    }
  } finally { remote.close(); if (query) await query.release(); else releasePreflight?.(); await Promise.allSettled([spawned, ...(cancelled ? [cancelled] : []), ...(duplicate ? [duplicate] : []), ...(held ? [held] : [])]); }
});

it.each(["success", "failed-control"])("wire cancellation after actual publication reaches only the original late host once and preserves original responses: %s", async outcome => {
  remote.close();
  const paired = { id: randomUUID(), name: "paired", fingerprint: "a".repeat(64) }, advertised = fixtureRemotePeer(home, paired, { ...peer, sessionId: peer.supervisor });
  let receive!: (payload: any, pair: any) => Promise<void>, release!: () => void;
  const replies = new Map<string, (response: any) => void>();
  remote = new RemoteJobs({ peerSupports: () => true, peers: () => [advertised], registerExtension: (_type: string, _cap: string, handler: typeof receive) => { receive = handler; },
    sendExtension: async (_host: string, _type: string, raw: any) => { const frame = remoteJobWireSchema.parse(raw); replies.get(frame.rid)!(frame); } } as any, home, nullLogger,
    async (record, command, origin) => {
      await control(record, command);
      expect(origin).toEqual({ kind: "remote-job-control", operation: record.id, owner: `native:${advertised.nativeOwner}`,
        source: { kind: "remote", hostId: paired.id, hostFingerprint: paired.fingerprint } });
      if (outcome === "failed-control") throw new Error("controlled accepted-host control failure");
      writeRunnerState(home, record.id, { pid: 0, peer: record.name, status: "cancelled", updatedAt: Date.now(), delivered: false });
    });
  const wire = (request: RemoteJobRequest) => new Promise<any>((resolve, reject) => {
    const rid = randomUUID(); replies.set(rid, resolve); void receive({ kind: "request", rid, peer, request }, paired).catch(reject);
  });
  const actualStart = JobRunners.prototype.startAsync;
  vi.spyOn(JobRunners.prototype, "startAsync").mockImplementation(async function (this: JobRunners, ...args) {
    const started = await actualStart.apply(this, args);
    await new Promise<void>(resolve => { release = resolve; }); return started;
  });
  const launch = vi.spyOn(JobRunners.prototype, "start").mockImplementation((job, spec) => {
    publishRunnerSpec(home, job.id, { ...spec, home, job: { ...job, controller: undefined } }); return host;
  });
  vi.spyOn(JobRunners.prototype, "alive").mockImplementation((_job, state) => state?.status !== "cancelled");
  const spawned = wire(request("1234abcd", "Exact original already published context"));
  let cancel: Promise<any> | undefined, duplicate: Promise<any> | undefined;
  try {
    await until(() => Boolean(release)); expect((remote as any).starting.get("1234abcd").effectAttempted).toBe(true);
    const original = readOriginalRunnerSpec(home, "1234abcd"); expect(original).toBeTruthy();
    cancel = wire({ op: "control", job: "1234abcd", control: { type: "cancel" } });
    duplicate = wire({ op: "control", job: "1234abcd", control: { type: "cancel" } });
    await Promise.resolve(); expect((remote as any).pendingStarts.get("1234abcd").controller.signal.aborted).toBe(true);
    expect(control).not.toHaveBeenCalled(); expect(existsSync(join(home, "remote-job-states", "1234abcd.json"))).toBe(false);
    release(); const results = await Promise.all([spawned, cancel, duplicate]);
    if (outcome === "success") expect(results.map(result => result.value.state.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    else {
      expect(results.every(result => result.value === undefined && typeof result.error === "string")).toBe(true);
      expect(readRunnerState(home, "1234abcd")).toBeNull();
      const record = JSON.parse(readFileSync(join(home, "remote-jobs.json"), "utf8")).jobs[0];
      expect(record.job).toMatchObject({ id: "1234abcd", prompt: "Exact original already published context", host });
    }
    expect(control).toHaveBeenCalledExactlyOnceWith({ owner: "paired/sender", name: "codex-job-1234abcd", id: "1234abcd" }, { type: "cancel" });
    expect(launch).toHaveBeenCalledOnce(); expect(readOriginalRunnerSpec(home, "1234abcd")).toEqual(original);
    expect((remote as any).pendingStarts.size).toBe(0); expect((remote as any).starting.size).toBe(0);
  } finally { release?.(); remote.close(); await Promise.allSettled([spawned, ...(cancel ? [cancel] : []), ...(duplicate ? [duplicate] : [])]); }
});

it.each([
  ["message", "success"], ["settings", "success"], ["pause", "success"],
  ["title", "success"], ["effort", "success"], ["attach", "success"],
  ["message", "failed-start"], ["cancel", "closed"], ["cancel", "replaced"], ["cancel", "capability"],
])("owns early wire %s across suspended pre-record spawn admission: %s", async (kind, outcome) => {
  remote.close();
  const paired = { id: randomUUID(), name: "paired", fingerprint: "a".repeat(64) };
  const advertised = fixtureRemotePeer(home, paired, { ...peer, sessionId: peer.supervisor });
  let currentPeer = advertised, compatible = true;
  let receive!: (payload: any, pair: any) => Promise<void>, releasePreflight!: () => void, releaseHost!: () => void;
  const replies = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const network = { peerSupports: () => compatible, peers: () => [currentPeer], registerExtension: (_type: string, _cap: string, handler: typeof receive) => { receive = handler; },
    sendExtension: vi.fn(async (_host, _type, raw) => {
      const frame = remoteJobWireSchema.parse(raw); expect(frame.kind).toBe("response");
      if (frame.kind !== "response") throw new Error("Expected actual production response");
      const pending = replies.get(frame.rid)!; replies.delete(frame.rid);
      if (frame.error) pending.reject(new Error(frame.error)); else pending.resolve(frame.value);
    }) };
  remote = new RemoteJobs(network as any, home, nullLogger, async (record, command, origin) => {
    await control(record, command);
    expect(origin).toEqual({ kind: "remote-job-control", operation: record.id, owner: `native:${advertised.nativeOwner}`,
      source: { kind: "remote", hostId: paired.id, hostFingerprint: paired.fingerprint } });
    if (command.type === "cancel") writeRunnerState(home, record.id, { pid: 0, peer: record.name, status: "cancelled", updatedAt: Date.now(), delivered: false });
  });
  vi.mocked(worktree.gitDirsOutside).mockImplementationOnce(() => new Promise((resolve, reject) => { releasePreflight = () => outcome === "failed-start" ? reject(new Error("controlled preflight refusal")) : resolve([]); }));
  const start = vi.spyOn(JobRunners.prototype, "startAsync").mockImplementation(async job => {
    await new Promise<void>(resolve => { releaseHost = resolve; });
    writeRunnerState(home, job.id, { pid: 0, peer: job.name, status: "running", updatedAt: Date.now() }); return host;
  });
  vi.spyOn(JobRunners.prototype, "alive").mockImplementation((_job, state) => state?.status === "running");
  const remoteJob = vi.fn((_host: string, request: RemoteJobRequest) => new Promise<any>((resolve, reject) => {
    const rid = randomUUID(); replies.set(rid, { resolve, reject });
    void receive({ kind: "request", rid, peer, request }, paired).catch(reject);
  }));
  const source = join(home, "requester"), client = new RemoteJobHost({ remoteJob } as any, source, nullLogger);
  const job = { id: "1234abcd", name: "codex-job-1234abcd", agent: "codex", startedAt: 123, owner: peer.name, supervisor: peer.supervisor,
    controller: new AbortController(), queue: [] } as unknown as Job;
  const cache = () => JSON.parse(readFileSync(join(source, "remote-job-states", `${job.id}.json`), "utf8"));
  try {
    client.start(job, paired.name, "codex", { prompt: "Exact pre-record original context", title: "Early control", cwd: home });
    await until(() => Boolean(releasePreflight));
    const commands: Record<string, RunnerControl> = { cancel: { type: "cancel" }, message: { type: "message", body: "Exact early C1", cid: randomUUID() },
      settings: { type: "settings", settings: { model: "fixture-model" } }, pause: { type: "pause", reason: "Original early pause" },
      title: { type: "title", title: "Original early title" }, effort: { type: "effort", effort: "high" }, attach: { type: "attach" } };
    const command = commands[kind]!;
    if (kind === "cancel") job.controller.abort(); // Actual JobManager cancellation keeps this exact controller/incarnation.
    client.send(job, command);
    // An authenticated same-name peer with another supervisor session cannot
    // attach to this wait or affect either original operation.
    const foreignReply = new Promise<any>((resolve, reject) => {
      const rid = randomUUID(); replies.set(rid, { resolve, reject });
      void receive({ kind: "request", rid, peer: { ...peer, supervisor: "foreign-session" }, request: { op: "control", job: job.id, control: { type: "cancel" } } }, paired).catch(reject);
    });
    await expect(foreignReply).rejects.toThrow("another supervisor");
    expect(() => new RemoteJobHost({ remoteJob } as any, source, nullLogger).assertTurnAdmission(job)).toThrow();
    await Promise.resolve(); await Promise.resolve(); expect(control).not.toHaveBeenCalled();
    if (outcome === "closed") remote.close();
    if (outcome === "replaced") currentPeer = fixtureRemotePeer(home, paired, { ...peer, sessionId: "replacement-session" });
    if (outcome === "capability") compatible = false;
    releasePreflight();
    if (outcome === "success") {
      await until(() => Boolean(releaseHost));
      releaseHost();
    }
    if (outcome !== "success") {
      await vi.waitFor(() => expect(cache().operations[1].state).toBe("blocked"));
      expect(control).not.toHaveBeenCalled(); expect(remoteJob).toHaveBeenCalledTimes(2);
      const original = cache().operations;
      expect(original[1].request.control).toEqual(command);
      const restarted = new RemoteJobHost({ remoteJob } as any, source, nullLogger);
      expect(() => restarted.start({ ...job, startedAt: 124 }, "replacement-host", "codex", { prompt: "No replay", title: "Refuse", cwd: home })).toThrow();
      expect(restarted.alive(job)).toBe(true); expect(cache().operations).toEqual(original);
      expect((remote as any).starting.size).toBe(0); expect((remote as any).pendingStarts.size).toBe(0);
      return;
    }
    await vi.waitFor(() => expect(control).toHaveBeenCalledWith({ owner: "paired/sender", name: job.name, id: job.id }, command));
    await vi.waitFor(() => expect(cache().operations.map((op: any) => op.state)).toEqual(["confirmed", "confirmed"]));
    expect(start).toHaveBeenCalledOnce(); expect(remoteJob).toHaveBeenCalledTimes(2);
    expect(cache().operations[0].request.args.prompt).toBe("Exact pre-record original context");
    expect(cache().operations[1].request.control).toEqual(command);
    if (kind === "cancel") expect(client.state(job)?.status).toBe("cancelled");
    const stored = JSON.parse(readFileSync(join(home, "remote-jobs.json"), "utf8")).jobs[0];
    expect(stored.job).toMatchObject({ id: job.id, prompt: "Exact pre-record original context", supervisor: `${paired.id}/${peer.supervisor}` });
    expect(stored.returnRoute.destination).toMatchObject({ hostId: paired.id, hostFingerprint: paired.fingerprint, native: advertised.nativeOwner });
  } finally { releasePreflight?.(); releaseHost?.(); }
});

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
  // These deliberately unproven old bytes cannot be blessed by clearing a
  // field; retain the original report and evidence for explicit recovery.
  expect(() => writeRunnerState(home, id, { ...state, pendingDeliveryRetention: [], deliveryRetentionFailure: undefined })).toThrow(/retention.*unsettled/i);
  expect(readRunnerState(home, id)).toMatchObject(state);
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
  remote = new RemoteJobs({ registerExtension() {}, peerSupports: () => true } as any, home, nullLogger, control);
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
