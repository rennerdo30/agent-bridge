import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { AGENT_KINDS, type CodingAgent } from "../src/core/protocol.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
const nodes: BridgeNode[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { for (const n of nodes.splice(0)) await n.stop(); await env.cleanup(); });
async function session(name: string, cwd = env.home) {
  if (name === "outside" && cwd === env.home) { cwd = join(env.home, "outside-project"); mkdirSync(cwd); }
  const n = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name, cwd, agent: "codex", autoWake: false, log: nullLogger });
  nodes.push(n); await n.start(); return n;
}
async function runner(agent: CodingAgent, parent: string, cwd = env.home, grants: string[] = []) {
  const n = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name: `${agent}-job-one`, id: "job:one", cwd,
    agent: "other", jobAgent: agent, jobParent: parent, jobOwner: "root-session", jobSendTo: grants, autoWake: false, canHostBroker: false, log: nullLogger });
  nodes.push(n); await n.start(); return n;
}
function registry(name: string, owner: string, project: string, grants: string[] = [], extra: Record<string, unknown> = {}) {
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ id: "one", name, agent: name.split("-")[0],
    owner, rootName: owner, supervisor: "root-session", status: "running", startedAt: Date.now(), workdir: project, args: { send_to: grants }, ...extra }] }));
}
function repo() {
  const cwd = join(env.home, "project"); mkdirSync(cwd);
  execFileSync("git", ["init", cwd], { windowsHide: true, stdio: "ignore" }); return cwd;
}

it.each(AGENT_KINDS.filter((agent): agent is CodingAgent => agent !== "other"))("rejects ordinary foreign mail visibly for %s jobs", async (agent) => {
  const master = await session("master"), outside = await session("outside");
  const job = await runner(agent, master.name);
  await expect(outside.send({ to: job.name, body: "Please answer" })).rejects.toThrow("No message was stored");
  expect(job.unread()).toEqual([]);
  await expect(master.send({ to: job.name, body: "Parent request" })).rejects.toThrow("message_subagent");
});

it("requires a supported job channel even when a direct reply grant exists", async () => {
  const master = await session("master"), outside = await session("outside");
  const job = await runner("codex", master.name, env.home, [outside.name]);
  registry(job.name, master.name, env.home);
  await expect(outside.send({ to: job.name, body: "Removed grant" })).rejects.toThrow("No message was stored");
  registry(job.name, master.name, env.home, [outside.name]);
  await expect(outside.send({ to: job.name, body: "Current grant" })).rejects.toThrow("No message was stored");
  expect(job.unread()).toEqual([]);
});

it("rejects unsupported mail after handoff and primary outage", async () => {
  const master = await session("old-master"), target = await session("new-master"), outside = await session("outside");
  const job = await runner("opencode", master.name);
  registry(job.name, target.name, env.home, [], { ownershipHistory: [{ from: master.name, fromRootName: master.name, to: target.name, rootName: target.name }], masters: [master.name, target.name] });
  await expect(outside.send({ to: job.name, body: "After handoff" })).rejects.toThrow("Ask its supervisor");
  await target.setUnavailable(true);
  await expect(outside.send({ to: job.name, body: "Primary unavailable" })).rejects.toThrow("No message was stored");
});

it("requires job control from project masters while retaining sibling delivery", async () => {
  const cwd = repo(), master = await session("master", cwd), group = await session("group-master", cwd), outside = await session("outside");
  const job = await runner("claude", master.name, cwd); registry(job.name, master.name, cwd);
  await expect(group.send({ to: job.name, body: "Same project" })).rejects.toThrow("message_subagent");
  await master.setUnavailable(true);
  await expect(outside.send({ to: job.name, body: "Ask available master" })).rejects.toThrow("No message was stored");
  const sibling = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name: "codex-job-two", id: "job:two", cwd,
    agent: "other", jobAgent: "codex", jobParent: master.name, jobOwner: "root-session", autoWake: false, canHostBroker: false, log: nullLogger });
  nodes.push(sibling); await sibling.start();
  expect((await sibling.sendSibling({ to: job.name, body: "Sibling request" }, 3)).replyRestrictions).toBeUndefined();
});

it("rejects ordinary mail to an offline job without queuing an undeliverable question", async () => {
  const master = await session("master"), outside = await session("outside");
  registry("codex-job-one", master.name, env.home);
  await expect(outside.send({ to: "codex-job-one", body: "Queued question" })).rejects.toThrow("No message was stored");
});
