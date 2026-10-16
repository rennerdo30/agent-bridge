import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { readStoredJobs } from "../src/core/dashboard-read.js";
import { JobManager, readStore, type Run } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";

const managers: JobManager[] = [];
afterEach(() => { for (const jobs of managers.splice(0)) { jobs.setDormant(true); jobs.cancelAll(); } });

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), "ab-pause-")), "jobs.json");
  const node = new LocalCoordinator("owner", "owner-session");
  Object.assign(node, { jobAuthority: async (ref: string) => readStore(path).find(j => j.name === ref || j.id === ref) ?? null });
  const jobs = new JobManager(node, nullLogger, path, 3); managers.push(jobs);
  return { jobs, path };
}

const answer = { text: "finished", sessionId: "same-native-session", isError: false, details: {} };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

it("keeps a paused job paused and resumes its same native session", async () => {
  const { jobs, path } = fixture();
  let stop!: () => void;
  const initial: Run = signal => new Promise(resolve => {
    stop = () => resolve({ ...answer, status: "cancelled" });
    signal.addEventListener("abort", stop, { once: true });
  });
  const continued = vi.fn(async () => answer);
  const resume = vi.fn((_message: string, _sessionId: string) => continued);
  const job = jobs.start("codex", null, "task", initial, resume);
  jobs.note(job, { sessionId: "same-native-session" });
  expect(jobs.pause(job.name, "owner build")).toBe(true);
  expect(job.status).toBe("paused");
  expect(job.pauseReason).toBe("owner build");
  expect(job.pausedAt).toBeTypeOf("number");
  expect(readStore(path)[0]).toMatchObject({ status: "paused", pauseReason: "owner build" });
  expect(readStoredJobs(join(path, "..")).get(job.name)).toMatchObject({ status: "paused", pauseReason: "owner build" });
  expect(jobs.followUp(job.name, "retained next step").outcome).toBe("queued");
  expect(resume).not.toHaveBeenCalled();
  stop(); await flush();
  expect(job.status).toBe("paused");
  expect(resume).not.toHaveBeenCalled();
  expect(jobs.resumePaused(job.name)).toEqual([job.name]);
  await flush();
  expect(resume.mock.calls[0]?.[1]).toBe("same-native-session");
  expect(resume.mock.calls[0]?.[0]).toContain("retained next step");
  expect(continued).toHaveBeenCalledOnce();
  expect(() => jobs.pause(job.name)).toThrow(/already finished \(done\)/);
});

it("pauses and resumes all owned jobs and refuses a finished job", async () => {
  const { jobs } = fixture();
  const resume = vi.fn((): Run => async () => answer);
  const interruptible: Run = signal => new Promise(resolve => signal.addEventListener("abort", () => resolve({ ...answer, status: "cancelled" }), { once: true }));
  const one = jobs.start("codex", null, "one", interruptible, resume);
  const two = jobs.start("codex", null, "two", interruptible, resume);
  jobs.note(one, { sessionId: "session-one" }); jobs.note(two, { sessionId: "session-two" });
  expect(jobs.pauseAll("owner build")).toEqual({ paused: [one.name, two.name], failed: [] });
  expect(one.status).toBe("paused"); expect(two.status).toBe("paused");
  await flush();
  expect(jobs.resumeAll()).toEqual({ resumed: [one.name, two.name], failed: [] });
  await flush();
  expect(resume).toHaveBeenCalledTimes(2);
  expect(() => jobs.pause("missing-or-finished")).toThrow();
});

it("waits for a hosted runner to exit before resuming the retained session", async () => {
  const { jobs } = fixture();
  let state: import("../src/mcp/jobs.js").RunnerState | null = null;
  let alive = true;
  const send = vi.fn();
  jobs.runners = { state: () => state, alive: () => alive, send, kill: vi.fn() };
  const run: Run = Object.assign(async () => answer, { hosted: () => ({ pid: 123, peer: "runner", startedAt: Date.now() }) });
  const resume = vi.fn((_message: string, _sessionId: string): Run => async () => answer);
  const job = jobs.start("codex", null, "hosted task", run, resume);
  jobs.note(job, { sessionId: "same-native-session" });
  jobs.pause(job.name, "owner build");
  expect(send).toHaveBeenCalledWith(job, { type: "pause", reason: "owner build" });
  expect(jobs.resumePaused(job.name)).toEqual([job.name]);
  expect(resume).not.toHaveBeenCalled();
  state = { pid: 123, peer: "runner", status: "paused", updatedAt: Date.now(), sessionId: "same-native-session" };
  alive = false;
  jobs.list(); await flush();
  expect(resume.mock.calls[0]?.[1]).toBe("same-native-session");
});

it("holds a job waiting for its first slot without starting it", async () => {
  const { jobs } = fixture();
  jobs.setLimit(1);
  const busy = jobs.start("codex", null, "busy", signal => new Promise(resolve => signal.addEventListener("abort", () => resolve({ ...answer, status: "cancelled" }), { once: true })));
  const initial = vi.fn(async () => answer);
  const waiting = jobs.start("codex", null, "waiting", initial);
  expect(waiting.waitingForStart).toBe(true);
  expect(jobs.pause(waiting.name, "owner build")).toBe(true);
  expect(waiting.status).toBe("paused");
  expect(initial).not.toHaveBeenCalled();
  jobs.cancel(busy.name);
  await flush();
  expect(initial).not.toHaveBeenCalled();
  expect(jobs.resumePaused(waiting.name)).toEqual([waiting.name]);
  await flush();
  expect(initial).toHaveBeenCalledOnce();
});

it("retains an initial run while detached startup is still pending", async () => {
  const { jobs } = fixture();
  jobs.runners = { state: () => null, alive: () => false, send: vi.fn(), kill: vi.fn() };
  let resolveHost!: (host: null) => void;
  const initial = vi.fn(async () => answer);
  const run: Run = Object.assign(initial, { hosted: () => new Promise<null>(resolve => { resolveHost = resolve; }) });
  const job = jobs.start("codex", null, "starting", run);
  expect(jobs.pause(job.name, "owner build")).toBe(true);
  resolveHost(null); await flush();
  expect(job.status).toBe("paused");
  expect(initial).not.toHaveBeenCalled();
  jobs.runners = null;
  expect(jobs.resumePaused(job.name)).toEqual([job.name]);
  await flush();
  expect(initial).toHaveBeenCalledOnce();
});
