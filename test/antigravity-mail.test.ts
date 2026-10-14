import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { registerAntigravityRoot } from "../src/core/antigravity-plugin.js";
import { nullLogger } from "../src/core/logger.js";
import { lookup } from "../src/core/procinfo.js";
import { AntigravityHooks } from "../src/mcp/antigravity-hooks.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv, until } from "./helpers.js";

vi.mock("../src/core/procinfo.js", () => ({ antigravityAncestor: async () => process.pid, lookup: vi.fn(async () => ({ pid: process.pid, ppid: process.ppid, cmdline: "agy --conversation parent" })) }));

let env: ReturnType<typeof makeEnv>, hooks: AntigravityHooks;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await hooks?.stop(); await env.cleanup(); vi.restoreAllMocks(); });

function context(node: ServerContext["node"], extra: Partial<ServerContext> = {}): ServerContext {
  return { agent: "antigravity", cfg: { ...DEFAULT_CONFIG, maxHops: 2, lingerSec: 0 }, home: env.home, node, log: nullLogger, cwd: () => env.home, channelActive: () => false, ...extra };
}
async function call(event: string, conversationId = "parent"): Promise<Record<string, any>> {
  const reg = JSON.parse(readFileSync(join(env.home, "antigravity-hooks", `${process.pid}.json`), "utf8"));
  const response = await fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}` }, body: JSON.stringify({ event, input: { conversationId, workspacePaths: [env.home] } }) });
  expect(response.status).toBe(200);
  return response.json();
}

it("delivers active and stopping mail once, tracks busy/idle, and leaves idle mail queued until a turn", async () => {
  const node = env.node("native", "antigravity", true), peer = env.node("sender"), activity = vi.fn();
  await node.start(); await peer.start();
  hooks = new AntigravityHooks(context(node, { activity })); await hooks.start();
  await peer.send({ to: node.name, body: "active boundary mail" });
  await until(() => node.unread().length === 1);
  expect(await call("PreInvocation", "child")).toEqual({});
  expect(node.currentSessionId).toBeNull(); expect(node.unread()).toHaveLength(1);
  expect(await call("PreInvocation")).toMatchObject({ injectSteps: [{ ephemeralMessage: expect.stringContaining("active boundary mail") }] });
  expect(node.currentSessionId).toBe("parent"); expect(node.unread()).toHaveLength(0);
  expect(activity).toHaveBeenLastCalledWith("busy");
  expect(await call("Stop")).toEqual({}); expect(activity).toHaveBeenLastCalledWith("idle");
  await peer.send({ to: node.name, body: "arrived while idle" });
  await until(() => node.unread().length === 1);
  expect(node.unread()[0]!.body).toBe("arrived while idle");
  expect(await call("Stop")).toMatchObject({ decision: "continue", reason: expect.stringContaining("arrived while idle") });
  expect(node.unread()).toHaveLength(0); expect(activity).toHaveBeenLastCalledWith("busy");
  expect(await call("Stop")).toEqual({});
  await peer.send({ to: node.name, body: "next turn mail" });
  await until(() => node.unread().length === 1);
  expect(await call("PreInvocation")).toMatchObject({ injectSteps: [{ ephemeralMessage: expect.stringContaining("next turn mail") }] });
  expect(await call("PreInvocation")).toEqual({});
});

it("keeps unbound child-first mail unread until top-level stream evidence binds the root", async () => {
  vi.mocked(lookup).mockResolvedValueOnce({ pid: process.pid, ppid: process.ppid, cmdline: "agy" });
  const node = env.node("native", "antigravity"), peer = env.node("sender");
  await node.start(); await peer.start();
  hooks = new AntigravityHooks(context(node)); await hooks.start();
  await peer.send({ to: node.name, body: "root inbox" });
  await until(() => node.unread().length === 1);
  expect(await call("PreInvocation", "child")).toEqual({});
  expect(await call("PreInvocation")).toEqual({});
  expect(node.currentSessionId).toBeNull(); expect(node.unread()).toHaveLength(1);
  const release = registerAntigravityRoot(env.home, process.pid, "parent");
  try {
    expect(await call("PreInvocation", "child")).toEqual({});
    expect(node.unread()).toHaveLength(1);
    expect(await call("PreInvocation")).toMatchObject({ injectSteps: [{ ephemeralMessage: expect.stringContaining("root inbox") }] });
    expect(node.currentSessionId).toBe("parent"); expect(node.unread()).toHaveLength(0);
  } finally { release(); }
});

it("honors stopping hop limits and preserves quiet mail for explicit inbox reads", async () => {
  const node = env.node("native", "antigravity", true), peer = env.node("sender");
  await node.start(); await peer.start();
  hooks = new AntigravityHooks(context(node)); await hooks.start();
  const first = await peer.send({ to: node.name, body: "hop zero" });
  const second = await node.send({ to: peer.name, body: "hop one", replyTo: first.messages[0]!.id });
  await peer.send({ to: node.name, body: "hop limit", replyTo: second.messages[0]!.id });
  await peer.send({ to: node.name, body: "quiet observer", conversationId: "siblings:note" });
  await until(() => node.unread().length === 3);
  node.markRead([first.messages[0]!.id]);
  expect(await call("Stop")).toEqual({}); expect(node.unread()).toHaveLength(2);
  const output = JSON.stringify(await call("PreInvocation"));
  expect(output).toContain("hop limit"); expect(output).not.toContain("quiet observer");
  expect(node.unread()).toEqual([expect.objectContaining({ body: "quiet observer" })]);
});

it("retirement aborts slow hook preparation before it can consume real inbox mail", async () => {
  const node = env.node("native", "antigravity"), peer = env.node("sender");
  await node.start(); await peer.start();
  let prepare!: () => void;
  const entering = new Promise<void>(resolve => { prepare = resolve; });
  const launchKnown = new Promise<void>(() => {}), then = launchKnown.then.bind(launchKnown);
  vi.spyOn(launchKnown, "then").mockImplementation((...args) => { prepare(); return then(...args); });
  hooks = new AntigravityHooks(context(node, { launchKnown })); await hooks.start();
  await peer.send({ to: node.name, body: "keep through cancellation" });
  await until(() => node.unread().length === 1);
  const request = call("PreInvocation");
  await entering;
  node.emit("replaced");
  expect(await request).toEqual({}); expect(node.unread()).toHaveLength(1);
});
