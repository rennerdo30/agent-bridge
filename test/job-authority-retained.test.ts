import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { archiveJobs } from "../src/core/job-archive.js";
import { recoverJobRecord, recoverJobRecordAsync } from "../src/core/job-recovery.js";
import { writeRunnerStateRecord } from "../src/core/runner-store.js";
import * as history from "../src/core/run-history.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
  vi.stubEnv("AGENT_BRIDGE_HISTORY_INGEST", "false");
  vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await env.cleanup(); vi.unstubAllEnvs(); });

function retained(status: string, owner = "owner") {
  return { id: "older", name: "codex-job-older", agent: "codex", owner, rootName: owner,
    status, startedAt: 1, prompt: "exact original task ".repeat(100), sessionId: "retained-native" as string | null,
    model: null, workdir: env.home, worktree: null, args: { access: "read", future: { keep: true } },
    future: { context: ["preserve"] } };
}
function save(job: ReturnType<typeof retained>) {
  const path = join(env.home, "jobs.json");
  // The selected job is cold, older than every active job, and absent from jobs.json.
  archiveJobs(path, [job]);
  writeFileSync(path, JSON.stringify({ version: 4, jobs: Array.from({ length: 15 }, (_, i) => ({
    ...retained("running"), id: `live-${i}`, name: `codex-job-live-${i}`, startedAt: i + 2,
  })) }));
}

it.each(["done", "failed", "cancelled", "interrupted", "running"])(
  "recovers exact older %s context within the request budget despite suspended catalog discovery", async status => {
    const job = retained(status); save(job);
    let release!: (runs: history.RunLogRecord[]) => void;
    const blocked = new Promise<history.RunLogRecord[]>(resolve => { release = resolve; });
    const discovery = vi.spyOn(history, "readRunLogsResponsive").mockReturnValue(blocked);
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof recoverJobRecordAsync>>;
    const pending = recoverJobRecordAsync(env.home, job.name).then(value => { result = value; });
    try {
      // Advance the existing request budget, without loading the PC or raising it.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(result!).toMatchObject({ ...job, status: status === "running" ? "interrupted" : status, host: null });
      expect(discovery).not.toHaveBeenCalled();
    } finally { release([]); await pending; }
  },
);

it.each(["missing", "stale", "null", "current"])(
  "recovers an unlearned session from run metadata unless %s runner state supplies it", async mode => {
    const job = { ...retained("done"), sessionId: null, startedAt: 10 }; save(job);
    const root = join(env.home, "runs"); mkdirSync(root);
    const run = join(root, "independent-retained-feed");
    writeFileSync(run + ".log", "header by owner\n         exact task\n         ---\n");
    writeFileSync(run + ".json", JSON.stringify({ job: job.name, jobStartedAt: job.startedAt, session: "meta-native" }));
    if (mode !== "missing") writeRunnerStateRecord(env.home, job.id, {
      pid: process.pid, peer: job.name, status: "done", updatedAt: mode === "stale" ? 9 : 10,
      sessionId: mode === "null" ? null : "runner-native",
    });
    const discovery = vi.spyOn(history, "readRunLogsResponsive");
    const recovered = await recoverJobRecordAsync(env.home, job.name);
    expect(recovered).toMatchObject({ ...job, sessionId: mode === "current" ? "runner-native" : "meta-native" });
    if (mode === "current") expect(discovery).not.toHaveBeenCalled();
    else expect(discovery).toHaveBeenCalledTimes(2);
    expect(recovered).toEqual(recoverJobRecord(env.home, job.name));
  },
);

it("serves selected authority through the real broker and preserves current handoff ownership", async () => {
  const owner = env.node("owner", "other"), next = env.node("next", "other");
  await owner.start(); await next.start();
  const job = retained("done"); save(job);
  const discovery = vi.spyOn(history, "readRunLogsResponsive").mockRejectedValue(new Error("unrelated catalog unavailable"));
  expect(await owner.jobAuthority(job.name)).toMatchObject(job);
  archiveJobs(join(env.home, "jobs.json"), [{ ...job, owner: next.name, rootName: next.name, masters: [next.name] }]);
  expect(await owner.jobAuthority(job.name)).toBeNull();
  expect(await next.jobAuthority(job.name)).toMatchObject({ ...job, owner: next.name, rootName: next.name, masters: [next.name] });
  expect(discovery).not.toHaveBeenCalled();
});
