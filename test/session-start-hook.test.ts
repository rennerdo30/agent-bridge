import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSessionStartHook } from "../src/cli/session-start-hook.js";
import { nullLogger } from "../src/core/logger.js";
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

  it("still answers when no broker is running", async () => {
    const text = await run({ cwd: "/work/my-app" });
    expect(text).toContain("No other agents are online right now.");
  });
});
