import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalProjectRoot, projectGroupsEnabled } from "../src/core/project-identity.js";
import { ProjectGroups } from "../src/core/project-groups.js";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, type TestEnv } from "./helpers.js";

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

  it("reads the project opt-out without rewriting old settings and denies malformed values", () => {
    const path = repo(); mkdirSync(join(path, ".agent-bridge"));
    const config = join(path, ".agent-bridge", "config.json"), raw = '{"projectGroups":false,"oldField":{"x":1}}';
    writeFileSync(config, raw); expect(projectGroupsEnabled(path)).toBe(false); expect(readFileSync(config, "utf8")).toBe(raw);
    writeFileSync(config, '{"projectGroups":"true"}'); expect(projectGroupsEnabled(path)).toBe(false);
    writeFileSync(config, '{"projectGroups":true}'); expect(projectGroupsEnabled(path)).toBe(true);
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
