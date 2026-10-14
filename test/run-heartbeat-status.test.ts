import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listRuns } from "../src/core/dashboard-read.js";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import { writeRunnerStateRecord } from "../src/core/runner-store.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { closeMetadataDbs(); await env.cleanup(); });

/** A run log that started and then stayed silent for three minutes. */
function silentRun(job: string, now: number): string {
  const dir = join(env.home, "runs");
  mkdirSync(dir, { recursive: true });
  const name = `2026-10-10-06-00-00-${job}`;
  const log = join(dir, `${name}.log`);
  writeFileSync(log, "06:00:00 started\nwaiting for the Unity queue\n");
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ job, title: "fresh job" }));
  const quiet = (now - 180_000) / 1000;
  utimesSync(log, quiet, quiet);
  return name;
}

it("keeps a silent run running while its job runner heartbeat is fresh", () => {
  const now = Date.now();
  const name = silentRun("codex-job-abcdef12", now);
  writeRunnerStateRecord(env.home, "abcdef12", { pid: process.pid, peer: "codex-job-abcdef12", status: "running", updatedAt: now - 10_000 });
  expect(listRuns(env.home, now).find(run => run.name === name)?.status).toBe("running");
});

it("still shows a silent run as interrupted when no runner reports in", () => {
  const now = Date.now();
  const name = silentRun("codex-job-0badc0de", now);
  expect(listRuns(env.home, now).find(run => run.name === name)?.status).toBe("interrupted");
});

it("shows a silent run as interrupted when its runner heartbeat is old", () => {
  const now = Date.now();
  const name = silentRun("codex-job-12345678", now);
  writeRunnerStateRecord(env.home, "12345678", { pid: process.pid, peer: "codex-job-12345678", status: "running", updatedAt: now - 600_000 });
  expect(listRuns(env.home, now).find(run => run.name === name)?.status).toBe("interrupted");
});
