import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { packArchivedRuns, packedRunRecords } from "../src/core/finished-run-bundles.js";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import { archiveOldRuns } from "../src/core/run-archive.js";
import { readRunLogs, readRunStarts } from "../src/core/run-history.js";
import { readRetainedMetadataFile } from "../src/core/metadata-import.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { closeMetadataDbs(); await env.cleanup(); });

it("packs archived finished runs out of the scanned folders and keeps them listed and readable (AB-208)", async () => {
  const archive = join(env.home, "runs", "archive");
  mkdirSync(archive, { recursive: true });
  const name = "2026-10-01-09-00-00-codex-job-packed01";
  const log = `09:00:00 started\nsome output\n09:00:05 finished after 5s · done`;
  writeFileSync(join(archive, `${name}.log`), log);
  writeFileSync(join(archive, `${name}.json`), JSON.stringify({ job: "codex-job-packed01", title: "packed run" }));
  // An active, unfinished run stays where it is.
  writeFileSync(join(env.home, "runs", "2026-10-09-09-00-00-codex-job-active01.log"), "09:00:00 started\nstill going");
  archiveOldRuns(env.home);
  // Ordinary archiving keeps archived runs in place; packing is maintenance (broker worker, doctor --archive).
  expect(existsSync(join(archive, `${name}.log`))).toBe(true);
  packArchivedRuns(env.home);
  expect(existsSync(join(archive, `${name}.log`))).toBe(false);
  const [packed] = packedRunRecords(env.home);
  expect(packed).toMatchObject({ name, archived: true, meta: { job: "codex-job-packed01" } });
  expect(packed!.file.startsWith(join(env.home, "cold"))).toBe(true);
  expect(readFileSync(packed!.file, "utf8")).toBe(log);
  expect(readRetainedMetadataFile(env.home, `runs/archive/${name}.log`)!.toString("utf8")).toBe(log);
  const runs = readRunLogs(env.home);
  expect(runs.map(r => r.name).sort()).toEqual(["2026-10-09-09-00-00-codex-job-active01", name].sort());
  expect(runs.find(r => r.name === name)!.meta).toMatchObject({ title: "packed run" });
  expect((await readRunStarts(env.home)).map(s => s.job)).toContain("codex-job-packed01");
  expect(existsSync(join(env.home, "runs", "2026-10-09-09-00-00-codex-job-active01.log"))).toBe(true);
});
