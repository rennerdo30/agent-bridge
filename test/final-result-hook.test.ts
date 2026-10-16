import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { JobManager } from "../src/mcp/jobs.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv, until } from "./helpers.js";

it("keeps a completion unread if a Stop hand-out fails, then receipts it after a model step", async () => {
  const env = makeEnv();
  const node = env.node("claude-final", "claude");
  await node.start();
  const jobs = new JobManager(node, nullLogger);
  const ctx: ServerContext = {
    agent: "claude", cfg: { ...DEFAULT_CONFIG, lingerSec: 0 }, node, log: nullLogger,
    home: env.home, cwd: () => env.home, channelActive: () => false, jobs,
  };
  try {
    jobs.start("codex", null, "review", async () => ({ sessionId: "review-1", text: "Final review", isError: false, details: {} }));
    await until(() => node.unread().some(m => m.body.includes("Final review")));
    const id = node.unread().find(m => m.body.includes("Final review"))!.id;
    const first = await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false });
    expect(first).toMatchObject({ decision: "block" });
    expect(node.unread().some(m => m.id === id)).toBe(true);
    await buildHookResponse(ctx, { event: "StopFailure", sessionId: null, stopHookActive: false });
    expect(node.unread().some(m => m.id === id)).toBe(true);
    const retry = await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false });
    expect(retry).toMatchObject({ decision: "block" });
    await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: true });
    expect(node.unread().some(m => m.id === id)).toBe(false);
  } finally { jobs.cancelAll(); await env.cleanup(); }
});
