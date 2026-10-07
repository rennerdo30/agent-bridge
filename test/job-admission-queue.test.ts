import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { ResourceSlots } from "../src/core/resource-slots.js";
import { RootConcurrency } from "../src/core/root-concurrency.js";
import { STARTUP_RESOURCE, STARTUP_CAPACITY } from "../src/core/startup-admission.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { JobManager, readStore, type Run } from "../src/mcp/jobs.js";
import { JobRunners } from "../src/mcp/job-host.js";
import { runDelegate } from "../src/mcp/delegate-run.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { until } from "./helpers.js";

let home: string;
const managers: JobManager[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-admission-")); });
afterEach(() => { managers.splice(0).forEach(j => j.cancelAll()); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
const result = { text: "done", sessionId: "saved", isError: false, details: {} };
function manager(cap = 2) {
  const jobs = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, join(home, "jobs.json"), cap);
  managers.push(jobs); return jobs;
}

it("queues a mass spawn in order, cancels unstarted work and never exceeds its running cap", async () => {
  const jobs = manager(2);
  const started: string[] = []; const finish: Array<() => void> = [];
  const run: Run = async (_signal, _progress, job) => {
    started.push(job.prompt); await new Promise<void>(resolve => finish.push(resolve)); return result;
  };
  const agents = ["claude", "codex", "opencode", "antigravity"] as const;
  const all = Array.from({ length: 25 }, (_, i) => jobs.start(agents[i % 4]!, null, `task-${i}`, run));
  expect(jobs.runningCount()).toBe(2); expect(jobs.waiting()).toHaveLength(23);
  expect(started).toEqual(["task-0", "task-1"]);
  expect(jobs.cancel(all[4]!.name)).toBe(true); expect(all[4]!.status).toBe("failed");
  for (let i = 0; i < 24; i++) {
    finish[i]!(); await until(() => all.filter(j => j.status === "done").length === i + 1);
    expect(jobs.runningCount()).toBeLessThanOrEqual(2);
  }
  expect(started).toEqual(all.filter((_, i) => i !== 4).map(j => j.prompt));
  expect(jobs.waiting()).toEqual([]);
});

