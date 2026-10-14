import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { formatParentRoute, ParentLink, parentFromEnv, type ParentRoute } from "../src/core/parent-link.js";
import { questionRoute } from "../src/mcp/job-runner.js";
import { openJobQuestions } from "../src/core/job-questions.js";
import { isJobQuestion } from "../src/core/protocol.js";
import { startUi } from "../src/cli/ui.js";
import { makeEnv, type TestEnv } from "./helpers.js";

// AB-249: a job's question to a parent that is not connected goes to the project's current main session,
// the send result names where it went, and open questions are listed for the dashboard.
let env: TestEnv;
const nodes: BridgeNode[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { for (const n of nodes.splice(0)) await n.stop().catch(() => {}); await env.cleanup(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
function repo(): string {
  const path = join(env.home, "project"); mkdirSync(path);
  git(path, "init");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial");
  return path;
}
async function node(name: string, cwd: string, job?: { id: string; parent: string }): Promise<BridgeNode> {
  const n = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name, cwd,
    agent: job ? "other" : name.startsWith("codex") ? "codex" : "claude", autoWake: false, log: nullLogger,
    ...(job ? { id: `job:${job.id}`, jobAgent: "codex" as const, jobOwner: job.parent, jobParent: job.parent, canHostBroker: false } : {}) });
  nodes.push(n); await n.start(); return n;
}
function registry(project: string): void {
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "one", name: "codex-job-one", agent: "codex", model: null, prompt: "task",
    startedAt: Date.now(), status: "running", sessionId: null, workdir: project, worktree: null, owner: "claude-parent", rootName: "claude-parent",
    supervisor: "claude-parent", args: { title: "Job one" } }] }));
}
const isMainOf = (n: BridgeNode) => async (name: string) => (await n.peers()).some((p) => p.name === name && p.projectMain === true);
const question = (runner: BridgeNode, body: string) => runner.send({ to: "claude-parent", body, conversationId: "job-one:question" }, { quiet: true });

describe("job questions to the parent (AB-249)", () => {
  it("delivers to a connected parent and reports it", async () => {
    const path = repo(); registry(path);
    await node("codex-main", path);
    const parent = await node("claude-parent", path);
    const runner = await node("codex-job-one", path, { id: "one", parent: "claude-parent" });
    const sent = await question(runner, "Which branch should I release from?");
    expect(sent.deliveredTo).toEqual(["claude-parent"]);
    expect(sent.messages[0]!.conversationId).toBe("job-one:question");
    expect(isJobQuestion(sent.messages[0]!)).toBe(true);
    await expect.poll(() => parent.unread().some((m) => m.id === sent.messages[0]!.id)).toBe(true);
    const route = await questionRoute(sent, "claude-parent", isMainOf(runner));
    expect(route).toEqual({ state: "delivered", parent: "claude-parent" });
    expect(formatParentRoute(route)).toContain("Question delivered to claude-parent");
  });

  it("routes a question to the project's current main session while the parent is offline", async () => {
    const path = repo(); registry(path);
    const oldest = await node("codex-first", path);
    const main = await node("claude-main", path);
    // The owner made the newer session the main: the question follows the main, not the oldest member.
    await main.setProjectMain("claude-main");
    const runner = await node("codex-job-one", path, { id: "one", parent: "claude-parent" });
    const sent = await question(runner, "May I delete the stale release branch?");
    expect(sent.deliveredTo).toEqual(["claude-main"]);
    expect(sent.messages[0]!.conversationId).toBe("job-one:question:fallback");
    await expect.poll(() => main.unread().some((m) => m.id === sent.messages[0]!.id)).toBe(true);
    expect(oldest.unread().some((m) => m.id === sent.messages[0]!.id)).toBe(false);
    const route = await questionRoute(sent, "claude-parent", isMainOf(runner));
    expect(route).toEqual({ state: "rerouted", parent: "claude-parent", recipient: "claude-main", main: true });
    const text = formatParentRoute(route);
    expect(text).toContain("claude-parent, the session that gave you this task, is not available");
    expect(text).toContain("went to claude-main, the project's current main session,");

    // Ordinary job mail keeps its existing fallback order (unchanged delivery semantics).
    const note = await runner.send({ to: "claude-parent", body: "Status: tests pass", conversationId: "job-one:note" }, { quiet: true });
    expect(note.deliveredTo).toEqual(["codex-first"]);

    // The dashboard lists the open question until the job hears back through its control conversation.
    const open = openJobQuestions(env.db);
    expect(open.map((q) => [q.job, q.recipient, q.rerouted])).toEqual([["codex-job-one", "claude-main", true]]);
    await main.send({ to: "codex-job-one", body: JSON.stringify({ type: "message", body: "Yes, delete it.", cid: "c1" }), conversationId: "jobctl-one" }, { quiet: true });
    expect(openJobQuestions(env.db)).toEqual([]);
  });

  it("says so explicitly when neither the parent nor a project main is connected", async () => {
    const path = repo(); registry(path);
    await env.node("broker", "other").start();
    const runner = await node("codex-job-one", path, { id: "one", parent: "claude-parent" });
    const sent = await question(runner, "Should I publish now?");
    expect(sent.deliveredTo).toEqual([]);
    expect(sent.queuedFor).toEqual(["claude-parent"]);
    const route = await questionRoute(sent, "claude-parent", isMainOf(runner));
    expect(route).toEqual({ state: "queued", parent: "claude-parent", recipient: "claude-parent" });
    const text = formatParentRoute(route);
    expect(text).toContain("no project main session is available either");
    expect(text).toContain("Apply your fallback now");
    expect(openJobQuestions(env.db).map((q) => q.recipient)).toEqual(["claude-parent"]);

    // "Waiting for you" lists it next to owner questions and permissions, with the job's parent.
    const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    try {
      const cookie = String((await fetch(ui.url, { redirect: "manual" })).headers.get("set-cookie")).split(";")[0]!;
      const data = await (await fetch(ui.url.replace(/\/\?t=.*$/, "") + "/api/approvals", { headers: { cookie } })).json() as { approvals: Record<string, unknown>[] };
      expect(data.approvals).toEqual([expect.objectContaining({ kind: "job-question", job: "codex-job-one", owner: "claude-parent", recipient: "claude-parent",
        rerouted: false, body: "Should I publish now?", id: sent.messages[0]!.id })]);
    } finally { await ui.close(); }
  });

  it("closes a dashboard question when the job reports again, and ignores notes and non-control mail", () => {
    const db = new DatabaseSync(env.db);
    try {
      db.exec(`CREATE TABLE messages (id TEXT NOT NULL, recipient TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL, from_agent TEXT NOT NULL,
        to_target TEXT NOT NULL, conversation_id TEXT NOT NULL, reply_to TEXT, hop INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
        PRIMARY KEY (id, recipient))`);
      const add = db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,NULL,0,?,?,NULL)");
      add.run("q1", "parent", "job:aa", "codex-job-aa", "codex", "parent", "job-aa:question", "First question?", 10);
      add.run("n1", "parent", "job:aa", "codex-job-aa", "codex", "parent", "job-aa:note", "Meanwhile running tests", 11);
      add.run("t1", "codex-job-aa", "parent", "parent", "claude", "codex-job-aa", "jobctl-aa", JSON.stringify({ type: "title", title: "x" }), 12);
      add.run("q2", "parent", "job:bb", "codex-job-bb", "codex", "parent", "job-bb:question", "Second question?", 20);
      add.run("r2", "parent", "job:bb", "codex-job-bb", "codex", "parent", "job-bb", "Final report", 21);
      add.run("x1", "parent", "job:cc", "codex-job-cc", "codex", "parent", "job-cc", "Not a question", 30);
    } finally { db.close(); }
    const open = openJobQuestions(env.db);
    expect(open.map((q) => q.id)).toEqual(["q1"]);
    expect(open[0]).toMatchObject({ job: "codex-job-aa", recipient: "parent", rerouted: false, body: "First question?", readAt: null });
  });

  it("returns the routing to the job over its parent link, or says it is unconfirmed", async () => {
    const routes: ParentRoute[] = [{ state: "rerouted", parent: "claude-parent", recipient: "claude-main", main: true }];
    let pending = false;
    const link = new ParentLink("claude-parent", (_body, _reply, kind) =>
      kind === "question" ? (pending ? new Promise(() => {}) : Promise.resolve(routes[0])) : undefined, nullLogger);
    await link.start();
    try {
      const child = parentFromEnv(link.childEnv())!;
      expect(await child.send("Proceed?", undefined, "question")).toEqual(routes[0]);
      expect(await child.send("Status only", undefined, "note")).toBeUndefined();
      pending = true;
      const unconfirmed = await child.send("Proceed now?", undefined, "question");
      expect(unconfirmed).toEqual({ state: "unconfirmed", parent: "claude-parent" });
      expect(formatParentRoute(unconfirmed!)).toContain("do not resend it");
    } finally { await link.close(); }
  });
});
