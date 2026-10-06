import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startUi } from "../src/cli/ui.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";
import { CLAUDE_SESSION, CODEX_CHILD, CODEX_SESSION, installTranscriptFixtures } from "./transcript-fixtures.js";

let env: TestEnv, ui: Awaited<ReturnType<typeof startUi>>, cookie: string;
const base = () => ui.url.replace(/\/\?t=.*$/, "");
const get = (path: string) => fetch(`${base()}${path}`, { headers: { cookie } });
beforeEach(async () => {
  env = makeEnv();
  const fixtures = installTranscriptFixtures(env.home);
  ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger, transcripts: fixtures.paths });
  const response = await fetch(ui.url, { redirect: "manual" });
  cookie = String(response.headers.get("set-cookie")).split(";")[0]!;
});
afterEach(async () => { await ui.close(); await env.cleanup(); });

describe("session transcript endpoints", () => {
  it.each([
    ["claude", CLAUDE_SESSION, "agent_example"],
    ["codex", CODEX_SESSION, CODEX_CHILD],
    ["opencode", "ses_child", "ses_grandchild"],
  ] as const)("serves %s normal chat and only its native child's chat", async (agent, sessionId, child) => {
    const peer = env.node(`${agent}-app`, agent);
    await peer.start(); await peer.setSessionId(sessionId);
    const route = `/api/sessions/${peer.name}`;
    const response = await get(`${route}/chat`);
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.next).toBeTypeOf("string");
    expect((await (await get(`${route}/chat?from=${encodeURIComponent(page.next)}`)).json()).items).toEqual([]);
    expect((await (await get(`${route}/subagents`)).json()).subagents).toMatchObject([{ id: child }]);
    expect((await get(`${route}/subagents/${child}`)).status).toBe(200);
    expect((await get(`${route}/subagents/foreign_child`)).status).toBe(404);
    expect((await get(`${route}/subagents/..%2Fsecret`)).status).toBe(404);
    expect((await get(`${route}/subagents/${"a".repeat(129)}`)).status).toBe(404);
    expect((await get(`${route}/chat?from=-1`)).status).toBe(400);
    expect((await fetch(`${base()}${route}/chat`, { method: "POST", headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base()}${route}/chat`)).status).toBe(403);
  });
  it("distinguishes unknown, remote and not-yet-bound sessions", async () => {
    const peer = env.node("claude-unbound", "claude"); await peer.start();
    expect((await get("/api/sessions/unknown/chat")).status).toBe(404);
    expect((await get("/api/sessions/host%2Fclaude-unbound/chat")).status).toBe(404);
    expect((await get("/api/sessions/claude-unbound/chat")).status).toBe(409);
    expect((await get("/api/sessions/claude-unbound/subagents")).status).toBe(409);
    await peer.setSessionId("../outside");
    expect((await get("/api/sessions/claude-unbound/chat")).status).toBe(404);
  });
});
