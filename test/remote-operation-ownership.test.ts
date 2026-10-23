import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteJobHost } from "../src/mcp/remote-job-host.js";
import { JobRunners } from "../src/mcp/job-host.js";
import type { Job, RunnerControl } from "../src/mcp/jobs.js";
import { BridgeError } from "../src/core/protocol.js";
import { nullLogger } from "../src/core/logger.js";
import { remoteJobSnapshotSchema, type RemoteJobRequest } from "../src/network/remote-job-protocol.js";
import type { RemoteJobSnapshot } from "../src/network/remote-jobs.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
interface Deferred { promise: Promise<RemoteJobSnapshot>; resolve: (value: RemoteJobSnapshot) => void; reject: (error: unknown) => void }
const pending: Deferred[] = [];
function snapshot(status: "running" | "cancelled" = "running"): RemoteJobSnapshot {
  return remoteJobSnapshotSchema.parse({ state: { pid: 7, peer: "codex-job-1234abcd", status, updatedAt: Date.now() },
    alive: status === "running", approvals: [] });
}
function deferred(): Deferred {
  let resolve!: (value: RemoteJobSnapshot) => void, reject!: (error: unknown) => void;
  const promise = new Promise<RemoteJobSnapshot>((yes, no) => { resolve = yes; reject = no; });
  const item = { promise, resolve, reject }; pending.push(item); return item;
}
afterEach(async () => {
  for (const item of pending.splice(0)) item.resolve(snapshot());
  // Drain actual RPC continuations/cleanup before closing the owned metadata handle.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  vi.useRealTimers(); vi.restoreAllMocks(); if (env) await env.cleanup();
});

it("keeps the actual remote kill fallback on the original live cancel without duplicate RPC or lost C1", async () => {
  const f = fixture(), runners = new JobRunners({ remoteJob: f.remoteJob } as any, env.home, "unused-cli", nullLogger);
  runners.start(f.job, { args: { prompt: "Original", title: "Fallback", cwd: env.home, host: "original-paired" }, target: "codex" } as any);
  await f.settled(); const first = deferred(), cancel = deferred(); f.responses.push(first, cancel);
  runners.send(f.job, message("C1 before remote kill")); runners.send(f.job, { type: "cancel" }); runners.kill(f.job);
  expect(f.remoteJob.mock.calls.map(([, req]) => req.op === "control" ? req.control.type : req.op)).toEqual(["spawn", "message", "cancel"]);
  first.resolve(snapshot()); cancel.resolve(snapshot("cancelled")); await f.settled();
  expect(runners.state(f.job)?.status).toBe("cancelled"); expect(f.remoteJob).toHaveBeenCalledTimes(3);
});

it("retains immutable CID/request bytes on caller mutation and refuses conflicting reuse before another dispatch", async () => {
  const f = fixture(); f.start(); await f.settled(); const first = deferred(); f.responses.push(first);
  const original = message("Exact original body") as Extract<RunnerControl, { type: "message" }>;
  f.host.send(f.job, original); const before = f.read().operations.at(-1); original.body = "Changed caller body";
  expect(() => f.host.send(f.job, original)).toThrow(/unsettled/);
  expect(f.read().operations.at(-1)).toEqual(before); expect(f.remoteJob).toHaveBeenCalledTimes(2);
  expect(f.remoteJob.mock.calls[1]![1]).toMatchObject({ control: { body: "Exact original body", cid: original.cid } });
  first.resolve(snapshot()); await f.settled();
  f.host.send(f.job, { ...original, body: "Exact original body" }); expect(f.remoteJob).toHaveBeenCalledTimes(2);
});

it.each(["synchronous", "malformed"])("cleans %s RPC evidence without fabricating failed/delivered status or borrowing another operation", async mode => {
  const f = fixture(); f.start(); await f.settled();
  if (mode === "synchronous") f.remoteJob.mockImplementationOnce(() => { throw new Error("fixture unknown failure"); });
  else f.remoteJob.mockResolvedValueOnce({ ...snapshot(), state: { ...snapshot().state!, peer: "host/invalid-wire-peer" } });
  f.host.send(f.job, message("Original unknown input")); f.host.send(f.job, { type: "cancel" });
  await vi.waitFor(() => expect(f.read().operations.at(-1).state).toBe("confirmed"));
  const before = f.remoteJob.mock.calls.length; f.host.send(f.job, message("Must remain held"));
  expect(f.remoteJob).toHaveBeenCalledTimes(before); expect(f.host.alive(f.job)).toBe(true);
  expect(f.read().operations[1].state).toBe(mode === "synchronous" ? "blocked" : "pending");
  expect(f.read().snapshot.state.status).not.toBe("failed");
});

it("refuses same-turn reexecution and invalid next-turn input before replacing a settled original cache", async () => {
  const f = fixture(); f.start(); await f.settled(); const before = f.read(), destination = { ...f.job.remote! };
  expect(() => f.start()).toThrow(/already recorded/);
  expect(() => f.host.start({ ...f.job, startedAt: 124 }, "different-host", "codex", { prompt: "", title: "Invalid" })).toThrow();
  expect(f.read()).toEqual(before); expect(f.job.remote).toEqual(destination); expect(f.remoteJob).toHaveBeenCalledOnce();
});
function fixture() {
  env = makeEnv();
  const responses: ReturnType<typeof deferred>[] = [];
  const remoteJob = vi.fn((_host: string, _request: RemoteJobRequest) => responses.shift()?.promise ?? Promise.resolve(snapshot()));
  const host = new RemoteJobHost({ remoteJob } as any, env.home, nullLogger);
  const job = { id: "1234abcd", name: "codex-job-1234abcd", agent: "codex", owner: "original-supervisor", supervisor: "original-session",
    rootSession: "original-root", startedAt: 123, queue: [], controller: new AbortController() } as unknown as Job;
  const start = () => host.start(job, "original-paired", "codex", { prompt: "Exact original input", title: "Owned operations", cwd: env.home });
  const read = () => JSON.parse(readFileSync(join(env.home, "remote-job-states", `${job.id}.json`), "utf8"));
  const settled = () => vi.waitFor(() => expect(read().operations.every((op: any) => op.state === "confirmed")).toBe(true));
  return { host, job, remoteJob, responses, start, read, settled };
}
const message = (body: string): RunnerControl => ({ type: "message", body, cid: randomUUID() });

it("does not replay a confirmed original cancel when its aborted spawn response settles later", async () => {
  const f = fixture(), spawn = deferred(), cancel = deferred(); f.responses.push(spawn, cancel);
  f.start(); f.job.controller.abort(); f.host.send(f.job, { type: "cancel" });
  cancel.resolve(snapshot("cancelled"));
  await vi.waitFor(() => expect(f.read().operations[1].state).toBe("confirmed"));
  const original = f.read().operations[1]; spawn.resolve(snapshot()); await f.settled();
  expect(f.remoteJob).toHaveBeenCalledTimes(2);
  expect(f.read().operations).toHaveLength(2); expect(f.read().operations[1]).toEqual(original);
  expect(f.read().snapshot.state.status).toBe("cancelled");
});

it.each(["message", "settings", "title", "effort", "attach", "pause"])("owns suspended post-spawn %s and overlapping C2/cancel without duplicate dispatch or stale settlement", async kind => {
  const f = fixture(); f.start(); await f.settled();
  const c1: RunnerControl = kind === "message" ? message("Exact C1 input") : kind === "settings" ? { type: "settings", settings: { model: "fixture-model" } } :
    kind === "title" ? { type: "title", title: "Original title" } : kind === "effort" ? { type: "effort", effort: "high" } :
      kind === "pause" ? { type: "pause", reason: "Original pause" } : { type: "attach" };
  const c2 = message("Exact C2 input"), c3 = message("Exact C3 input");
  const first = deferred(), second = deferred(), cancel = deferred(); f.responses.push(first, second, cancel);
  f.host.send(f.job, c1); const original = f.read().operations.at(-1);
  f.host.send(f.job, c1); // Same live operation coalesces, including settings.
  f.host.send(f.job, c2); f.host.send(f.job, { type: "cancel" });
  expect(f.remoteJob.mock.calls.map(([, req]) => req.op)).toEqual(["spawn", "control", "control", "control"]);
  expect(f.remoteJob.mock.calls.map(([host]) => host)).toEqual(Array(4).fill("original-paired"));
  expect(f.read().operations.slice(1).map((op: any) => op.state)).toEqual(["pending", "pending", "pending"]);
  first.resolve(snapshot());
  await vi.waitFor(() => expect(f.read().operations.find((op: any) => op.id === original.id).state).toBe("confirmed"));
  f.host.send(f.job, c3); f.host.send(f.job, c2);
  expect(f.remoteJob).toHaveBeenCalledTimes(5); // C1 cleanup cannot clear C2 ownership.
  cancel.resolve(snapshot("cancelled"));
  await vi.waitFor(() => expect(f.read().snapshot.state.status).toBe("cancelled"));
  second.resolve(snapshot()); await f.settled();
  expect(f.read().snapshot.state.status).toBe("cancelled"); // A late older response cannot resurrect it.
  expect(f.read().operations.find((op: any) => op.id === original.id)).toEqual({ ...original, state: "confirmed" });
  f.host.send(f.job, c2); expect(f.remoteJob).toHaveBeenCalledTimes(5); // Original CID already confirmed.
  expect(() => new RemoteJobHost({ remoteJob: f.remoteJob } as any, env.home, nullLogger).assertTurnAdmission(f.job)).not.toThrow();
});

it.each(["spawn", "poll"])("keeps C1 owned when a suspended %s finishes before C2 and cancellation", async kind => {
  const f = fixture(), activity = deferred(), c1 = deferred();
  if (kind === "spawn") { f.responses.push(activity); f.start(); }
  else {
    f.start(); await f.settled(); vi.useFakeTimers(); vi.setSystemTime(Date.now() + 4_000);
    f.responses.push(activity); f.host.state(f.job);
  }
  f.responses.push(c1); f.host.send(f.job, message("Still live C1"));
  activity.resolve(snapshot());
  // A wire response is not cleanup; let the original production chain complete.
  await vi.waitFor(() => expect(f.read().operations[0].state).toBe("confirmed"));
  await Promise.resolve(); await Promise.resolve();
  f.host.send(f.job, message("Next C2")); f.host.send(f.job, { type: "cancel" });
  expect(f.remoteJob.mock.calls.filter(([, req]) => req.op === "control")).toHaveLength(3);
  c1.resolve(snapshot()); await f.settled();
});

it.each(["failure", "timeout", "cancellation", "capability"])("retains exact %s evidence after live overlapping cancellation, cleans only that RPC and refuses restart replay", async mode => {
  const f = fixture(); f.start(); await f.settled();
  const original = deferred(), cancel = deferred(); f.responses.push(original, cancel);
  const c1 = message("Original unconfirmed input"); f.host.send(f.job, c1);
  const evidence = f.read().operations.at(-1); f.host.send(f.job, { type: "cancel" });
  expect(f.remoteJob).toHaveBeenCalledTimes(3);
  const error = mode === "timeout" ? new BridgeError("timeout", "fixture unknown response") : mode === "capability" ? new BridgeError("protocol_mismatch", "fixture incompatible") :
    mode === "cancellation" ? Object.assign(new Error("fixture aborted response"), { name: "AbortError" }) : new Error("fixture transport failure");
  original.reject(error); cancel.resolve(snapshot("cancelled"));
  await vi.waitFor(() => expect(f.read().operations.at(-1).state).toBe("confirmed"));
  const retained = f.read().operations.find((op: any) => op.id === evidence.id);
  expect(retained).toEqual({ ...evidence, state: "blocked" });
  const restarted = new RemoteJobHost({ remoteJob: f.remoteJob } as any, env.home, nullLogger);
  expect(restarted.alive(f.job)).toBe(true); // Unknown input is not a drained/acknowledged turn.
  expect(() => restarted.start({ ...f.job, startedAt: 124 }, "replacement-paired", "codex", { prompt: "must not replay", title: "Replacement" })).toThrow();
  restarted.send(f.job, message("New request held behind original unknown")); restarted.state(f.job);
  expect(f.remoteJob).toHaveBeenCalledTimes(3);
  expect(f.read().operations.find((op: any) => op.id === evidence.id)).toEqual(retained);
});

it.each(["owner", "host", "generation", "instance"])("does not lend live ownership to a replacement %s or accept its late result as current evidence", async dimension => {
  const f = fixture(); f.start(); await f.settled(); const response = deferred(); f.responses.push(response);
  f.host.send(f.job, message("Original held input")); const evidence = f.read().operations.at(-1);
  const replacement = { ...f.job, remote: { ...f.job.remote! } };
  if (dimension === "owner") replacement.supervisor = "another-session";
  if (dimension === "host") replacement.remote.host = "replacement-paired";
  if (dimension === "generation") replacement.startedAt++;
  const next = dimension === "instance" ? new RemoteJobHost({ remoteJob: f.remoteJob } as any, env.home, nullLogger) : f.host;
  expect(() => next.assertTurnAdmission(replacement)).toThrow();
  expect(f.read().operations.at(-1)).toEqual(evidence); expect(f.remoteJob).toHaveBeenCalledTimes(2);
  // A changed original context also cannot attribute its old RPC result to a new owner.
  if (dimension !== "instance") Object.assign(f.job, replacement);
  response.resolve(snapshot());
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(f.read().operations.at(-1)).toEqual(dimension === "instance" ? { ...evidence, state: "confirmed" } : evidence);
});
