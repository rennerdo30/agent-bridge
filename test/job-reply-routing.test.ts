import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { formatDelivery, formatReplyRestrictions } from "../src/mcp/format.js";
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

it.each(AGENT_KINDS.filter((agent): agent is CodingAgent => agent !== "other"))("warns both sides of a restricted %s reply", async (agent) => {
  const master = await session("master"), outside = await session("outside");
  const job = await runner(agent, master.name);
  const result = await outside.send({ to: job.name, body: "Please answer" });
  expect(result.replyRestrictions).toEqual([{ name: job.name, supervisor: master.name }]);
  expect(formatDelivery(result).join("\n")).toContain(`${job.name} can't reply to you directly. Its replies go to its supervisor master.`);
  expect(formatReplyRestrictions(result).join("\n")).toContain("grant you with send_to");
  await expect.poll(() => job.unread()[0]?.body).toContain("this sender can't receive your direct reply; answer via your supervisor master");
  expect((await master.send({ to: job.name, body: "Parent request" })).replyRestrictions).toBeUndefined();
});

it("uses current durable grants instead of a stale runner grant", async () => {
  const master = await session("master"), outside = await session("outside");
  const job = await runner("codex", master.name, env.home, [outside.name]);
  registry(job.name, master.name, env.home);
  expect((await outside.send({ to: job.name, body: "Removed grant" })).replyRestrictions).toHaveLength(1);
  registry(job.name, master.name, env.home, [outside.name]);
  const allowed = await outside.send({ to: job.name, body: "Current grant" });
  expect(allowed.replyRestrictions).toBeUndefined();
  expect(allowed.messages[0]!.body).toBe("Current grant");
});

it("names the current available master after a handoff and primary outage", async () => {
  const master = await session("old-master"), target = await session("new-master"), outside = await session("outside");
  const job = await runner("opencode", master.name);
  registry(job.name, target.name, env.home, [], { ownershipHistory: [{ from: master.name, fromRootName: master.name, to: target.name, rootName: target.name }], masters: [master.name, target.name] });
  expect((await outside.send({ to: job.name, body: "After handoff" })).replyRestrictions?.[0]?.supervisor).toBe(target.name);
  await target.setUnavailable(true);
  expect((await outside.send({ to: job.name, body: "Primary unavailable" })).replyRestrictions?.[0]?.supervisor).toBe(master.name);
});

it("allows project masters and sibling replies and names a group fallback", async () => {
  const cwd = repo(), master = await session("master", cwd), group = await session("group-master", cwd), outside = await session("outside");
  const job = await runner("claude", master.name, cwd); registry(job.name, master.name, cwd);
  expect((await group.send({ to: job.name, body: "Same project" })).replyRestrictions).toBeUndefined();
  await master.setUnavailable(true);
  expect((await outside.send({ to: job.name, body: "Ask available master" })).replyRestrictions?.[0]?.supervisor).toBe(group.name);
  const sibling = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name: "codex-job-two", id: "job:two", cwd,
    agent: "other", jobAgent: "codex", jobParent: master.name, jobOwner: "root-session", autoWake: false, canHostBroker: false, log: nullLogger });
  nodes.push(sibling); await sibling.start();
  expect((await sibling.sendSibling({ to: job.name, body: "Sibling request" }, 3)).replyRestrictions).toBeUndefined();
});

it("retains the reply hint for an offline job without modifying the storage schema", async () => {
  const master = await session("master"), outside = await session("outside");
  registry("codex-job-one", master.name, env.home);
  const result = await outside.send({ to: "codex-job-one", body: "Queued question" });
  expect(result.queuedFor).toEqual(["codex-job-one"]);
  expect(result.replyRestrictions).toEqual([{ name: "codex-job-one", supervisor: master.name }]);
  expect(result.messages[0]!.body).toContain("Queued question\n\n[agent-bridge routing hint:");
});
