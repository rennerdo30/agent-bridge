import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { AgentBridgePlugin } from "../src/opencode/plugin.js";
import { makeEnv, type TestEnv } from "./helpers.js";
import { readStore } from "../src/mcp/jobs.js";

let env: TestEnv | undefined, plugin: any;
afterEach(async () => { await plugin?.dispose?.(); plugin = undefined; await env?.cleanup(); env = undefined; vi.unstubAllEnvs(); });

it("hands off through the native bridge_ tool and wakes opencode when it inherits jobs", async () => {
  env = makeEnv();
  vi.stubEnv("AGENT_BRIDGE_HOME", env.home);
  vi.stubEnv("AGENT_BRIDGE_OPENCODE_SERVER", join(import.meta.dirname, "..", "plugins", "opencode", "dist", "server.mjs"));
  vi.stubEnv("AGENT_BRIDGE_NAME", "opencode-handoff");
  vi.stubEnv("AGENT_BRIDGE_DASHBOARD", "off");
  const prompts: { id: string; text: string }[] = [];
  plugin = await AgentBridgePlugin({ directory: env.home, client: { session: { promptAsync: async (input: any) => {
    prompts.push({ id: input.path.id, text: input.body.parts[0].text }); return { data: undefined };
  } } } });
  const peer = env.node("claude-handoff"); await peer.start();
  const ctx = { sessionID: "native-session", abort: new AbortController().signal };
  // The handshake precedes broker registration. Seed owned jobs only after their owner is live,
  // otherwise legitimate project failover can adopt the fixture before the explicit handoff.
  expect(await plugin.tool.bridge_peers.execute({}, ctx)).toContain(peer.name);
  const path = join(env.home, "jobs.json");
  writeFileSync(path, JSON.stringify({ version: 2, jobs: [{ id: "native", name: "claude-job-native", agent: "claude", model: null,
    prompt: "Task", startedAt: Date.now(), status: "done", sessionId: "fixture", workdir: env.home, worktree: null,
    owner: "opencode-handoff", rootName: "opencode-handoff", rootSession: "original", supervisor: "original", args: { title: "Native plugin inheritance" } }] }));
  expect(plugin.tool.bridge_handoff_subagents).toBeDefined();
  const handed = await plugin.tool.bridge_handoff_subagents.execute({ to: peer.name, note: "Review native tools" }, ctx);
  expect(handed).toContain("claude-handoff"); expect(readStore(path)[0]!.owner).toBe(peer.name);
  await plugin.tool.bridge_inbox.execute({}, ctx);
  await plugin.tool.bridge_auto_wake.execute({ enabled: true }, ctx);
  await peer.handoffSubagents({ to: "opencode-handoff", note: "Continue in opencode" });
  await plugin.event({ event: { type: "session.status", properties: { sessionID: "native-session", status: { type: "idle" } } } });
  await expect.poll(() => prompts.some((p) => p.text.includes("Inherited subagents") && p.text.includes("Continue in opencode")), { timeout: 8000 }).toBe(true);
  expect(prompts.some((p) => p.id === "native-session" && p.text.includes("Native plugin inheritance"))).toBe(true);
  expect(readStore(path)[0]!.owner).toBe("opencode-handoff");
});
