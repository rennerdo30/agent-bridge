import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { readDashboard } from "../src/core/dashboard-read.js";
import { makeEnv } from "./helpers.js";

// The job-settings overlay of a run page reads named job records; simulate that store being unreadable.
vi.mock("../src/core/run-history.js", async original => {
  const real = await original<typeof import("../src/core/run-history.js")>();
  return {
    ...real,
    historyJobsSteps: function* (...args: Parameters<typeof real.historyJobsSteps>) {
      if (args[2]?.names && args[2]?.metadata) throw new Error("jobs store locked");
      return yield* real.historyJobsSteps(...args);
    },
  };
});

it("serves a valid run page with empty job settings when the job store cannot be read", async () => {
  const env = makeEnv();
  try {
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ id: "abcd1234", name: "codex-job-abcd1234", agent: "codex",
      status: "done", startedAt: 1_000, finishedAt: 2_000, prompt: "Do the task", resultStored: true, args: { effort: "high" } }] }));
    const ctx = { home: env.home, log: nullLogger, peers: () => [] };
    const result = await readDashboard(ctx, { path: "/api/runs", query: {} } as never);
    expect(result.status).toBe(200);
    const body = result.body as { runs: { job?: string }[]; jobs: Record<string, unknown> };
    expect(body.runs.map(run => run.job)).toContain("codex-job-abcd1234");
    expect(body.jobs).toEqual({});
    expect((await readDashboard(ctx, { path: "/api/runs", query: { before: "no" } } as never)).status).toBe(400);
  } finally { await env.cleanup(); }
});
