import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import plugin, { AgentBridgePlugin } from "../src/opencode/plugin.js";
import { BridgeNode } from "../src/core/node.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { nullLogger } from "../src/core/logger.js";

describe("V2 plugin domains with the real Bridge transport", () => {
  const home = mkdtempSync(join(tmpdir(), "ab-ocv2-"));
  const tools = new Map<string, any>();
  const callbacks = new Map<string, (input: any) => Promise<void>>();
  const stored: any[] = [], prompted: any[] = [];
  const events: any[] = [];
  const disposals: string[] = [];
  let signal: AbortSignal;
  let notify: (() => void) | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  let peer: BridgeNode;
  let stops = 0;
  let spy: ReturnType<typeof vi.spyOn>;
  const register = (name: string, callback: any) => {
    callbacks.set(name, callback);
    return Promise.resolve({ dispose: async () => { disposals.push(name); } });
  };
  const event = (type: string, data: any, directory = home) => {
    events.push({ type, data, location: { directory } }); notify?.();
  };
  beforeAll(async () => {
    vi.stubEnv("AGENT_BRIDGE_HOME", home);
    vi.stubEnv("AGENT_BRIDGE_OPENCODE_SERVER", join(import.meta.dirname, "../plugins/opencode/dist/server.mjs"));
    vi.stubEnv("AGENT_BRIDGE_NAME", "opencode-v2-test");
    vi.stubEnv("AGENT_BRIDGE_LINGER_SEC", "1");
    writeFileSync(join(home, "config.json"), "{}");
    const original = Client.prototype.callTool;
    spy = vi.spyOn(Client.prototype, "callTool").mockImplementation(async function (this: Client, req: any, ...args: any[]) {
      if (req.name === "hook_event" && req.arguments?.event === "PostToolUse") await new Promise(resolve => setTimeout(resolve, 1_100));
      const stop = req.name === "hook_event" && req.arguments?.event === "Stop";
      if (stop) stops++;
      try { return await original.apply(this, [req, ...args] as any); }
      finally { if (stop) stops--; }
    });
    cleanup = await plugin.setup({ location: { directory: home },
      tool: { transform: async (fn: any) => {
        fn({ add: (t: any) => tools.set(t.name, t) });
        return { dispose: async () => { disposals.push("tools"); } };
      }, hook: (name: string, fn: any) => register(`tool.${name}`, fn) },
      session: { hook: register, synthetic: async (input: any) => { stored.push(input); },
        prompt: async (input: any) => { prompted.push(input); } },
      event: { subscribe: async function* (options: any) {
        signal = options.signal;
        signal.addEventListener("abort", () => notify?.(), { once: true });
        while (!signal.aborted) {
          if (events.length) { yield events.shift(); continue; }
          await new Promise<void>(resolve => { notify = resolve; });
        }
      } },
    });
    peer = new BridgeNode({ pipePath: resolvePipePath(home, {}), token: loadOrCreateToken(home), dbPath: resolveDbPath(home),
      agent: "claude", name: "claude-v2-peer", cwd: home, autoWake: false, log: nullLogger });
    await peer.start();
  }, 30_000);
  afterAll(async () => {
    await cleanup?.(); spy?.mockRestore(); await peer?.stop(); vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("lets V1 select server and V2 select setup; registers native JSON schemas/results", async () => {
    expect(plugin.server).toBe(AgentBridgePlugin);
    expect(tools.has("bridge_hook_event")).toBe(false);
    expect(tools.get("bridge_send").input).toMatchObject({ type: "object", required: expect.arrayContaining(["to", "message"]) });
    const result = await tools.get("bridge_peers").execute({}, { sessionID: "ses_main", signal: new AbortController().signal });
    expect(result.content).toContain("claude-v2-peer");
    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0]).toMatchObject({ sessionID: "ses_main", resume: false });
  });
  it("stores busy mail without starting a model turn, includes typed system parts", async () => {
    event("session.execution.started", { sessionID: "ses_main" });
    await new Promise(resolve => setTimeout(resolve, 10));
    const before = stored.length;
    await peer.send({ to: "opencode-v2-test", body: "V2 busy mail" });
    const context = { sessionID: "ses_main", system: [] as any[] };
    // A context boundary consumes mail. Polling it can consume a successful
    // result after expect.poll's deadline, then observe an empty second result.
    await callbacks.get("context")!(context);
    expect(context.system).toContainEqual({ type: "text", text: expect.stringContaining("V2 busy mail") });
    expect(stored.slice(before)).toEqual([expect.objectContaining({ sessionID: "ses_main", resume: false, text: expect.stringContaining("V2 busy mail") })]);
    expect(prompted).toHaveLength(0);
  });
  it("ignores child and foreign-directory events, delivers idle mail once", async () => {
    event("session.created", { sessionID: "ses_child", parentID: "ses_main" });
    event("session.execution.succeeded", { sessionID: "ses_main" }, "foreign-directory");
    await new Promise(resolve => setTimeout(resolve, 10));
    const child = { sessionID: "ses_child", system: [] };
    await callbacks.get("prompt")!(child); await callbacks.get("context")!(child);
    expect(child.system).toEqual([]);
    expect(prompted).toHaveLength(0);
    event("session.execution.succeeded", { sessionID: "ses_main" });
    await expect.poll(() => stops).toBe(1);
    await peer.send({ to: "opencode-v2-test", body: "V2 idle mail" });
    await expect.poll(() => prompted.filter(p => p.text.includes("V2 idle mail")).length, { timeout: 8_000 }).toBe(1);
    expect(prompted[0]).toMatchObject({ sessionID: "ses_main" });
  });
  it("disposes registrations and event stream before closing the bridge", async () => {
    await cleanup!(); cleanup = undefined;
    expect(signal.aborted).toBe(true);
    expect(disposals.sort()).toEqual(["context", "prompt", "tool.execute.after", "tools"]);
  });
});
