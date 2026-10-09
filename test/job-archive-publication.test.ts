import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { archiveJobs, readArchivedJobs } from "../src/core/job-archive.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const publication = vi.hoisted(() => ({ before: undefined as undefined | ((source: string, target: string) => void), fail: false }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, linkSync: (source: string, target: string) => {
    publication.before?.(source, target);
    if (publication.fail) throw Object.assign(new Error("synthetic publication interruption"), { code: "EIO" });
    fs.linkSync(source, target);
  } };
});
let env: TestEnv;
beforeEach(() => { env = makeEnv(); publication.before = undefined; publication.fail = false; });
afterEach(async () => { await env.cleanup(); });

it("publishes complete per-job transactions and preserves active bytes after an interrupted batch", () => {
  const active = join(env.home, "jobs.json"), jobs = [{ id: "kept", name: "codex-job-kept", prompt: "retained bytes" }];
  writeFileSync(active, JSON.stringify({ jobs }));
  archiveJobs(active, jobs);
  expect(() => archiveJobs(active, [{ id: "partial" }, { id: "bad", value: 1n }])).toThrow(/BigInt/);
  expect(JSON.parse(readFileSync(active, "utf8")).jobs).toEqual(jobs);
  expect(readArchivedJobs(active)).toEqual(jobs);
  expect(readdirSync(join(env.home, ".migration-snapshots"))).toHaveLength(1);
  const target = archiveJobs(active, jobs);
  expect(existsSync(target)).toBe(true);
  expect(readArchivedJobs(active)).toEqual(jobs);
});

it("rejects a linked archive directory without reading or modifying its target", () => {
  const target = join(env.home, "other-data"), archive = join(env.home, "archive"), active = join(env.home, "jobs.json");
  mkdirSync(target);
  writeFileSync(join(target, "jobs-1.json"), "owner content");
  symlinkSync(target, archive, process.platform === "win32" ? "junction" : "dir");
  expect(() => readArchivedJobs(active)).toThrow("physical");
  expect(() => archiveJobs(active, [{ id: "new" }])).toThrow("physical");
  expect(readFileSync(join(target, "jobs-1.json"), "utf8")).toBe("owner content");
  expect(readdirSync(target)).toEqual(["jobs-1.json"]);
});
