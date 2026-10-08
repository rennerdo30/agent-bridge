import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { archivePendingJob, mergePendingJob, pendingJobRoot, readPendingJobs, retainPendingJob } from "../src/core/job-pending-journal.js";
import { nullLogger } from "../src/core/logger.js";
import { JobManager, readStore } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), linkSync: vi.fn(actual.linkSync), readFileSync: vi.fn(actual.readFileSync) };
});

let home: string, path: string;
const managers: JobManager[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-pending-job-")); path = join(home, "jobs.json"); });
afterEach(() => { for (const manager of managers.splice(0)) { manager.setDormant(true); manager.cancelAll(); } vi.restoreAllMocks(); vi.resetAllMocks(); rmSync(home, { recursive: true, force: true }); });
function snapshot(extra: Record<string, unknown> = {}) {
  return { id: "abcdef12", name: "claude-job-abcdef12", owner: "owner", supervisor: "owner-session", agent: "claude", model: null,
    prompt: "complete exact original prompt", startedAt: Date.now() - 1000, finishedAt: Date.now(), status: "failed", sessionId: null, workdir: null, worktree: null,
    args: { access: "read-only", futureSetting: { keep: true } }, unknownFutureFields: { keep: [1, 2, 3] }, deliveryHistory: [], host: null, ...extra };
}
function retain(job = snapshot(), name = "owner") { return retainPendingJob(path, { name, session: "owner-session", nonce: randomUUID() }, job); }
function manager(name = "owner", eligible = true) {
  const node = new LocalCoordinator(name, "owner-session"), jobs = new JobManager(node, nullLogger, path, 4, undefined,
    { canRestore: () => eligible, canReceiveHandoff: () => false }); managers.push(jobs); return jobs;
}

it("recovers exact full context/result and unknown fields after restart, then archives verified original bytes", () => {
  const message = { id: "report-id", body: "complete preserved failure result" }, job = snapshot({ deliveryHistory: [message] });
  const receipt = retain(job), original = readFileSync(receipt.path, "utf8");
  manager().restore(() => undefined);
  expect(readStore(path)[0]).toMatchObject(job); expect(existsSync(receipt.path)).toBe(false);
  const archived = join(pendingJobRoot(path), "archive");
  expect(readdirSync(archived).some(dir => readFileSync(join(archived, dir, "receipt.json"), "utf8") === original)).toBe(true);
});

it.each([
  ["newer turn", { startedAt: 300, status: "running" }],
  ["newer settings", { metadataVersion: 9, args: { title: "latest settings" } }],
  ["changed owner", { owner: "new-owner", ownershipHistory: [{ to: "new-owner", reason: "explicit-handoff" }] }],
])("keeps %s durable authority and retains the superseded receipt", (_label, changes) => {
  const receipt = retain(), current = { ...receipt.value.job, ...changes, ...(_label === "newer turn" ? { startedAt: Date.now() + 1000 } : {}) }, original = JSON.stringify({ version: 4, unknownEnvelope: true, jobs: [current] });
  writeFileSync(path, original); manager().restore(() => undefined);
  expect(readFileSync(path, "utf8")).toBe(original); expect(existsSync(receipt.path)).toBe(true);
});

it.each(["done", "failed", "cancelled"])("keeps durable %s state ahead of a stale same-turn running receipt", status => {
  const current = snapshot({ status }), stale = { ...current, status: "running", finishedAt: undefined };
  expect(mergePendingJob(current, stale)).toBeNull();
});

it.each(["done", "cancelled"])("preserves newer same-turn durable queues, forwarded facts, %s status and exact envelopes", status => {
  const base = snapshot({ status: "running", finishedAt: undefined, queuedMessages: [], forwarded: [], deliveryHistory: [] });
  const current = { ...base, status, finishedAt: Date.now(), queuedMessages: ["new accepted follow-up"],
    forwarded: [{ cid: "new-cid", body: "new live message" }], deliveryHistory: [{ id: "same-id", body: "original durable contents" }] };
  const stale = { ...base, status: "failed", finishedAt: Date.now() - 10, deliveryHistory: [{ id: "same-id", body: "different retained contents" }] };
  const receipt = retainPendingJob(path, { name: "owner", session: "owner-session", nonce: randomUUID() }, stale, base);
  writeFileSync(path, JSON.stringify({ version: 4, jobs: [current] })); manager().restore(() => undefined);
  const saved = readStore(path)[0]!;
  expect(saved).toMatchObject({ status, finishedAt: current.finishedAt, queuedMessages: current.queuedMessages, forwarded: current.forwarded });
  expect(saved.deliveryHistory).toEqual([...current.deliveryHistory, ...stale.deliveryHistory]);
  expect(existsSync(receipt.path)).toBe(false);
  const archives = join(pendingJobRoot(path), "archive"), verification = JSON.parse(readFileSync(join(archives, readdirSync(archives)[0]!, "verification.json"), "utf8"));
  expect(verification).toMatchObject({ kind: "superseded", retainedOnlyDataExecuted: false });
  expect(verification.retainedOnlyFields).toEqual(expect.arrayContaining(["status", "queuedMessages", "forwarded"]));
});

it("uses writer sequence to recover the latest final envelope even when all writes share a timestamp", () => {
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now); const nonce = randomUUID(), writer = { name: "owner", session: "owner-session", nonce };
  const job = snapshot(); retainPendingJob(path, writer, { ...job, status: "running", deliveryHistory: [] });
  retainPendingJob(path, writer, { ...job, deliveryHistory: [] });
  retainPendingJob(path, writer, { ...job, deliveryHistory: [{ id: "final", body: "complete final result" }] });
  manager().restore(() => undefined);
  expect(readStore(path)[0]?.deliveryHistory).toEqual([{ id: "final", body: "complete final result" }]);
  expect(readPendingJobs(path)).toEqual([]);
});

it.each([["foreign", "other", true], ["headless", "owner", false]])("refuses %s receipt adoption or archiving", (_label, name, eligible) => {
  const receipt = retain(); manager(name as string, eligible as boolean).restore(() => undefined);
  expect(existsSync(path)).toBe(false); expect(existsSync(receipt.path)).toBe(true);
});

it("retains unknown versions and partial publications without modifying bytes", () => {
  const receipt = retain(), unknown = JSON.stringify({ ...receipt.value, schemaVersion: 999 });
  writeFileSync(receipt.path, unknown); const partial = join(dirname(receipt.path), "unfinished.partial"); writeFileSync(partial, "partial original");
  expect(readPendingJobs(path)).toEqual([]); manager().restore(() => undefined);
  expect(readFileSync(receipt.path, "utf8")).toBe(unknown); expect(readFileSync(partial, "utf8")).toBe("partial original");
});

it("fails verification without archiving a modified original receipt", () => {
  const receipt = retain(), changed = JSON.stringify({ ...receipt.value, future: "unexpected bytes" }); writeFileSync(receipt.path, changed);
  expect(() => archivePendingJob(receipt, receipt.value.job)).toThrow("verification failed");
  expect(readFileSync(receipt.path, "utf8")).toBe(changed);
});

it("rejects linked namespace ancestors before writing outside the journal", () => {
  const external = join(home, "external"); mkdirSync(external);
  symlinkSync(external, join(home, "pending-job-writes"), process.platform === "win32" ? "junction" : "dir");
  expect(() => retain()).toThrow("not physical"); expect(readdirSync(external)).toEqual([]);
});

it("retains oversized accepted context even when bounded automatic recovery leaves it for inspection", () => {
  const job = snapshot({ prompt: "x".repeat(32 * 1024 * 1024 + 1), futurePayload: "complete unknown retained bytes" });
  const receipt = retain(job), original = readFileSync(receipt.path, "utf8"), warn = vi.fn();
  expect(readPendingJobs(path, warn)).toEqual([]);
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("retained for manual recovery") }));
  expect(JSON.parse(readFileSync(receipt.path, "utf8")).job).toEqual(job);
  expect(readFileSync(receipt.path, "utf8")).toBe(original);
});

it("publishes exclusively and retains complete partial bytes if a destination races publication", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(linkSync).mockImplementation((source, target) => { writeFileSync(target, "raced original bytes"); actual.linkSync(source, target); });
  expect(() => retain()).toThrow();
  const root = pendingJobRoot(path), dir = join(root, readdirSync(root)[0]!);
  expect(readFileSync(join(dir, "receipt.json"), "utf8")).toBe("raced original bytes");
  expect(JSON.parse(readFileSync(join(dir, "receipt.partial"), "utf8")).job.prompt).toBe("complete exact original prompt");
});

it("never reads an outside replacement after the physical witness changes to a link", async () => {
  const receipt = retain(), outside = join(home, "outside-original.json"); writeFileSync(outside, "outside retained bytes");
  writeFileSync(receipt.path, `${readFileSync(receipt.path, "utf8")}\n`); // Invalidate parsed cache.
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(openSync).mockImplementation(((file: any, flags: any, mode: any) => {
    if (file === receipt.path) { renameSync(file, `${file}.original`); symlinkSync(outside, file, "file"); }
    return actual.openSync(file, flags, mode);
  }) as typeof openSync);
  vi.mocked(readFileSync).mockClear(); const warn = vi.fn();
  expect(readPendingJobs(path, warn)).toEqual([]); expect(warn).toHaveBeenCalled();
  expect(readFileSync).not.toHaveBeenCalled(); expect(actual.readFileSync(outside, "utf8")).toBe("outside retained bytes");
});

it("verifies consumption with captured stat evidence without rereading full payloads", () => {
  const receipt = retain(); vi.mocked(readFileSync).mockClear();
  expect(archivePendingJob(receipt, receipt.value.job)).toBe(true); expect(readFileSync).not.toHaveBeenCalled();
});

it("keeps hashed receipt evidence immutable while restored runtime arrays and settings remain mutable", () => {
  const job = snapshot({ forwarded: [{ cid: "original", body: "original content" }] }), receipt = retain(job);
  const loaded = readPendingJobs(path)[0]!, restored = mergePendingJob(undefined, loaded.value.job)!;
  (restored.forwarded as any[]).push({ cid: "new-runtime", body: "new runtime content" });
  (restored.args as any).futureSetting.keep = false;
  expect(() => (loaded.value.job.forwarded as any[]).push({ cid: "changed-evidence" })).toThrow();
  expect(readPendingJobs(path)[0]!.value.job).toEqual(job);
  expect(JSON.parse(readFileSync(receipt.path, "utf8")).job).toEqual(job);
  expect(archivePendingJob(loaded, job)).toBe(true);
  const root = join(pendingJobRoot(path), "archive"), dir = join(root, readdirSync(root)[0]!);
  expect(JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8")).job).toEqual(job);
  expect(JSON.parse(readFileSync(join(dir, "verification.json"), "utf8"))).toMatchObject({ kind: "incorporated", receiptSha256: receipt.digest });
});
