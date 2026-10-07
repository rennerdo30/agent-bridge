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

describe("local project permission groups", () => {
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
    expect(source.unread()).toHaveLength(0); expect(secondary.unread()).toHaveLength(0);
    await source.setUnavailable(false);
    await expect.poll(() => source.unread().filter((m) => m.id === sent.messages[0]!.id).length).toBe(1);
    expect(source.unread().filter((m) => m.id === inline.id)).toHaveLength(1);
    source.markRead([sent.messages[0]!.id, inline.id]);
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
    expect((await runner.messageReceipt(sent.messages[0]!.id))[0]!.readAt).toBeTypeOf("number");
  });
  it("lets a secondary become primary after the starter has closed", async () => {
    await env.node("broker", "other").start();
    const path = repo(); registry(path);
    const source = await node("claude-master", path), secondary = await node("codex-master", path);
    await source.stop();
    await secondary.handoffSubagents({ to: secondary.name, jobs: ["codex-job-one"] });
    expect(await secondary.jobAuthority("codex-job-one")).toMatchObject({ owner: secondary.name, projectRoot: canonicalProjectRoot(path) });
    const outside = await node("claude-outside", env.home);
    await expect(outside.handoffSubagents({ to: outside.name, jobs: ["codex-job-one"] })).rejects.toThrow("not controlled");
  });
  it("lets another master message, change and cancel an inline job whose primary is unavailable", async () => {
    const path = repo(), source = await node("claude-master", path), secondary = await node("codex-master", path);
    const original = new JobManager(source, nullLogger, join(env.home, "jobs.json"));
    const shared = new JobManager(secondary, nullLogger, join(env.home, "jobs.json"));
    const job = original.start("codex", null, "Inline work", (signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ text: "cancelled", sessionId: null, isError: true, details: {} }));
    }));
    try {
      await source.setUnavailable(true);
      expect(await shared.share(job.name)).toBeTruthy();
      expect(shared.followUp(job.name, "Redirect inline work").outcome).toBe("delivered");
      await expect.poll(() => job.queue).toContain("Redirect inline work");
      shared.setTitle(job.name, "Shared inline title");
      shared.setSettings(job.name, { effort: "high" });
      await expect.poll(() => job.args).toMatchObject({ title: "Shared inline title", effort: "high" });
      expect(shared.cancel(job.name)).toBe(true);
      await expect.poll(() => job.controller.signal.aborted).toBe(true);
    } finally { original.cancelAll(); }
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
  it("switches the main with an all-jobs handoff and rejects a cross-group switch atomically", async () => {
    const path = repo(); registry(path);
    const source = await node("claude-master", path), target = await node("codex-master", path), outside = await node("claude-Development", env.home);
    const registryPath = join(env.home, "jobs.json"), original = readFileSync(registryPath, "utf8");
    await expect(source.handoffSubagents({ to: outside.name, jobs: "all", switch_project_main: true })).rejects.toThrow("same project group");
    expect(readFileSync(registryPath, "utf8")).toBe(original);
    await source.handoffSubagents({ to: target.name, jobs: "all", switch_project_main: true });
    expect((await source.peers()).find((p) => p.name === target.name)?.projectMain).toBe(true);
    expect(await source.jobAuthority("codex-job-one")).toBeTruthy();
  });
  it("keeps handoff grants outside the group and falls back to the previous primary first", async () => {
    const path = repo(); const jobs = registry(path);
    const source = await node("claude-master", path), secondary = await node("codex-master", path);
    const parentFolder = await node("claude-Development", env.home), unrelated = await node("codex-Development", env.home);
    const runner = await node(jobs[0]!.name, path, { id: "one", owner: "first", parent: source.name });
    await source.handoffSubagents({ to: parentFolder.name, jobs: [runner.name] });
    expect(await source.jobAuthority(runner.name)).toBeTruthy();
    expect(await secondary.jobAuthority(runner.name)).toBeTruthy();
    expect(await parentFolder.jobAuthority(runner.name)).toBeTruthy();
    expect(await unrelated.jobAuthority(runner.name)).toBeNull();
    await runner.send({ to: source.name, body: "Only to primary", conversationId: "job-one" });
    expect(parentFolder.unread().some((m) => m.body === "Only to primary")).toBe(true);
    expect(source.unread().some((m) => m.body === "Only to primary")).toBe(false);
    parentFolder.markRead(parentFolder.unread().map((m) => m.id));
    await parentFolder.setUnavailable(true);
    await runner.send({ to: source.name, body: "Previous primary fallback", conversationId: "job-one" });
    await expect.poll(() => source.unread().some((m) => m.body === "Previous primary fallback")).toBe(true);
    expect(secondary.unread().some((m) => m.body === "Previous primary fallback")).toBe(false);
    source.markRead(source.unread().map((m) => m.id));
    await parentFolder.setUnavailable(false);
    expect(parentFolder.unread().some((m) => /Only to primary|Previous primary fallback/.test(m.body))).toBe(false);
  });

  it("does not merge sibling authority across original projects after a shared handoff", async () => {
    const path = repo(), records = registry(path), separate = join(env.home, "separate"); mkdirSync(separate);
    records[1]!.workdir = separate;
    for (const record of records) { record.supervisor = "same-handoff-root"; record.owner = "claude-Development"; record.rootName = "claude-Development"; }
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 2, jobs: records }));
    await node("claude-Development", env.home);
    const a = await node(records[0]!.name, path, { id: "one", owner: "same-handoff-root", parent: "claude-Development" });
    const b = await node(records[1]!.name, separate, { id: "two", owner: "same-handoff-root", parent: "claude-Development" });
    expect((await a.siblings()).map((p) => p.name)).not.toContain(b.name);
    await expect(a.sendSibling({ to: b.name, body: "Cross-project sibling attempt" }, 32)).rejects.toThrow();
  });

  it("routes the project to main or secondary while exact addresses stay direct", async () => {
    const path = repo(), a = await node("claude-master", path), b = await node("codex-master", path);
    const outsider = await node("outside", env.home);
    expect((await a.peers()).find((p) => p.name === a.name)).toMatchObject({ projectMain: true, projectAddress: "project:project" });
    expect((await outsider.send({ to: "project:project", body: "Project request" })).deliveredTo).toEqual([a.name]);
    await a.setProjectMain(b.name);
    expect((await outsider.send({ to: "project:project", body: "New main request" })).deliveredTo).toEqual([b.name]);
    await b.setUnavailable(true);
    expect((await outsider.send({ to: "project:project", body: "Fallback request" })).deliveredTo).toEqual([a.name]);
    expect((await outsider.send({ to: b.name, body: "Exact session" })).deliveredTo).toEqual([b.name]);
    await expect(outsider.setProjectMain(a.name)).rejects.toThrow("Only a master");
    await b.stop();
    await expect.poll(async () => (await a.peers()).find((p) => p.name === a.name)?.projectMain).toBe(true);
  });
  it("unifies nested folders and linked worktrees using the common Git root", () => {
    const path = repo(), nested = join(path, "nested"); mkdirSync(nested);
    const worktree = join(env.home, "worktree"); git(path, "worktree", "add", "--detach", worktree);
    expect(canonicalProjectRoot(nested)).toBe(realpathSync.native(path));
    expect(canonicalProjectRoot(worktree)).toBe(realpathSync.native(path));
    expect(canonicalProjectRoot(join(env.home, "missing"))).toBeNull();
  });
  it("unifies linked worktrees when the repository uses a separate Git directory", () => {
    const path = join(env.home, "separate-git-project"); mkdirSync(path);
    git(path, "init", "--separate-git-dir", join(env.home, "metadata"));
    git(path, "config", "core.worktree", path);
    git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial");
    const worktree = join(env.home, "separate-git-worktree"); git(path, "worktree", "add", "--detach", worktree);
    expect(canonicalProjectRoot(worktree)).toBe(realpathSync.native(path));
  });

  it("reads the project opt-out without rewriting old settings and denies malformed values", () => {
    const path = repo(); mkdirSync(join(path, ".agent-bridge"));
    const config = join(path, ".agent-bridge", "config.json"), raw = '{"projectGroups":false,"oldField":{"x":1}}';
    writeFileSync(config, raw); expect(projectGroupsEnabled(path)).toBe(false); expect(readFileSync(config, "utf8")).toBe(raw);
    writeFileSync(config, '{"projectGroups":"true"}'); expect(projectGroupsEnabled(path)).toBe(false);
    writeFileSync(config, '{"projectGroups":true}'); expect(projectGroupsEnabled(path)).toBe(true);
    writeFileSync(join(env.home, "config.json"), '{"projectGroups":false,"claude":{"projectGroups":false}}');
    expect(projectGroupsEnabled(path, env.home, "claude")).toBe(true);
    expect(loadConfig(env.home, "claude", nullLogger, {}, path).projectGroups).toBe(true);
    writeFileSync(config, '{"projectGroups":true,"claude":{"projectGroups":false}}');
    expect(projectGroupsEnabled(path, env.home, "claude")).toBe(false);
    expect(loadConfig(env.home, "claude", nullLogger, {}, path).projectGroups).toBe(false);
    writeFileSync(config, '{"projectGroups":"true"}');
    expect(projectGroupsEnabled(path, env.home, "claude")).toBe(false);
    expect(loadConfig(env.home, "claude", nullLogger, {}, path).projectGroups).toBe(false);
    writeFileSync(config, '{broken'); expect(projectGroupsEnabled(path, env.home, "claude")).toBe(false);
  });

  it("lets both masters see and control jobs and lets their jobs message as siblings", async () => {
    const path = repo(); registry(path);
    const master = await node("claude-master", path), other = await node("codex-master", path);
    const a = await node("codex-job-one", path, { id: "one", owner: "first", parent: master.name });
    const b = await node("codex-job-two", path, { id: "two", owner: "second", parent: other.name });
    expect((await other.projectJobs()).map((j) => j.name)).toEqual([a.name, b.name]);
    expect(await other.jobAuthority(a.name)).toMatchObject({ owner: master.name });
    expect((await a.siblings()).map((p) => p.name)).toContain(b.name);
    expect((await a.sendSibling({ to: b.name, body: "Compare the results" }, 32)).deliveredTo).toEqual([b.name]);
  });

  it("keeps other projects and nested workers outside group authority while retaining grants", async () => {
    const path = repo(), jobs = registry(path);
    const master = await node("claude-master", path);
    const separate = join(env.home, "separate"); mkdirSync(separate);
    const other = await node("codex-other", separate);
    expect(await other.jobAuthority(jobs[0]!.name)).toBeNull();
    const groups = new ProjectGroups(env.home), peers = await master.peers(), primary = peers.find((p) => p.name === master.name)!;
    expect(groups.canControl({ ...primary, subagent: true }, jobs[0]!, peers)).toBe(false);
    expect(groups.shareable({ ...jobs[0], ownershipHistory: [{ reason: "explicit-handoff" }] })).toBe(true);
    expect(groups.shareable({ ...jobs[0], ownershipHistory: [{ reason: "group-restored" }] })).toBe(true);
  });
});
