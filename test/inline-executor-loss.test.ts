import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JSON_STORE_VERSION } from "../src/core/json-store.js";
import { nullLogger } from "../src/core/logger.js";
import { closeMetadataDbs, metadataDb, saveMetadataValue } from "../src/core/metadata-db.js";
import { importMetadataDomain } from "../src/core/metadata-import.js";
import { processIdentity } from "../src/core/process-identity.js";
import { BridgeError } from "../src/core/protocol.js";
import { JobManager, readStore, type Resume, type RunResult } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";

// A handed-off inline turn (an ask_* run, or one started without a job runner) runs inside its executing
// session's process. When that process is gone, the new owner must not keep the turn "running" forever.
const EXITED_PID = 2_000_000_007;
let home: string;
const managers: JobManager[] = [];
beforeEach(() => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!; mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "inline-executor-"));
  const kill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === EXITED_PID) throw Object.assign(new Error("exited"), { code: "ESRCH" });
    return kill(pid, signal);
  });
});
afterEach(() => {
  for (const manager of managers.splice(0)) { manager.setDormant(true); manager.cancelAll(); }
  vi.restoreAllMocks(); closeMetadataDbs(); rmSync(home, { recursive: true, force: true });
});

const path = () => join(home, "jobs.json");
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const done = (text: string, sessionId = "native-session"): RunResult => ({ text, sessionId, workdir: home, isError: false, details: {} });
const offline = () => Promise.reject(new BridgeError("unknown_target", "The inline job's executor is offline."));

/** The executor's presence, in the AB-208 database layout every 0.30.4+ home uses. */
function presence(pid: number, extra: Record<string, unknown> = {}): void {
  metadataDb(home); importMetadataDomain(home, "storage-capabilities");
  saveMetadataValue(home, "storage-capabilities", String(pid), { schemaVersion: 1, json: 4, sqlite: 9, jobArchive: 1, pid, name: "executor", version: "0.30.6", explicit: true, observedAt: Date.now(), ...extra });
}

function handedOff(extra: Record<string, unknown> = {}) {
  const job = { id: "abcdef12", name: "claude-job-abcdef12", agent: "claude", model: null, prompt: "original task", startedAt: Date.now() - 60_000, status: "running",
    sessionId: "native-session", workdir: home, worktree: null, args: {}, owner: "owner", supervisor: "target-root", rootSession: "target-root", rootName: "owner",
    executionOwner: "executor", masters: ["owner", "executor"], host: null, queuedMessages: [],
    ownershipHistory: [{ id: "handoff", at: Date.now() - 30_000, from: "executor", to: "owner", rootSession: "target-root", rootName: "owner", reason: "explicit-handoff" }], ...extra };
  writeFileSync(path(), JSON.stringify({ version: JSON_STORE_VERSION, jobs: [job] }));
  return job;
}

function owner(options: { peers?: () => Promise<{ name: string }[]>; control?: (job: string, control: { type: string }) => Promise<unknown> } = {}) {
  const node = Object.assign(new LocalCoordinator("owner", "target-root"), {
    peers: options.peers ?? (async () => [{ name: "owner" }]),
    controlInlineJob: vi.fn(options.control ?? offline),
  });
  const jobs = new JobManager(node, nullLogger, path()); managers.push(jobs);
  const resumed = vi.fn((message: string, sessionId: string | null) => async () => done(`resumed: ${message}`, sessionId!));
  jobs.restore(() => resumed as unknown as Resume);
  return { jobs, node, resumed };
}

it("interrupts a handed-off inline turn whose executor exited, durably and resumable with its session", async () => {
  const saved = handedOff(); presence(EXITED_PID);
  const { jobs, resumed } = owner();
  const job = jobs.find(saved.name)!;
  expect(job.status).toBe("running");
  expect(jobs.runningCount()).toBe(1);
  await jobs.checkInlineExecutors();
  expect(job.status).toBe("interrupted");
  expect(jobs.runningCount()).toBe(0);
  expect(readStore(path())[0]).toMatchObject({ status: "interrupted", sessionId: "native-session", startedAt: saved.startedAt });
  // Refreshes from the store no longer revive it, and it is listed for recovery.
  jobs.refreshOwnership();
  expect(jobs.find(saved.name)!.status).toBe("interrupted");
  expect(jobs.recent().map(j => j.name)).toContain(saved.name);
  // A restart of the new owner loads it interrupted as well.
  const restarted = owner();
  expect(restarted.jobs.find(saved.name)!.status).toBe("interrupted");
  restarted.jobs.setDormant(true);
  expect(jobs.followUp(saved.name, "continue please").outcome).toBe("started");
  expect(resumed).toHaveBeenCalledWith("continue please", "native-session", home, null);
  await flush(); await flush();
  expect(readStore(path())[0]).toMatchObject({ status: "done", sessionId: "native-session" });
});

it("never loses a follow-up the broker could not deliver to a dead executor: it runs on the resume", async () => {
  const saved = handedOff({ queuedMessages: ["accepted by the executor"] }); presence(EXITED_PID);
  // The broker briefly still lists the executor (it has not noticed the exit yet), so the triggered check keeps the turn.
  let online = [{ name: "owner" }, { name: "executor" }];
  const { jobs, node, resumed } = owner({ peers: async () => online });
  expect(jobs.find(saved.name)!.status).toBe("running");
  expect(jobs.followUp(saved.name, "sent while it was gone").outcome).toBe("delivered");
  await flush(); await flush();
  expect(node.controlInlineJob).toHaveBeenCalledTimes(1);
  // The refused message is durable before the executor is proven gone.
  expect(readStore(path())[0]!.queuedMessages).toEqual(["accepted by the executor", "sent while it was gone"]);
  expect(resumed).not.toHaveBeenCalled();
  online = [{ name: "owner" }];
  await jobs.checkInlineExecutors();
  await flush(); await flush();
  expect(resumed).toHaveBeenCalledTimes(1);
  expect(resumed).toHaveBeenCalledWith("accepted by the executor\n\nsent while it was gone", "native-session", home, null);
  expect(readStore(path())[0]).toMatchObject({ status: "done", queuedMessages: [] });
});

it("reports a follow-up as queued, not delivered, while its executor is known offline", async () => {
  const saved = handedOff(); presence(process.pid, { processIdentity: processIdentity(process.pid) });
  const { jobs, node } = owner();
  jobs.find(saved.name);
  await jobs.checkInlineExecutors();
  expect(jobs.followUp(saved.name, "keep this").outcome).toBe("queued");
  expect(node.controlInlineJob).not.toHaveBeenCalled();
  expect(readStore(path())[0]).toMatchObject({ status: "running", queuedMessages: ["keep this"] });
});

it("settles a cancelled turn as cancelled once its executor is proven gone", async () => {
  const saved = handedOff(); presence(EXITED_PID);
  const { jobs, node, resumed } = owner();
  expect(jobs.find(saved.name)!.status).toBe("running");
  expect(jobs.cancel(saved.name)).toBe(true);
  await flush(); await flush();
  expect(node.controlInlineJob).toHaveBeenCalledWith(saved.name, { type: "cancel" });
  await jobs.checkInlineExecutors();
  expect(readStore(path())[0]).toMatchObject({ status: "cancelled" });
  expect(jobs.find(saved.name)!.status).toBe("cancelled");
  expect(jobs.runningCount()).toBe(0);
  expect(resumed).not.toHaveBeenCalled();
});

it.each([
  ["the broker still lists the executor", () => presence(EXITED_PID), async () => [{ name: "owner" }, { name: "executor" }]],
  ["the executor's recorded process still lives", () => presence(process.pid, { processIdentity: processIdentity(process.pid) }), undefined],
  ["the executor left no presence record", () => {}, undefined],
  ["the broker did not answer", () => presence(EXITED_PID), () => Promise.reject(new Error("broker stalled"))],
])("keeps a handed-off inline turn running when %s", async (_case, record, peers) => {
  const saved = handedOff(); record();
  const { jobs } = owner({ peers: peers as (() => Promise<{ name: string }[]>) | undefined });
  expect(jobs.find(saved.name)!.status).toBe("running");
  await jobs.checkInlineExecutors();
  expect(jobs.find(saved.name)!.status).toBe("running");
  expect(jobs.runningCount()).toBe(1);
  expect(readStore(path())[0]!.status).toBe("running");
});

it("restore interrupts an already loaded running entry that is neither running here nor elsewhere", () => {
  const saved = handedOff({ executionOwner: undefined, host: { pid: EXITED_PID, peer: "claude-job-abcdef12", startedAt: 1 } });
  const node = new LocalCoordinator("owner", "target-root");
  const jobs = new JobManager(node, nullLogger, path()); managers.push(jobs);
  // Connected/job events load saved jobs before restore installs the continuation factory.
  node.emit("jobs_changed");
  expect(jobs.hookJobs().find(j => j.id === saved.id)?.status).toBe("running");
  jobs.restore(() => undefined);
  expect(jobs.hookJobs().find(j => j.id === saved.id)?.status).toBe("interrupted");
  expect(jobs.runningCount()).toBe(0);
});
