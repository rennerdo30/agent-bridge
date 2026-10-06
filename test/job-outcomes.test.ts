import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveJobOutcome, listJobOutcomes, JOB_OUTCOMES_DIR, MAX_HOLD_REASON_CHARS, readOutcomeDecision, setJobOutcome, type OutcomeJob } from "../src/core/job-outcomes.js";
import { recordLocalResult } from "../src/core/local-result-receipts.js";
import { JSON_STORE_VERSION } from "../src/core/json-store.js";
import { ReadJournal } from "../src/core/read-journal.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { runMetaPath, startRunFeed } from "../src/core/runfeed.js";
import { resolveDbPath } from "../src/core/paths.js";
import { createWorktree, finishWorktree } from "../src/core/worktree.js";
import { JobManager } from "../src/mcp/jobs.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { archiveJobs } from "../src/core/job-archive.js";
import { createBackup, readBackup, restoreBackup } from "../src/core/backups.js";
import { doctor } from "../src/core/doctor.js";
import { maintenanceLock } from "../src/core/storage-lock.js";
import * as worktreeHelpers from "../src/core/worktree.js";

let home: string;
let store: MessageStore;
const job = (): OutcomeJob => ({ id: "deadbeef", name: "codex-job-deadbeef", owner: "supervisor", startedAt: 100, status: "done", worktree: null });
const message = (at = 200, body = "Subagent codex-job-deadbeef (codex) done after 1s."): BridgeMessage => ({ id: randomUUID(), recipient: "supervisor", to: "supervisor", from: { id: "job:deadbeef", name: job().name, agent: "codex" }, conversationId: "job-deadbeef", replyTo: null, hop: 0, body, createdAt: at, readAt: null });
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-outcomes-")); store = new MessageStore(resolveDbPath(home), nullLogger); });
afterEach(() => { store.close(); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe("finished job delivery", () => {
  it("distinguishes unknown, delivered, and supervisor consumption with times", async () => {
    expect((await deriveJobOutcome(home, job(), nullLogger)).delivery.status).toBe("unknown");
    const result = message();
    store.insert(result);
    expect((await deriveJobOutcome(home, job(), nullLogger)).delivery).toMatchObject({ status: "delivered", messageId: result.id, deliveredAt: 200, readAt: null });
    store.markRead("supervisor", [result.id], 300);
    expect((await deriveJobOutcome(home, job(), nullLogger)).delivery).toMatchObject({ status: "read", readAt: 300 });
    store.purgeOlderThan(400);
    expect((await deriveJobOutcome(home, job(), nullLogger)).delivery).toMatchObject({ status: "read", deliveredAt: 200, readAt: 300 });
  });

  it("does not confuse progress, sibling copies, old turns, or later turns with a result", async () => {
    store.insert(message(50));
    store.insert(message(250, "Approval for a job allowed by session."));
    store.insert({ ...message(260), recipient: "other-supervisor" });
    store.insert(message(500));
    expect((await deriveJobOutcome(home, job(), nullLogger, { before: 400 })).delivery.status).toBe("unknown");
    const result = message(300, "Subagent codex-job-deadbeef (codex) failed after 2s.");
    store.insert(result);
    expect((await deriveJobOutcome(home, job(), nullLogger, { before: 400 })).delivery.messageId).toBe(result.id);
  });

  it("retains local result receipts and supports legacy journal reads with unknown time", async () => {
    const result = message();
    recordLocalResult(home, result);
    expect((await deriveJobOutcome(home, job(), nullLogger)).delivery.status).toBe("delivered");
    const journal = new ReadJournal(home);
    journal.append("name:supervisor", [result.id]);
    const outcome = await deriveJobOutcome(home, job(), nullLogger);
    expect(outcome.delivery.status).toBe("read");
    expect(outcome.delivery.readAt).toBeGreaterThan(0);
    const path = join(home, "read-state", `${createHash("sha256").update("name:supervisor").digest("hex")}.jsonl`);
    writeFileSync(path, `${JSON.stringify([result.id])}\n`);
    expect((await deriveJobOutcome(home, job(), nullLogger)).delivery).toMatchObject({ status: "read", readAt: null });
  });
});

describe("supervisor decisions and migration", () => {
  it("includes archived jobs without rewriting the archive or losing active precedence", async () => {
    const path = join(home, "jobs.json");
    const archived = archiveJobs(path, [{ ...job(), worktree: null, agent: "codex", prompt: "task", model: null, sessionId: null, workdir: null }]);
    const old = readFileSync(archived, "utf8").replace('"version": 2', '"version": 1');
    writeFileSync(archived, old);
    writeFileSync(path, JSON.stringify({ version: 1, jobs: [] }));
    setJobOutcome(home, job(), "supervisor", "held", "archive hold");
    expect((await listJobOutcomes(home, nullLogger))[job().name]?.outcome.merge.state).toBe("held");
    expect(readFileSync(archived, "utf8")).toBe(old);
    writeFileSync(path, JSON.stringify({ jobs: [{ ...job(), startedAt: 600, status: "running" }] }));
    expect(await listJobOutcomes(home, nullLogger)).toEqual({});
  });

  it("backs up and restores decisions and local receipts under the home maintenance lock", async () => {
    store.close();
    const result = message();
    recordLocalResult(home, result);
    new ReadJournal(home).append("name:supervisor", [result.id]);
    setJobOutcome(home, job(), "supervisor", "held", "original", 400);
    const backup = createBackup(home);
    expect(readBackup(backup).files.some((f) => f.path.startsWith("job-outcomes/"))).toBe(true);
    expect(readBackup(backup).files.some((f) => f.path.startsWith("local-result-receipts/"))).toBe(true);
    expect(doctor(home).findings.some((f) => f.code.startsWith("journal-"))).toBe(false);
    setJobOutcome(home, job(), "supervisor", "discarded", "later", 500);
    restoreBackup(home, backup, true);
    expect(readOutcomeDecision(home, job())?.reason).toBe("original");
    expect((await deriveJobOutcome(home, job(), nullLogger)).delivery.status).toBe("read");
    const unlock = maintenanceLock(home);
    try {
      expect(() => setJobOutcome(home, job(), "supervisor", "discarded")).toThrow("maintenance");
      expect(() => recordLocalResult(home, message(600))).toThrow("maintenance");
    } finally { unlock(); }
    store = new MessageStore(resolveDbPath(home), nullLogger);
  });
  it("requires a finished owned job and a bounded nonblank hold reason", () => {
    expect(() => setJobOutcome(home, job(), "other", "discarded")).toThrow("supervisor");
    expect(() => setJobOutcome(home, { ...job(), status: "running" }, "supervisor", "held", "wait")).toThrow("finished");
    expect(() => setJobOutcome(home, job(), "supervisor", "held", " ")).toThrow("reason");
    expect(() => setJobOutcome(home, job(), "supervisor", "held", "x".repeat(MAX_HOLD_REASON_CHARS + 1))).toThrow("at most");
    expect(setJobOutcome(home, job(), "supervisor", "held", " wait for CPU A/B ", 400)).toMatchObject({ state: "held", reason: "wait for CPU A/B", at: 400 });
  });

  it("preserves decision history, unknown fields, old bytes in backup, and separates turns", async () => {
    setJobOutcome(home, job(), "supervisor", "held", "wait", 400);
    const path = join(home, JOB_OUTCOMES_DIR, readdirSync(join(home, JOB_OUTCOMES_DIR))[0]!);
    const legacy = JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), version: 1, future: { keep: true } });
    writeFileSync(path, legacy);
    setJobOutcome(home, job(), "supervisor", "discarded", "superseded", 500);
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(data).toMatchObject({ version: JSON_STORE_VERSION, future: { keep: true }, history: [{ state: "held", at: 400 }], decision: { state: "discarded", at: 500 } });
    const backup = readdirSync(join(home, JOB_OUTCOMES_DIR)).find((f) => f.includes(".backup-"))!;
    expect(readFileSync(join(home, JOB_OUTCOMES_DIR, backup), "utf8")).toBe(legacy);
    expect(readOutcomeDecision(home, { ...job(), startedAt: 600 })).toBeNull();
    expect((await deriveJobOutcome(home, job(), nullLogger)).merge).toMatchObject({ state: "discarded", decisionAt: 500, decisionBy: "supervisor" });
    const future = JSON.stringify({ version: JSON_STORE_VERSION + 1, decision: data.decision });
    writeFileSync(path, future);
    expect(() => setJobOutcome(home, job(), "supervisor", "held", "wait")).toThrow("unsupported");
    expect(readFileSync(path, "utf8")).toBe(future);
  });

  it("backs up v1 run metadata only on write and keeps unknown nested data", () => {
    const feed = startRunFeed({ home, name: "codex-test", header: "codex" });
    const path = runMetaPath(feed.logPath);
    const legacy = JSON.stringify({ version: 1, future: { keep: true } });
    writeFileSync(path, legacy);
    feed.meta({ branch: "agent-bridge/test", branchHead: "tip" });
    feed.end("done");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: JSON_STORE_VERSION, branch: "agent-bridge/test", future: { keep: true } });
    const backup = readdirSync(join(home, "runs")).find((f) => f.includes(".backup-"))!;
    expect(readFileSync(join(home, "runs", backup), "utf8")).toBe(legacy);
  });
});

describe("Git outcome derivation", () => {
  it("never checks paired-PC worktrees or receipts against local evidence", async () => {
    const remote = { ...job(), remote: { host: "paired-pc", name: "codex-job-remote" }, worktree: { repoRoot: home, path: home, cwd: home, branch: "main", base: "base", baseBranch: "main" } };
    const local = message(); store.insert(local); store.markRead("supervisor", [local.id], 300);
    const git = vi.spyOn(worktreeHelpers, "git");
    try {
      expect(await deriveJobOutcome(home, remote, nullLogger)).toMatchObject({ delivery: { status: "unknown" }, merge: { state: "unmerged", reason: expect.stringContaining("paired PC") } });
      setJobOutcome(home, remote, "supervisor", "held", "remote review");
      expect((await deriveJobOutcome(home, remote, nullLogger)).merge.state).toBe("held");
      expect(git).not.toHaveBeenCalled();
    } finally { git.mockRestore(); }
  });
  it("checks the recorded base, respects held/discarded, and uses a saved tip after deletion", async () => {
    const repo = join(home, "repo"); mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q");
    git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "base");
    const wt = await createWorktree({ cwd: repo, home, jobId: job().id, log: nullLogger });
    const j = { ...job(), worktree: wt };
    expect((await deriveJobOutcome(home, j, nullLogger, { baseBranch: null })).merge).toMatchObject({ state: "unmerged", baseBranch: null });
    writeFileSync(join(wt.path, "a.txt"), "work\n");
    await finishWorktree(wt, "work", nullLogger);
    const head = git("rev-parse", wt.branch);
    expect((await deriveJobOutcome(home, j, nullLogger)).merge.state).toBe("unmerged");
    git("branch", "other", head);
    expect((await deriveJobOutcome(home, j, nullLogger)).merge.state).toBe("unmerged");
    setJobOutcome(home, j, "supervisor", "held", "CPU A/B");
    expect((await deriveJobOutcome(home, j, nullLogger)).merge.state).toBe("held");
    const old = { ...j, startedAt: 90 };
    git("merge", "--ff-only", wt.branch);
    expect((await deriveJobOutcome(home, old, nullLogger)).merge.state).toBe("merged");
    git("worktree", "remove", wt.path); git("branch", "-d", wt.branch);
    expect((await deriveJobOutcome(home, old, nullLogger)).merge).toMatchObject({ state: "unmerged", reason: expect.stringContaining("missing") });
    expect((await deriveJobOutcome(home, old, nullLogger, { branchHead: head })).merge.state).toBe("merged");
  });
});

describe("local JobManager result integration", () => {
  it("records delivery and consumption of a real local job result", async () => {
    const env: TestEnv = makeEnv();
    const node = env.node("supervisor");
    await node.start();
    const manager = new JobManager(node, nullLogger);
    try {
      const j = manager.start("codex", null, "task", async () => ({ sessionId: "session", text: "done", isError: false, details: {} }));
      await until(() => node.unread().length > 0);
      expect((await deriveJobOutcome(env.home, j, nullLogger)).delivery.status).toBe("delivered");
      node.markRead(node.unread().map((m) => m.id));
      expect((await deriveJobOutcome(env.home, j, nullLogger)).delivery.status).toBe("read");
    } finally { manager.cancelAll(); await env.cleanup(); }
  });
});
