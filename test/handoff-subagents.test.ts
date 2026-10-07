import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { commitHandoff } from "../src/core/job-handoff.js";
import { JobManager, readStore, type Job, type Run } from "../src/mcp/jobs.js";
import { JOBS_FILE } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import { RootConcurrency } from "../src/core/root-concurrency.js";
import { ResourceSlots } from "../src/core/resource-slots.js";
import { publishApproval, listPendingApprovals, newApprovalId, answerPendingApproval } from "../src/core/relay.js";
import { listRuns } from "../src/core/dashboard-read.js";
import { startUi } from "../src/cli/ui.js";
import { attachDashboardJobControl } from "../src/mcp/dashboard-control.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { chooseJobRecipient, mastersFor } from "../src/core/job-ownership.js";

let env: TestEnv, source: BridgeNode, target: BridgeNode;
let extra: BridgeNode[] = [];
let managers: JobManager[] = [];
let ui: Awaited<ReturnType<typeof startUi>> | undefined;
const path = () => join(env.home, JOBS_FILE);
const record = (id: string, more: Record<string, unknown> = {}) => ({ id, name: `codex-job-${id}`, agent: "codex", model: null, prompt: "Task", startedAt: 100,
  status: "done", owner: "claude-source", supervisor: "source-root", rootSession: "source-root", rootName: "claude-source",
  sessionId: `thread-${id}`, workdir: env.home, worktree: null, args: { title: `Task ${id}`, send_to: ["claude-source", "other-session"] }, ...more });
const save = (jobs: unknown[]) => writeFileSync(path(), JSON.stringify({ version: 2, preserved: "extension", jobs }));
const manager = (node: BridgeNode) => {
  const m = new JobManager(node, nullLogger, path());
  managers.push(m); m.restore(() => () => Object.assign(async () => ({ text: "continued", sessionId: "thread", isError: false, details: {} }), {}));
  return m;
};

beforeEach(async () => { env = makeEnv(); source = env.node("claude-source"); target = env.node("codex-target", "codex"); await source.start(); await target.start(); });
afterEach(async () => { await ui?.close(); ui = undefined; for (const m of managers.splice(0)) m.cancelAll(); for (const n of extra.splice(0)) await n.stop(); await env.cleanup(); });

describe("local subagent ownership handoff", () => {
  it("routes a legacy direct job to its current owner despite stale root lineage", async () => {
    const job = record("legacy", { owner: target.name });
    expect(mastersFor(job)).toEqual([target.name]);
    expect(chooseJobRecipient(job, await source.peers())).toBe(target.name);
  });
  it.each(["claude", "codex", "opencode"] as const)("moves all jobs to a live %s session with history and a waking inventory", async (agent) => {
    const to = env.node(`${agent}-receiver`, agent); await to.start();
    save([record("a"), record("b", { status: "failed" })]);
    const result = await source.handoffSubagents({ to: to.name, note: "Review the evidence" });
    expect(result.jobs).toHaveLength(2);
    const stored = readStore(path());
    expect(stored.every((j) => j.owner === to.name && j.rootName === to.name)).toBe(true);
    expect(stored[0]!.ownershipHistory).toMatchObject([{ from: source.name, to: to.name, fromRoot: "source-root", note: "Review the evidence" }]);
    expect(stored[0]!.args?.send_to).toEqual([to.name, "other-session"]);
    await until(() => to.unread().some((m) => m.body.includes("Inherited subagents")));
    expect(to.unread()[0]!.body).toContain("Task a (done)");
    expect(to.unread()[0]!.body).toContain("Task b (failed)");
    expect(to.unread()[0]!.body).toContain("Review the evidence");
    expect(to.unread()[0]!.conversationId).not.toContain(":note");
    expect(JSON.parse(readFileSync(path(), "utf8")).preserved).toBe("extension");
    expect(source.unread().some((m) => m.body.includes("Handed off 2"))).toBe(true);
  });

  it("moves selected parent trees, leaves other jobs, and uses the target's existing root", async () => {
    save([record("a"), record("child", { parentJob: "codex-job-a", owner: "codex-job-a" }), record("b"), record("target", { owner: target.name, supervisor: "target-root" })]);
    await source.handoffSubagents({ to: target.name, jobs: ["codex-job-a"] });
    expect(readStore(path()).find((j) => j.id === "child")).toMatchObject({ parentJob: "codex-job-a", owner: "codex-job-a", rootName: target.name, rootSession: "target-root", supervisor: "target-root" });
    expect(readStore(path()).find((j) => j.id === "b")!.owner).toBe(source.name);
    const moved = listRuns(env.home).find((r) => r.job === "codex-job-child")!;
    expect(moved.rootName).toBe(target.name);
  });

  it("copies unread results while retaining old rows and keeps later reports out of the old inbox", async () => {
    save([record("a", { status: "running", host: { peer: "codex-job-a", pid: process.pid, startedAt: Date.now() } })]);
    const runner = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), id: "job:a", name: "codex-job-a", agent: "other", jobAgent: "codex", jobOwner: "source-root", jobParent: source.name, cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
    extra.push(runner); await runner.start();
    const first = (await runner.send({ to: source.name, body: "Pending report", conversationId: "job-a" })).messages[0]!;
    await until(() => source.unread().some((m) => m.id === first.id));
    await source.handoffSubagents({ to: target.name });
    await until(() => target.unread().some((m) => m.id === first.id));
    await until(() => !source.unread().some((m) => m.id === first.id));
    const deliveries: string[] = [];
    source.on("message", (m) => { if (m.from.id === "job:a") deliveries.push(m.id); });
    const later = await runner.send({ to: source.name, body: "Later report", conversationId: "job-a" });
    expect(later.deliveredTo).toEqual([target.name]);
    expect(await runner.messageReceipt(first.id)).toEqual(expect.arrayContaining([{ recipient: source.name, readAt: expect.any(Number) }, { recipient: target.name, readAt: null }]));
    expect((await source.send({ to: runner.name, body: '{"type":"attach"}', conversationId: "jobctl-a" })).deliveredTo).toEqual([runner.name]);
    expect((await target.send({ to: runner.name, body: '{"type":"attach"}', conversationId: "jobctl-a" })).deliveredTo).toEqual([runner.name]);
    await runner.send({ to: source.name, body: "Status note", conversationId: "job-a:note" });
    await runner.send({ to: source.name, body: "Approval question", conversationId: "job-a" });
    await until(() => target.unread().some((m) => m.body === "Approval question"));
    expect(deliveries).toEqual([]);
    target.markRead(target.unread().map((m) => m.id));
    await target.stop();
    await expect.poll(async () => (await source.peers()).some((p) => p.name === target.name)).toBe(false);
    const fallback = await runner.send({ to: "codex-target", body: "Fallback report", conversationId: "job-a" });
    expect(fallback.deliveredTo).toEqual([source.name]);
    await until(() => source.unread().some((m) => m.body === "Fallback report"));
    source.markRead(source.unread().map((m) => m.id));
    const returned = env.node("codex-target", "codex"); await returned.start();
    const resumed = await runner.send({ to: source.name, body: "Primary returned", conversationId: "job-a" });
    expect(resumed.deliveredTo).toEqual([returned.name]);
    expect(readStore(path())[0]!.owner).toBe(returned.name);
    expect((await runner.siblings()).some((p) => p.name === "unrelated")).toBe(false);
  });

  it("retains an inline result that previously bypassed the broker", async () => {
    save([record("a")]);
    source.deliverLocal({ id: "local-report", from: { id: "job:a", name: "codex-job-a", agent: "codex" }, to: source.name, recipient: source.name, body: "Subagent codex-job-a (codex) done after 1s.\n\nEvidence", conversationId: "job-a", replyTo: null, hop: 0, createdAt: Date.now(), readAt: null });
    await source.handoffSubagents({ to: target.name });
    await until(() => target.unread().some((m) => m.id === "local-report"));
  });

  it("returns unread mail to former-master history without replaying a consumed envelope", () => {
    const store = new MessageStore(":memory:", nullLogger);
    try {
      store.insert({ id: "roundtrip", from: { id: "job:a", name: "codex-job-a", agent: "codex" }, to: source.name, recipient: source.name, body: "Pending evidence", conversationId: "job-a", replyTo: null, hop: 0, createdAt: 1, readAt: null });
      expect(store.handoffMail(source.name, target.name, "a", 2).map((m) => m.id)).toEqual(["roundtrip"]);
      expect(store.unread(source.name, 10)).toHaveLength(0);
      expect(store.handoffMail(target.name, source.name, "a", 3).map((m) => m.id)).toEqual(["roundtrip"]);
      expect(store.unread(target.name, 10)).toHaveLength(0);
      expect(store.unread(source.name, 10)).toMatchObject([{ id: "roundtrip", readAt: null }]);
      store.markRead(source.name, ["roundtrip"], 4);
      expect(store.handoffMail(source.name, target.name, "a", 5)).toEqual([]);
      expect(store.unread(target.name, 10)).toEqual([]);
    } finally { store.close(); }
  });

  it("recovers inline envelopes after a failed send and never replays consumed delivery history", async () => {
    const old = manager(source); let finish!: (value: { text: string; sessionId: string; isError: boolean; details: {} }) => void;
    const job = old.start("codex", null, "Work", async () => new Promise((resolve) => { finish = resolve; }));
    await source.handoffSubagents({ to: target.name });
    source.reportInlineJob = async () => { throw new Error("Connection lost before report"); };
    finish({ text: "Crash-safe evidence", sessionId: "thread", isError: false, details: {} });
    await until(() => Boolean(readStore(path())[0]?.deliveryHistory?.length));
    expect(target.unread().some((m) => m.from.name === job.name)).toBe(false);
    const recovery = env.node("recovery", "opencode"); extra.push(recovery); await recovery.start();
    await until(() => target.unread().some((m) => m.body.includes("Crash-safe evidence")));
    const report = target.unread().find((m) => m.from.name === job.name)!;
    target.markRead([report.id]);
    await expect.poll(() => {
      const reader = new DatabaseSync(env.db, { readOnly: true });
      try { return reader.prepare("SELECT read_at FROM messages WHERE id=? AND recipient=?").get(report.id, target.name)?.read_at !== null; } finally { reader.close(); }
    }).toBe(true);
    await recovery.stop(); const again = env.node("recovery-again", "opencode"); extra.push(again); await again.start();
    await target.peers();
    expect(target.unread().some((m) => m.id === report.id)).toBe(false);
    expect(readStore(path())[0]!.deliveryHistory).toMatchObject([{ id: report.id, body: expect.stringContaining("Crash-safe evidence") }]);
  });

  it("moves archived jobs without changing their archived bytes", async () => {
    mkdirSync(join(env.home, "archive"));
    const archive = join(env.home, "archive", "jobs-saved.json");
    const bytes = JSON.stringify({ jobs: [record("a")] }); writeFileSync(archive, bytes); save([]);
    await source.handoffSubagents({ to: target.name });
    expect(readFileSync(archive, "utf8")).toBe(bytes);
    expect(readStore(path(), undefined, true).find((j) => j.id === "a")!.owner).toBe(target.name);
  });

  it("appends a second transfer and rejects the former owner", async () => {
    save([record("a")]); await source.handoffSubagents({ to: target.name });
    await expect(source.handoffSubagents({ to: target.name, jobs: ["codex-job-a"] })).rejects.toThrow("not owned");
    await target.handoffSubagents({ to: source.name });
    expect(readStore(path())[0]!.ownershipHistory).toHaveLength(2);
  });

  it.each(["missing", "codex", "paired/codex-target", "claude-source"])("rejects invalid or nonexact target %s without changing records", async (to) => {
    save([record("a")]); const bytes = readFileSync(path(), "utf8");
    await expect(source.handoffSubagents({ to })).rejects.toThrow();
    expect(readFileSync(path(), "utf8")).toBe(bytes);
  });

  it("rejects a remote descendant atomically", async () => {
    save([record("a"), record("remote", { parentJob: "codex-job-a", owner: "codex-job-a", remote: { host: "paired", name: "remote" } })]);
    const bytes = readFileSync(path(), "utf8");
    await expect(source.handoffSubagents({ to: target.name })).rejects.toThrow("remote-jobs-v1");
    expect(readFileSync(path(), "utf8")).toBe(bytes);
  });

  it("preserves newer-format data and fails before writing", async () => {
    writeFileSync(path(), JSON.stringify({ version: 999, jobs: [record("a")] }));
    const bytes = readFileSync(path(), "utf8");
    await expect(source.handoffSubagents({ to: target.name })).rejects.toThrow("unsupported JSON");
    expect(readFileSync(path(), "utf8")).toBe(bytes);
  });

  it("replays delivery effects after a crash following the registry commit", async () => {
    save([record("a")]);
    const [from, to] = (await source.peers()).filter((p) => [source.name, target.name].includes(p.name));
    const receipt = commitHandoff(path(), from!, to!, { to: target.name });
    await source.stop(); await target.stop();
    const restarted = env.node(target.name, "codex"); await restarted.start();
    await until(() => restarted.unread().some((m) => m.id === `${receipt.id}-inherited`));
    await restarted.stop(); const again = env.node(target.name, "codex"); await again.start();
    await until(() => again.unread().some((m) => m.id === `${receipt.id}-inherited`));
    expect(again.unread().filter((m) => m.id === `${receipt.id}-inherited`)).toHaveLength(1);
  });

  it("moves leases beyond capacity without interrupting work and releases them from the original root", async () => {
    save([record("a", { status: "running" })]);
    const old = new RootConcurrency(env.home, "source-root"), next = new RootConcurrency(env.home, target.id);
    const lease = { id: "codex-job-a-turn", pid: process.pid }, other = { id: "target-turn", pid: process.pid };
    try {
      old.setLimit(1); next.setLimit(1); expect(old.acquire(lease)).toBe(true); expect(next.acquire(other)).toBe(true);
      await source.handoffSubagents({ to: target.name });
      expect(old.available()).toBe(true); expect(next.available()).toBe(false);
      old.renew(lease); old.release(lease); next.release(other); expect(next.available()).toBe(true);
    } finally { old.release(lease); next.release(other); old.close(); next.close(); }
  });

  it("projects pending approvals under the new supervisor without losing the relay", async () => {
    save([record("a")]); const id = newApprovalId(); let answer = "";
    const close = await publishApproval(env.home, { id, owner: source.name, job: "codex-job-a", agent: "codex", tool: "command", command: "build", reason: "build", askedAt: Date.now(), deadline: Date.now() + 10000 }, (body) => { answer = body; return true; });
    try {
      await source.handoffSubagents({ to: target.name });
      expect(listPendingApprovals(env.home)[0]!.owner).toBe(target.name);
      expect(await answerPendingApproval(env.home, id, { decision: "allow" })).toBe("answered"); expect(answer).toBe("allow");
    } finally { close(); }
  });

  it("retains former-master controls and prevents the old manager overwriting ownership", async () => {
    save([record("a")]); const old = manager(source), next = manager(target);
    await source.handoffSubagents({ to: target.name });
    expect(old.find("codex-job-a")!.owner).toBe(target.name);
    expect(next.find("codex-job-a")!.owner).toBe(target.name);
    old.persist(); expect(readStore(path())[0]!.owner).toBe(target.name);
    expect(old.followUp("codex-job-a", "Continue as former master").outcome).toBe("delivered");
    await until(() => target.unread().some((m) => m.from.name === "codex-job-a" && m.body.includes("continued")));
    await until(() => next.find("codex-job-a")?.status === "done");
  });

  it.each([true, false])("does not let a delayed original executor overwrite a newer continuation (handoff=%s)", async (handoff) => {
    const old = manager(source);
    const tracked = old.track("codex", null, "Initial blocking work");
    if (handoff) await source.handoffSubagents({ to: target.name });
    const document = JSON.parse(readFileSync(path(), "utf8"));
    const current = document.jobs.find((j: Job) => j.id === tracked.job.id);
    Object.assign(current, { startedAt: tracked.job.startedAt + 100, status: "running", executionOwner: target.name, sessionId: "newer-continuation" });
    writeFileSync(path(), JSON.stringify(document));
    tracked.job.status = "done";
    old.persist();
    expect(readStore(path()).find((j) => j.id === tracked.job.id)).toMatchObject({ startedAt: current.startedAt, status: "running", executionOwner: target.name, sessionId: "newer-continuation" });
  });

  it("lets the new owner message and cancel an inline run while preserving execution", async () => {
    const old = manager(source), next = manager(target);
    const run: Run = async (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ text: "stopped", sessionId: "thread", isError: true, details: {} }), { once: true }));
    const job = old.start("codex", null, "Work", run, undefined, { title: "Inline work" }); let message = "";
    job.live = { post: (body) => { message = body; } };
    await source.handoffSubagents({ to: target.name });
    expect(job.controller.signal.aborted).toBe(false); expect(old.list()).toHaveLength(0); expect(next.list()).toHaveLength(1);
    expect(next.followUp(job.name, "New instruction").outcome).toBe("delivered"); await until(() => message === "New instruction");
    expect(next.cancel(job.name)).toBe(true); await until(() => job.controller.signal.aborted);
    await until(() => target.unread().some((m) => m.from.name === job.name && m.body.includes("stopped")));
    expect(old.find(job.name)!.owner).toBe(target.name);
  });

  it("routes the dashboard POST through the same supervisor core and guards cross-site requests", async () => {
    save([record("a")]); const old = manager(source); attachDashboardJobControl(source, old, nullLogger);
    ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    const url = new URL(ui.url); const cookie = (await fetch(url, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
    const body = JSON.stringify({ from: source.name, to: target.name, note: "Dashboard move" });
    expect((await fetch(`${url.origin}/api/subagents/handoff`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body })).status).toBe(403);
    const response = await fetch(`${url.origin}/api/subagents/handoff`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-agent-bridge": "1" }, body });
    expect(response.status).toBe(200); expect(readStore(path())[0]!.owner).toBe(target.name);
    expect((await listRuns(env.home))[0]!.rootName).toBe(target.name);
  });
});
