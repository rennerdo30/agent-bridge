import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteJobs } from "../src/network/remote-jobs.js";
import { NetworkService, networkHelloSchema } from "../src/network/link.js";
import { REMOTE_RUNNER_LEDGER_CAPABILITY, REMOTE_JOB_CAPABILITY, REMOTE_JOB_USAGE_CAPABILITY, unsupportedRunnerLedger } from "../src/network/remote-job-protocol.js";
import { RemoteJobHost } from "../src/mcp/remote-job-host.js";
import { JobRunners } from "../src/mcp/job-host.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv, remote: RemoteJobs | undefined;
afterEach(async () => { remote?.close(); remote = undefined; vi.restoreAllMocks(); if (env) await env.cleanup(); });
function boundary() {
  env = makeEnv(); let available = true, onLink: ((pair: any) => void) | undefined;
  const handlers = new Map<string, (payload: any, pair: any) => Promise<void>>();
  const aliases: string[] = [];
  const network = { peerConnected: () => true, peerSupports: (_host: string, capability: string) => capability !== REMOTE_RUNNER_LEDGER_CAPABILITY || available,
    peers: vi.fn(() => []), registerExtension: (type: string, _cap: string, handler: any, extra: string[]) => { handlers.set(type, handler); aliases.push(...extra); },
    sendExtension: vi.fn(async () => {}), onLink: (callback: typeof onLink) => { onLink = callback; return () => {}; } };
  remote = new RemoteJobs(network as any, env.home, nullLogger, vi.fn());
  return { network, handlers, aliases, remote, lose: () => { available = false; onLink?.({ id: "11111111-1111-4111-8111-111111111111", name: "paired" }); },
    receive: (payload: any) => handlers.get("remote-job")!(payload, { id: "11111111-1111-4111-8111-111111111111", name: "paired", fingerprint: "fixture-paired-fingerprint" }) };
}
const spawn = () => ({ op: "spawn" as const, job: "1234abcd", target: "codex" as const, args: { prompt: "Original accepted input", title: "Ledger", cwd: env.home } });
it.each(["spawn", "state", "cancel", "answer"])("refuses old executor before %s dispatch or a pending RPC is created", async operation => {
  const f = boundary(); f.lose();
  const request = operation === "spawn" ? spawn() : operation === "state" ? { op: "state", job: "1234abcd" } :
    operation === "cancel" ? { op: "control", job: "1234abcd", control: { type: "cancel" } } : { op: "approval", job: "1234abcd", id: randomUUID(), decision: "allow" };
  await expect(f.remote.request("paired", { id: "owner", name: "owner" }, request as any)).rejects.toMatchObject({ code: "protocol_mismatch", details: { runnerLedgerUnsupported: true } });
  expect(f.network.sendExtension).not.toHaveBeenCalled(); expect((f.remote as any).pending.size).toBe(0);
});
it.each(["spawn", "state", "control"])("refuses an old requester before %s lookup, execution or response effects", async op => {
  const f = boundary(); f.lose();
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
  expect(result.additionalCapabilities).toContain(REMOTE_RUNNER_LEDGER_CAPABILITY);
});
it("retains the exact unconfirmed spawn and later cancel across requester restart, without autoexecution or status settlement", async () => {
  env = makeEnv();
  const remoteJob = vi.fn(async () => { throw unsupportedRunnerLedger(true); });
  const node = { remoteJob } as any;
  const job = { id: "retained-job", name: "codex-job-retained", agent: "codex", startedAt: 123, queue: [], controller: new AbortController() } as any;
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
