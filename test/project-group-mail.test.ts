import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalProjectRoot, projectGroupsEnabled } from "../src/core/project-identity.js";
import { ProjectGroups } from "../src/core/project-groups.js";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { fixtureProject, makeEnv, type TestEnv } from "./helpers.js";
import { ReadJournal, readJournalIdentities } from "../src/core/read-journal.js";
import { JobManager, readStore } from "../src/mcp/jobs.js";
import { fixtureJobReport, fixtureNodePeer, retainFixtureRunner } from "./owned-mail.js";
import { MessageStore } from "../src/core/store.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import type { ServerContext } from "../src/mcp/server.js";

let env: TestEnv;
const nodes: BridgeNode[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { for (const n of nodes.splice(0)) await n.stop(); await env.cleanup(); });
function repo() {
  const path = join(env.home, "project"); mkdirSync(path);
  // Canonical project discovery reads the ordinary Git layout directly; this
  // routing fixture needs no repository mutation or Git subprocess.
  fixtureProject(path);
  return path;
}
async function node(name: string, cwd: string, job?: { id: string; owner: string; parent: string }) {
  if (job) retainFixtureRunner(env.home, { id: job.id, name, agent: "codex", owner: job.parent, supervisor: job.owner, cwd });
  const n = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name, cwd,
    agent: job ? "other" : name.startsWith("codex") ? "codex" : "claude", autoWake: true, log: nullLogger,
    ...(job ? { id: `job:${job.id}`, jobAgent: "codex" as const, jobOwner: job.owner, jobParent: job.parent, canHostBroker: false } : {}) });
  nodes.push(n); if (!job) await n.setSessionId(`fixture-session:${name}`); await n.start(); return n;
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
  it("retains an undelivered finished job note through reconnect without prompt injection", async () => {
    await env.node("broker", "other").start();
    const path = repo(), records = registry(path), source = await node("claude-master", path);
    const runner = await node("codex-job-one", path, { id: "one", owner: "first", parent: source.name });
    await source.stop();
    const sent = await runner.send({ to: source.name, body: "Final pending note", conversationId: "job-one:note" });
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...readStore(join(env.home, "jobs.json"))[0], status: "done", projectRoot: canonicalProjectRoot(path) }] }));
    const returned = await node("claude-master", path);
    await expect.poll(() => returned.unread().some((m) => m.id === sent.messages[0]!.id)).toBe(true);
    const jobs = new JobManager(returned, nullLogger, join(env.home, "jobs.json"));
    const ctx = { agent: "claude", cfg: { ...DEFAULT_CONFIG }, node: returned, jobs, log: nullLogger, home: env.home, cwd: () => path, channelActive: () => false } as ServerContext;
    const result = await buildHookResponse(ctx, { event: "UserPromptSubmit", sessionId: null, stopHookActive: false });
    expect(JSON.stringify(result)).not.toContain("Final pending note");
    expect(returned.unread().some(m => m.id === sent.messages[0]!.id)).toBe(true);
    expect((await runner.messageReceipt(sent.messages[0]!.id))[0]!.readAt).toBeNull();
  });
  it("does not replay a recovered inline envelope consumed before its broker acknowledgement", async () => {
    const path = repo(), records = registry(path), source = await node("claude-master", path);
    const secondary = await node("codex-master", path);
    retainFixtureRunner(env.home, { id: "one", name: "codex-job-one", agent: "codex", owner: source.name, supervisor: "first", cwd: path });
    const envelope = source.prepareLocalMessage({ id: randomUUID(), from: { id: "job:one", name: "codex-job-one", agent: "codex" }, to: source.name,
      recipient: source.name, body: "Already consumed", conversationId: "job-one", hop: 0, replyTo: null, createdAt: Date.now(), readAt: null });
    const store = new MessageStore(env.db, nullLogger);
    let report: ReturnType<typeof fixtureJobReport>;
    const retained = readStore(join(env.home, "jobs.json"));
    const originalJob = retained.find(job => job.id === "one")!;
    try { const peer = fixtureNodePeer(store, source, "claude"); report = fixtureJobReport(store, originalJob as unknown as Record<string, unknown>, peer, peer, envelope); }
    finally { store.close(); }
    new ReadJournal(env.home).append(readJournalIdentities(source.name, source.currentSessionId, envelope.recipientFrontend, envelope.recipientNative, envelope.recipientMailbox, { grant: envelope.id, generation: 0 })[0]!, [envelope.id]);
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: retained.map(job => job.id === originalJob.id ? { ...job, deliveryHistory: [report.message], reportRouting: { [envelope.id]: report.draft } } : job) }));
    await source.setUnavailable(true);
    expect(secondary.unread().some((m) => m.id === envelope.id)).toBe(false);
    const runner = await node("codex-job-one", path, { id: "one", owner: "first", parent: source.name });
    expect((await runner.messageReceipt(envelope.id))[0]!.readAt).toBeTypeOf("number");
  });
});
