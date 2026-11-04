import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSessionStartHook } from "../src/cli/session-start-hook.js";
import { nullLogger } from "../src/core/logger.js";
import { randomUUID } from "node:crypto";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
  vi.stubEnv("AGENT_BRIDGE_HOME", env.home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await env.cleanup();
});

async function run(input: unknown): Promise<string> {
  let printed = "";
  expect(await runSessionStartHook(nullLogger, (text) => (printed += text), async () => JSON.stringify(input))).toBe(0);
  return JSON.parse(printed).hookSpecificOutput.additionalContext;
}

describe("SessionStart command hook", () => {
  it("names the session after its folder and lists the other peers from the broker", async () => {
    const peer = env.node("codex-other", "codex");
    await peer.start();
    const self = env.node("claude-my-app", "claude");
    await self.start();
    const text = await run({ session_id: "s1", cwd: "/work/my-app", source: "resume" });
    expect(text).toContain('connected to agent-bridge as "claude-my-app"');
    expect(text).toContain("codex-other");
    expect(text).not.toMatch(/^- claude-my-app/m);
  });

  it("AB-491: never claims the folder name another live session holds, and names a known session by its id", async () => {
    const holder = env.node("claude-my-app", "claude");
    await holder.start(); await holder.setSessionId("holder-session");
    const fresh = await run({ session_id: "new-session", cwd: "/work/my-app", source: "startup" });
    expect(fresh).not.toContain('connected to agent-bridge as "claude-my-app"');
    expect(fresh).toContain('Another live session already uses "claude-my-app"');
    expect(fresh).toMatch(/^- claude-my-app /m);

    const client = await BridgeClient.connect(env.pipe, nullLogger);
    const hello = await client.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: {
      id: randomUUID(), name: "claude-my-app", agent: "claude", cwd: "/work/my-app", pid: process.pid, agentPid: null, sessionId: "new-session", startedAt: Date.now(), autoWake: false } });
    try {
      expect(hello.name).not.toBe("claude-my-app");
      const resumed = await run({ session_id: "new-session", cwd: "/work/my-app", source: "resume" });
      expect(resumed).toContain(`connected to agent-bridge as "${hello.name}"`);
      expect(resumed).toMatch(/^- claude-my-app /m);
    } finally { client.close(); }
  });
  it("still answers when no broker is running", async () => {
    const text = await run({ cwd: "/work/my-app" });
    expect(text).toContain("No other agents are online right now.");
  });
});
