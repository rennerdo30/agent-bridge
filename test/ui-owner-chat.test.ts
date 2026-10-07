import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startUi } from "../src/cli/ui.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { CLAUDE_SESSION, CODEX_CHILD, CODEX_SESSION, installTranscriptFixtures } from "./transcript-fixtures.js";
import { MAX_BODY_CHARS } from "../src/core/constants.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JOBS_FILE } from "../src/core/constants.js";
import { JobManager } from "../src/mcp/jobs.js";
import { attachDashboardJobControl } from "../src/mcp/dashboard-control.js";

let env: TestEnv, ui: Awaited<ReturnType<typeof startUi>>, cookie: string;
const queue = vi.fn(async (_thread: string, _text: string, _cwd: string) => "accepted" as "accepted" | "unsupported" | "unconfirmed");
const managers: JobManager[] = [];
const base = () => ui.url.replace(/\/\?t=.*$/, "");
const headers = () => ({ cookie, "x-agent-bridge": "1", "content-type": "application/json" });
const post = (name: string, body: unknown, extra = {}) => fetch(`${base()}/api/sessions/${encodeURIComponent(name)}/message`, { method: "POST", headers: { ...headers(), ...extra }, body: JSON.stringify(body) });
beforeEach(async () => {
  env = makeEnv(); queue.mockClear(); queue.mockResolvedValue("accepted");
  const fixtures = installTranscriptFixtures(env.home);
  ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger, transcripts: fixtures.paths, chatQueue: queue });
  const response = await fetch(ui.url, { redirect: "manual" });
  cookie = String(response.headers.get("set-cookie")).split(";")[0]!;
});
afterEach(async () => { for (const manager of managers.splice(0)) manager.cancelAll(); await ui.close(); await env.cleanup(); });

describe("authenticated local owner chat", () => {
  it("routes a delegated job child's parent note through its actual local job owner", async () => {
    const owner = env.node("claude-owner", "claude"); await owner.start();
    const jobs = new JobManager(owner, nullLogger); managers.push(jobs);
    attachDashboardJobControl(owner, jobs, nullLogger);
    const received: string[] = [];
    const job = jobs.start("codex", null, "task", async (_s, _p, j) => {
      j.live = { post: (text) => received.push(text) }; return new Promise(() => {});
    });
    const run = "2026-10-07-00-00-00-codex-parent";
    mkdirSync(join(env.home, "runs"), { recursive: true });
    writeFileSync(join(env.home, "runs", `${run}.log`), "00:00:00 codex\n");
    writeFileSync(join(env.home, "runs", `${run}.json`), JSON.stringify({ by: "former-owner", job: job.name, session: CODEX_SESSION }));
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify([{ name: job.name, owner: owner.name, agent: "codex", sessionId: CODEX_SESSION }]));
    const route = `${base()}/api/jobs/${job.name}/message`;
    const send = (data: unknown) => fetch(route, { method: "POST", headers: headers(), body: JSON.stringify(data) });
    expect((await send({ body: "child task", child: CODEX_CHILD })).status).toBe(409);
    expect(received).toEqual([]);
    expect((await send({ body: "child task", child: CODEX_CHILD, target: "parent" })).status).toBe(200);
    expect(received).toEqual([expect.stringContaining(`native subagent ${CODEX_CHILD}`)]);
    expect(queue).not.toHaveBeenCalled();
    expect((await send({ body: "forged", child: "foreign", target: "parent" })).status).toBe(404);
  });
  it("requires the UI cookie, custom header, JSON and local origin", async () => {
    for (const extra of [{ cookie: "" }, { "x-agent-bridge": "" }, { "content-type": "text/plain" }, { origin: "https://external.example" }, { "sec-fetch-site": "cross-site" }]) {
      expect((await post("session", { body: "hello" }, extra)).status).toBe(403);
    }
    expect(queue).not.toHaveBeenCalled();
  });
  it("rejects remote/offline, malformed input and request-selected transports", async () => {
    expect((await post("pc/session", { body: "hello" })).status).toBe(404);
    expect((await post("unknown", { body: "hello" })).status).toBe(409);
    for (const body of [null, [], { body: 3 }, { body: " " }, { body: "x".repeat(MAX_BODY_CHARS) }, { body: "hi", bin: "evil" }, { body: "hi", child: "../evil" }, { body: "hi", target: "parent" }]) {
      expect((await post("session", body)).status).toBe(400);
    }
    const malformed = await fetch(`${base()}/api/sessions/session/message`, { method: "POST", headers: headers(), body: "{" });
    expect(malformed.status).toBe(400);
    expect(queue).not.toHaveBeenCalled();
  });
  it("sends a busy main Codex native user prompt and verifies native child ancestry", async () => {
    const p = env.node("codex-app", "codex"); await p.start(); await p.setSessionId(CODEX_SESSION);
    p.setActivity("busy");
    expect(await (await post(p.name, { body: "hello owner" })).json()).toMatchObject({ state: "queued", transport: "native-prompt" });
    expect(queue).toHaveBeenLastCalledWith(CODEX_SESSION, "Owner message from the local dashboard:\n\nhello owner", env.home);
    expect(await (await post(p.name, { body: "child hello", child: CODEX_CHILD })).json()).toMatchObject({ state: "queued", transport: "native-prompt" });
    expect(queue.mock.calls.at(-1)![0]).toBe(CODEX_CHILD);
    expect((await post(p.name, { body: "forged", child: "foreign_child" })).status).toBe(404);
    expect(queue).toHaveBeenCalledTimes(2);
    expect(p.unread()).toEqual([]);
  });
  it("retains bridge fallback and reports delivered only after consumption", async () => {
    const p = env.node("claude-app", "claude"); await p.start(); await p.setSessionId(CLAUDE_SESSION);
    const response = await post(p.name, { body: "hello owner" });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ state: "queued", transport: "bridge" });
    await until(() => p.unread().length === 1);
    expect(p.unread()[0]).toMatchObject({ from: { name: "you" }, body: "Owner message from the local dashboard:\n\nhello owner" });
    const receipt = () => fetch(`${base()}/api/chat-delivery/${result.receipt}`, { headers: { cookie } });
    expect(await (await receipt()).json()).toMatchObject({ state: "queued" });
    p.markRead([result.id]);
    await until(() => p.unread().length === 0);
    // ACK is asynchronous; give the local broker one event turn before reading.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await (await receipt()).json()).toMatchObject({ state: "delivered" });
    expect((await fetch(`${base()}/api/chat-delivery/${result.receipt}`)).status).toBe(403);
    expect((await fetch(`${base()}/api/chat-delivery/00000000-0000-0000-0000-000000000000`, { headers: { cookie } })).status).toBe(404);
  });
  it("returns unsupported for a native child, then explicitly routes a parent note", async () => {
    const p = env.node("claude-app", "claude"); await p.start(); await p.setSessionId(CLAUDE_SESSION);
    const child = "agent_example";
    const noDirect = await post(p.name, { body: "help", child });
    expect(noDirect.status).toBe(409);
    expect(await noDirect.json()).toMatchObject({ state: "not-supported", transport: "parent" });
    expect(p.unread()).toEqual([]);
    expect((await post(p.name, { body: "help", child, target: "parent" })).status).toBe(200);
    await until(() => p.unread().length === 1);
    expect(p.unread()[0]!.body).toContain("native subagent agent_example");
    expect(p.unread()[0]!.to).toBe(p.name);
  });
  it("does not duplicate ambiguous native delivery and falls back only on definitive rejection", async () => {
    const p = env.node("codex-app", "codex"); await p.start(); await p.setSessionId(CODEX_SESSION);
    queue.mockResolvedValue("unconfirmed");
    expect((await post(p.name, { body: "maybe" })).status).toBe(502);
    expect(p.unread()).toEqual([]);
    queue.mockResolvedValue("unsupported");
    expect(await (await post(p.name, { body: "fallback" })).json()).toMatchObject({ transport: "bridge", state: "queued" });
    await until(() => p.unread().length === 1);
    expect(p.unread()[0]!.body).toContain("fallback");
  });
});
