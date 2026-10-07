import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyPeers, startUi, summarizeRun, type RunSummary } from "../src/cli/ui.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { attachDashboardJobControl } from "../src/mcp/dashboard-control.js";
import { JobManager, type Job } from "../src/mcp/jobs.js";
import { loadConfig } from "../src/core/config.js";
import { JOBS_FILE } from "../src/core/constants.js";
import { DASHBOARD_JOB_CONVERSATION } from "../src/core/job-control.js";
import { setJobOutcome } from "../src/core/job-outcomes.js";

let env: TestEnv;
let ui: { url: string; close: () => Promise<void> };
let cookie = "";
const managers: JobManager[] = [];

beforeEach(async () => {
  env = makeEnv();
  ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger, models: async () => [{ agent: "codex", defaultModel: "test-model", models: ["test-model"], lines: ["- test-model (default): Test. Efforts: low, high"] }] });
  const first = await fetch(ui.url, { redirect: "manual" });
  expect(first.status).toBe(302);
  cookie = String(first.headers.get("set-cookie")).split(";")[0]!;
});
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.cancelAll();
  await ui.close();
  await env.cleanup();
});

const base = () => ui.url.replace(/\/\?t=.*$/, "");
const POST_HEADERS = () => ({ cookie, "x-agent-bridge": "1", "content-type": "application/json" });
const RUN = "2026-10-06-06-32-18-codex-dashboard";
function recordJob(owner: string, job: Job): void {
  mkdirSync(join(env.home, "runs"), { recursive: true });
  writeFileSync(join(env.home, "runs", `${RUN}.log`), "06:32:18 codex\n");
  writeFileSync(join(env.home, "runs", `${RUN}.json`), JSON.stringify({ by: owner, job: job.name }));
}

describe("web dashboard", () => {
  it("offers Continue for an interrupted retained record and resumes it through the available project master", async () => {
    const master = env.node("codex-master", "codex"); await master.start();
    const name = "codex-job-1234abcd";
    const backup = JSON.stringify({ version: 2, jobs: [{ id: "1234abcd", name, agent: "codex", owner: "claude-offline", projectRoot: env.home, workdir: env.home, startedAt: 1, status: "running", sessionId: "original-native-thread", prompt: "original task" }] });
    writeFileSync(join(env.home, "jobs.json.backup-1"), backup);
    const jobs = new JobManager(master, nullLogger, join(env.home, JOBS_FILE)); managers.push(jobs);
    const sessions: string[] = [];
    jobs.restore(() => (_body, session) => async () => { sessions.push(session); return { sessionId: session, text: "continued", isError: false, details: {} }; });
    attachDashboardJobControl(master, jobs, nullLogger);
    const page = await (await fetch(base(), { headers: { cookie } })).text();
    expect(page).toContain('g.status === "interrupted" ? "Continue" : "Send"');
    const r = await fetch(`${base()}/api/subagents/message`, { method: "POST", headers: POST_HEADERS(), body: JSON.stringify({ run: name, body: "Continue where you stopped and finish the task." }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ outcome: "delivered", isError: false });
    await until(() => sessions.length === 1);
    expect(sessions).toEqual(["original-native-thread"]);
    expect(readFileSync(join(env.home, "jobs.json.backup-1"), "utf8")).toBe(backup);
  });

  it("sets a year-long protected cookie and shows safe recovery for missing or invalid credentials", async () => {
    const first = await fetch(ui.url, { redirect: "manual" });
    expect(first.headers.get("set-cookie")).toContain("Max-Age=31536000; HttpOnly; SameSite=Strict; Path=/");
    for (const path of ["/", "/?t=wrong", "/api/state"]) {
      const response = await fetch(`${base()}${path}`);
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("/agent-bridge:dashboard");
      expect(html).toContain("agent-bridge ui");
      expect(html).toContain("<style>");
      expect(html).not.toContain(new URL(ui.url).searchParams.get("t"));
      expect(html).not.toContain("wrong");
    }
  });
  it("authenticates project main and availability actions using the existing custom controls", async () => {
    const a = env.node("claude-group"), b = env.node("codex-group", "codex"); await a.start(); await b.start();
    const body = JSON.stringify({ name: a.name, unavailable: true });
    expect((await fetch(`${base()}/api/coordinator/availability`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body })).status).toBe(403);
    expect((await fetch(`${base()}/api/coordinator/availability`, { method: "POST", headers: POST_HEADERS(), body })).status).toBe(200);
    expect((await b.peers()).find((p) => p.name === a.name)?.unavailable).toBe(true);
    expect((await fetch(`${base()}/api/project/main`, { method: "POST", headers: POST_HEADERS(), body: JSON.stringify({ to: b.name }) })).status).toBe(200);
    expect((await b.peers()).find((p) => p.name === b.name)?.projectMain).toBe(true);
    expect((await fetch(`${base()}/api/project/main`, { method: "POST", headers: POST_HEADERS(), body: JSON.stringify({ to: "paired/remote" }) })).status).toBe(400);
  });

  it("authenticates outcomes and derives legacy runs without rewriting their metadata", async () => {
    expect((await fetch(`${base()}/api/job-outcomes`)).status).toBe(403);
    const startedAt = Date.UTC(2026, 9, 6, 6, 32, 18);
    const job = { id: "deadbeef", name: "codex-job-deadbeef", owner: "supervisor", agent: "codex", model: null, prompt: "task", startedAt,
      status: "done", sessionId: null, workdir: null, worktree: { repoRoot: env.home, path: env.home, cwd: env.home, branch: "agent-bridge/deadbeef", base: "unknown", baseBranch: "main" } };
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify([job]));
    mkdirSync(join(env.home, "runs"), { recursive: true });
    writeFileSync(join(env.home, "runs", `${RUN}.log`), "06:32:18 codex\n06:32:19 finished after 1s · done\n");
    const legacy = JSON.stringify({ job: job.name, by: "supervisor", future: "keep" });
    const meta = join(env.home, "runs", `${RUN}.json`);
    writeFileSync(meta, legacy);
    setJobOutcome(env.home, job, "supervisor", "held", "CPU A/B", startedAt + 2_000);
    const response = await fetch(`${base()}/api/job-outcomes`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const state = await response.json() as any;
    expect(state.contractVersion).toBe(1);
    expect(state.jobs[job.name].outcome).toMatchObject({ delivery: { status: "unknown" }, merge: { state: "held", branch: job.worktree.branch, reason: "CPU A/B" } });
    expect(state.runs[RUN].merge.state).toBe("held");
    expect(state.groups).toEqual({ needsReview: [], held: [job.name], merged: [], discarded: [] });
    expect(readFileSync(meta, "utf8")).toBe(legacy);
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify([{ ...job, startedAt: startedAt + 10_000, remote: { host: "paired-pc", name: "remote-job" } }]));
    writeFileSync(meta, JSON.stringify({ job: job.name, by: "supervisor", jobStartedAt: startedAt + 10_000, remote: { host: "paired-pc", name: "remote-job" } }));
    const remote = await (await fetch(`${base()}/api/job-outcomes`, { headers: { cookie } })).json() as any;
    expect(remote.jobs[job.name].outcome.merge.reason).toContain("paired PC");
    expect(remote.runs[RUN].merge.reason).toContain("paired PC");
  });
  it("refuses requests without the secret, a wrong link or a foreign Host", async () => {
    expect((await fetch(`${base()}/api/state`)).status).toBe(403);
    expect((await fetch(`${base()}/?t=nope`)).status).toBe(403);
    // DNS-rebinding guard: fetch cannot override Host, so use a raw request.
    const u = new URL(base());
    const status = await new Promise<number>((resolve) => {
      request({ host: u.hostname, port: u.port, path: "/api/state", headers: { cookie, host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).end();
    });
    expect(status).toBe(403);
  });

  it("serves the page and the state: sessions, runs and messages", async () => {
    const page = await fetch(`${base()}/`, { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain("<title>agent-bridge</title>");
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(script[1]!)).not.toThrow();

    const peer = env.node("codex-app", "codex");
    await peer.start();
    mkdirSync(join(env.home, "runs"), { recursive: true });
    writeFileSync(join(env.home, "runs", "2026-09-29-06-32-18-opencode-ab12cd34.log"), "06:32:18 opencode in /w, access edit\n06:32:30 12s · step 1 (1 cmds) · bash: ls\n06:32:40 finished after 22s · done\n");

    const state = await (await fetch(`${base()}/api/state`, { headers: { cookie } })).json();
    expect(state.brokerPid).toBeTypeOf("number");
    expect(state.peers.map((p: { name: string }) => p.name)).toContain("codex-app");
    expect(state.runs[0]).toMatchObject({ name: "2026-09-29-06-32-18-opencode-ab12cd34", agent: "opencode", status: "done" });
    // Written next to the log by the run feed: who started it and which job it belongs to.
    writeFileSync(join(env.home, "runs", "2026-09-29-06-32-18-opencode-ab12cd34.json"), JSON.stringify({ by: "claude-app", job: "opencode-job-1", session: "ses_1", title: "Fix castle gates" }));
    const withMeta = await (await fetch(`${base()}/api/state`, { headers: { cookie } })).json();
    expect(withMeta.runs[0]).toMatchObject({ by: "claude-app", job: "opencode-job-1", session: "ses_1", workdir: "/w", title: "Fix castle gates" });

    const log = await (await fetch(`${base()}/api/runs/2026-09-29-06-32-18-opencode-ab12cd34?from=0`, { headers: { cookie } })).json();
    expect(log.text).toContain("bash: ls");
    expect((await fetch(`${base()}/api/runs/..%2F..%2Fsecret`, { headers: { cookie } })).status).toBe(404);
  });

  it("sends a message as 'you' and shows it in the history", async () => {
    const peer = env.node("claude-app", "claude");
    await peer.start();
    const noHeader = await fetch(`${base()}/api/send`, { method: "POST", headers: { cookie }, body: JSON.stringify({ to: "claude-app", body: "hi" }) });
    expect(noHeader.status).toBe(403);
    const r = await fetch(`${base()}/api/send`, {
      method: "POST",
      headers: { cookie, "x-agent-bridge": "1", "content-type": "application/json" },
      body: JSON.stringify({ to: "claude-app", body: "hello from the dashboard" }),
    });
    expect(await r.json()).toMatchObject({ deliveredTo: ["claude-app"] });
    expect((await peer.waitForMessage(2_000))?.body).toBe("hello from the dashboard");
    const state = await (await fetch(`${base()}/api/state`, { headers: { cookie } })).json();
    expect(state.messages[0]).toMatchObject({ from_name: "you", body: "hello from the dashboard" });
  });

  it("shows restricted job reply guidance in a dashboard send result", async () => {
    const peer = env.node("claude-owner", "claude"); await peer.start();
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ version: 4, jobs: [{ id: "one", name: "codex-job-one", agent: "codex", owner: peer.name, rootName: peer.name, supervisor: "root", status: "running", workdir: env.home }] }));
    const r = await fetch(`${base()}/api/send`, { method: "POST", headers: POST_HEADERS(), body: JSON.stringify({ to: "codex-job-one", body: "Please answer" }) });
    expect(r.status).toBe(200);
    const result = await r.json();
    expect(result.replyRestrictions).toEqual([{ name: "codex-job-one", supervisor: peer.name }]);
    expect(result.replyGuidance[0]).toContain("can't reply to you directly. Its replies go to its supervisor claude-owner");
  });

  it("concurrent first sends share one sender peer", async () => {
    const peer = env.node("claude-app", "claude");
    await peer.start();
    const post = (body: string) =>
      fetch(`${base()}/api/send`, {
        method: "POST",
        headers: { cookie, "x-agent-bridge": "1", "content-type": "application/json" },
        body: JSON.stringify({ to: "claude-app", body }),
      }).then((r) => r.json());
    const results = await Promise.all([post("one"), post("two"), post("three")]);
    expect(results.every((r) => r.deliveredTo?.[0] === "claude-app")).toBe(true);
    const senders = (await peer.peers()).filter((p) => p.agent === "other").map((p) => p.name);
    expect(senders).toEqual(["you"]);
  });

  it("routes a dashboard message live to only the selected job, without waking the parent", async () => {
    const peer = env.node("claude-owner", "claude");
    await peer.start();
    const jobs = new JobManager(peer, nullLogger);
    managers.push(jobs);
    attachDashboardJobControl(peer, jobs, nullLogger);
    const received: string[] = [], other: string[] = [];
    const job = jobs.start("codex", null, "task", async (_s, _p, j) => {
      j.live = { post: (text) => received.push(text) };
      return new Promise(() => {});
    });
    jobs.start("codex", null, "other task", async (_s, _p, j) => {
      j.live = { post: (text) => other.push(text) };
      return new Promise(() => {});
    });
    recordJob(peer.name, job);
    const r = await fetch(`${base()}/api/subagents/message`, { method: "POST", headers: POST_HEADERS(), body: JSON.stringify({ run: RUN, body: "check the tests" }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ outcome: "delivered", isError: false });
    expect(received).toEqual(["check the tests"]);
    expect(other).toEqual([]);
    expect(peer.unread()).toEqual([]);
    const state = await (await fetch(`${base()}/api/state`, { headers: { cookie } })).json();
    expect(state.messages).toEqual([]);
  });

  it("continues a finished job with its own session and folder", async () => {
    const peer = env.node("claude-owner", "claude");
    await peer.start();
    const jobs = new JobManager(peer, nullLogger);
    managers.push(jobs);
    attachDashboardJobControl(peer, jobs, nullLogger);
    const calls: unknown[] = [];
    const job = jobs.start("codex", null, "task", async () => ({ sessionId: "thread-1", text: "done", isError: false, details: {}, workdir: env.home }), (body, sessionId, workdir) => async () => {
      calls.push({ body, sessionId, workdir });
      return { sessionId, text: "continued", isError: false, details: {} };
    });
    await until(() => job.status === "done");
    recordJob(peer.name, job);
    const r = await fetch(`${base()}/api/subagents/message`, { method: "POST", headers: POST_HEADERS(), body: JSON.stringify({ run: RUN, body: "one more thing" }) });
    expect(await r.json()).toMatchObject({ outcome: "started", isError: false });
    expect(calls).toEqual([{ body: "one more thing", sessionId: "thread-1", workdir: env.home }]);
  });

  it("uses the current owner when a session adopted a job from a former name", async () => {
    const peer = env.node("current-owner", "claude");
    await peer.start();
    const jobs = new JobManager(peer, nullLogger);
    managers.push(jobs);
    attachDashboardJobControl(peer, jobs, nullLogger);
    const received: string[] = [];
    const job = jobs.start("codex", null, "task", async (_s, _p, j) => {
      j.live = { post: (body) => received.push(body) };
      return new Promise(() => {});
    });
    recordJob("former-owner", job);
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify([{ name: job.name, owner: peer.name }]));
    const r = await fetch(`${base()}/api/subagents/message`, { method: "POST", headers: POST_HEADERS(), body: JSON.stringify({ run: RUN, body: "after adoption" }) });
    expect(r.status).toBe(200);
    expect(received).toEqual(["after adoption"]);
  });

  it("finds the current owner in the versioned job store too", async () => {
    const peer = env.node("current-owner", "claude");
    await peer.start();
    const jobs = new JobManager(peer, nullLogger);
    managers.push(jobs);
    attachDashboardJobControl(peer, jobs, nullLogger);
    const received: string[] = [];
    const job = jobs.start("codex", null, "task", async (_s, _p, j) => {
      j.live = { post: (body) => received.push(body) };
      return new Promise(() => {});
    });
    recordJob("former-owner", job);
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ version: 1, jobs: [{ name: job.name, owner: peer.name }] }));
    const r = await fetch(`${base()}/api/subagents/message`, { method: "POST", headers: POST_HEADERS(), body: JSON.stringify({ run: RUN, body: "after adoption" }) });
    expect(r.status).toBe(200);
    expect(received).toEqual(["after adoption"]);
  });

  it("reads and saves the global native subagent default without changing other config", async () => {
    const fs = await import("node:fs");
    fs.writeFileSync(join(env.home, "config.json"), JSON.stringify({ name: "keep", custom: { data: "keep" }, codex: { effort: "high" } }));
    const url = `${base()}/api/config/codex-subagents`;
    expect((await fetch(url)).status).toBe(403);
    expect(await (await fetch(url, { headers: { cookie } })).json()).toEqual({ codexSubagents: 6, defaultCodexSubagents: 6, maxCodexSubagents: 32 });
    expect((await fetch(url, { method: "POST", headers: { cookie }, body: "{}" })).status).toBe(403);
    for (const value of [-1, 33, 1.5, "2", null]) expect((await fetch(url, { method: "POST", headers: POST_HEADERS(), body: JSON.stringify({ codexSubagents: value }) })).status).toBe(400);
    for (const value of [0, 32]) {
      const response = await fetch(url, { method: "POST", headers: POST_HEADERS(), body: JSON.stringify({ codexSubagents: value }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ codexSubagents: value });
      expect(loadConfig(env.home, "codex", nullLogger, {}).codexSubagents).toBe(value);
    }
    expect(JSON.parse(fs.readFileSync(join(env.home, "config.json"), "utf8"))).toMatchObject({ name: "keep", custom: { data: "keep" }, codex: { effort: "high" } });
    expect((await fetch(url, { method: "POST", headers: POST_HEADERS(), body: JSON.stringify({ codexSubagents: 2, unknown: true }) })).status).toBe(400);
    expect((await fetch(url, { method: "POST", headers: POST_HEADERS(), body: "{" })).status).toBe(400);
  });

  it("saves a job's next-turn settings without continuing it, and lists them in the state", async () => {
    const peer = env.node("claude-owner", "claude");
    await peer.start();
    const jobs = new JobManager(peer, nullLogger, join(env.home, JOBS_FILE));
    managers.push(jobs);
    attachDashboardJobControl(peer, jobs, nullLogger);
    const received: string[] = [];
    const job = jobs.start("codex", null, "task", async (_s, _p, j) => {
      j.live = { post: (body) => received.push(body) };
      return new Promise(() => {});
    });
    recordJob(peer.name, job);
    const post = (settings: unknown) => fetch(`${base()}/api/subagents/settings`, { method: "POST", headers: POST_HEADERS(), body: JSON.stringify({ run: RUN, settings }) });
    const r = await post({ model: "gpt-6-luna", effort: "high", sandbox: "danger-full-access", native_subagents: 0 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ outcome: "saved", isError: false, text: expect.stringContaining("Applies from its next turn") });
    expect(job.args).toMatchObject({ model: "gpt-6-luna", effort: "high", sandbox: "danger-full-access", native_subagents: 0 });
    expect(received).toEqual([]);
    expect(job.queue).toEqual([]);
    const state = await (await fetch(`${base()}/api/state`, { headers: { cookie } })).json();
    expect(state.jobs[job.name].next).toMatchObject({ model: "gpt-6-luna", effort: "high", sandbox: "danger-full-access", native_subagents: 0 });

    const wrongAgent = await post({ permission_mode: "bypassPermissions" });
    expect(wrongAgent.status).toBe(409);
    expect(await wrongAgent.json()).toMatchObject({ outcome: "invalid", text: "permission_mode applies only to claude jobs." });
    expect((await post({ effort: "high; rm" })).status).toBe(409);
    expect((await post({ owner: "someone-else" })).status).toBe(409);
    expect((await post({})).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect(job.args).not.toHaveProperty("permission_mode");
  });

  it("ignores malformed control commands and does not route another session's restored job", async () => {
    const peer = env.node("owner", "claude"), sender = env.node("test-sender", "other");
    await peer.start();
    await sender.start();
    const jobs = new JobManager(peer, nullLogger);
    managers.push(jobs);
    attachDashboardJobControl(peer, jobs, nullLogger);
    const job = jobs.start("codex", null, "foreign task", async () => new Promise(() => {}));
    job.owner = "another-session";
    const sent = await sender.send({ to: peer.name, body: "null", conversationId: DASHBOARD_JOB_CONVERSATION }, { quiet: true });
    await until(() => peer.hasSeen(sent.messages[0]!.id));
    expect(peer.unread()).toEqual([]);
    recordJob(peer.name, job);
    const r = await fetch(`${base()}/api/subagents/message`, { method: "POST", headers: POST_HEADERS(), body: JSON.stringify({ run: RUN, body: "wrong owner" }) });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ outcome: "unknown" });
    expect(job.queue).toEqual([]);
  });

  it("authenticates job messages and rejects missing metadata, invalid input and unavailable jobs", async () => {
    const post = (args: unknown, headers = POST_HEADERS()) => fetch(`${base()}/api/subagents/message`, { method: "POST", headers, body: JSON.stringify(args) });
    expect((await post({ run: RUN, body: "hi" }, { "x-agent-bridge": "1", "content-type": "application/json" } as ReturnType<typeof POST_HEADERS>)).status).toBe(403);
    expect((await post({ run: RUN, body: "hi" }, { cookie } as ReturnType<typeof POST_HEADERS>)).status).toBe(403);
    expect((await post({ run: "../secret", body: "hi" })).status).toBe(400);
    expect((await post({ run: RUN, body: " " })).status).toBe(400);
    expect((await post({ run: RUN, body: "hi" })).status).toBe(404);
    mkdirSync(join(env.home, "runs"), { recursive: true });
    writeFileSync(join(env.home, "runs", `${RUN}.log`), "06:32:18 codex\n");
    expect((await post({ run: RUN, body: "hi" })).status).toBe(409);
    writeFileSync(join(env.home, "runs", `${RUN}.json`), JSON.stringify({ by: "offline", job: "codex-job-missing" }));
    const offline = await post({ run: RUN, body: "hi" });
    expect(offline.status).toBe(409);
    expect(await offline.json()).toMatchObject({ error: expect.stringContaining("not connected") });
    const peer = env.node("offline", "claude");
    await peer.start();
    const jobs = new JobManager(peer, nullLogger);
    managers.push(jobs);
    attachDashboardJobControl(peer, jobs, nullLogger);
    const missing = await post({ run: RUN, body: "hi", to: "another-session", job: "ignored" });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ outcome: "unknown", isError: true });
  });

  it("serves models and defaults only to an authenticated dashboard", async () => {
    expect((await fetch(`${base()}/api/models`)).status).toBe(403);
    const r = await fetch(`${base()}/api/models`, { headers: { cookie } });
    expect(await r.json()).toMatchObject({ reports: [{ agent: "codex", defaultModel: "test-model", models: ["test-model"] }] });
  });
});

describe("summarizeRun", () => {
  it("detects running, failed and interrupted runs", () => {
    const f = "2026-09-29-06-32-18-codex-x.log";
    expect(summarizeRun(f, "06:32:18 h\n06:33:00 1m · step 3 · bash: x\n", 1_000, 2_000).status).toBe("running");
    expect(summarizeRun(f, "06:32:18 h\n06:40:00 finished after 400s · failed: boom\n", 1_000, 2_000).status).toBe("failed");
    expect(summarizeRun(f, "06:32:18 h\n", 0, 10 * 60_000).status).toBe("interrupted");
  });

  it("reads who started a run and the task from older logs", () => {
    const r = summarizeRun("2026-09-29-06-32-18-codex-x.log", "06:32:18 codex in /w, access read, by claude-app, continues th-1\n         fix the bug\n         in main.ts\n         ---\n06:32:19 started · x\n", 1_000, 2_000);
    expect(r).toMatchObject({ by: "claude-app", workdir: "/w", continues: "th-1", task: "fix the bug in main.ts" });
  });
});

describe("classifyPeers", () => {
  it("nests sessions in a subagent worktree under the session that ran it", () => {
    const peer = (name: string, cwd: string) => ({ id: name, name, agent: "codex", cwd, pid: 1, agentPid: null, sessionId: null, startedAt: 0, autoWake: false }) as PeerInfo;
    const home = "/h/.agent-bridge";
    const runs = [{ by: "claude-app", workdir: "/h/.agent-bridge/worktrees/app-1a2b" } as RunSummary];
    const out = classifyPeers([peer("claude-app", "/w/app"), peer("codex-app-1a2b", "/h/.agent-bridge/worktrees/app-1a2b/")], runs, home);
    expect(out.map((p) => [p.subagent, p.parent])).toEqual([
      [false, null],
      [true, "claude-app"],
    ]);
  });
});

describe("network helpers", () => {
  it("shows the broker's fixed refusals but never text that could hold a pairing code", async () => {
    const { safeNetworkError } = await import("../src/cli/ui.js");
    const { BridgeError } = await import("../src/core/protocol.js");
    expect(safeNetworkError(new BridgeError("bad_request", "networking is disabled or unavailable; enable it and restart the broker"))).toContain("networking is disabled");
    expect(safeNetworkError(new BridgeError("bad_request", "bad code eyJ2IjoxLCJpZCI6ImFiYyJ9eyJ2IjoxLCJpZCI6"))).toBeNull();
    expect(safeNetworkError(new Error("Unexpected token in JSON"))).toBeNull();
  });

  it("lists this PC's LAN IPv4 addresses only", async () => {
    const { lanAddresses } = await import("../src/cli/ui.js");
    const nic = (address: string, family: "IPv4" | "IPv6", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null });
    expect(lanAddresses({ lo: [nic("127.0.0.1", "IPv4", true)], eth: [nic("192.168.1.20", "IPv4"), nic("fe80::1", "IPv6")], apipa: [nic("169.254.3.4", "IPv4")] } as any)).toEqual(["192.168.1.20"]);
  });
});
