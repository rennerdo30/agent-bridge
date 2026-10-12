import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import plugin from "../src/opencode/plugin.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined, cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.(); cleanup = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await env?.cleanup(); env = undefined;
});

async function setup(start: () => Promise<Record<string, unknown>>, synthetic?: (input: unknown) => Promise<void>) {
  env = makeEnv(); vi.stubEnv("AGENT_BRIDGE_HOME", env.home);
  const tools = new Map<string, any>(), stored: any[] = [];
  const hooks = new Map<string, (input: any) => Promise<void>>();
  vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
  vi.spyOn(Client.prototype, "close").mockResolvedValue(undefined);
  vi.spyOn(Client.prototype, "listTools").mockResolvedValue({ tools: [{ name: "peers", inputSchema: { type: "object" } }] });
  vi.spyOn(Client.prototype, "callTool").mockImplementation(async request => ({ content: [{ type: "text", text:
    request.name === "hook_event" ? JSON.stringify(await start()) : "retained-peer" }] }));
  const registration = { dispose: async () => {} };
  cleanup = await plugin.setup({ location: { directory: env.home },
    tool: { transform: async (transform: any) => { transform({ add: (tool: any) => tools.set(tool.name, tool) }); return registration; }, hook: async () => registration },
    session: { hook: async (name: string, hook: any) => { hooks.set(name, hook); return registration; },
      synthetic: synthetic ?? (async input => { stored.push(input); }), prompt: async () => {} },
    event: { subscribe: async function* () {} },
  });
  return { stored, prompt: () => hooks.get("prompt")!({ sessionID: "ses_main" }),
    execute: () => tools.get("bridge_peers").execute({}, { sessionID: "ses_main", signal: new AbortController().signal }) };
}
const context = () => ({ hookSpecificOutput: { additionalContext: "initial retained peer context" } });

it("retries one empty SessionStart deferral immediately and stores context only once", async () => {
  let attempts = 0;
  const fixture = await setup(async () => ++attempts === 1 ? {} : context());
  expect(await fixture.execute()).toEqual({ content: "retained-peer" });
  expect(attempts).toBe(2);
  expect(fixture.stored).toEqual([{ sessionID: "ses_main", text: "initial retained peer context", resume: false }]);
  await fixture.execute(); await fixture.prompt();
  expect(attempts).toBe(2); expect(fixture.stored).toHaveLength(1);
});

it("coalesces concurrent attempts, bounds empty retries, and retries on a later boundary", async () => {
  let attempts = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fixture = await setup(async () => { const attempt = ++attempts; if (attempt === 1) await held; return attempt <= 2 ? {} : context(); });
  const execute = fixture.execute(), prompt = fixture.prompt();
  expect(attempts).toBe(1); release(); await Promise.all([execute, prompt]);
  expect(attempts).toBe(2); expect(fixture.stored).toEqual([]);
  await Promise.all([fixture.execute(), fixture.prompt()]);
  expect(attempts).toBe(3); expect(fixture.stored).toHaveLength(1);
});

it("marks context delivered only after synthetic storage succeeds and retries a rejected store later", async () => {
  let attempts = 0, stores = 0;
  const stored: unknown[] = [];
  const fixture = await setup(async () => { attempts++; return context(); }, async input => {
    if (++stores === 1) throw new Error("synthetic store unavailable");
    stored.push(input);
  });
  await fixture.execute();
  expect(attempts).toBe(1); expect(stores).toBe(1); expect(stored).toEqual([]);
  await Promise.all([fixture.execute(), fixture.prompt()]);
  expect(attempts).toBe(2); expect(stores).toBe(2);
  expect(stored).toEqual([{ sessionID: "ses_main", text: "initial retained peer context", resume: false }]);
  await fixture.execute(); expect(attempts).toBe(2); expect(stores).toBe(2);
});
