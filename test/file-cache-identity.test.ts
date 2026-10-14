import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { makeEnv } from "./helpers.js";
import { fileSignature, readJsonSnapshot } from "../src/core/file-cache.js";
import { indexedJobProjectionCurrent, markJobProjection, openJobArchive, readIndexedJobs, storeJobRecords } from "../src/core/job-archive-index.js";

const collision = vi.hoisted(() => ({ file: "", ino: 144115188078880085n }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, statSync: (...args: Parameters<typeof fs.statSync>) => {
    const stat = fs.statSync(...args);
    if (stat && String(args[0]) === collision.file) Object.assign(stat, { ino: typeof stat.ino === "bigint" ? collision.ino : Number(collision.ino) });
    return stat;
  } };
});

it("distinguishes the observed NTFS IDs even when numeric fingerprints collide", async () => {
  const env = makeEnv();
  try {
    const file = collision.file = join(env.home, "scanned.json");
    const oldId = 144115188078880085n, newId = 144115188078880098n;
    expect(Number(oldId)).toBe(Number(newId));
    writeFileSync(file, '{"retained":"old"}');
    collision.ino = oldId;
    const old = statSync(file, { bigint: true });
    expect(readJsonSnapshot(file, { file, stat: old }).value).toEqual({ retained: "old" });
    writeFileSync(file, '{"retained":"new"}'); collision.ino = newId;
    // Equal timestamps/size reproduce the real collision without depending on allocation timing.
    const next = Object.assign(statSync(file, { bigint: true }), { birthtimeMs: old.birthtimeMs, birthtimeNs: old.birthtimeNs,
      ctimeMs: old.ctimeMs, ctimeNs: old.ctimeNs, mtimeMs: old.mtimeMs, mtimeNs: old.mtimeNs });
    expect(fileSignature(next)).not.toBe(fileSignature(old));
    expect(() => readJsonSnapshot(file, { file, stat: old })).toThrow("identity changed");
    expect(() => fileSignature({ ...old, ino: Number(oldId) })).toThrow("unverifiable");
    expect(() => readJsonSnapshot(file, { file, stat: statSync(file) })).toThrow("unverifiable");
    expect(readJsonSnapshot(file, { file, stat: statSync(file, { bigint: true }) }).value).toEqual({ retained: "new" });
    expect(readFileSync(file, "utf8")).toBe('{"retained":"new"}');
  } finally { collision.file = ""; await env.cleanup(); }
});

it("treats a stored unversioned projection fingerprint as unknown without altering retained data", async () => {
  const env = makeEnv();
  try {
    const file = join(env.home, "jobs.json"), jobs = [{ id: "retained", name: "codex-job-retained", prompt: "all original bytes" }];
    writeFileSync(file, JSON.stringify({ version: 4, jobs })); storeJobRecords(file, jobs); markJobProjection(file, jobs);
    const before = readFileSync(file), stat = statSync(file), legacy = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
    const db = openJobArchive(file, true)!;
    try { db.prepare("UPDATE archive_projection SET signature=? WHERE version=1").run(legacy); }
    finally { db.close(); }
    expect(indexedJobProjectionCurrent(file)).toBe(false);
    expect(readJsonSnapshot(file).value).toEqual({ version: 4, jobs });
    expect(readIndexedJobs(file).jobs).toEqual(jobs);
    expect(readFileSync(file)).toEqual(before);
    const inspect = openJobArchive(file)!;
    try { expect(inspect.prepare("SELECT signature FROM archive_projection WHERE version=1").get()?.signature).toBe(legacy); }
    finally { inspect.close(); }
  } finally { await env.cleanup(); }
});
