import { afterEach, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { CODING_AGENTS } from "../src/core/protocol.js";
import { shouldWakeClaudeMessage } from "../src/mcp/rewake.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });
it("broadcasts to every live project secondary while project addresses use only the main", async () => {
  const project = join(env.home, "project"); mkdirSync(project);
  execFileSync("git", ["init", project], { windowsHide: true, stdio: "ignore" });
  const sender = env.node("sender", "other"); await sender.start();
  const sessions: ReturnType<TestEnv["node"]>[] = [];
  for (const agent of CODING_AGENTS) {
    const node = env.node(`${agent}-secondary`, agent);
    await node.relocate(project); await node.start(); await node.setWakePolicy(true, true); node.setActivity("idle");
    sessions.push(node);
  }
  const main = sessions[0]!;
  expect((await sender.send({ to: `project:${basename(project)}`, body: "project instruction" })).deliveredTo).toEqual([main.name]);
  const sent = await sender.send({ to: "*", body: "all sessions" });
  expect(sent.deliveredTo.sort()).toEqual(sessions.map((n) => n.name).sort());
  expect(sent.wakeRequestedFor!.sort()).toEqual(sessions.map((n) => n.name).sort());
  expect(sent.queuedFor).toEqual([]); expect(sent.skippedFor).toEqual([]);
  await until(() => sessions.every((n) => n.unread().some((m) => m.body === "all sessions")));
  for (const node of sessions) expect(shouldWakeClaudeMessage(node, DEFAULT_CONFIG, node.unread().find((m) => m.body === "all sessions")!)).toBe(true);
  expect(sessions.every((node) => node.autoWakeEnabled === false)).toBe(true);
});
