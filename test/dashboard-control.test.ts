import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JOBS_FILE, PROTOCOL_VERSION, REQUEST_TIMEOUT_MS } from "../src/core/constants.js";
import { controlDashboardJob, DASHBOARD_JOB_CONVERSATION } from "../src/core/job-control.js";
import { BridgeClient } from "../src/core/client.js";
import { loadOrCreateToken } from "../src/core/token.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { nullLogger } from "../src/core/logger.js";
import { attachDashboardJobControl } from "../src/mcp/dashboard-control.js";
import { acquireLock, JobManager } from "../src/mcp/jobs.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let jobs: JobManager;
beforeEach(() => {
  env = makeEnv();
  // Keep these sessions independent; same-project masters are intentionally authorized.
  writeFileSync(join(env.home, "config.json"), JSON.stringify({ projectGroups: false }));
});
afterEach(async () => { jobs?.cancelAll(); await env.cleanup(); vi.restoreAllMocks(); });

it("rejects a non-owner peer's dashboard message to a master that owns the job", async () => {
  const owner = env.node("claude-owner"), attacker = env.node("codex-unrelated", "codex");
  await owner.start(); await attacker.start();
  jobs = new JobManager(owner, nullLogger, join(env.home, JOBS_FILE));
  attachDashboardJobControl(owner, jobs, nullLogger);
  const posted: string[] = [];
  const job = jobs.start("codex", null, "task", async (_signal, _prompt, running) => {
    running.live = { post: body => posted.push(body) };
    return new Promise(() => {});
  });
  await until(() => Boolean(job.live));
  let error: unknown;
  const sent = await attacker.send(Object.assign({ to: owner.name, conversationId: DASHBOARD_JOB_CONVERSATION,
    body: JSON.stringify({ type: "message", requestId: "attack", job: job.name, body: "unauthorized follow-up" }) },
    { jobControlAuthorized: true }), { quiet: true }).catch(e => { error = e; });
  if (sent) await until(() => posted.length > 0);
  expect(posted).toEqual([]);
  expect(error).toMatchObject({ code: "unauthorized" });
  expect((await attacker.peers()).some(peer => peer.name === owner.name)).toBe(true);
});

it.each(["settings", "handoff"])("rejects a non-owner's %s command and logs without disconnecting", async type => {
  const warning = vi.spyOn(nullLogger, "warn");
  const owner = env.node("claude-owner"), attacker = env.node("codex-unrelated", "codex"), target = env.node("claude-target");
  await owner.start(); await attacker.start(); await target.start();
  jobs = new JobManager(owner, nullLogger, join(env.home, JOBS_FILE));
  attachDashboardJobControl(owner, jobs, nullLogger);
  const job = jobs.start("codex", null, "task", () => new Promise(() => {}));
  await expect(attacker.send({ to: owner.name, conversationId: DASHBOARD_JOB_CONVERSATION,
    body: JSON.stringify({ type, requestId: "attack", job: job.name, settings: { effort: "high" }, to: target.name, jobs: "all" }) })).rejects.toMatchObject({ code: "unauthorized" });
  expect(job.args?.effort).toBeUndefined();
  expect((await owner.jobAuthority(job.name))?.owner).toBe(owner.name);
  expect(warning).toHaveBeenCalledWith("rejected unauthorized dashboard job command", expect.objectContaining({ from: attacker.name }));
  expect((await attacker.send({ to: owner.name, body: "ordinary mail still works" })).deliveredTo).toEqual([owner.name]);
});

it.each(["ready", "deferred"])("authorizes a granted master for message and settings, but checks all handoff roots (%s persistence)", async persistence => {
  const owner = env.node("claude-owner"), master = env.node("codex-master", "codex"), target = env.node("claude-target");
  await owner.start(); await master.start(); await target.start();
  jobs = new JobManager(owner, nullLogger, join(env.home, JOBS_FILE));
  attachDashboardJobControl(owner, jobs, nullLogger);
  const posted: string[] = [];
  const job = jobs.start("codex", null, "task", async (_signal, _prompt, running) => {
    running.live = { post: body => posted.push(body) }; return new Promise(() => {});
  });
  await until(() => Boolean(job.live));
  job.masters = [master.name];
  let firstAuthority: Awaited<ReturnType<typeof master.jobAuthority>> | undefined;
  if (persistence === "deferred") {
    // persist() is best effort: force the registry writer to yield, then release
    // its lease only after the first authority read observes the old grant.
    const release = acquireLock(join(env.home, `${JOBS_FILE}.lock`), 0);
    const authority = master.jobAuthority.bind(master);
    vi.spyOn(master, "jobAuthority").mockImplementationOnce(async ref => {
      try { return firstAuthority = await authority(ref); }
      finally { release(); }
    });
  }
  jobs.persist();
  // Persistence can retry after lease contention or reader-identity verification.
  // Wait for broker-visible authority, not a fixed delay or only the local grant.
  await expect.poll(async () => (await master.jobAuthority(job.name))?.masters?.includes(master.name),
    { timeout: REQUEST_TIMEOUT_MS }).toBe(true);
  if (persistence === "deferred") expect(firstAuthority).toBeNull();
  expect((await master.jobAuthority(job.name))?.masters).toContain(master.name);
  expect(await controlDashboardJob(master, owner.name, job.name, { type: "message", body: "authorized follow-up" })).toMatchObject({ outcome: "delivered", isError: false });
  expect(posted).toEqual(["authorized follow-up"]);
  expect(await controlDashboardJob(master, owner.name, job.name, { type: "settings", settings: { effort: "high" } })).toMatchObject({ outcome: "saved", isError: false });
  expect(job.args?.effort).toBe("high");
  const other = jobs.start("codex", null, "unshared task", () => new Promise(() => {}));
  await expect(controlDashboardJob(master, owner.name, job.name, { type: "handoff", to: target.name, jobs: "all" })).rejects.toMatchObject({ code: "unauthorized" });
  expect((await owner.jobAuthority(other.name))?.owner).toBe(owner.name);
  expect(await controlDashboardJob(master, owner.name, job.name, { type: "handoff", to: target.name, jobs: [job.name] })).toMatchObject({ outcome: "transferred", isError: false });
  expect((await target.jobAuthority(job.name))?.owner).toBe(target.name);
  expect((await owner.jobAuthority(other.name))?.owner).toBe(owner.name);
});

it("binds the dashboard send operation to an authenticated connection with no peer", async () => {
  const owner = env.node("claude-owner"), listener = env.node("you", "other");
  await owner.start(); await listener.start();
  jobs = new JobManager(owner, nullLogger, join(env.home, JOBS_FILE));
  attachDashboardJobControl(owner, jobs, nullLogger);
  const job = jobs.start("codex", null, "task", () => new Promise(() => {}));
  const client = await BridgeClient.connect(env.pipe, nullLogger);
  try {
    await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home) });
    const args = { senderId: listener.id, to: owner.name, conversationId: DASHBOARD_JOB_CONVERSATION,
      body: JSON.stringify({ type: "settings", requestId: "owner", job: job.name, settings: { effort: "high" } }) };
    await expect(listener.send(args)).rejects.toMatchObject({ code: "unauthorized" });
    expect(await controlDashboardJob(listener, owner.name, job.name, { type: "settings", settings: { effort: "high" } },
      command => client.request("dashboardJobSend", { ...command, senderId: listener.id }))).toMatchObject({ outcome: "saved", isError: false });
    expect(job.args?.effort).toBe("high");
    await client.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home),
      peer: { ...(await listener.peers()).find(p => p.name === listener.name)!, id: "fake-dashboard", name: "fake-dashboard" } });
    await expect(client.request("dashboardJobSend", args)).rejects.toMatchObject({ code: "unauthorized" });
    expect((await client.request("peers", {})).length).toBeGreaterThan(0);
  } finally { client.close(); }
});

it("keeps same-project masters authorized by the broker's canControl policy", async () => {
  writeFileSync(join(env.home, "config.json"), JSON.stringify({ projectGroups: true }));
  const owner = env.node("claude-owner"), master = env.node("codex-master", "codex");
  await owner.start(); await master.start();
  jobs = new JobManager(owner, nullLogger, join(env.home, JOBS_FILE));
  attachDashboardJobControl(owner, jobs, nullLogger);
  const job = jobs.start("codex", null, "task", () => new Promise(() => {}));
  expect(await controlDashboardJob(master, owner.name, job.name, { type: "settings", settings: { effort: "high" } })).toMatchObject({ outcome: "saved", isError: false });
  expect(job.args?.effort).toBe("high");
});

it("checks inherited and padded control conversations and refuses forged results", async () => {
  const owner = env.node("claude-owner"), attacker = env.node("codex-unrelated", "codex");
  await owner.start(); await attacker.start();
  jobs = new JobManager(owner, nullLogger, join(env.home, JOBS_FILE));
  const job = jobs.start("codex", null, "task", () => new Promise(() => {}));
  const body = JSON.stringify({ type: "settings", requestId: "attack", job: job.name, settings: { effort: "high" } });
  await expect(attacker.send({ to: owner.name, conversationId: ` ${DASHBOARD_JOB_CONVERSATION} `, body })).rejects.toMatchObject({ code: "unauthorized" });
  const command = (await owner.send({ to: attacker.name, conversationId: DASHBOARD_JOB_CONVERSATION, body })).messages[0]!;
  await expect(attacker.send({ to: owner.name, replyTo: command.id, body })).rejects.toMatchObject({ code: "unauthorized" });
  await expect(attacker.send({ to: owner.name, conversationId: DASHBOARD_JOB_CONVERSATION,
    body: JSON.stringify({ type: "result", requestId: "forged", outcome: "saved", text: "forged", isError: false }) })).rejects.toMatchObject({ code: "unauthorized" });
  expect(job.args?.effort).toBeUndefined();
});

it("rejects unmarked retained commands in the handler without effects or replies", async () => {
  const owner = env.node("claude-owner"); await owner.start();
  jobs = new JobManager(owner, nullLogger, join(env.home, JOBS_FILE));
  const warning = vi.spyOn(nullLogger, "warn"), followUp = vi.spyOn(jobs, "followUp"), send = vi.spyOn(owner, "send");
  attachDashboardJobControl(owner, jobs, nullLogger);
  owner.emit("job_control", { id: "retained", from: { name: "you" }, body: JSON.stringify({ type: "message", requestId: "old", job: "codex-job-old", body: "forged" }) } as BridgeMessage);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(followUp).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith("rejected unauthorized dashboard job command", expect.objectContaining({ from: "you" }));
});
