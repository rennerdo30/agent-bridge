import { appendFileSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readJsonSnapshot } from "../src/core/file-cache.js";
import { listRuns, readStoredJobs } from "../src/core/dashboard-read.js";
import { readArchivedJobs } from "../src/core/job-archive.js";
import { readHistoryJobs, readHistoryJson } from "../src/core/run-history.js";
import { makeEnv, type TestEnv } from "./helpers.js";
const reads = vi.hoisted(() => ({ files: [] as string[], failOnce: "" }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    reads.files.push(String(args[0]));
    if (String(args[0]) === reads.failOnce) {
      reads.failOnce = "";
      throw Object.assign(new Error("temporary sharing failure"), { code: "EACCES" });
    }
    return fs.readFileSync(...args);
  } };
});

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });
const store = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));

describe("read-only performance caches", () => {
  it("reuses unchanged parses and observes same-size atomic replacement with restored mtime", () => {
    const file = join(env.home, "jobs.json"), replacement = `${file}.next`;
    store(file, { jobs: [{ name: "job", args: { title: "old" } }] });
    utimesSync(file, 10, 10);
    const first = readJsonSnapshot(file);
    expect(readJsonSnapshot(file)).toBe(first);
    store(replacement, { jobs: [{ name: "job", args: { title: "new" } }] });
    utimesSync(replacement, 10, 10); renameSync(replacement, file);
    expect(readJsonSnapshot(file)).not.toBe(first);
    expect(readHistoryJobs(env.home).get("job")?.args).toEqual({ title: "new" });
    const publicValue = readHistoryJson(file) as any;
    publicValue.jobs[0].args.title = "poisoned";
    expect((readHistoryJson(file) as any).jobs[0].args.title).toBe("new");
  });

  it("invalidates metadata, log appends, stale status and caller mutations independently", () => {
    const root = join(env.home, "runs"); mkdirSync(root);
    const file = join(root, "2026-10-01-00-00-00-codex-abc.log"), meta = file.replace(/\.log$/, ".json");
    writeFileSync(file, "00:00:00 codex by owner\ntask\n---\n00:00:01 working\n");
    store(meta, { title: "first", etaAt: 999, worktree: { branch: "original" } });
    utimesSync(file, 100, 100);
    expect(listRuns(env.home, 100_000)[0]).toMatchObject({ status: "running", title: "first", etaAt: 999 });
    expect(listRuns(env.home, 300_000)[0]).toMatchObject({ status: "interrupted", etaAt: undefined });
    const publicRun = listRuns(env.home, 100_000)[0]!; publicRun.worktree!.branch = "changed";
    expect(listRuns(env.home, 100_000)[0]?.worktree?.branch).toBe("original");
    store(meta, { title: "second" });
    expect(listRuns(env.home, 100_000)[0]?.title).toBe("second");
    appendFileSync(file, "00:00:02 finished after 2s · done\n");
    expect(listRuns(env.home)[0]?.status).toBe("done");
    expect(readFileSync(file, "utf8")).toContain("working");
  });

  it("observes archives added and changed after warmup, keeps precedence and surfaces damage", () => {
    const root = join(env.home, "archive"); mkdirSync(root);
    const active = join(env.home, "jobs.json"), archive = join(root, "jobs-1.json");
    store(active, { jobs: [{ id: "a", name: "job-a", owner: "current" }] });
    store(archive, { jobs: [{ id: "a", name: "job-a", owner: "older" }] });
    expect(readStoredJobs(env.home).get("job-a")?.owner).toBe("current");
    store(join(root, "jobs-2.json"), { jobs: [{ id: "b", name: "job-b", owner: "other" }] });
    expect(readHistoryJobs(env.home).has("job-b")).toBe(true);
    const archived = readArchivedJobs(active); archived[0]!.owner = "poisoned";
    expect(readArchivedJobs(active)[0]?.owner).toBe("older");
    store(archive, { jobs: [{ id: "a", name: "job-a", owner: "updated" }] });
    expect(readArchivedJobs(active).find(job => job.id === "a")?.owner).toBe("updated");
    writeFileSync(archive, "corrupt");
    expect(() => readArchivedJobs(active)).toThrow();
    expect(readFileSync(archive, "utf8")).toBe("corrupt");
  });

  it("checks archive/run stat signatures without rereading an evicted unchanged corpus", () => {
    const root = join(env.home, "archive"), runs = join(env.home, "runs");
    mkdirSync(root); mkdirSync(runs);
    const active = join(env.home, "jobs.json"), archive = join(root, "jobs-1.json");
    const log = join(runs, "2026-10-01-00-00-00-codex-abc.log"), meta = log.replace(/\.log$/, ".json");
    store(archive, { jobs: [{ id: "a", name: "job-a", owner: "owner" }] });
    store(meta, { title: "retained" });
    writeFileSync(log, "00:00:00 codex\n00:00:01 finished after 1s · done\n");
    readArchivedJobs(active); listRuns(env.home);
    // Evict the raw JSON cache with unrelated entries. The projections must still
    // test their stat signatures before asking that cache to parse any file.
    for (let i = 0; i < 2050; i++) {
      const file = join(env.home, `unrelated-${i}.json`); store(file, { i }); readJsonSnapshot(file);
    }
    reads.files = [];
    expect(readArchivedJobs(active)[0]?.name).toBe("job-a");
    expect(listRuns(env.home).find(run => run.hasLog)?.title).toBe("retained");
    expect(reads.files.filter(file => [archive, meta, log].includes(file))).toEqual([]);
    store(meta, { title: "changed" });
    expect(listRuns(env.home).find(run => run.hasLog)?.title).toBe("changed");
    expect(reads.files).toContain(meta);
  });

  it("retries transient job and metadata read failures without needing a stat change", () => {
    const active = join(env.home, "jobs.json"), root = join(env.home, "runs"); mkdirSync(root);
    const log = join(root, "2026-10-01-00-00-00-codex-abc.log"), meta = log.replace(/\.log$/, ".json");
    store(active, { jobs: [{ id: "a", name: "job-a", owner: "present" }] });
    reads.failOnce = active;
    expect(readHistoryJobs(env.home).has("job-a")).toBe(false);
    expect(readHistoryJobs(env.home).get("job-a")?.owner).toBe("present");
    store(meta, { title: "available" });
    writeFileSync(log, "00:00:00 codex\n00:00:01 finished after 1s · done\n");
    reads.failOnce = meta;
    expect(listRuns(env.home).find(run => run.hasLog)?.title).toBeUndefined();
    expect(listRuns(env.home).find(run => run.hasLog)?.title).toBe("available");
  });

  it("retains and reports malformed bytes without rereading them on every poll", () => {
    const active = join(env.home, "jobs.json");
    writeFileSync(active, "malformed retained bytes");
    reads.files = [];
    for (let i = 0; i < 5; i++) expect(readHistoryJobs(env.home).size).toBe(0);
    expect(reads.files.filter(file => file === active)).toHaveLength(1);
    store(active, { jobs: [{ name: "repaired", id: "repaired" }] });
    expect(readHistoryJobs(env.home).has("repaired")).toBe(true);
  });
});
