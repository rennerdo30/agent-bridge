import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { migrateJobOwnership } from "../src/core/job-handoff.js";
import { JSON_STORE_VERSION, writeJsonStore } from "../src/core/json-store.js";
import { canonicalProjectRoot } from "../src/core/project-identity.js";
import { ProjectGroups } from "../src/core/project-groups.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

it("upgrades real 0.29.10 jobs additively with one backup and stable original project identity", () => {
  const old = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "handoff", "jobs-0.29.10.json"), "utf8"));
  const project = join(env.home, "original-project"); mkdirSync(project);
  old.jobs[0].workdir = project;
  old.jobs[0].ownershipHistory = [{ from: "old-master", to: "parent-folder-master", fromRootName: "old-master", rootName: "parent-folder-master" }];
  old.jobs[0].masters = ["old-master", "parent-folder-master"];
  old.jobs[0].deliveries = [{ id: "pending-result", body: "Keep this evidence", consumed: false }];
  const path = join(env.home, "jobs.json"), bytes = JSON.stringify(old);
  writeFileSync(path, bytes);
  const next = migrateJobOwnership(old);
  writeJsonStore(path, next, old);
  expect(next.version).toBe(JSON_STORE_VERSION);
  expect(next.jobs).toHaveLength(old.jobs.length);
  for (const [index, record] of old.jobs.entries()) expect((next.jobs as unknown[])[index]).toMatchObject(record);
  const first = (next.jobs as Record<string, unknown>[])[0]!;
  expect(first.projectRoot).toBe(canonicalProjectRoot(project));
  expect(new ProjectGroups(env.home).jobRoot({ ...first, owner: "parent-folder-master", rootName: "parent-folder-master" }, [])).toBe(canonicalProjectRoot(project));
  const backups = readdirSync(env.home).filter((f) => f.startsWith("jobs.json.backup-"));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(env.home, backups[0]!), "utf8")).toBe(bytes);
  expect(migrateJobOwnership(next)).toEqual(next);
  writeJsonStore(path, migrateJobOwnership(next), next);
  expect(readdirSync(env.home).filter((f) => f.startsWith("jobs.json.backup-"))).toEqual(backups);
});
