import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { acquireLock, JobManager, readStore, type HostedAdmission, type JobHostInfo, type Run } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { until } from "./helpers.js";

let home: string, jobs: JobManager;
const result = { text: "done", sessionId: "native-session", isError: false, details: {} };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ab-host-admission-"));
  jobs = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, join(home, "jobs.json"), 2);
  jobs.runners = { state: () => null, alive: () => true, send: vi.fn(), kill: vi.fn() };
});
afterEach(() => { jobs.cancelAll(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
function deferred() {
  let resolve!: (host: JobHostInfo | null) => void, admission!: HostedAdmission;
  const promise = new Promise<JobHostInfo | null>(ready => { resolve = ready; });
  const inline = vi.fn(async () => result);
  const run: Run = Object.assign(inline, { hosted: (_job: unknown, gate: HostedAdmission) => { admission = gate; return promise; } });
  return { run, inline, resolve, admission: () => admission };
}
const host = { pid: null, peer: "detached-fixture", startedAt: Date.now() };

it("keeps queued admission out of inline execution and rejects stale owner/session authority", async () => {
  const pending = deferred(), job = jobs.start("codex", null, "retained queued prompt", pending.run);
  expect(pending.admission().isCurrent()).toBe(true); expect(pending.inline).not.toHaveBeenCalled();
  jobs.setDormant(true); expect(pending.admission().signal.aborted).toBe(true); expect(pending.admission().isCurrent()).toBe(false);
  pending.resolve(null); await until(() => job.status === "interrupted");
  expect(pending.inline).not.toHaveBeenCalled();
  expect(readStore(join(home, "jobs.json")).find(saved => saved.id === job.id)?.prompt).toBe("retained queued prompt");
});

it.each([true, false])("retains a real late host while distinguishing explicit cancel=%s from shutdown", async explicit => {
  const pending = deferred(), job = jobs.start("codex", null, "retained", pending.run);
  if (explicit) jobs.cancel(job.name); else jobs.cancelAll();
  pending.resolve(host); await until(() => Boolean(job.host));
  expect(job.host).toEqual(host); expect(job.status).toBe("running"); expect(pending.inline).not.toHaveBeenCalled();
  if (explicit) expect(jobs.runners!.send).toHaveBeenCalledWith(job, { type: "cancel" });
  else expect(jobs.runners!.send).not.toHaveBeenCalled();
  expect(readStore(join(home, "jobs.json")).find(saved => saved.id === job.id)?.host).toEqual(host);
});

it("publishes an already-started host without replacing a new supervisor's durable authority", async () => {
  const pending = deferred(), job = jobs.start("codex", null, "handoff prompt", pending.run);
  const path = join(home, "jobs.json"), document = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(document.jobs[0], { owner: "new-owner", supervisor: "new-session", rootSession: "new-session", rootName: "new-owner",
    ownershipHistory: [{ from: "owner", to: "new-owner", at: Date.now() }] });
  writeFileSync(path, JSON.stringify(document)); jobs.refreshOwnership();
  pending.resolve(host);
  await until(() => Boolean(JSON.parse(readFileSync(path, "utf8")).retainedHostedStarts?.length));
  const retained = JSON.parse(readFileSync(path, "utf8"));
  expect(retained.jobs[0]).toMatchObject({ owner: "new-owner", supervisor: "new-session", prompt: "handoff prompt", host });
  expect(retained.retainedHostedStarts[0]).toMatchObject({ version: 1, executor: "owner", turn: { id: job.id, prompt: "handoff prompt" }, host });
  expect(jobs.runners!.send).not.toHaveBeenCalled(); expect(pending.inline).not.toHaveBeenCalled();
});

it("yields while the shared jobs lock is held and retains the actual late-host receipt after unlock", async () => {
  const pending = deferred(), job = jobs.start("codex", null, "locked retained prompt", pending.run);
  const path = join(home, "jobs.json"), document = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(document.jobs[0], { owner: "new-owner", supervisor: "new-session", ownershipHistory: [{ from: "owner", to: "new-owner", at: Date.now() }] });
  writeFileSync(path, JSON.stringify(document)); jobs.refreshOwnership();
  const release = acquireLock(`${path}.lock`, 0);
  try {
    pending.resolve(host); await new Promise(ready => setTimeout(ready, 80));
    expect(JSON.parse(readFileSync(path, "utf8")).retainedHostedStarts).toBeUndefined();
  } finally { release(); }
  await until(() => Boolean(JSON.parse(readFileSync(path, "utf8")).retainedHostedStarts?.length));
  expect(JSON.parse(readFileSync(path, "utf8")).retainedHostedStarts[0]).toMatchObject({ version: 1, turn: { id: job.id, prompt: "locked retained prompt" }, host });
});

it("does not project a previous finished host into a queued continuation when its initial persist is unavailable", async () => {
  const first = jobs.start("codex", null, "original", async () => result);
  await until(() => first.status === "done");
  const path = join(home, "jobs.json"), document = JSON.parse(readFileSync(path, "utf8"));
  const history = [{ from: "owner", to: "owner", at: Date.now() }];
  Object.assign(document.jobs[0], { host, ownershipHistory: history }); writeFileSync(path, JSON.stringify(document));
  Object.assign(first, { host, ownershipHistory: history });
  const pending = deferred(); first.resume = () => pending.run;
  vi.spyOn(jobs, "persist").mockImplementation(() => {});
  jobs.followUp(first.id, "continue");
  expect(pending.admission().isCurrent()).toBe(true); jobs.refreshOwnership();
  expect(first.host).toBeNull(); expect(first.status).toBe("running"); expect(pending.admission().isCurrent()).toBe(true);
  pending.resolve(host); await until(() => first.host === host); expect(pending.inline).not.toHaveBeenCalled();
});

it("hydrates a continuation exposed by an early ownership refresh before connected restoration", async () => {
  const first = jobs.start("claude", null, "original retained context", async () => result, undefined, { send_to: ["reviewer"] });
  await until(() => first.status === "done"); jobs.cancelAll();
  jobs = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, join(home, "jobs.json"), 2);
  jobs.refreshOwnership();
  const observed = jobs.find(first.id)!; expect(observed.resume).toBeUndefined();
  const controller = observed.controller, continuation = vi.fn(async () => result), factory = vi.fn(() => () => continuation);
  jobs.restore(factory);
  expect(jobs.find(first.id)?.controller).toBe(controller);
  expect(factory).toHaveBeenCalledWith("claude", expect.objectContaining({ send_to: ["reviewer"] }));
  expect(jobs.followUp(first.id, "continue with exact grants").outcome).toBe("started");
  await until(() => continuation.mock.calls.length === 1);
});

it.each([true, false])("resumer hydration preserves an already active hosted=%s turn and its controller", hosted => {
  const run: Run = Object.assign(() => new Promise<typeof result>(() => {}), hosted ? { hosted: () => host } : {});
  const active = jobs.start("claude", null, "active retained turn", run);
  active.progress = "live partial response";
  const controller = active.controller, startedAt = active.startedAt, existingHost = active.host;
  jobs.restore(() => () => async () => result);
  expect(active.resume).toBeTypeOf("function"); expect(active.controller).toBe(controller);
  expect(controller.signal.aborted).toBe(false);
  expect(active).toMatchObject({ status: "running", startedAt, progress: "live partial response", host: existingHost });
});
