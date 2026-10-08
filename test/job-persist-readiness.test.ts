import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import * as identity from "../src/core/process-identity.js";
import { JobManager, readStore, type Run } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { until } from "./helpers.js";
import { pendingJobRoot, readPendingJobs } from "../src/core/job-pending-journal.js";

const observed = vi.hoisted(() => ({ clones: [] as string[] }));
vi.mock("../src/core/file-cache.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/core/file-cache.js")>();
  return { ...actual, cloneJson: <T>(value: T): T => {
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) if (entry && typeof entry === "object" && "id" in entry && typeof entry.id === "string") observed.clones.push(entry.id);
    return actual.cloneJson(value);
  } };
});

let home: string, jobs: JobManager, node: LocalCoordinator;
let nextPid = process.pid + 3_000_000;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ab-persist-ready-"));
  node = new LocalCoordinator("owner", "owner-session");
  jobs = new JobManager(node, nullLogger, join(home, "jobs.json"));
});
afterEach(() => { jobs.setDormant(true); jobs.cancelAll(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
function reader(json: number) {
  const pid = ++nextPid; mkdirSync(join(home, "storage-capabilities"));
  writeFileSync(join(home, "storage-capabilities", `${pid}.json`), JSON.stringify({ schemaVersion: 1, pid, name: "inspector", version: APP_VERSION,
    explicit: true, json, sqlite: 9, processIdentity: `generation-${pid}` }));
  vi.spyOn(process, "kill").mockReturnValue(true);
  return pid;
}
function report() {
  const send = vi.fn(async (message: any) => {
    const saved = readStore(join(home, "jobs.json")).find(job => `job:${job.id}` === message.from.id);
    expect(saved?.deliveryHistory).toContainEqual(message);
    return { saved: true };
  });
  Object.assign(node, { reportInlineJob: send }); return send;
}
function queued() {
  jobs.runners = { state: () => null, alive: () => false, send() {}, kill() {} };
  const inline = vi.fn(async () => ({ text: "never inline", sessionId: null, isError: false, details: {} }));
  const run: Run = Object.assign(inline, { hosted: (_job: unknown, gate: any) => new Promise<null>((_resolve, reject) => {
    gate.signal.addEventListener("abort", () => reject(new Error("cancelled before runner startup")), { once: true });
  }) });
  return { run, inline };
}

it("saves an immediate prelaunch cancellation and its exact report after cold identity readiness", async () => {
  const pid = reader(4), send = report(); let release!: (identities: Map<number, string>) => void;
  vi.spyOn(identity, "readProcessIdentities").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = queued(), job = jobs.start("claude", null, "complete retained paired context", pending.run, undefined, { host: "paired", title: "Cancel startup" });
  jobs.cancel(job.name); await until(() => job.status === "failed" && Boolean(release));
  expect(existsSync(join(home, "jobs.json"))).toBe(false); expect(send).not.toHaveBeenCalled();
  release(new Map([[pid, `generation-${pid}`]]));
  await until(() => send.mock.calls.length === 1);
  const saved = readStore(join(home, "jobs.json")).find(record => record.id === job.id)!;
  expect(saved).toMatchObject({ status: "failed", prompt: "complete retained paired context", args: { host: "paired", title: "Cancel startup" }, host: null });
  expect(saved.deliveryHistory).toHaveLength(1); expect(saved.deliveryHistory![0]!.body).toContain("cancelled before runner startup");
  expect(send.mock.calls[0]![0].id).toBe(saved.deliveryHistory![0]!.id); expect(pending.inline).not.toHaveBeenCalled();
});

it("keeps a genuine old reader's bytes intact and backs them up before eventually saving the latest completed state", async () => {
  const pid = reader(3), send = report();
  vi.spyOn(identity, "readProcessIdentities").mockResolvedValue(new Map([[pid, `generation-${pid}`]]));
  const original = JSON.stringify({ version: 3, unknownOwnerData: { keep: "all bytes" }, jobs: [] });
  const path = join(home, "jobs.json"); writeFileSync(path, original);
  const job = jobs.start("claude", null, "retained finished context", async () => ({ text: "complete result", sessionId: "native", isError: false, details: {} }));
  await until(() => job.status === "done"); await new Promise(resolve => setTimeout(resolve, 160));
  expect(readFileSync(path, "utf8")).toBe(original); expect(send).not.toHaveBeenCalled();
  vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("reader exited"), { code: "ESRCH" }); });
  await until(() => send.mock.calls.length === 1);
  expect(readStore(path)[0]).toMatchObject({ prompt: "retained finished context", status: "done", sessionId: "native" });
  expect(JSON.parse(readFileSync(path, "utf8")).unknownOwnerData).toEqual({ keep: "all bytes" });
  expect(readdirSync(home).filter(file => file.startsWith("jobs.json.backup-")).some(file => readFileSync(join(home, file), "utf8") === original)).toBe(true);
});

it("does not let a late readiness callback write after the supervisor becomes dormant", async () => {
  const pid = reader(4); let release!: (identities: Map<number, string>) => void;
  vi.spyOn(identity, "readProcessIdentities").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = queued(), job = jobs.start("claude", null, "retained dormant context", pending.run);
  await until(() => Boolean(release)); jobs.setDormant(true);
  release(new Map([[pid, `generation-${pid}`]])); await new Promise(resolve => setTimeout(resolve, 100));
  expect(existsSync(join(home, "jobs.json"))).toBe(false); expect(pending.inline).not.toHaveBeenCalled();
  expect(job.prompt).toBe("retained dormant context");
});

it("retains the final durable envelope after shutdown without reconnecting to send it", async () => {
  const pid = reader(4), send = report(); let release!: (identities: Map<number, string>) => void;
  vi.spyOn(identity, "readProcessIdentities").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = queued(), job = jobs.start("claude", null, "shutdown context", pending.run);
  jobs.cancel(job.name); await until(() => job.status === "failed" && Boolean(release)); node.emit("stopped");
  release(new Map([[pid, `generation-${pid}`]]));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(existsSync(join(home, "jobs.json"))).toBe(false);
  const retained = readPendingJobs(join(home, "jobs.json")).find(receipt => receipt.value.job.status === "failed" && Array.isArray(receipt.value.job.deliveryHistory))!;
  expect(retained.value.job.prompt).toBe("shutdown context"); expect(retained.value.job.deliveryHistory).toHaveLength(1); expect(send).not.toHaveBeenCalled();
  // A new eligible owner recovers the original context and exact stable report.
  jobs = new JobManager(node = new LocalCoordinator("owner", "owner-session"), nullLogger, join(home, "jobs.json"));
  const recoveredSend = report(); jobs.restore(() => undefined);
  await until(() => recoveredSend.mock.calls.length === 1);
  expect(readStore(join(home, "jobs.json"))[0]).toMatchObject({ prompt: "shutdown context", status: "failed", deliveryHistory: retained.value.job.deliveryHistory });
  expect(readdirSync(join(pendingJobRoot(join(home, "jobs.json")), "archive")).length).toBeGreaterThan(0);
});

it("retries a durable final report after a disconnected RPC without another job update", async () => {
  const send = report(); send.mockRejectedValueOnce(new Error("connection to broker closed"));
  const job = jobs.start("claude", null, "retry complete context", async () => ({ text: "retained final answer", sessionId: "session", isError: false, details: {} }));
  await until(() => send.mock.calls.length === 2);
  expect(job.status).toBe("done"); expect(send.mock.calls[0]![0]).toEqual(send.mock.calls[1]![0]);
});

it("does not prove delivery from a same-ID envelope with different contents", async () => {
  const send = report(), message = { id: "fixed-id", body: "accepted result" };
  (jobs as any).pendingReports.set(message.id, { jobId: "fixed-job", message });
  (jobs as any).flushStoredReports([{ id: "fixed-job", owner: "owner", deliveryHistory: [{ ...message, body: "different original" }] }]);
  await new Promise(resolve => setTimeout(resolve, 20)); expect(send).not.toHaveBeenCalled();
});

it("report retries select their one durable job without cloning the unrelated archive corpus", async () => {
  const message = { id: "fixed-id", body: "retained answer" }, send = vi.fn(async () => ({ saved: true }));
  Object.assign(node, { reportInlineJob: send }); mkdirSync(join(home, "archive"));
  const unrelated = Array.from({ length: 300 }, (_, index) => ({ id: `foreign-${index}`, name: `foreign-job-${index}`, owner: "other", prompt: "unrelated retained context" }));
  writeFileSync(join(home, "archive", "jobs-corpus.json"), JSON.stringify({ version: 4, jobs: [...unrelated,
    { id: "selected", name: "selected-job", owner: "owner", deliveryHistory: [message] }] }));
  (jobs as any).pendingReports.set(message.id, { jobId: "selected", message }); observed.clones.length = 0;
  (jobs as any).scheduleReportRetry(); await until(() => send.mock.calls.length === 1);
  expect(observed.clones.length).toBeGreaterThan(0); expect(observed.clones.every(id => id === "selected")).toBe(true);
});
