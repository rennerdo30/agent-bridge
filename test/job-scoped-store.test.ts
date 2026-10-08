import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JobManager, type JobCoordinator } from "../src/mcp/jobs.js";
import { readArchivedJobSnapshot } from "../src/core/job-archive.js";
import { readJsonSnapshot } from "../src/core/file-cache.js";
import { nullLogger } from "../src/core/logger.js";
import { JSON_STORE_VERSION } from "../src/core/json-store.js";

const observed = vi.hoisted(() => ({ clones: [] as string[], reads: [] as string[], failBackup: false, failBackupSync: false, fds: new Map<number, string>() }));
vi.mock("../src/core/file-cache.js", async original => {
  const cache = await original<typeof import("../src/core/file-cache.js")>();
  return { ...cache, cloneJson: <T>(value: T): T => {
    const records = Array.isArray(value) ? value : [value];
    for (const record of records) if (record && typeof record === "object" && typeof record.id === "string") observed.clones.push(record.id);
    return cache.cloneJson(value);
  } };
});
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => { observed.reads.push(String(args[0])); return fs.readFileSync(...args); },
    copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
      if (observed.failBackup && String(args[1]).includes(".backup-")) throw Object.assign(new Error("fixture backup failed"), { code: "EIO" });
      fs.copyFileSync(...args);
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => { const fd = fs.openSync(...args); observed.fds.set(fd, String(args[0])); return fd; },
    closeSync: (fd: number) => { fs.closeSync(fd); observed.fds.delete(fd); },
    fsyncSync: (fd: number) => {
      if (observed.failBackupSync && observed.fds.get(fd)?.includes(".backup-")) throw Object.assign(new Error("fixture backup flush failed"), { code: "EIO" });
      fs.fsyncSync(fd);
    },
  };
});
let home: string, path: string, archive: string;
const managers: JobManager[] = [];
beforeEach(() => {
  const root = join(process.cwd(), ".agent-bridge-test"); mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "scoped-job-store-")); path = join(home, "jobs.json");
  mkdirSync(join(home, "archive")); archive = join(home, "archive", "jobs-1.json");
  vi.stubEnv("AGENT_BRIDGE_JOB_STORE_LIMIT", "0"); vi.stubEnv("AGENT_BRIDGE_ARCHIVE_AGE_MS", "0");
  observed.failBackup = false; observed.failBackupSync = false;
});
afterEach(() => { observed.failBackup = false; observed.failBackupSync = false; managers.splice(0).forEach(manager => manager.cancelAll()); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
const job = (id: string, owner = "owner", more: Record<string, unknown> = {}) => ({ id, name: `codex-job-${id}`, agent: "codex", owner, supervisor: owner,
  rootName: owner, rootSession: owner, status: "done", startedAt: Date.now(), finishedAt: Date.now(), prompt: "original task", sessionId: "native-context",
  model: null, workdir: home, worktree: null, future: { nested: { keep: true } }, ...more });
const save = (jobs: unknown[]) => writeFileSync(path, JSON.stringify({ version: JSON_STORE_VERSION, jobs }));
function manager(owner = "owner") {
  const node = Object.assign(new EventEmitter(), { name: owner, id: owner, currentSessionId: owner, deliverLocal: vi.fn() }) as JobCoordinator;
  const jobs = new JobManager(node, nullLogger, path); managers.push(jobs);
  jobs.restore(() => () => async () => ({ text: "resumed", sessionId: "native-context", isError: false, details: {} }));
  jobs.refreshOwnership();
  return jobs;
}
function corpus(extra: unknown[] = []) {
  const records = Array.from({ length: 15_675 }, (_, i) => job(`unrelated-${i}`));
  writeFileSync(archive, JSON.stringify({ version: JSON_STORE_VERSION, jobs: [...records, ...extra] }));
  readArchivedJobSnapshot(path); readJsonSnapshot(path);
  observed.clones.length = 0; observed.reads.length = 0;
}
function expectWarmOnly(selected: string[]) {
  expect(observed.clones).toEqual(selected);
  expect(observed.reads.filter(file => file === path || file === archive)).toEqual([]);
}

it("refreshes only tracked archive jobs across 15,675 unrelated owned rows, with no warm full rereads", () => {
  const tracked = job("tracked"); save([tracked]);
  const jobs = manager(); save([]);
  corpus([tracked]);
  jobs.refreshOwnership(); jobs.refreshOwnership();
  expectWarmOnly(["tracked", "tracked"]);
  const found = jobs.find(tracked.name)! as unknown as Record<string, any>;
  found.future.nested.keep = false;
  expect(readArchivedJobSnapshot(path).jobs.find(record => record.id === "tracked")!.future).toEqual({ nested: { keep: true } });
  expect(jobs.hookJobs()).toHaveLength(1);
});

it("lazy find selects one archived record and retains full native context and unknown prototype-shaped fields", () => {
  save([]); const jobs = manager();
  const wanted = job("wanted", "owner", { prompt: "full task ".repeat(1000), args: { custom: "retain" },
    ...JSON.parse('{"__proto__":{"retained":true}}') });
  corpus([wanted]);
  const found = jobs.find(wanted.name)! as unknown as Record<string, any>;
  expectWarmOnly(["wanted"]);
  expect(found).toMatchObject({ prompt: wanted.prompt, sessionId: "native-context", workdir: home, args: { custom: "retain" } });
  expect(Object.hasOwn(found.recoveredRecord, "__proto__")).toBe(true);
  found.recoveredRecord.__proto__.retained = false; found.future.nested.keep = false;
  const cached = readArchivedJobSnapshot(path).jobs.find(record => record.id === "wanted")! as Record<string, any>;
  expect(cached.__proto__.retained).toBe(true);
  expect(cached.future.nested.keep).toBe(true);
});

it("active overrides win before clone selection, including final duplicate active rows", () => {
  save([]); const jobs = manager();
  save([job("wanted", "owner", { prompt: "first active" }), job("wanted", "owner", { prompt: "last active", future: { source: "active" } })]);
  corpus([job("wanted", "other", { prompt: "obsolete archive", future: { source: "archive" } })]);
  expect(jobs.find("codex-job-wanted")).toMatchObject({ prompt: "last active", owner: "owner", future: { source: "active" } });
  expectWarmOnly(["wanted"]);
  expect(readArchivedJobSnapshot(path).jobs.find(record => record.id === "wanted")!.future).toEqual({ source: "archive" });
});

it("discovers newly handed-off active jobs and removes tracked jobs moved to another owner", () => {
  save([job("tracked")]); const jobs = manager();
  const receipt = { id: "handoff", at: Date.now(), from: "other", to: "owner", rootSession: "owner", rootName: "owner", reason: "explicit-handoff" };
  save([job("tracked", "other", { ownershipHistory: [{ ...receipt, from: "owner", to: "other", rootName: "other" }] }),
    job("assigned", "owner", { ownershipHistory: [receipt] })]);
  corpus([job("assigned", "other")]);
  jobs.refreshOwnership();
  expectWarmOnly(["tracked", "assigned"]);
  expect(jobs.hookJobs()).toContainEqual(expect.objectContaining({ id: "assigned", owner: "owner" }));
  expect(jobs.hookJobs().some(record => record.id === "tracked")).toBe(false);
});

it("metadata persist clones only its selected old archive record and never exposes archive authority arrays", () => {
  const tracked = job("tracked"); save([tracked]); const jobs = manager(); save([]);
  const receipt = { id: "handoff", at: Date.now(), from: "other", to: "owner", rootSession: "owner", rootName: "owner", reason: "explicit-handoff" };
  corpus([{ ...tracked, ownershipHistory: [receipt], masters: ["owner"], args: { send_to: ["owner"] } }]);
  jobs.persist();
  expect(observed.clones.length).toBeGreaterThan(0);
  expect(observed.clones.length).toBeLessThanOrEqual(2);
  expect(new Set(observed.clones)).toEqual(new Set(["tracked"]));
  expect(observed.reads.filter(file => file === archive)).toEqual([]);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.jobs.map((record: { id: string }) => record.id)).toEqual(["tracked"]);
  expect(saved.jobs[0]).toMatchObject({ sessionId: "native-context", prompt: "original task", future: { nested: { keep: true } },
    ownershipHistory: [receipt], masters: ["owner"], args: { send_to: ["owner"] } });
  const mutable = jobs.hookJobs()[0]!;
  mutable.masters!.push("changed");
  mutable.ownershipHistory![0]!.note = "changed";
  (mutable.args!.send_to as string[]).push("changed");
  const cached = readArchivedJobSnapshot(path).jobs.find(record => record.id === "tracked")! as Record<string, any>;
  expect(cached.masters).toEqual(["owner"]);
  expect(cached.ownershipHistory[0].note).toBeUndefined();
  expect(cached.args.send_to).toEqual(["owner"]);
});

it.each(['{"broken":', '{"version":4,"jobs":"invalid"}', '{"version":99,"futureFormat":["keep"]}'])("passive ownership refresh preserves invalid/future bytes %s", raw => {
  save([]); const jobs = manager();
  writeFileSync(path, raw);
  jobs.refreshOwnership();
  expect(readFileSync(path, "utf8")).toBe(raw);
  expect(readdirSync(home).sort()).toEqual(["archive", "jobs.json"]);
});

function duplicateAuthority() {
  const change = (name: string) => ({ id: `handoff-${name}`, at: 1, from: "previous", to: name, rootSession: name, rootName: name, reason: "explicit-handoff" });
  const old = job("conflict", "former", { startedAt: 100, sessionId: "old-context", ownershipHistory: [change("former")], masters: ["former"],
    args: { send_to: ["former"], oldOption: "keep in backup" }, shadowedOnly: { original: "never lose" } });
  const latest = job("conflict", "owner", { startedAt: 200, sessionId: "new-context", ownershipHistory: [change("owner")], masters: ["owner"],
    args: { send_to: ["owner"], customOption: "current" }, future: { latest: { keep: true } } });
  save([old]); const stale = manager("former");
  save([latest]); const current = manager();
  const unknown = { unknownEntry: { keep: "original" } };
  const raw = JSON.stringify({ version: JSON_STORE_VERSION, envelopeFuture: { keep: true }, jobs: [old, unknown, latest] }, null, 2) + "\n";
  writeFileSync(path, raw);
  return { stale, current, latest, old, unknown, raw };
}

it.each(["current", "stale"] as const)("last duplicate authority survives %s manager persistence, with the complete conflicting original retained", which => {
  const data = duplicateAuthority();
  data[which].persist();
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.envelopeFuture).toEqual({ keep: true });
  expect(saved.jobs).toContainEqual(data.unknown);
  const records = saved.jobs.filter((record: { id?: string }) => record.id === "conflict");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject(data.latest);
  expect(records[0]).toMatchObject({ owner: "owner", sessionId: "new-context", masters: ["owner"], args: { send_to: ["owner"] } });
  const backups = readdirSync(home).filter(file => file.startsWith("jobs.json.backup-"));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(home, backups[0]!), "utf8")).toBe(data.raw);
  expect(JSON.parse(readFileSync(join(home, backups[0]!), "utf8")).jobs[0]).toEqual(data.old);
});

it.each(["copy", "flush"] as const)("does not collapse or rewrite duplicate bytes if the required original-document backup %s fails", phase => {
  const data = duplicateAuthority();
  observed.failBackup = phase === "copy"; observed.failBackupSync = phase === "flush";
  data.current.persist();
  expect(readFileSync(path, "utf8")).toBe(data.raw);
  const backups = readdirSync(home).filter(file => file.startsWith("jobs.json.backup-"));
  expect(backups).toHaveLength(phase === "copy" ? 0 : 1);
  if (phase === "flush") expect(readFileSync(join(home, backups[0]!), "utf8")).toBe(data.raw);
});
