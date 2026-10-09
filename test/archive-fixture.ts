import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { archiveJobs } from "../src/core/job-archive.js";

/** Explicit generated-fixture import. Product readers never discover legacy copies. */
export function indexFixtureFile(file: string): void {
  const value = JSON.parse(readFileSync(file, "utf8"));
  const jobs = Array.isArray(value) ? value : value.jobs;
  const home = basename(dirname(file)) === "archive" ? dirname(dirname(file)) : dirname(file);
  archiveJobs(join(home, "jobs.json"), jobs);
}
export function indexFixtureArchives(home: string): void {
  const dir = join(home, "archive");
  for (const name of readdirSync(dir).sort()) if (/^jobs-.*\.json$/.test(name) || /^jobs\.json[-.]/.test(name)) indexFixtureFile(join(dir, name));
}
