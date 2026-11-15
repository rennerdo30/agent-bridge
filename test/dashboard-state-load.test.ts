import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startUi } from "../src/cli/ui.js";
import { forgetInFlightScans, listRunsResponsive } from "../src/core/dashboard-read.js";
import { DEFAULT_RUN_PAGE_SIZE } from "../src/core/run-history.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

// AB-505: the dashboard polls /api/state every 1.5 s per tab. Its cost must follow the page, not the whole history.

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

const doneJobs = (count: number) => Array.from({ length: count }, (_, i) => {
  const id = (0x10000000 + i).toString(16);
  return { id, name: `codex-job-${id}`, agent: "codex", status: "done", owner: "s1", startedAt: 1_000 + i, finishedAt: 2_000 + i, prompt: `task ${i}`, args: {} };
});

it("/api/state carries job settings only for the runs on its page", async () => {
  const jobs = doneJobs(DEFAULT_RUN_PAGE_SIZE + 10);
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs }));
  const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
  try {
    const base = ui.url.replace(/\/\?t=.*$/, "");
    const cookie = String((await fetch(ui.url, { redirect: "manual" })).headers.get("set-cookie")).split(";")[0]!;
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json() as { jobs: Record<string, unknown>; runs: { job?: string }[]; runsTotal: number };
    expect(state.runsTotal).toBe(jobs.length);
    const onPage = state.runs.map((r) => r.job).filter((j): j is string => typeof j === "string").sort();
    expect(onPage).toHaveLength(DEFAULT_RUN_PAGE_SIZE);
    // Exactly the page's jobs: the 10 oldest belong to /api/runs?before=, which sends their settings itself.
    expect(Object.keys(state.jobs).sort()).toEqual(onPage);
    expect(state.jobs[jobs[0]!.name]).toBeUndefined();
    expect(state.jobs[jobs.at(-1)!.name]).toBeDefined();
  } finally { await ui.close(); }
});

it("joins a full run listing that is already in progress, and reads afresh once it settled or after a write", async () => {
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: doneJobs(3) }));
  // Started together: the second caller gets the first scan's summaries (same objects), in its own array.
  const first = listRunsResponsive(env.home), joined = listRunsResponsive(env.home);
  const [a, b] = await Promise.all([first, joined]);
  expect(a).toHaveLength(3);
  expect(b).not.toBe(a);
  expect(b[0]).toBe(a[0]);
  // Settled: nothing is kept, so the next call scans again.
  const later = await listRunsResponsive(env.home);
  expect(later).toEqual(a);
  expect(later[0]).not.toBe(a[0]);
  // A write in between: a caller after it must not be answered from the scan that started before it.
  const before = listRunsResponsive(env.home);
  forgetInFlightScans(env.home);
  const after = listRunsResponsive(env.home);
  const [c, d] = await Promise.all([before, after]);
  expect(d[0]).not.toBe(c[0]);
});
