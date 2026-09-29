import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startUi, summarizeRun } from "../src/cli/ui.js";
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
});

describe("summarizeRun", () => {
  it("detects running, failed and interrupted runs", () => {
    const f = "2026-09-29-06-32-18-codex-x.log";
    expect(summarizeRun(f, "06:32:18 h\n06:33:00 1m · step 3 · bash: x\n", 1_000, 2_000).status).toBe("running");
    expect(summarizeRun(f, "06:32:18 h\n06:40:00 finished after 400s · failed: boom\n", 1_000, 2_000).status).toBe("failed");
    expect(summarizeRun(f, "06:32:18 h\n", 0, 10 * 60_000).status).toBe("interrupted");
  });
});
