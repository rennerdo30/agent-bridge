import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { archiveJobs } from "../src/core/job-archive.js";
import { recoverJobRecordAsync } from "../src/core/job-recovery.js";
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
    status, startedAt: 1, prompt: "exact original task ".repeat(100), sessionId: "retained-native",
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
