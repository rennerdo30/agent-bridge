import { indexFixtureFile } from "./archive-fixture.js";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneJson, readJsonSnapshot } from "../src/core/file-cache.js";
import { listRuns, readStoredJobs } from "../src/core/dashboard-read.js";
import { readArchivedJobs } from "../src/core/job-archive.js";
import { readHistoryJobs, readHistoryJson, readRunStarts } from "../src/core/run-history.js";
import { makeEnv, type TestEnv } from "./helpers.js";
const reads = vi.hoisted(() => ({ files: [] as string[], asyncFiles: [] as string[], stats: [] as string[], lstats: [] as string[], realpaths: [] as string[], descriptors: new Map<number, string>(), failOnce: "", changeDuringRead: "",
  swapAfterListing: null as null | ((dir: string) => void), virtualLink: null as null | { file: string; target: string } }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const realpath = Object.assign(fs.realpathSync.bind(fs), { native: (...args: Parameters<typeof fs.realpathSync.native>) => {
    reads.realpaths.push(String(args[0]));
    if (String(args[0]) === reads.virtualLink?.file) return fs.realpathSync.native(reads.virtualLink.target);
    return fs.realpathSync.native(...args);
  } });
  return { ...fs, realpathSync: realpath,
    statSync: (...args: Parameters<typeof fs.statSync>) => { reads.stats.push(String(args[0])); if (String(args[0]) === reads.virtualLink?.file) args[0] = reads.virtualLink.target; return fs.statSync(...args); },
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      reads.lstats.push(String(args[0]));
      if (String(args[0]) === reads.virtualLink?.file) {
        const st = fs.lstatSync(...args);
        return st ? Object.assign(st, { isFile: () => false, isSymbolicLink: () => true }) : st;
      }
      return fs.lstatSync(...args);
    },
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => { const result = fs.readdirSync(...args); reads.swapAfterListing?.(String(args[0])); return result; },
    openSync: (...args: Parameters<typeof fs.openSync>) => { const fd = fs.openSync(...args); reads.descriptors.set(fd, String(args[0])); return fd; },
    closeSync: (fd: number) => { reads.descriptors.delete(fd); return fs.closeSync(fd); },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    let path = typeof args[0] === 'number' ? reads.descriptors.get(args[0]) ?? String(args[0]) : String(args[0]);
    if (path === reads.virtualLink?.file) { path = reads.virtualLink.target; args[0] = path; }
    reads.files.push(path);
    if (path === reads.failOnce) {
      reads.failOnce = "";
      throw Object.assign(new Error("temporary sharing failure"), { code: "EACCES" });
    }
    const result = fs.readFileSync(...args);
    if (path === reads.changeDuringRead) { reads.changeDuringRead = ''; fs.appendFileSync(path, ' '); }
    return result;
  } };
});
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === reads.virtualLink?.file) args[0] = reads.virtualLink.target;
    reads.asyncFiles.push(String(args[0])); return fs.readFile(...args);
  } };
});

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { reads.virtualLink = null; reads.swapAfterListing = null; await env.cleanup(); });
const store = (file: string, value: unknown) => {
  writeFileSync(file, JSON.stringify(value));
  if (/jobs-.*\.json$/.test(file)) indexFixtureFile(file);
};

describe("read-only performance caches", () => {
  it("keeps the complete cold 307-archive/1024-run corpus with bounded discovery and post-read identity checks", () => {
    const archive = join(env.home, 'archive'), runs = join(env.home, 'runs'); mkdirSync(archive); mkdirSync(runs);
    for (let file = 0; file < 307; file++) {
      const jobs = Array.from({ length: 75 }, (_, n) => ({ id: `archived-${file % 209}-${n}`, name: `codex-job-archived-${file % 209}-${n}`,
        agent: 'codex', owner: 'fixture', status: 'done', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_001_000,
        prompt: 'Synthetic retained completed job. '.repeat(18), args: { title: `archived-${n}` }, worktree: null }));
      store(join(archive, `jobs-${1_700_000_000_000 + file}-synthetic.json`), { version: 4, jobs });
    }
    for (let n = 0; n < 1024; n++) {
      const name = `synthetic-run-${n}`;
      store(join(runs, `${name}.json`), { title: name, nested: { retained: true } });
      writeFileSync(join(runs, `${name}.log`), 'Synthetic retained output\n');
    }
    store(join(env.home, 'jobs.json'), { version: 4, jobs: [] });
    reads.stats = []; reads.lstats = []; reads.realpaths = []; reads.files = [];
    const start = performance.now(), cold = listRuns(env.home);
    const coldMs = performance.now() - start;
    expect(cold).toHaveLength(209 * 75 + 1024);
    expect(cold.filter(run => run.hasLog)).toHaveLength(1024);
    expect(reads.realpaths.length).toBeLessThanOrEqual(20);
    // One fresh discovery identity per log/JSON, plus one post-read JSON identity.
    // No realpath-per-file or repeated stats inside archive ordering/parsing.
    expect(reads.stats.length + reads.lstats.length).toBeLessThanOrEqual(1024 * 3 + (307 + 1) * 2);
    expect(reads.files).toHaveLength(1024 + 1);
    reads.files = [];
    const warmStart = performance.now(), warm = listRuns(env.home);
    const warmMs = performance.now() - warmStart;
    expect(warm).toHaveLength(cold.length); expect(reads.files).toEqual([]);
    (cold.find(run => run.hasLog)! as any).nested.retained = false;
    expect((listRuns(env.home).find(run => run.hasLog)! as any).nested.retained).toBe(true);
    console.info(JSON.stringify({ corpus: 'cold-history-stat-regression', archives: 307, physicalRuns: 1024, totalRuns: cold.length, coldMs, warmMs }));
  });

  it("isolates nested JSON containers and preserves own prototype-shaped keys", () => {
    const original = JSON.parse('{"__proto__":{"retained":true},"constructor":"retained","nested":[{"value":"original"}]}');
    const copied = cloneJson(original);
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.hasOwn(copied, "__proto__")).toBe(true);
    copied.__proto__.retained = false; copied.nested[0].value = "changed";
    expect(original.__proto__.retained).toBe(true);
    expect(original.nested[0].value).toBe("original");
    expect(copied.constructor).toBe("retained");
  });

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

  it("rejects a stale scanner identity before reading a replacement and retries fresh", () => {
    const file = join(env.home, 'scanned.json'), replacement = `${file}.next`;
    store(file, { retained: 'old' }); const previous = statSync(file);
    store(replacement, { retained: 'new' }); renameSync(replacement, file);
    expect(() => readJsonSnapshot(file, { file, stat: previous })).toThrow('identity changed');
    expect(readJsonSnapshot(file, { file, stat: statSync(file) }).value).toEqual({ retained: 'new' });
    expect(() => readJsonSnapshot(file, { file: replacement, stat: statSync(file) })).toThrow('another file');
  });

  it("does not publish bytes changed during a scanned read", () => {
    const file = join(env.home, 'changing.json'); store(file, { retained: 'original' });
    reads.changeDuringRead = file;
    expect(() => readJsonSnapshot(file, { file, stat: statSync(file) })).toThrow('identity changed during read');
    expect(readJsonSnapshot(file, { file, stat: statSync(file) }).value).toEqual({ retained: 'original' });
    expect(readFileSync(file, 'utf8')).toMatch(/ $/);
  });

  it("refuses linked archive directories while preserving contained and outside originals", async () => {
    const archive = join(env.home, 'archive'), target = join(env.home, 'contained-history');
    mkdirSync(target); store(join(target, 'jobs-1.json'), { jobs: [{ name: 'contained', id: 'contained', args: { title: 'kept' } }] });
    symlinkSync(target, archive, process.platform === 'win32' ? 'junction' : 'dir');
    try { expect(() => readHistoryJobs(env.home)).toThrow(/physical/); }
    finally { unlinkSync(archive); }
    const outside = makeEnv();
    try {
      const external = join(outside.home, 'jobs-1.json'); store(external, { jobs: [{ name: 'outside', id: 'outside' }] });
      symlinkSync(outside.home, archive, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        expect(() => readHistoryJobs(env.home)).toThrow(/physical/);
        expect(readFileSync(external, 'utf8')).toContain('outside');
      } finally { unlinkSync(archive); }
      expect(readFileSync(join(target, 'jobs-1.json'), 'utf8')).toContain('kept');
    } finally { await outside.cleanup(); }
  });

  it("refuses an escaping file link swapped after directory enumeration, before any outside read", async () => {
    const outside = makeEnv(), archive = join(env.home, 'archive'); mkdirSync(archive);
    const file = join(archive, 'jobs-1.json'), target = join(outside.home, 'outside.json');
    store(file, { jobs: [{ id: 'original', name: 'original' }] });
    store(target, { title: 'outside-title', job: 'outside-job', jobStartedAt: 100, jobs: [{ id: 'outside', name: 'outside' }] });
    reads.files = [];
    reads.swapAfterListing = dir => { if (dir === archive) reads.virtualLink = { file, target }; };
    try {
      expect(readHistoryJobs(env.home).has('outside')).toBe(false);
      expect(reads.files).not.toContain(target);
      reads.virtualLink = null; reads.swapAfterListing = null;
      expect(readHistoryJobs(env.home).has('original')).toBe(true);
      const runs = join(env.home, 'runs'), name = '2026-10-09-00-00-00-codex-safe'; mkdirSync(runs);
      const metadata = join(runs, `${name}.json`);
      store(metadata, { title: 'original-title', job: 'original-job', jobStartedAt: 100 }); writeFileSync(join(runs, `${name}.log`), '00:00:00 codex\n00:00:01 finished after 1s · done\n');
      reads.files = [];
      reads.swapAfterListing = dir => { if (dir === runs) reads.virtualLink = { file: metadata, target }; };
      expect(listRuns(env.home).find(run => run.name === name)?.title).toBeUndefined();
      expect(reads.files).not.toContain(target);
      reads.asyncFiles = [];
      expect(await readRunStarts(env.home)).toEqual([]);
      expect(reads.asyncFiles).not.toContain(target);
      reads.virtualLink = null; reads.swapAfterListing = null;
      expect(listRuns(env.home).find(run => run.name === name)?.title).toBe('original-title');
      expect(await readRunStarts(env.home)).toMatchObject([{ job: 'original-job', jobStartedAt: 100 }]);
      expect(readFileSync(target, 'utf8')).toContain('outside');
    } finally { reads.virtualLink = null; reads.swapAfterListing = null; await outside.cleanup(); }
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
    expect(() => indexFixtureFile(archive)).toThrow();
    expect(readArchivedJobs(active).find(job => job.id === "a")?.owner).toBe("updated");
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
