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
import { JobManager, readStore } from "../src/mcp/jobs.js";
import { metadataFileLease } from "../src/core/metadata-file-lease.js";
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
    agent: job ? "other" : name.startsWith("codex") ? "codex" : name.startsWith("antigravity") ? "antigravity" : "claude", autoWake: true, log: nullLogger,
    ...(job ? { id: `job:${job.id}`, jobAgent: "codex" as const, jobOwner: job.owner, jobParent: job.parent, canHostBroker: false } : {}) });
  nodes.push(n); await n.start(); return n;
}
function registry(project: string) {
  const jobs = ["one", "two"].map((id, i) => ({ id, name: `codex-job-${id}`, agent: "codex", model: null, prompt: "task", startedAt: Date.now(), status: "running", sessionId: null, workdir: project, worktree: null,
    owner: i ? "codex-master" : "claude-master", rootName: i ? "codex-master" : "claude-master", supervisor: i ? "second" : "first", args: { title: `Job ${id}` } }));
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 2, jobs })); return jobs;
}

describe("local project permission groups", () => {
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
  it("waits for a registry lease held briefly in the broker's own process instead of failing the handoff", async () => {
    const path = repo(); registry(path);
    const source = await node("claude-master", path), target = await node("codex-master", path);
    // The broker's history worker reconciles ask completions under this lease from the same PID (never stale).
    const release = metadataFileLease(join(env.home, "jobs.json.lock"));
    const released = new Promise<void>((resolve) => setTimeout(() => { release(); resolve(); }, 300));
    try {
      const receipt = await source.handoffSubagents({ to: target.name, jobs: "all" });
      expect(receipt.jobs.map((j) => j.name)).toContain("codex-job-one");
    } finally { await released; }
    expect(readStore(join(env.home, "jobs.json")).find((j) => j.id === "one")?.owner).toBe(target.name);
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

  it.each(["codex", "antigravity"])("routes the project to a %s main or secondary while exact addresses stay direct", async (agent) => {
    const path = repo(), a = await node("claude-master", path), b = await node(`${agent}-master`, path);
    const outsider = await node("outside", env.home);
    expect((await a.peers()).find((p) => p.name === a.name)).toMatchObject({ projectMain: true, projectAddress: "project:project" });
    expect((await outsider.send({ to: "project:project", body: "Project request" })).deliveredTo).toEqual([a.name, b.name]);
    await a.setProjectMain(b.name);
    expect((await outsider.send({ to: "project:project", body: "New main request" })).deliveredTo).toEqual([b.name, a.name]);
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
