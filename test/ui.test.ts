import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyPeers, startUi, summarizeRun, type RunSummary } from "../src/cli/ui.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
let ui: { url: string; close: () => Promise<void> };
let cookie = "";

beforeEach(async () => {
  env = makeEnv();
  ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
  const first = await fetch(ui.url, { redirect: "manual" });
  expect(first.status).toBe(302);
  cookie = String(first.headers.get("set-cookie")).split(";")[0]!;
});
afterEach(async () => {
  await ui.close();
  await env.cleanup();
});

const base = () => ui.url.replace(/\/\?t=.*$/, "");

describe("web dashboard", () => {
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
    expect(await page.text()).toContain("<title>agent-bridge</title>");

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