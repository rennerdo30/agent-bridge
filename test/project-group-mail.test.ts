import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalProjectRoot, projectGroupsEnabled } from "../src/core/project-identity.js";
import { ProjectGroups } from "../src/core/project-groups.js";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, type TestEnv } from "./helpers.js";
import { ReadJournal } from "../src/core/read-journal.js";
import { JobManager } from "../src/mcp/jobs.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import type { ServerContext } from "../src/mcp/server.js";

let env: TestEnv;
const nodes: BridgeNode[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { for (const n of nodes.splice(0)) await n.stop(); await env.cleanup(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
function repo() {
  const path = join(env.home, "project"); mkdirSync(path);
  git(path, "init");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial");
  return path;
}
async function node(name: string, cwd: string, job?: { id: string; owner: string; parent: string }) {
  const n = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name, cwd,
    agent: job ? "other" : name.startsWith("codex") ? "codex" : "claude", autoWake: true, log: nullLogger,
    ...(job ? { id: `job:${job.id}`, jobAgent: "codex" as const, jobOwner: job.owner, jobParent: job.parent, canHostBroker: false } : {}) });
  nodes.push(n); await n.start(); return n;
}
function registry(project: string) {
  const jobs = ["one", "two"].map((id, i) => ({ id, name: `codex-job-${id}`, agent: "codex", model: null, prompt: "task", startedAt: Date.now(), status: "running", sessionId: null, workdir: project, worktree: null,
    owner: i ? "codex-master" : "claude-master", rootName: i ? "codex-master" : "claude-master", supervisor: i ? "second" : "first", args: { title: `Job ${id}` } }));
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 2, jobs })); return jobs;
}

describe("durable project job mail", () => {
  it("keeps pending sibling mail and quiet observer notes at their intended recipients on group changes", async () => {
    const path = repo(); registry(path);
    const source = await node("claude-master", path), secondary = await node("codex-master", path);
    const a = await node("codex-job-one", path, { id: "one", owner: "first", parent: source.name });
    const b = await node("codex-job-two", path, { id: "two", owner: "second", parent: secondary.name });
    const sent = await a.sendSibling({ to: b.name, body: "Private sibling context" }, 32);
    const id = sent.messages[0]!.id;
    expect(b.unread().some((m) => m.id === id)).toBe(true);
    const third = await node("claude-third", path);
    await source.setUnavailable(true);
    expect(b.unread().some((m) => m.id === id)).toBe(true);
    for (const master of [source, secondary, third]) {
      expect(master.unread().some((m) => m.id === id)).toBe(false);
      expect(master.unread().filter((m) => m.conversationId.startsWith("siblings-")).every((m) => m.conversationId.endsWith(":note"))).toBe(true);
    }
    b.markRead([id]);
    await expect.poll(async () => (await a.messageReceipt(id))[0]?.readAt).toBeTypeOf("number");
  });
  it("queues reports while every master is unavailable and delivers once on return", async () => {
    const path = repo(); registry(path);
    const source = await node("claude-master", path), secondary = await node("codex-master", path);
    const runner = await node("codex-job-one", path, { id: "one", owner: "first", parent: source.name });
    await source.setUnavailable(true); await secondary.setUnavailable(true);
    const sent = await runner.send({ to: source.name, body: "Retained until available", conversationId: "job-one:note" });
    const inline = { ...sent.messages[0]!, id: randomUUID(), body: "Retained inline report" };
    await source.reportInlineJob(inline);
    expect(sent.deliveredTo).toEqual([]); expect(sent.queuedFor).toEqual([source.name]);
    // Refill RPCs must obey the same availability fence as live and replay events.
    await source.refreshPending(); await secondary.refreshPending();
    expect(source.unread()).toHaveLength(0); expect(secondary.unread()).toHaveLength(0);
    await source.setUnavailable(false);
    await expect.poll(() => source.unread().filter((m) => m.id === sent.messages[0]!.id).length).toBe(1);
    expect(source.unread().filter((m) => m.id === inline.id)).toHaveLength(1);
    source.markRead([sent.messages[0]!.id, inline.id]);
    // A local read precedes the broker ACK; reassign only after consumption is durable.
    for (const id of [sent.messages[0]!.id, inline.id]) {
      await expect.poll(async () => (await runner.messageReceipt(id))[0]?.readAt).toBeTypeOf("number");
    }
    await source.setUnavailable(true); await secondary.setUnavailable(false);
    expect(secondary.unread()).toHaveLength(0);
  });
  it("retains an undelivered finished job note through reconnect and the prompt hook", async () => {
    await env.node("broker", "other").start();
    const path = repo(), records = registry(path), source = await node("claude-master", path);
    const runner = await node("codex-job-one", path, { id: "one", owner: "first", parent: source.name });
    await source.stop();
    const sent = await runner.send({ to: source.name, body: "Final pending note", conversationId: "job-one:note" });
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...records[0], status: "done", projectRoot: canonicalProjectRoot(path) }] }));
    const returned = await node("claude-master", path);
    await expect.poll(() => returned.unread().some((m) => m.id === sent.messages[0]!.id)).toBe(true);
    const jobs = new JobManager(returned, nullLogger, join(env.home, "jobs.json"));
    const ctx = { agent: "claude", cfg: { ...DEFAULT_CONFIG }, node: returned, jobs, log: nullLogger, home: env.home, cwd: () => path, channelActive: () => false } as ServerContext;
    const result = await buildHookResponse(ctx, { event: "UserPromptSubmit", sessionId: null, stopHookActive: false });
    expect(JSON.stringify(result)).toContain("Final pending note");
    await expect.poll(async () => (await runner.messageReceipt(sent.messages[0]!.id))[0]!.readAt).toBeTypeOf("number");
  });
  it("does not replay a recovered inline envelope consumed before its broker acknowledgement", async () => {
    const path = repo(), records = registry(path), source = await node("claude-master", path);
    const secondary = await node("codex-master", path);
    const envelope = { id: randomUUID(), from: { id: "job:one", name: "codex-job-one", agent: "codex" }, to: source.name,
      recipient: source.name, body: "Already consumed", conversationId: "job-one", hop: 0, replyTo: null, createdAt: Date.now(), readAt: null };
    new ReadJournal(env.home).append(`name:${source.name}`, [envelope.id]);
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ ...records[0], deliveryHistory: [envelope] }, records[1]] }));
    await source.setUnavailable(true);
    expect(secondary.unread().some((m) => m.id === envelope.id)).toBe(false);
    const runner = await node("codex-job-one", path, { id: "one", owner: "first", parent: source.name });
    expect((await runner.messageReceipt(envelope.id))[0]!.readAt).toBeTypeOf("number");
  });
});
