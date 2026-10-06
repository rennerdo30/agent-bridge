import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRuns, startUi } from "../src/cli/ui.js";
import { nullLogger } from "../src/core/logger.js";
import { pageRuns, readHistoryJobs } from "../src/core/run-history.js";
import { makeEnv, type TestEnv } from "./helpers.js";
import { CLAUDE_SESSION, CODEX_CHILD, CODEX_SESSION, installTranscriptFixtures } from "./transcript-fixtures.js";

const ARCHIVE_SUFFIX = "-1791288000000-22222222-2222-4222-8222-222222222222";
let env: TestEnv, ui: Awaited<ReturnType<typeof startUi>>, cookie: string;
let fixtures: ReturnType<typeof installTranscriptFixtures>;
const base = () => ui.url.replace(/\/\?t=.*$/, "");
const get = (path: string) => fetch(`${base()}${path}`, { headers: { cookie } });
const job = (name: string, agent = "codex", sessionId: string | null = CODEX_SESSION) => ({
  id: name, name, agent, model: "test-model", prompt: "Recover my work.", status: "done", owner: "claude-parent",
  startedAt: 1_000, finishedAt: 2_000, sessionId, workdir: "/project", args: { title: "Recovered task" },
  worktree: { path: "/tree", cwd: "/tree/src", repoRoot: "/project", branch: "agent-bridge/task", base: "abc" },
});
function archiveJobs(filename: string, jobs: unknown[], legacy = false): void {
  const dir = join(env.home, "archive"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), JSON.stringify(legacy ? jobs : { version: 1, jobs }));
}
function archivedRun(name: string, meta: Record<string, unknown> = {}, legacy = true): void {
  const dir = join(env.home, "runs", "archive"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.log${legacy ? ARCHIVE_SUFFIX : ""}`), "00:00:00 codex\n00:00:01 finished after 1s · done\n");
  writeFileSync(join(dir, `${name}.json${legacy ? ARCHIVE_SUFFIX.replace("22222222", "33333333") : ""}`), JSON.stringify(meta));
}
beforeEach(async () => {
  env = makeEnv(); fixtures = installTranscriptFixtures(env.home);
  ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger, transcripts: fixtures.paths });
  const first = await fetch(ui.url, { redirect: "manual" });
  cookie = String(first.headers.get("set-cookie")).split(";")[0]!;
});
afterEach(async () => { await ui.close(); await env.cleanup(); });

describe("durable run history", () => {
  it("pages every run without dropping ties or imposing a history cap", async () => {
    for (let i = 0; i < 125; i++) archivedRun(`2026-10-06-00-00-00-codex-${String(i).padStart(3, "0")}`);
    const state = await (await get("/api/state")).json();
    expect(state.runs).toHaveLength(50); expect(state.runsTotal).toBe(125); expect(state.runsNext).toBeTypeOf("string");
    const names = state.runs.map((run: { name: string }) => run.name);
    let before = state.runsNext;
    while (before) {
      const response = await get(`/api/runs?before=${encodeURIComponent(before)}&limit=17`);
      expect(response.status).toBe(200);
      const page = await response.json(); expect(page.total).toBe(125);
      names.push(...page.runs.map((run: { name: string }) => run.name)); before = page.next;
    }
    expect(names).toHaveLength(125); expect(new Set(names).size).toBe(125);
    expect(listRuns(env.home)).toHaveLength(125);
    expect((await get("/api/runs?before=1791244800001&limit=500")).status).toBe(200);
    for (const query of ["limit=0", "limit=501", "limit=1.5", "limit=no", "before=no", "before=NaN", "before=9007199254740992"]) expect((await get(`/api/runs?${query}`)).status).toBe(400);
    expect((await fetch(`${base()}/api/runs`)).status).toBe(403);
  });

  it("serves both archive formats by original name and matches independently archived metadata", async () => {
    for (const legacy of [true, false]) {
      const name = `2026-10-06-00-00-00-codex-${legacy}`;
      archivedRun(name, { title: "Archived task", job: `job-${legacy}`, session: CODEX_SESSION }, legacy);
      const page = await (await get(`/api/runs/${name}`)).json();
      expect(page.text).toContain("finished after"); expect(page.next).toBe(page.size);
      expect(listRuns(env.home).find((r) => r.name === name)).toMatchObject({ archived: true, recovered: false, title: "Archived task", session: CODEX_SESSION });
      expect((await get(`/api/runs/${name}/chat`)).status).toBe(200);
    }
    expect((await get("/api/runs/missing")).status).toBe(404);
    expect((await get("/api/runs/..%2Fsecret")).status).toBe(404);
  });

  it("recovers every legacy and current archive job, preserves details, and lets active data win", async () => {
    archiveJobs(`jobs.json.overflow.json${ARCHIVE_SUFFIX}`, [job("codex-job-old"), job("codex-job-duplicate")]);
    archiveJobs("jobs-1791288000001-example.json", [job("codex-job-new")]);
    archiveJobs(`jobs.json.backup${ARCHIVE_SUFFIX}`, [job("codex-job-legacy")], true);
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ jobs: [{ ...job("codex-job-duplicate"), owner: "new-owner" }] }));
    expect(readHistoryJobs(env.home).size).toBe(4);
    const runs = listRuns(env.home); expect(runs).toHaveLength(4);
    expect(runs.find((r) => r.name === "codex-job-old")).toMatchObject({ recovered: true, hasLog: false, job: "codex-job-old", model: "test-model", title: "Recovered task", prompt: "Recover my work.", by: "claude-parent", owner: "claude-parent", sessionId: CODEX_SESSION, session: CODEX_SESSION, startedAt: 1_000, finishedAt: 2_000, branch: "agent-bridge/task" });
    expect(runs.find((r) => r.name === "codex-job-duplicate")?.owner).toBe("new-owner");
    expect(await (await get("/api/runs/codex-job-old")).json()).toEqual({ text: "", next: 0, size: 0, recovered: true, hasLog: false });
    archivedRun("2026-10-06-00-00-00-codex-old", { job: "codex-job-old" });
    expect(listRuns(env.home).filter((r) => r.job === "codex-job-old")).toHaveLength(1);
    archiveJobs("jobs-extra.json", [{ ...job("codex-job-running"), status: "running" }]);
    expect(listRuns(env.home).find((r) => r.name === "codex-job-running")?.status).toBe("interrupted");
  });

  it("does not rename, repair or overwrite corrupt stores while reading history", async () => {
    archivedRun("2026-10-06-00-00-00-codex-corrupt");
    const dir = join(env.home, "runs", "archive"), meta = readdirSync(dir).find((name) => name.includes(".json"))!;
    writeFileSync(join(dir, meta), "broken metadata"); writeFileSync(join(env.home, "jobs.json"), "broken jobs");
    archiveJobs("jobs-valid.json", [job("codex-job-valid")]);
    writeFileSync(join(env.home, "archive", "jobs-corrupt.json"), "broken archive");
    const before = readdirSync(dir);
    expect((await get("/api/state")).status).toBe(200); expect((await get("/api/runs")).status).toBe(200);
    expect(readFileSync(join(dir, meta), "utf8")).toBe("broken metadata");
    expect(readFileSync(join(env.home, "jobs.json"), "utf8")).toBe("broken jobs"); expect(readdirSync(dir)).toEqual(before);
    expect(listRuns(env.home).some((r) => r.name === "codex-job-valid")).toBe(true);
  });

  it("uses the newest archive snapshot across layouts and integer cursors for undated logs", () => {
    archiveJobs(`jobs.json.overflow.json${ARCHIVE_SUFFIX}`, [{ ...job("codex-job-duplicate"), sessionId: null }]);
    archiveJobs("jobs-1791288000001-example.json", [job("codex-job-duplicate")]);
    expect(readHistoryJobs(env.home).get("codex-job-duplicate")?.sessionId).toBe(CODEX_SESSION);
    archivedRun("undated");
    const page = pageRuns(listRuns(env.home), null, 1);
    expect(() => pageRuns(listRuns(env.home), page.next, 1)).not.toThrow();
  });
});

describe("job transcript recovery", () => {
  it.each([
    ["claude", CLAUDE_SESSION, "agent_example"], ["codex", CODEX_SESSION, CODEX_CHILD], ["opencode", "ses_child", "ses_grandchild"],
  ] as const)("reads %s recovered chat and native children without a connected peer", async (agent, session, child) => {
    const name = `${agent}-job-recovered`;
    archiveJobs("jobs-recovered.json", [job(name, agent, session)]);
    const sources = [fixtures.claude, fixtures.codex, fixtures.sqlite]; const bytes = sources.map((file) => readFileSync(file));
    const response = await get(`/api/runs/${name}/chat`); expect(response.status).toBe(200);
    const page = await response.json(); expect(page.items.length).toBeGreaterThan(0); expect(page.next).toBeTypeOf("string");
    expect((await (await get(`/api/runs/${name}/chat?from=${encodeURIComponent(page.next)}`)).json()).items).toEqual([]);
    const children = `/api/jobs/${name}/subagents`;
    expect((await (await get(children)).json()).subagents).toMatchObject([{ id: child }]);
    expect((await get(`${children}/${child}`)).status).toBe(200);
    expect((await get(`${children}/foreign-child`)).status).toBe(404);
    expect((await get(`${children}/..%2Fsecret`)).status).toBe(404);
    expect((await get(`${children}/${child}?from=-1`)).status).toBe(400);
    expect((await get(`/api/runs/${name}/chat?from=invalid`)).status).toBe(400);
    for (const path of [`/api/runs/${name}/chat`, children, `${children}/${child}`]) {
      expect((await fetch(`${base()}${path}`)).status).toBe(403);
      expect((await fetch(`${base()}${path}`, { method: "POST", headers: { cookie } })).status).toBe(404);
    }
    sources.forEach((file, index) => expect(readFileSync(file)).toEqual(bytes[index]));
  });

  it("resolves logged jobs and threadId-only legacy records and distinguishes missing sessions/storage", async () => {
    const legacy = { ...job("codex-job-thread"), sessionId: undefined, threadId: CODEX_SESSION };
    archiveJobs("jobs-thread.json", [legacy, job("codex-job-unbound", "codex", null), job("codex-job-missing", "codex", "missing")]);
    expect((await get("/api/runs/codex-job-thread/chat")).status).toBe(200);
    archivedRun("2026-10-06-00-00-00-codex-live", { job: "codex-job-live", session: CODEX_SESSION });
    expect((await get("/api/jobs/codex-job-live/subagents")).status).toBe(200);
    for (const suffix of ["/chat", ""]) expect((await get(`/api/runs/unknown${suffix}`)).status).toBe(404);
    expect((await get("/api/jobs/unknown/subagents")).status).toBe(404);
    expect((await get("/api/jobs/codex-job-unbound/subagents")).status).toBe(409);
    expect((await get("/api/runs/codex-job-unbound/chat")).status).toBe(409);
    expect((await get("/api/runs/codex-job-missing/chat")).status).toBe(404);
    expect(await (await get("/api/jobs/codex-job-missing/subagents")).json()).toEqual({ subagents: [] });
  });
});

it("timestamp-only cursors remain supported while composite cursors preserve equal times", () => {
  const runs = [{ name: "b", startedAt: 100 }, { name: "a", startedAt: 100 }, { name: "c", startedAt: 99 }];
  expect(pageRuns(runs, "100", 5).runs).toEqual([runs[2]]);
  expect(pageRuns(runs, "100:b", 5).runs).toEqual([runs[1], runs[2]]);
});

it("keeps an old running job on the first page behind newer finished ones (AB-112)", () => {
  const runs = [
    { name: "new", startedAt: 300, status: "done" },
    { name: "mid", startedAt: 200, status: "done" },
    { name: "old-running", startedAt: 100, status: "running" },
    { name: "old-done", startedAt: 50, status: "done" },
  ];
  const first = pageRuns(runs, null, 2);
  expect(first.runs.map((r) => r.name)).toEqual(["new", "mid", "old-running"]);
  expect(first.next).toBe("200:mid");
  // Later pages are unchanged (the page dedupes the repeat by name).
  expect(pageRuns(runs, first.next, 5).runs.map((r) => r.name)).toEqual(["old-running", "old-done"]);
});
