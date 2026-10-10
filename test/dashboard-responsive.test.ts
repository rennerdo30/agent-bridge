import { indexFixtureFile } from "./archive-fixture.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listRuns, listRunsResponsive, readDashboard, readStoredJobs, readStoredJobsResponsive } from "../src/core/dashboard-read.js";
import { pageRuns, readHistoryJobs, readHistoryJobsResponsive, readRunLogs, readRunLogsResponsive } from "../src/core/run-history.js";
import { nullLogger } from "../src/core/logger.js";
import * as outcomeBackground from "../src/core/outcome-background.js";
import * as fileCache from "../src/core/file-cache.js";
import { archiveJobs, readArchivedJobSteps } from "../src/core/job-archive.js";
import { drainScan } from "../src/core/responsive-scan.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv, outside: TestEnv;
beforeEach(() => { env = makeEnv(); outside = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); await outside.cleanup(); });
const save = (file: string, value: unknown) => {
  writeFileSync(file, JSON.stringify(value));
  if (file.includes("archive") && /jobs-.*\.json$/.test(file)) indexFixtureFile(file);
};
function job(id: string, changes: Record<string, unknown> = {}) {
  return { id, name: `codex-job-${id}`, agent: "codex", owner: "old-owner", prompt: "Retained complete prompt", status: "done", startedAt: 100,
    sessionId: "session-one", args: { title: "Retained task", model: "model-one" }, worktree: { path: "retained-worktree", unknown: { keep: [1] } }, ...changes };
}
function corpus(archives = 307, logs = 1024) {
  mkdirSync(join(env.home, "archive")); mkdirSync(join(env.home, "runs"));
  // Retain every generated archive file, but index their records in one durable transaction:
  // 307 separately synced index writes made the fixture, not the reader under test, consume
  // most of the time budget on a loaded Windows runner.
  const archived: unknown[] = [];
  for (let file = 0; file < archives; file++) {
    const jobs = Array.from({ length: 16 }, (_, row) => job(`${file}-${row}`, { prompt: "Retained context ".repeat(64), future: { nested: [file, row] } }));
    writeFileSync(join(env.home, "archive", `jobs-${1700000000000 + file}-fixture.json`), JSON.stringify({ version: 4, jobs }));
    archived.push(...jobs);
  }
  if (archived.length) archiveJobs(join(env.home, "jobs.json"), archived);
  save(join(env.home, "jobs.json"), { version: 4, jobs: [job("active", { owner: "current-owner", ownershipHistory: [{ owner: "old-owner" }], rootName: "main", rootSession: "root-session" })] });
  for (let i = 0; i < logs; i++) {
    const name = `2026-10-01-12-00-${String(i % 60).padStart(2, "0")}-codex-${String(i).padStart(5, "0")}`;
    writeFileSync(join(env.home, "runs", `${name}.log`), "12:00:00 codex by main in retained-project, access full\nRetained task\n---\n12:00:01 finished · done\n");
    save(join(env.home, "runs", `${name}.json`), { job: `codex-job-log-${i}`, prompt: `Prompt ${i}`, futureMeta: { nested: [i] } });
  }
}

it("serves the complete cold 307-archive/1024-log corpus while timers keep running, with exact sync parity and cursors", async () => {
  corpus();
  const now = Date.now(), ticks: number[] = [];
  const timer = setInterval(() => ticks.push(performance.now()), 1);
  let asyncRuns;
  try { asyncRuns = await listRunsResponsive(env.home, now); } finally { clearInterval(timer); }
  expect(asyncRuns).toHaveLength(307 * 16 + 1024 + 1);
  expect(ticks.length).toBeGreaterThan(5);
  expect(Math.max(...ticks.slice(1).map((at, i) => at - ticks[i]!))).toBeLessThan(250);
  const syncRuns = listRuns(env.home, now);
  expect(asyncRuns).toEqual(syncRuns);
  const first = pageRuns(asyncRuns, null, 50);
  expect(first).toEqual(pageRuns(syncRuns, null, 50));
  expect(pageRuns(asyncRuns, first.next, 50)).toEqual(pageRuns(syncRuns, first.next, 50));
  expect(await readRunLogsResponsive(env.home)).toEqual(readRunLogs(env.home));
  expect(await readHistoryJobsResponsive(env.home)).toEqual(readHistoryJobs(env.home));
  const state = await readDashboard({ home: env.home, log: nullLogger, peers: () => [] }, { path: "/api/state" });
  expect(state.status).toBe(200);
  expect((state.body as { runsTotal: number }).runsTotal).toBe(asyncRuns.length);
  // Writing ~5,000 fixture files dominates on a loaded Windows runner (AB-255).
}, 60_000);

it("preserves unknown metadata and isolates nested returned mutations, including recovered ownership and worktrees", async () => {
  corpus(2, 3);
  const now = Date.now(), original = listRuns(env.home, now);
  const returned = await listRunsResponsive(env.home, now);
  const log = returned.find(run => run.job === "codex-job-log-0")!;
  (log as any).futureMeta.nested.push("caller mutation");
  const recovered = returned.find(run => run.name === "codex-job-active")!;
  expect(recovered.owner).toBe("current-owner"); expect(recovered.rootName).toBe("main");
  (recovered.worktree as any).unknown.keep.push("caller mutation");
  expect(await listRunsResponsive(env.home, now)).toEqual(original);
  expect(listRuns(env.home, now)).toEqual(original);
});

it("projects every stored job with sync parity and detaches exposed nested settings and remote fields", async () => {
  corpus(307, 0);
  save(join(env.home, "jobs.json"), { version: 4, jobs: [job("active", {
    owner: "current-owner", projectRoot: "retained-project", args: { title: "Current settings", model: { future: [1] } },
    remote: { host: "paired-fixture", name: "remote-job", unknown: { future: [2] } },
  })] });
  const original = readStoredJobs(env.home), returned = await readStoredJobsResponsive(env.home);
  expect(returned.size).toBe(307 * 16 + 1);
  expect(returned).toEqual(original);
  const active = returned.get("codex-job-active")!;
  (active.next.model as any).future.push("caller mutation");
  (active.remote as any).unknown.future.push("caller mutation");
  expect(await readStoredJobsResponsive(env.home)).toEqual(original);
  expect(readStoredJobs(env.home)).toEqual(original);
  expect(await readStoredJobsResponsive(env.home, new Set(["codex-job-active"]))).toEqual(new Map([["codex-job-active", original.get("codex-job-active")!]]));
});

it("rechecks changed files across yields and observes added archives and fresh active precedence on the next scan", async () => {
  corpus(2, 1024);
  await listRunsResponsive(env.home);
  const changed = join(env.home, "runs", "2026-10-01-12-00-00-codex-00000.json");
  const reading = listRunsResponsive(env.home);
  await new Promise<void>(resolve => setImmediate(resolve));
  save(changed, { job: "changed-job", futureMeta: { new: "changed during yielding scan" } });
  await reading;
  save(join(env.home, "archive", "jobs-1800000000000-added.json"), { version: 4, jobs: [job("added"), job("active", { owner: "archive-owner" })] });
  const next = await listRunsResponsive(env.home);
  expect(next.find(run => run.job === "changed-job")).toMatchObject({ futureMeta: { new: "changed during yielding scan" } });
  expect(next.find(run => run.name === "codex-job-added")).toBeDefined();
  expect(next.find(run => run.name === "codex-job-active")).toMatchObject({ owner: "current-owner" });
  expect(next).toEqual(listRuns(env.home));
});

it("keeps internal links contained and rejects outside metadata, including a replacement between scan steps", async () => {
  corpus(2, 1024);
  const runs = join(env.home, "runs"), external = join(outside.home, "external.json");
  save(external, { job: "outside-job", futureMeta: { outside: "synthetic outside bytes" } });
  save(join(runs, "internal-target.json"), { job: "inside-job", futureMeta: { inside: true } });
  symlinkSync(join(runs, "internal-target.json"), join(runs, "inside.json"), "file");
  symlinkSync(external, join(runs, "outside.json"), "file");
  writeFileSync(join(runs, "inside.log"), "finished · done\n"); writeFileSync(join(runs, "outside.log"), "finished · done\n");
  const first = await listRunsResponsive(env.home);
  expect(first.find(run => run.job === "inside-job")).toBeDefined();
  expect(first.some(run => run.job === "outside-job")).toBe(false);
  const changed = join(runs, "2026-10-01-12-00-00-codex-00000.json");
  const pending = listRunsResponsive(env.home);
  await new Promise<void>(resolve => setImmediate(resolve));
  renameSync(changed, join(env.home, "retained-original-metadata.json"));
  symlinkSync(external, changed, "file");
  expect((await pending).some(run => run.job === "outside-job")).toBe(false);
  expect((await listRunsResponsive(env.home)).some(run => run.job === "outside-job")).toBe(false);
});

it("refuses a replaced archive ancestor before any outside read or cache publication and retains the original bytes", () => {
  // Independent retained fixture: teardown never recurses into this junction.
  const fixture = mkdtempSync(join(tmpdir(), "ab-archive-ancestor-"));
  const home = join(fixture, "home"), retained = join(fixture, "retained-home"), external = join(fixture, "outside");
  mkdirSync(join(home, "archive"), { recursive: true }); mkdirSync(join(external, "archive"), { recursive: true });
  const name = "jobs-1900000000000-same.json";
  save(join(home, "archive", name), { version: 4, jobs: [job("physical-original")] });
  save(join(external, "archive", name), { version: 4, jobs: [job("outside-replacement")] });
  const originalBytes = readFileSync(join(home, "archive", name), "utf8"), outsideBytes = readFileSync(join(external, "archive", name), "utf8");
  const reads = vi.spyOn(fileCache, "readJsonSnapshot");
  const scanning = readArchivedJobSteps(join(home, "jobs.json"), true);
  expect(scanning.next().done).toBe(false);
  renameSync(home, retained);
  symlinkSync(external, home, process.platform === "win32" ? "junction" : "dir");
  expect(() => scanning.next()).toThrow(/archive ancestor changed/);
  expect(reads).not.toHaveBeenCalled();
  expect(readFileSync(join(retained, "archive", name), "utf8")).toBe(originalBytes);
  expect(readFileSync(join(external, "archive", name), "utf8")).toBe(outsideBytes);
  // Rebind the original pathname to retained data: a rejected scan cannot have
  // published outside jobs under the original cache key.
  renameSync(home, join(fixture, "retained-outside-link")); renameSync(retained, home);
  expect(drainScan(readArchivedJobSteps(join(home, "jobs.json"), true)).jobs.map(value => value.id)).toEqual(["physical-original"]);
  expect(reads).not.toHaveBeenCalled();
  console.info(JSON.stringify({ retainedArchiveAncestorFixture: fixture }));
});

it("accepts a stable initial home ancestor alias while binding the canonical archive identities", () => {
  const fixture = mkdtempSync(join(tmpdir(), "ab-archive-stable-alias-"));
  const physical = join(fixture, "physical-parent"), alias = join(fixture, "initial-parent-alias");
  const home = join(physical, "home"), file = join(home, "archive", "jobs-1900000000000-same.json");
  mkdirSync(join(home, "archive"), { recursive: true });
  save(file, { version: 4, jobs: [job("stable-alias-original")] });
  const bytes = readFileSync(file, "utf8");
  symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");
  const aliasedStore = join(alias, "home", "jobs.json");
  expect(drainScan(readArchivedJobSteps(aliasedStore, true)).jobs.map(value => value.id)).toEqual(["stable-alias-original"]);
  expect(drainScan(readArchivedJobSteps(aliasedStore, true)).jobs.map(value => value.id)).toEqual(["stable-alias-original"]);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  console.info(JSON.stringify({ retainedArchiveAliasFixture: fixture }));
});

it("retains malformed archive bytes and retries changed valid bytes instead of caching a partial catalog", async () => {
  corpus(2, 3);
  const bad = join(env.home, "archive", "jobs-1900000000000-malformed.json");
  writeFileSync(bad, "{ interrupted synthetic JSON");
  const partial = await listRunsResponsive(env.home);
  expect(readFileSync(bad, "utf8")).toBe("{ interrupted synthetic JSON");
  expect(partial.some(run => run.name === "codex-job-fixed")).toBe(false);
  save(bad, { version: 4, jobs: [job("fixed")] });
  expect((await listRunsResponsive(env.home)).find(run => run.name === "codex-job-fixed")).toBeDefined();
});

it("derives current stale/ETA state and metadata ownership with identical unknown fields across repeated polls", async () => {
  corpus(1, 1);
  const name = "2026-10-01-12-00-00-codex-00000", log = join(env.home, "runs", `${name}.log`);
  const at = Date.now();
  writeFileSync(log, "12:00:00 codex by old-owner\nUnfinished retained task\n---\n12:00:01 still running\n");
  utimesSync(log, new Date(at), new Date(at));
  save(join(env.home, "runs", `${name}.json`), { job: "codex-job-active", etaAt: at + 500_000, etaReportedAt: at, futureMeta: { legacy: ["retained"] } });
  const fresh = await listRunsResponsive(env.home, at + 1);
  expect(fresh.find(run => run.name === name)).toMatchObject({ status: "running", owner: "current-owner", rootName: "main", etaAt: at + 500_000, futureMeta: { legacy: ["retained"] } });
  const stale = await listRunsResponsive(env.home, at + 200_000);
  expect(stale).toEqual(listRuns(env.home, at + 200_000));
  expect(stale.find(run => run.name === name)).toMatchObject({ status: "interrupted", etaAt: undefined, etaReportedAt: undefined, owner: "current-owner" });
});

it("keeps outcome selection ID-based with active overrides and detaches unknown nested worktree evidence", async () => {
  corpus(1, 1);
  save(join(env.home, "archive", "jobs-1900000000000-override.json"), { version: 4, jobs: [job("active", { name: "old-archived-name", owner: "archive-owner" })] });
  const inputs: outcomeBackground.OutcomeInput[][] = [];
  vi.spyOn(outcomeBackground, "cachedOutcomes").mockImplementation(async (_home, selected) => {
    inputs.push(selected);
    return Object.fromEntries(selected.map(input => [input.key, outcomeBackground.pendingOutcome(input)]));
  });
  const ctx = { home: env.home, log: nullLogger, peers: () => [] };
  const old = await readDashboard(ctx, { path: "/api/job-outcomes", query: { job: "old-archived-name" } });
  expect(old.status).toBe(404);
  const current = await readDashboard(ctx, { path: "/api/job-outcomes", query: { job: "codex-job-active" } });
  expect(current.status).toBe(200);
  expect(inputs.at(-1)![0]!.job).toMatchObject({ id: "active", owner: "current-owner", worktree: { unknown: { keep: [1] } } });
  (inputs.at(-1)![0]!.job.worktree as any).unknown.keep.push("caller mutation");
  await readDashboard(ctx, { path: "/api/job-outcomes", query: { job: "codex-job-active" } });
  expect((inputs.at(-1)![0]!.job.worktree as any).unknown.keep).toEqual([1]);
});

it("preserves a large single-file context without promising that one native parse fits the traversal slice", async () => {
  corpus(1, 1);
  const prompt = "Synthetic retained context ".repeat(160_000);
  save(join(env.home, "archive", "jobs-1900000000000-large.json"), { version: 4, jobs: [job("large", { prompt })] });
  const result = await listRunsResponsive(env.home);
  expect(result.find(run => run.name === "codex-job-large")?.prompt).toBe(prompt.slice(0, 300));
  expect((await listRunsResponsive(env.home, Date.now(), new Set(["codex-job-large"])))[0]!.prompt).toBe(prompt);
  expect(readHistoryJobs(env.home).get("codex-job-large")!.prompt).toBe(prompt);
  expect(result).toEqual(listRuns(env.home));
});
