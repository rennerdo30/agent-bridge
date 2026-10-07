import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentBridgePlugin } from "../src/opencode/plugin.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined, plugin: any, ownedPid: number | null = null;
afterEach(async () => {
  await plugin?.dispose(); plugin = undefined;
  // The SDK's bounded close can return immediately after SIGKILL. Windows still
  // holds the child's working directory until the actual process exit completes.
  if (ownedPid) await expect.poll(() => {
    try { process.kill(ownedPid!, 0); return true; } catch { return false; }
  }, { timeout: 5_000 }).toBe(false);
  ownedPid = null;
  await env?.cleanup(); env = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs();
});

it("retains startup context and coalesces mail arriving during a Stop check", async () => {
  env = makeEnv();
  vi.stubEnv("AGENT_BRIDGE_HOME", env.home);
  vi.stubEnv("AGENT_BRIDGE_OPENCODE_SERVER", join(import.meta.dirname, "..", "plugins", "opencode", "dist", "server.mjs"));
  vi.stubEnv("AGENT_BRIDGE_NAME", "opencode-race");
  vi.stubEnv("AGENT_BRIDGE_DASHBOARD", "off");
  const prompts: { text: string; noReply: boolean }[] = [];
  const originalCall = Client.prototype.callTool;
  const originalConnect = Client.prototype.connect;
  vi.spyOn(Client.prototype, "connect").mockImplementation(async function (this: Client, transport: any, ...args: any[]) {
    await originalConnect.apply(this, [transport, ...args] as any);
    ownedPid = transport.pid;
  });
  let releaseStop!: () => void, stopEntered = false, checks = 0;
  const pendingStop = new Promise<void>((resolve) => { releaseStop = resolve; });
  vi.spyOn(Client.prototype, "callTool").mockImplementation(async function (this: Client, request: any, ...args: any[]) {
    if (request.name !== "hook_event") return originalCall.apply(this, [request, ...args] as any);
    let result: any = {};
    if (request.arguments.event === "SessionStart") result = { hookSpecificOutput: { additionalContext: "Retained initial peer context" } };
    if (request.arguments.event === "Stop") {
      checks++;
      if (checks === 1) { stopEntered = true; await pendingStop; }
      else result = { decision: "block", reason: "Mail arrived during the previous Stop" };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  let notify!: () => Promise<void>;
  const originalHandler = Client.prototype.setNotificationHandler;
  vi.spyOn(Client.prototype, "setNotificationHandler").mockImplementation(function (this: Client, schema: any, handler: any) {
    if (schema.shape?.method?.value === "notifications/agent-bridge/message") notify = () => handler({ method: "notifications/agent-bridge/message" });
    return originalHandler.call(this, schema, handler);
  });
  plugin = await AgentBridgePlugin({ directory: env.home, client: { session: { promptAsync: async (input: any) => {
    prompts.push({ text: input.body.parts[0].text, noReply: Boolean(input.body.noReply) }); return { data: undefined };
  } } } });
  const id = "native-race-thread";
  try {
    await plugin["chat.message"]({ sessionID: id });
    await expect.poll(() => prompts.some((p) => p.text === "Retained initial peer context" && p.noReply)).toBe(true);
    await plugin.event({ event: { type: "session.status", properties: { sessionID: id, status: { type: "idle" } } } });
    await expect.poll(() => stopEntered).toBe(true);
    expect(notify).toBeTypeOf("function");
    await notify(); await notify();
    releaseStop();
    await expect.poll(() => prompts.filter((p) => p.text === "Mail arrived during the previous Stop").length).toBe(1);
    expect(checks).toBe(2);
    expect(prompts.at(-1)?.noReply).toBe(false);
  } finally { releaseStop(); }
});
