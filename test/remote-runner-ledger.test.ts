import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteJobs } from "../src/network/remote-jobs.js";
import { NetworkService, networkHelloSchema } from "../src/network/link.js";
import { REMOTE_RUNNER_LEDGER_CAPABILITY, REMOTE_JOB_CAPABILITY, REMOTE_JOB_USAGE_CAPABILITY, unsupportedRunnerLedger } from "../src/network/remote-job-protocol.js";
import { RemoteJobHost } from "../src/mcp/remote-job-host.js";
import { JobRunners } from "../src/mcp/job-host.js";
import { publishRunnerSpec, readOriginalRunnerSpec } from "../src/core/runner-store.js";
import { readJsonStore } from "../src/core/json-store.js";
import { JobManager } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { writeJsonStore } from "../src/core/json-store.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv, remote: RemoteJobs | undefined;
afterEach(async () => { remote?.close(); remote = undefined; vi.restoreAllMocks(); if (env) await env.cleanup(); });
function boundary() {
  env = makeEnv(); let available = true, onLink: ((pair: any) => void) | undefined;
  const handlers = new Map<string, (payload: any, pair: any) => Promise<void>>();
  const aliases: string[] = [];
  const network = { peerConnected: () => true, peerSupports: (_host: string, capability: string) => [REMOTE_RUNNER_LEDGER_CAPABILITY, "remote-runner-ledger-v1"].includes(capability) ? capability === (available ? REMOTE_RUNNER_LEDGER_CAPABILITY : "remote-runner-ledger-v1") : true,
    peers: vi.fn(() => []), registerExtension: (type: string, _cap: string, handler: any, extra: string[]) => { handlers.set(type, handler); aliases.push(...extra); },
    sendExtension: vi.fn(async () => {}), onLink: (callback: typeof onLink) => { onLink = callback; return () => {}; } };
  remote = new RemoteJobs(network as any, env.home, nullLogger, vi.fn());
  return { network, handlers, aliases, remote, lose: () => { available = false; onLink?.({ id: "11111111-1111-4111-8111-111111111111", name: "paired" }); },
    receive: (payload: any) => handlers.get("remote-job")!(payload, { id: "11111111-1111-4111-8111-111111111111", name: "paired", fingerprint: "fixture-paired-fingerprint" }) };
}
const spawn = () => ({ op: "spawn" as const, job: "1234abcd", target: "codex" as const, args: { prompt: "Original accepted input", title: "Ledger", cwd: env.home } });
it.each([false, true])("refuses damaged remote evidence at actual start/preclaim/publication after %s corrupt preservation and missing registry projection", async preserved => {
  env = makeEnv();
  const remoteJob = vi.fn(async () => { throw unsupportedRunnerLedger(true); }), node = { remoteJob } as any;
  const job = { id: "1234abcd", name: "codex-job-1234abcd", agent: "codex", owner: "original", supervisor: "original-session", startedAt: 123,
    status: "done", queue: ["Unconsumed next turn"], controller: new AbortController() } as any;
  publishRunnerSpec(env.home, job.id, { owner: "original", job: { ...job, controller: undefined } });
  const spec = readOriginalRunnerSpec(env.home, job.id);
  new RemoteJobHost(node, env.home, nullLogger).start(job, "original-host", "codex", spawn().args);
  const file = join(env.home, "remote-job-states", `${job.id}.json`);
  await vi.waitFor(() => expect(JSON.parse(readFileSync(file, "utf8")).operations[0].state).toBe("blocked"));
  const original = readFileSync(file), damaged = original.subarray(0, original.length - 5);
  writeFileSync(file, damaged); delete job.remote;
  if (preserved) expect(readJsonStore(file, nullLogger)).toBeNull(); // Simulate an earlier tolerant reader's retained corruption.
  const files = readdirSync(join(env.home, "remote-job-states")), paths = files.map(name => join(env.home, "remote-job-states", name)).filter(path => lstatSync(path).isFile());
  const bytes = paths.map(path => readFileSync(path));
  const host = new JobRunners(node, env.home, "unused-cli", nullLogger);
  expect(() => host.assertTurnAdmission(job)).toThrow();
  expect(() => host.start(job, { args: {}, target: "codex" } as any)).toThrow();
  expect(() => publishRunnerSpec(env.home, job.id, { owner: "replacement" })).toThrow();
  const jobs = new JobManager(new LocalCoordinator("original", "original-session"), nullLogger, join(env.home, "jobs.json")); jobs.runners = host;
  expect((jobs as any).claimTurn(job)).toBe(false); jobs.setDormant(true);
  expect(job.queue).toEqual(["Unconsumed next turn"]);
  job.controller.abort(); expect(() => host.assertTurnAdmission({ ...job, startedAt: 124 })).toThrow();
  expect(readOriginalRunnerSpec(env.home, job.id)).toEqual(spec);
  expect(remoteJob).toHaveBeenCalledOnce(); expect(readdirSync(join(env.home, "remote-job-states"))).toEqual(files);
  paths.forEach((path, index) => expect(readFileSync(path)).toEqual(bytes[index]));
});
it.each(["empty", "settled", "wrong-job", "unknown-format", "missing-operations", "budget"])("inspects %s remote evidence without attributing another incarnation or treating unknown bytes as absence", async mode => {
  env = makeEnv(); const node = { remoteJob: vi.fn(async () => ({ state: null, alive: false, approvals: [] })) } as any;
  const job = { id: "1234abcd", name: "codex-job-1234abcd", agent: "codex", startedAt: 123, controller: new AbortController(), queue: [] } as any;
  new RemoteJobHost(node, env.home, nullLogger).start(job, "paired", "codex", spawn().args);
  const file = join(env.home, "remote-job-states", `${job.id}.json`);
  await vi.waitFor(() => expect(JSON.parse(readFileSync(file, "utf8")).operations[0].state).toBe("confirmed"));
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (mode === "empty") record.operations = [];
  if (mode === "wrong-job") record.operations[0].request.job = "00000000";
  if (mode === "unknown-format") record.version = 999;
  if (mode === "missing-operations") delete record.operations;
  if (mode === "unknown-format") writeFileSync(file, JSON.stringify(record));
  else writeJsonStore(file, record, JSON.parse(readFileSync(file, "utf8")));
  delete job.remote; const before = readFileSync(file), host = new JobRunners(node, env.home, "unused-cli", nullLogger);
  if (mode === "budget") { let tick = 0; vi.spyOn(performance, "now").mockImplementation(() => tick += 100); }
  if (mode === "empty" || mode === "settled") {
    expect(() => host.assertTurnAdmission(job)).not.toThrow();
    expect(() => publishRunnerSpec(env.home, job.id, { owner: "original" })).not.toThrow();
  } else expect(() => host.assertTurnAdmission({ ...job, startedAt: 124 })).toThrow();
  expect(readFileSync(file)).toEqual(before); expect(node.remoteJob).toHaveBeenCalledOnce();
});
it.each(["spawn", "state", "cancel", "answer"])("refuses old executor before %s dispatch or a pending RPC is created", async operation => {
  const f = boundary(); f.lose();
  expect(f.network.peerSupports("paired", "remote-runner-ledger-v1")).toBe(true);
  expect(f.network.peerSupports("paired", REMOTE_RUNNER_LEDGER_CAPABILITY)).toBe(false);
  const request = operation === "spawn" ? spawn() : operation === "state" ? { op: "state", job: "1234abcd" } :
    operation === "cancel" ? { op: "control", job: "1234abcd", control: { type: "cancel" } } : { op: "approval", job: "1234abcd", id: randomUUID(), decision: "allow" };
  await expect(f.remote.request("paired", { id: "owner", name: "owner" }, request as any)).rejects.toMatchObject({ code: "protocol_mismatch", details: { runnerLedgerUnsupported: true } });
  expect(f.network.sendExtension).not.toHaveBeenCalled(); expect((f.remote as any).pending.size).toBe(0);
});
it.each(["spawn", "state", "control"])("refuses an old requester before %s lookup, execution or response effects", async op => {
  const f = boundary(); f.lose();
  expect(f.network.peerSupports("paired", "remote-runner-ledger-v1")).toBe(true);
  expect(f.network.peerSupports("paired", REMOTE_RUNNER_LEDGER_CAPABILITY)).toBe(false);
  const request = op === "spawn" ? spawn() : op === "state" ? { op, job: "1234abcd" } : { op, job: "1234abcd", control: { type: "cancel" } };
  await expect(f.receive({ kind: "request", rid: randomUUID(), peer: { id: "owner", name: "owner", supervisor: "session" }, request })).rejects.toMatchObject({ details: { runnerLedgerUnsupported: true } });
  expect(f.network.peers).not.toHaveBeenCalled(); expect(f.network.sendExtension).not.toHaveBeenCalled();
});
it("rejects an in-flight result when reconnect drops the contract, without replaying its request or acknowledging it", async () => {
  const f = boundary();
  const result = f.remote.request("paired", { id: "owner", name: "owner" }, spawn());
  const rejected = expect(result).rejects.toMatchObject({ details: { runnerLedgerUnsupported: true, unknownAccepted: true } });
  expect(f.network.sendExtension).toHaveBeenCalledOnce();
  const frame = f.network.sendExtension.mock.calls[0] as any;
  f.lose(); await rejected;
  await expect(f.receive({ kind: "response", rid: frame[2].rid, value: { state: null, alive: false, approvals: [] } })).rejects.toMatchObject({ code: "protocol_mismatch" });
  expect(f.network.sendExtension).toHaveBeenCalledOnce(); expect((f.remote as any).pending.size).toBe(0);
});
it("puts the new capability in the bounded additional hello array and round-trips the production parser", () => {
  const f = boundary();
  const capabilities = [REMOTE_JOB_CAPABILITY, ...f.aliases, "file-stream-v1", "file-stream-window-v1", "dashboard-read-v1", "decision-sync-v1"];
  const hello = NetworkService.prototype.extensionHelloCapabilities.call({ extensionCapabilities: () => capabilities } as any);
  expect(hello.capabilities).not.toContain(REMOTE_RUNNER_LEDGER_CAPABILITY); expect(hello.capabilities.length).toBeLessThanOrEqual(8);
  expect(hello.additionalCapabilities).toEqual([REMOTE_JOB_USAGE_CAPABILITY, REMOTE_RUNNER_LEDGER_CAPABILITY]);
  const result = networkHelloSchema.parse({ type: "hello", v: 1, id: "11111111-1111-4111-8111-111111111111", name: "paired", fingerprint: "a".repeat(64), peers: [], ...hello });
  expect(REMOTE_RUNNER_LEDGER_CAPABILITY).toBe("remote-runner-ledger-v2");
  expect(result.additionalCapabilities).toContain(REMOTE_RUNNER_LEDGER_CAPABILITY);
  expect(hello.additionalCapabilities).not.toContain("remote-runner-ledger-v1");
  const old = networkHelloSchema.parse({ ...result, additionalCapabilities: [REMOTE_JOB_USAGE_CAPABILITY, "remote-runner-ledger-v1"] });
  expect(old.additionalCapabilities).not.toContain(REMOTE_RUNNER_LEDGER_CAPABILITY);
});
it("retains the exact unconfirmed spawn and later cancel across requester restart, without autoexecution or status settlement", async () => {
  env = makeEnv();
  const remoteJob = vi.fn(async () => { throw unsupportedRunnerLedger(true); });
  const node = { remoteJob } as any;
  const job = { id: "abcd1234", name: "codex-job-abcd1234", agent: "codex", startedAt: 123, queue: [], controller: new AbortController() } as any;
  const host = new RemoteJobHost(node, env.home, nullLogger);
  host.start(job, "original-paired", "codex", spawn().args);
  await vi.waitFor(() => expect(job.progress).toMatch(/unconfirmed/));
  const file = join(env.home, "remote-job-states", `${job.id}.json`), original = JSON.parse(readFileSync(file, "utf8"));
  expect(original.operations).toHaveLength(1); expect(original.operations[0]).toMatchObject({ turn: 123, state: "blocked", request: { op: "spawn", args: spawn().args } });
  const reopened = new RemoteJobHost(node, env.home, nullLogger);
  expect(reopened.alive(job)).toBe(true); expect(reopened.state(job)).toBeNull();
  expect(() => reopened.start(job, "replacement-same-display-host", "codex", { ...spawn().args, prompt: "must not reroute" })).toThrow(/original remote operation/i);
  reopened.send(job, { type: "cancel" });
  expect(remoteJob).toHaveBeenCalledOnce();
  const retained = JSON.parse(readFileSync(file, "utf8"));
  expect(retained.operations[0]).toEqual(original.operations[0]); expect(retained.operations[1].request).toMatchObject({ op: "control", control: { type: "cancel" } });
  expect(retained.snapshot).toMatchObject({ state: null, alive: true });
  // The remote cache can commit before the parent registry stores `remote`.
  // Losing that projection must not let a registry claim consume new input.
  delete job.remote;
  const runners = new JobRunners(node, env.home, "unused-cli", nullLogger);
  expect(() => runners.assertTurnAdmission(job)).toThrow(/runner-ledger/);
  expect(JSON.parse(readFileSync(file, "utf8")).operations).toEqual(retained.operations);
});
it("sends cancellation during a still-owned in-flight spawn while a restarted unknown spawn remains blocked", async () => {
  env = makeEnv(); let settle!: (snapshot: any) => void;
  const remoteJob = vi.fn(async (_host, request) => request.op === "spawn" ? await new Promise<any>(resolve => { settle = resolve; }) : { state: null, alive: true, approvals: [] });
  const node = { remoteJob } as any, host = new RemoteJobHost(node, env.home, nullLogger);
  const job = { id: "1234abcd", name: "codex-job-1234abcd", agent: "codex", startedAt: 123, queue: [], controller: new AbortController() } as any;
  host.start(job, "original-paired", "codex", spawn().args);
  host.send(job, { type: "cancel" }); expect(remoteJob.mock.calls.map(([, request]) => request.op)).toEqual(["spawn", "control"]);
  const restarted = new RemoteJobHost(node, env.home, nullLogger);
  expect(() => restarted.start(job, "original-paired", "codex", spawn().args)).toThrow(/unconfirmed/);
  expect(restarted.alive(job)).toBe(true);
  settle({ state: null, alive: true, approvals: [] });
  await vi.waitFor(() => expect(JSON.parse(readFileSync(join(env.home, "remote-job-states", `${job.id}.json`), "utf8")).operations.every((op: any) => op.state === "confirmed")).toBe(true));
});
