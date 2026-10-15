import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startUi } from "../src/cli/ui.js";
import { nullLogger } from "../src/core/logger.js";
import { JOBS_FILE } from "../src/core/constants.js";
import { JobManager } from "../src/mcp/jobs.js";
import { attachDashboardJobControl } from "../src/mcp/dashboard-control.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv, ui: Awaited<ReturnType<typeof startUi>>, cookie: string;
const queue = vi.fn(async () => "accepted" as const), managers: JobManager[] = [];
const session = "muse-native-root", child = "muse-native-child";
const base = () => ui.url.replace(/\/\?t=.*$/, "");
const headers = () => ({ cookie, "x-agent-bridge": "1", "content-type": "application/json" });
const post = (name: string, body: unknown, category = "sessions", extra = {}) => fetch(`${base()}/api/${category}/${encodeURIComponent(name)}/message`, { method: "POST", headers: { ...headers(), ...extra }, body: JSON.stringify(body) });
beforeEach(async () => {
  env = makeEnv(); queue.mockClear();
  const paths = { claude: join(env.home, "claude"), codex: join(env.home, "codex"), opencode: join(env.home, "opencode"), muse: join(env.home, "muse") };
  const file = join(paths.muse, "sessions", "2026", "10", "13", session, "session.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema_version: 1, id: "bound-1", stream: { kind: "session", id: session }, sequence: 1,
    recorded_at: 1_792_000_000_000_000, payload_type: "subagent.control.child_session_bound",
    payload: { kind: "subagent_control", record: { kind: "child_session_bound", child_session_id: child } } }) + "\n");
  ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger, transcripts: paths, chatQueue: queue });
  const response = await fetch(ui.url, { redirect: "manual" });
  cookie = String(response.headers.get("set-cookie")).split(";")[0]!;
});
afterEach(async () => { for (const manager of managers.splice(0)) manager.cancelAll(); await ui.close(); await env.cleanup(); });

describe("Muse owner chat through the local dashboard", () => {
  it.each(["busy", "idle"] as const)("queues labeled owner mail for a %s Muse session and confirms only consumption", async activity => {
    const peer = env.node("muse-owner", "muse"); await peer.start(); await peer.setSessionId(session); peer.setActivity(activity);
    const body = 'owner "quoted" $(literal) & <tag>\nnext line';
    const response = await post(peer.name, { body });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ state: "queued", transport: "bridge", receipt: expect.any(String) });
    expect(result.text).toContain(activity === "busy" ? "current turn is not interrupted" : "next turn or inbox read");
    expect(result.text).not.toContain("Wake requested"); expect(result.text).not.toContain("native user prompt");
    expect(queue).not.toHaveBeenCalled();
    await until(() => peer.unread().length === 1);
    expect(peer.unread()[0]).toMatchObject({ from: { name: "you" }, to: peer.name, body: `Owner message from the local dashboard:\n\n${body}` });
    const receipt = () => fetch(`${base()}/api/chat-delivery/${result.receipt}`, { headers: { cookie } });
    expect(await (await receipt()).json()).toMatchObject({ state: "queued" });
    peer.markRead([result.id]);
    await expect.poll(async () => (await (await receipt()).json()).state).toBe("delivered");
    expect(await (await receipt()).json()).toMatchObject({ text: expect.stringContaining("does not confirm a reply or completion") });
  });
  it("refuses direct child input and sends an explicit validated note to the native parent", async () => {
    const peer = env.node("muse-owner", "muse"); await peer.start(); await peer.setSessionId(session);
    expect((await post(peer.name, { body: "forged", child: "foreign-session", target: "parent" })).status).toBe(404);
    const direct = await post(peer.name, { body: "review this", child });
    expect(direct.status).toBe(409); expect(await direct.json()).toMatchObject({ state: "not-supported", transport: "parent" });
    expect(peer.unread()).toEqual([]);
    const response = await post(peer.name, { body: "review this", child, target: "parent" });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: "queued", transport: "parent" });
    await until(() => peer.unread().length === 1);
    expect(peer.unread()[0]).toMatchObject({ from: { name: "you" }, to: peer.name, body: expect.stringContaining(`native subagent ${child} (Muse subagent)`) });
    expect(peer.unread()[0]!.body).toContain("review this"); expect(queue).not.toHaveBeenCalled();
  });
  it("routes a delegated Muse job child's parent note to its owning supervisor", async () => {
    const owner = env.node("claude-owner", "claude"); await owner.start();
    const jobs = new JobManager(owner, nullLogger); managers.push(jobs); attachDashboardJobControl(owner, jobs, nullLogger);
    const received: string[] = [];
    const job = jobs.start("muse", null, "task", async (_session, _prompt, running) => {
      running.live = { post: body => received.push(body) }; return new Promise(() => {});
    });
    const run = "2026-10-13-00-00-00-muse-parent";
    mkdirSync(join(env.home, "runs"), { recursive: true });
    writeFileSync(join(env.home, "runs", `${run}.log`), "00:00:00 muse\n");
    writeFileSync(join(env.home, "runs", `${run}.json`), JSON.stringify({ by: "former-owner", agent: "muse", job: job.name, session }));
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify([{ name: job.name, owner: owner.name, agent: "muse", sessionId: session }]));
    expect((await post(job.name, { body: "child work", child }, "jobs")).status).toBe(409);
    expect(received).toEqual([]);
    const parent = await post(job.name, { body: "child work", child, target: "parent" }, "jobs");
    expect(parent.status).toBe(200); expect(await parent.json()).toMatchObject({ state: "queued", transport: "parent" });
    expect(received).toEqual([expect.stringContaining(`native subagent ${child}`)]); expect(queue).not.toHaveBeenCalled();
  });
  it("keeps Muse routes local and authenticated without accepting caller-selected transports", async () => {
    const peer = env.node("muse-owner", "muse"); await peer.start(); await peer.setSessionId(session);
    for (const extra of [{ cookie: "" }, { "x-agent-bridge": "" }, { origin: "https://external.example" }]) expect((await post(peer.name, { body: "blocked" }, "sessions", extra)).status).toBe(403);
    expect((await post(peer.name, { body: "blocked", transport: "native-prompt" })).status).toBe(400);
    expect((await post("pc/muse-owner", { body: "blocked" })).status).toBe(404);
    expect((await post("offline-muse", { body: "blocked" })).status).toBe(409);
    expect(peer.unread()).toEqual([]); expect(queue).not.toHaveBeenCalled();
  });
});
