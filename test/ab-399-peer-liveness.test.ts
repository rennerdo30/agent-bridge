import { afterEach, expect, it, vi } from "vitest";
import { canonicalDrivePath } from "../src/core/project-identity.js";
import { makeEnv } from "./helpers.js";
import type { TestEnv } from "./helpers.js";
import { BridgeClient } from "../src/core/client.js";
import { nullLogger } from "../src/core/logger.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { MessageStore } from "../src/core/store.js";
import { Broker } from "../src/core/broker.js";
import { DatabaseSync } from "node:sqlite";

let env: TestEnv;
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); if (env) await env.cleanup(); });

it("canonicalizes a mapped Windows drive without assuming a particular drive letter", () => {
  const resolveSubst = vi.fn(() => new Map([["R:", "C:\\workspace"], ["S:", "R:\\child"]]));
  expect(canonicalDrivePath("S:\\repo", resolveSubst)).toBe("C:\\workspace\\child\\repo");
  expect(canonicalDrivePath("T:\\repo", resolveSubst)).toBe("T:\\repo");
  expect(canonicalDrivePath("S:\\repo", () => new Map())).toBe("S:\\repo");
});

it("hides a disconnected agent process and queues exact mail while retaining its registration", async () => {
  env = makeEnv();
  const token = loadOrCreateToken(env.home);
  const broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, token, () => Date.now());
  await broker.listen();
  let exited = false;
  const realKill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid === 2_000_399 && signal === 0) {
      if (exited) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    }
    return realKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill);
  const ghost = await BridgeClient.connect(env.pipe, nullLogger);
  await ghost.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: {
    id: "ghost", name: "ghost", agent: "claude", cwd: env.home, pid: process.pid,
    agentPid: 2_000_399, agentStartedAt: "old-process", sessionId: "old-session",
    startedAt: Date.now(), autoWake: true, activity: "idle",
  } });
  const sender = await BridgeClient.connect(env.pipe, nullLogger);
  await sender.request("hello", { protocol: PROTOCOL_VERSION, token, peer: {
    id: "sender", name: "sender", agent: "codex", cwd: env.home, pid: process.pid,
    agentPid: null, sessionId: "sender-session", startedAt: Date.now() + 1, autoWake: false,
  } });
  const before = await sender.request("peers", {});
  expect(before.find(p => p.name === "ghost")?.projectMain).toBe(true);
  expect(before.find(p => p.name === "sender")?.projectMain).toBe(false);
  exited = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 31_000);
  const after = await sender.request("peers", {});
  expect(after.map(p => p.name)).toEqual(["sender"]);
  expect(after[0]?.projectMain).toBe(true);
  const sent = await sender.request("send", { to: "ghost", body: "offline", conversationId: "ab399" });
  expect(sent.deliveredTo).toEqual([]);
  expect(sent.queuedFor).toEqual(["ghost"]);
  const retained = new DatabaseSync(env.db, { readOnly: true });
  try { expect(retained.prepare("SELECT name FROM peer_names WHERE name='ghost'").all()).toHaveLength(1); }
  finally { retained.close(); }
  ghost.close(); sender.close(); await broker.close();
});
