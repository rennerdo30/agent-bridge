import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv, project: string;
const clients: BridgeClient[] = [];
beforeEach(async () => {
  env = makeEnv(); project = join(env.home, "project"); mkdirSync(project);
  execFileSync("git", ["init", project], { windowsHide: true, stdio: "ignore" });
  await env.node("broker", "other").start();
});
afterEach(async () => { for (const client of clients.splice(0)) client.close(); await env.cleanup(); });

async function session(name: string, id: string) {
  const client = await BridgeClient.connect(env.pipe, nullLogger); clients.push(client);
  const hello = await client.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: {
    id: randomUUID(), name, agent: "codex", cwd: project, pid: process.pid, agentPid: null, sessionId: id, startedAt: Date.now(), autoWake: false, subagent: false,
  } });
  return { client, hello };
}

it("AB-489: a new session that takes over the main's name gets no 'main changed from X to X' notice", async () => {
  const first = await session("codex-project", "first");
  expect((await first.client.request("peers", {})).find(p => p.sessionId === "first")?.projectMain).toBe(true);
  first.client.close();
  const reader = env.node("reader", "other"); await reader.start();
  let gone = false;
  for (const end = Date.now() + 5_000; !gone && Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) {
    gone = !(await reader.peers()).some(p => p.sessionId === "first");
  }
  expect(gone).toBe(true);
  const next = await session("codex-project", "next");
  expect(next.hello.name).toBe("codex-project");
  const peers = await next.client.request("peers", {});
  expect(peers.find(p => p.sessionId === "next")).toMatchObject({ projectMain: true });
  expect(peers.find(p => p.sessionId === "next")?.projectRoute?.previous).toBeUndefined();
  await new Promise(resolve => setTimeout(resolve, 100));
  expect((await next.client.request("pending", {})).filter(m => m.body.includes("main changed"))).toEqual([]);
});
