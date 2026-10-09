import { BridgeNode } from "../src/core/node.js";
import { indexFixtureFile } from "./archive-fixture.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { JobManager, readStore, type JobHost } from "../src/mcp/jobs.js";
import { nullLogger } from "../src/core/logger.js";
import { CODING_AGENTS } from "../src/core/protocol.js";
let env: TestEnv;
const managers: JobManager[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { for (const m of managers.splice(0)) m.cancelAll(); await env.cleanup(); });
function manager(node: ReturnType<TestEnv["node"]>, host?: JobHost) {
  const m = new JobManager(node, nullLogger, join(env.home, "jobs.json"));
  if (host) m.runners = host;
  managers.push(m); return m;
}

it.each(CODING_AGENTS)("continues an interrupted %s run with its retained native session after registry loss", async (agent) => {
  const owner = env.node("claude-owner"); await owner.start();
  const name = `${agent}-job-aabbccdd`, run = `2026-10-06-01-02-03-${agent}-aabbccdd`;
  mkdirSync(join(env.home, "runs"));
  const meta = JSON.stringify({ by: owner.name, byCwd: env.home, job: name, session: "original-thread", workdir: env.home, access: "read", title: "Recover me" });
  writeFileSync(join(env.home, "runs", `${run}.json`), meta);
  const log = "01:02:03 header\n         original task\n         ---\n01:02:04 started · fixture\n";
  writeFileSync(join(env.home, "runs", `${run}.log`), log);
  const jobs = manager(owner), calls: unknown[] = [];
  jobs.restore((_agent, args) => (body, session, cwd) => async () => {
    calls.push({ agent: _agent, args, body, session, cwd });
    return { sessionId: session, text: "resumed", isError: false, details: {} };
  });
  await jobs.share(name);
  expect(jobs.followUp(name, "finish it").outcome).toBe("started");
  await until(() => jobs.find(name)?.status === "done");
  expect(calls).toMatchObject([{ agent, body: "finish it", session: "original-thread", cwd: env.home }]);
  expect(readStore(join(env.home, "jobs.json"))).toMatchObject([{ name, sessionId: "original-thread" }]);
  expect(readFileSync(join(env.home, "runs", `${run}.json`), "utf8")).toBe(meta);
  expect(readFileSync(join(env.home, "runs", `${run}.log`), "utf8")).toBe(log);
});

it("recovers a 0.29.10 backup with current handoff authority and preserves unknown data", async () => {
  const old = env.node("claude-old"), next = env.node("codex-next", "codex"), outsider = env.node("other", "other");
  await old.start(); await next.start(); await outsider.start();
  const name = "codex-job-11223344", snapshot = JSON.stringify({ version: 2, custom: "keep", jobs: [{ id: "11223344", name, agent: "codex", owner: old.name, status: "running", sessionId: "native-29-10", startedAt: 1, workdir: env.home, prompt: "original", args: { access: "ask" }, custom: { future: "keep" } }] });
  writeFileSync(join(env.home, "jobs.json.backup-v2-1"), snapshot);
  // A later handoff snapshot must win over original launch/run ownership.
  mkdirSync(join(env.home, "archive"));
  writeFileSync(join(env.home, "archive", "jobs-2-new.json"), JSON.stringify({ version: 3, jobs: [{ id: "11223344", name, agent: "codex", owner: next.name, rootName: next.name, status: "interrupted", sessionId: "native-29-10", startedAt: 1, prompt: "original", custom: { future: "keep" } }] }));
  // readHistoryJobs orders by timestamp, so use a genuinely newer backup for the handoff.
  writeFileSync(join(env.home, "jobs.json.backup-v3-3"), JSON.stringify({ jobs: [{ id: "11223344", name, owner: next.name, rootName: next.name, masters: [next.name], ownershipHistory: [{ from: old.name, to: next.name }], agent: "codex", sessionId: "native-29-10", startedAt: 1, status: "interrupted", prompt: "original", custom: { future: "keep" } }] }));
  expect(await outsider.jobAuthority(name)).toBeNull();
  indexFixtureFile(join(env.home, "jobs.json.backup-v2-1"));
  indexFixtureFile(join(env.home, "archive", "jobs-2-new.json"));
  indexFixtureFile(join(env.home, "jobs.json.backup-v3-3"));
  const jobs = manager(next); jobs.restore(() => (_body, session) => async () => ({ sessionId: session, text: "done", isError: false, details: {} }));
  expect((await jobs.share(name))?.owner).toBe(next.name);
  expect(jobs.followUp(name, "recover").outcome).toBe("started");
  await until(() => jobs.find(name)?.status === "done");
  expect(JSON.parse(readFileSync(join(env.home, "jobs.json"), "utf8")).jobs[0].custom).toEqual({ future: "keep" });
  expect(readFileSync(join(env.home, "jobs.json.backup-v2-1"), "utf8")).toBe(snapshot);
});

it("attaches and cancels an orphan live runner instead of starting a second native turn", async () => {
  const owner = env.node("claude-owner"); await owner.start();
  mkdirSync(join(env.home, "jobs"));
  const name = "codex-job-aabbccdd";
  writeFileSync(join(env.home, "jobs", "aabbccdd.spec.json"), JSON.stringify({ cwd: env.home, base: { access: "ask" }, job: { id: "aabbccdd", name, agent: "codex", owner: owner.name, status: "running", startedAt: 1, prompt: "task" } }));
  writeFileSync(join(env.home, "jobs", "aabbccdd.json"), JSON.stringify({ pid: process.pid, peer: name, status: "running", sessionId: "live-thread", updatedAt: Date.now(), live: true }));
  const send = vi.fn();
  const host: JobHost = { state: () => ({ pid: process.pid, peer: name, status: "running", sessionId: "live-thread", updatedAt: Date.now(), live: true }), alive: () => true, send, kill: vi.fn() };
  const jobs = manager(owner, host); jobs.restore(() => () => async () => { throw new Error("must not resume live runner"); });
  await jobs.share(name);
  expect(jobs.followUp(name, "status").outcome).toBe("delivered");
  expect(jobs.cancel(name)).toBe(true);
  expect(send.mock.calls.map((c) => c[1].type)).toEqual(["message", "cancel"]);
  expect(jobs.find(name)?.sessionId).toBe("live-thread");
  jobs.find(name)!.host = null;
});

it("lets a project master continue a nested orphan with the saved thread through current routing", async () => {
  const master = env.node("codex-master", "codex"), outsider = env.node("outsider", "other");
  await master.start(); await outsider.start();
  mkdirSync(join(env.home, "runs"));
  const name = "opencode-job-55667788", run = "2026-10-06-01-02-03-opencode-55667788";
  writeFileSync(join(env.home, "runs", `${run}.log`), "01:02:03 header\n         task\n         ---\n");
  writeFileSync(join(env.home, "runs", `${run}.json`), JSON.stringify({ by: "claude-job-parent", parentJob: "claude-job-parent", rootSession: "root-session", byCwd: env.home, job: name, session: "nested-original-thread", workdir: env.home }));
  expect(await outsider.jobAuthority(name)).toBeNull();
  const jobs = manager(master), sessions: string[] = [];
  jobs.restore(() => (_body, session) => async () => { sessions.push(session); return { sessionId: session, text: "done", isError: false, details: {} }; });
  await jobs.share(name);
  expect(jobs.followUp(name, "continue").outcome).toBe("delivered");
  await until(() => jobs.find(name)?.status === "done");
  expect(sessions).toEqual(["nested-original-thread"]);
});

it("recognizes cancellation of an interrupted job without discarding its resume context", async () => {
  const owner = env.node("claude-owner"); await owner.start();
  const name = "codex-job-99887766";
  writeFileSync(join(env.home, "jobs.json.backup-1"), JSON.stringify([{ id: "99887766", name, agent: "codex", owner: owner.name, status: "running", sessionId: "original", startedAt: 1, prompt: "task" }]));
  indexFixtureFile(join(env.home, "jobs.json.backup-1"));
  const jobs = manager(owner); jobs.restore(() => (_body, session) => async () => ({ sessionId: session, text: "done", isError: false, details: {} }));
  await jobs.share(name);
  expect(jobs.cancel(name)).toBe(true);
  expect(jobs.find(name)).toMatchObject({ status: "cancelled", sessionId: "original" });
  expect(jobs.followUp(name, "continue").outcome).toBe("started");
  await until(() => jobs.find(name)?.status === "done");
});

it.each(CODING_AGENTS)("recovers ordinary %s runner jobs created after restore", async (agent) => {
  const owner = env.node("supervisor", agent); await owner.start();
  const host: JobHost = { state: () => ({ pid: process.pid, peer: "runner", status: "running", updatedAt: Date.now(), live: true }), alive: () => true, send: vi.fn(), kill: vi.fn() };
  const jobs = manager(owner, host); jobs.restore(() => () => async () => { throw new Error("duplicate native run"); });
  const name = `${agent}-job-reloaded`;
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ jobs: [{ id: "reloaded", name, agent, owner: owner.name,
    supervisor: "durable-supervisor", status: "running", host: { pid: process.pid, peer: name, startedAt: Date.now() }, startedAt: Date.now(), prompt: "task" }] }));
  expect(jobs.list().map((job) => job.name)).toContain(name);
  expect(jobs.followUp(name, "status").outcome).toBe("delivered");
  expect(jobs.cancel(name)).toBe(true);
  expect(vi.mocked(host.send).mock.calls.map((call) => call[1].type)).toEqual(["attach", "message", "cancel"]);
  jobs.find(name)!.host = null;
});

it("discovers and controls a connected orphan runner retained only in a backup", async () => {
  const owner = env.node("supervisor"); await owner.start();
  const name = "codex-job-retained";
  const record = { id: "retained", name, agent: "codex", owner: owner.name, rootName: owner.name, supervisor: "root",
    status: "running", host: { pid: process.pid, peer: name, startedAt: 1 }, startedAt: 1, prompt: "task" };
  writeFileSync(join(env.home, "jobs.json.backup-1"), JSON.stringify({ jobs: [record] }));
  indexFixtureFile(join(env.home, "jobs.json.backup-1"));
  mkdirSync(join(env.home, "jobs"));
  writeFileSync(join(env.home, "jobs", "retained.json"), JSON.stringify({ pid: process.pid, peer: name, status: "running", updatedAt: Date.now() - 120_000, live: true }));
  const runner = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), agent: "other", jobAgent: "codex", id: "job:retained", name, cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
  try {
    await runner.start();
    expect((await owner.projectJobs()).map((job) => job.name)).toContain(name);
    expect(await owner.jobAuthority(name)).toMatchObject({ name, owner: owner.name, status: "running" });
    await expect(owner.send({ to: name, body: "status" })).rejects.toThrow("No message was stored");
  } finally { await runner.stop(); }
});

it("reattaches a same-session runner when hello reclaims the original supervisor name", async () => {
  const owner = env.node("supervisor", "codex"); await owner.start(); await owner.setSessionId("same-native-session");
  const name = "codex-job-reload", startedAt = Date.now();
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ jobs: [{ id: "reload", name, agent: "codex", owner: owner.name,
    supervisor: "same-native-session", status: "running", host: { pid: process.pid, peer: name, startedAt }, startedAt, prompt: "task" }] }));
  const replacement = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), agent: "codex", name: "supervisor-2", cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
  const host: JobHost = { state: () => ({ pid: process.pid, peer: name, status: "running", updatedAt: Date.now(), live: true }), alive: () => true, send: vi.fn(), kill: vi.fn() };
  const jobs = manager(replacement, host); jobs.restore(() => () => async () => { throw new Error("duplicate native run"); });
  try {
    await replacement.setSessionId("same-native-session"); await replacement.start();
    expect(replacement.name).toBe("supervisor");
    expect(jobs.list().map((job) => job.name)).toContain(name);
    expect(jobs.followUp(name, "status").outcome).toBe("delivered");
    expect(jobs.cancel(name)).toBe(true);
    expect(vi.mocked(host.send).mock.calls.map((call) => call[1].type)).toEqual(["attach", "message", "cancel"]);
  } finally { jobs.find(name)!.host = null; await replacement.stop(); }
});
