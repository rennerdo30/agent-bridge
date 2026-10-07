import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ notification: undefined as (() => unknown) | undefined, call: undefined as ((event: string) => Promise<any>) | undefined }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class {} }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  async connect() {}
  async close() {}
  async listTools() { return { tools: [] }; }
  setNotificationHandler(_schema: unknown, callback: () => unknown) { fixture.notification = callback; }
  async callTool(input: any) { return { content: [{ type: "text", text: JSON.stringify(await fixture.call!(input.arguments.event)) }] }; }
} }));

import { AgentBridgePlugin } from "../src/opencode/plugin.js";
let plugin: any;
afterEach(async () => { await plugin?.dispose(); plugin = undefined; fixture.notification = undefined; fixture.call = undefined; });

it("coalesces mail arriving during an in-flight Stop into one later check", async () => {
  let finishStop!: () => void;
  const gate = new Promise<void>((resolve) => { finishStop = resolve; });
  let stops = 0;
  fixture.call = async (event) => {
    if (event !== "Stop") return {};
    if (++stops === 1) { await gate; return {}; }
    return { decision: "block", reason: "Deferred job completion" };
  };
  const prompts: any[] = [];
  plugin = await AgentBridgePlugin({ directory: "wake-coalesce-fixture", client: { session: { promptAsync: async (input: any) => { prompts.push(input); } } } });
  await plugin["chat.message"]({ sessionID: "owner" });
  await plugin.event({ event: { type: "session.status", properties: { sessionID: "owner", status: { type: "idle" } } } });
  await expect.poll(() => stops).toBe(1);
  await fixture.notification!(); await fixture.notification!();
  expect(stops).toBe(1);
  finishStop();
  await expect.poll(() => prompts.length).toBe(1);
  expect(stops).toBe(2);
  expect(prompts[0].body).toEqual({ parts: [{ type: "text", text: "Deferred job completion" }] });
});

it("stores initial SessionStart context once instead of discarding its consumed mail", async () => {
  fixture.call = async (event) => event === "SessionStart" ? { hookSpecificOutput: { additionalContext: "Initial job result" } } : {};
  const prompts: any[] = [];
  plugin = await AgentBridgePlugin({ directory: "initial-context-fixture", client: { session: { promptAsync: async (input: any) => { prompts.push(input); } } } });
  await plugin["chat.message"]({ sessionID: "owner" });
  await plugin["chat.message"]({ sessionID: "owner" });
  expect(prompts).toHaveLength(1);
  expect(prompts[0].body).toEqual({ parts: [{ type: "text", text: "Initial job result" }], noReply: true });
});
