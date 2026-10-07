import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { childEnv } from "../src/core/delegate.js";
import { classifyPeers, readDashboard } from "../src/core/dashboard-read.js";
import { ENV, PROTOCOL_VERSION } from "../src/core/constants.js";
import { commitHandoff } from "../src/core/job-handoff.js";
import { nullLogger } from "../src/core/logger.js";
import { isInternalBridgeProcess, isPluginCacheCwd } from "../src/core/session-visibility.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.unstubAllEnvs(); await env.cleanup(); });
const caches = ["C:/Users/test/.codex/plugins/cache/agent-bridge/0.29.12", "/home/test/.claude/plugins/cache/agent-bridge", "/home/test/.config/opencode/plugins/agent-bridge", "C:/Users/test/AppData/Roaming/opencode/plugin/agent-bridge"];
const peer = (cwd: string, name = "background"): PeerInfo => ({ id: name, name, agent: "codex", cwd, pid: 123, agentPid: 456, sessionId: null, startedAt: 1, autoWake: false });

it.each(caches)("recognizes cache folder %s across path separators and case", (cwd) => {
  expect(isPluginCacheCwd(cwd)).toBe(true);
  expect(isPluginCacheCwd(cwd.toUpperCase().replaceAll("/", "\\"))).toBe(true);
  expect(isPluginCacheCwd(`${cwd}/sub/../dist`)).toBe(true);
});

it.each(["/repo/cache-game", "/repo/.codex/plugins/cacheable", "/repo/.claude/plugins/cache-other", "/repo/opencode/plugin-game", "/repo/opencode/src"])("preserves ordinary project %s", (cwd) => {
  expect(isPluginCacheCwd(cwd)).toBe(false);
});

it("marks every bridge-owned child even when extra environment attempts to clear the flag", () => {
  vi.stubEnv("CLAUDE_PROJECT_DIR", "/parent/project");
  const env = childEnv({ [ENV.internal]: "0" });
  expect(isInternalBridgeProcess(env)).toBe(true);
  expect(env.CLAUDE_PROJECT_DIR).toBeUndefined();
  expect(isInternalBridgeProcess({})).toBe(false);
});

it("rejects legacy ghost registrations without claiming mail or persisting names", async () => {
  const token = loadOrCreateToken(env.home), store = new MessageStore(env.db, nullLogger);
  const broker = new Broker(env.pipe, store, nullLogger, token);
  await broker.listen();
  const client = await BridgeClient.connect(env.pipe, nullLogger);
  try {
    for (const cwd of caches) {
      await expect(client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: peer(cwd) })).rejects.toThrow("Plugin-cache");
    }
    await client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: peer(env.home, "real") });
    expect((await client.request("peers", {})).map((p) => p.name)).toEqual(["real"]);
    await expect(client.request("updatePeer", { cwd: caches[0]! })).rejects.toThrow("Plugin-cache");
    const db = new DatabaseSync(env.db, { readOnly: true });
    try { expect(db.prepare("SELECT name FROM peer_names WHERE name='background'").all()).toEqual([]); }
    finally { db.close(); }
  } finally { client.close(); await broker.close(); }
});

it("waits for real cwd without electing a broker, then registers only the real session", async () => {
  const node = env.node("real", "codex");
  await node.relocate(caches[0]!);
  await expect(node.start()).rejects.toThrow("plugin cache");
  expect(node.isConnected).toBe(false);
  expect(node.isBroker).toBe(false);
  await node.relocate(env.home);
  await node.start();
  expect((await node.peers()).map((p) => p.name)).toEqual(["real"]);
});

it("hides old-broker ghosts on every refresh and excludes chat and handoff targets", async () => {
  const real = peer(env.home, "real"), ghost = peer(caches[0]!);
  expect(classifyPeers([real, ghost], [], env.home).map((p) => p.name)).toEqual(["real"]);
  expect(classifyPeers([real], [], env.home).map((p) => p.name)).toEqual(["real"]);
  const response = await readDashboard({ home: env.home, log: nullLogger, peers: () => [ghost] }, { path: "/api/sessions/background/chat" });
  expect(response.status).toBe(404);
  expect(() => commitHandoff(join(env.home, "jobs.json"), real, ghost, { to: ghost.name })).toThrow("target must");
});
