import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
let env: TestEnv, project: string;
const clients: BridgeClient[] = [];
beforeEach(async () => {
  env = makeEnv(); project = join(env.home, "project"); mkdirSync(project);
  execFileSync("git", ["init", project], { windowsHide: true, stdio: "ignore" });
  await env.node("broker", "other").start();
});
afterEach(async () => { for (const client of clients.splice(0)) client.close(); await env.cleanup(); });
async function session(name: string, id: string, subagent = false) {
  const client = await BridgeClient.connect(env.pipe, nullLogger); clients.push(client);
  const hello = await client.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: {
    id: randomUUID(), name, agent: "codex", cwd: project, pid: process.pid, agentPid: null, sessionId: id, startedAt: Date.now(), autoWake: false, subagent,
  } });
  return { client, hello };
}
it("keeps an established suffix across replacement and reversed reconnect order, retaining mail", async () => {
  const base = await session("codex-project", "base"), parent = await session("codex-project", "parent");
  expect(parent.hello.name).toBe("codex-project-2");
  await base.client.request("projectMain", { to: parent.hello.name });
  const replacement = await session("codex-project", "parent");
  expect(replacement.hello.name).toBe("codex-project-2");
  expect((await replacement.client.request("peers", {})).find(p => p.sessionId === "parent")?.projectMain).toBe(true);
  base.client.close(); replacement.client.close();
  const reader = env.node("reader", "other"); await reader.start();
  await reader.peers();
  await reader.send({ to: "codex-project-2", body: "retained parent mail" });
  const resumed = await session("codex-project", "parent"), resumedBase = await session("codex-project", "base");
  expect(resumed.hello.name).toBe("codex-project-2"); expect(resumedBase.hello.name).toBe("codex-project");
  expect((await resumed.client.request("pending", {})).some(m => m.body === "retained parent mail")).toBe(true);
});
it("carries main through an owning rename/resume; a reused name cannot inherit it", async () => {
  const other = await session("other", "other"), main = await session("main", "main");
  await other.client.request("projectMain", { to: "main" });
  await main.client.request("updatePeer", { name: "renamed", sessionId: "resumed-main" });
  await session("main", "different");
  const peers = await other.client.request("peers", {});
  expect(peers.find(p => p.name === "renamed")?.projectMain).toBe(true);
  expect(peers.find(p => p.name === "main")?.projectMain).toBe(false);
  expect((await other.client.request("send", { to: "project:project", body: "project mail" })).projectRoute?.main).toBe("renamed");
});
it("rejects a positively identified native registration before it claims name or main", async () => {
  await expect(session("codex-project", "child", true)).rejects.toThrow("Native subagents");
  const main = await session("codex-project", "root");
  expect(main.hello.name).toBe("codex-project");
  expect((await main.client.request("peers", {})).some(p => p.sessionId === "child")).toBe(false);
});
