import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { AgentBridgePlugin } from "../src/opencode/plugin.js";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined, plugin: any, runner: BridgeNode | undefined;
afterEach(async () => { await runner?.stop(); runner = undefined; await plugin?.dispose?.(); plugin = undefined; await env?.cleanup(); env = undefined; vi.unstubAllEnvs(); });

it("wakes an idle native opencode group fallback once with auto-wake off", async () => {
  env = makeEnv();
  vi.stubEnv("AGENT_BRIDGE_HOME", env.home);
  vi.stubEnv("AGENT_BRIDGE_OPENCODE_SERVER", join(import.meta.dirname, "..", "plugins", "opencode", "dist", "server.mjs"));
  vi.stubEnv("AGENT_BRIDGE_NAME", "opencode-group");
  vi.stubEnv("AGENT_BRIDGE_DASHBOARD", "off");
  const primary = env.node("claude-primary"); await primary.start();
  const prompts: { text: string; noReply: boolean }[] = [];
  plugin = await AgentBridgePlugin({ directory: env.home, client: { session: { promptAsync: async (input: any) => {
    prompts.push({ text: input.body.parts[0].text, noReply: Boolean(input.body.noReply) }); return { data: undefined };
  } } } });
  const ctx = { sessionID: "opencode-group-thread", abort: new AbortController().signal };
  expect(plugin.tool.bridge_coordinator_availability).toBeDefined();
  expect(plugin.tool.bridge_project_main).toBeDefined();
  await plugin["chat.message"]({ sessionID: ctx.sessionID });
  await plugin.event({ event: { type: "session.status", properties: { sessionID: ctx.sessionID, status: { type: "idle" } } } });
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "native", name: "codex-job-native", agent: "codex", model: null,
    prompt: "Task", startedAt: Date.now(), status: "running", sessionId: "fixture", workdir: env.home, worktree: null,
    owner: primary.name, rootName: primary.name, supervisor: primary.id, args: { title: "Group fallback" } }] }));
  runner = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name: "codex-job-native", id: "job:native",
    agent: "other", jobAgent: "codex", jobOwner: primary.id, jobParent: primary.name, cwd: env.home, autoWake: false, log: nullLogger, canHostBroker: false });
  await runner.start();
  await primary.setUnavailable(true);
  await runner.send({ to: primary.name, body: "Native group fallback note", conversationId: "job-native:note" });
  await expect.poll(() => prompts.filter((p) => p.text.includes("Native group fallback note")).length, { timeout: 8000 }).toBe(1);
  expect(prompts.find((p) => p.text.includes("Native group fallback note"))!.noReply).toBe(false);
  expect(await plugin.tool.bridge_inbox.execute({}, ctx)).not.toContain("Native group fallback note");
  await primary.setUnavailable(false);
  await runner.send({ to: primary.name, body: "Returned primary note", conversationId: "job-native:note" });
  await expect.poll(() => primary.unread().some((m) => m.body === "Returned primary note")).toBe(true);
  expect(prompts.some((p) => p.text.includes("Returned primary note"))).toBe(false);
});
