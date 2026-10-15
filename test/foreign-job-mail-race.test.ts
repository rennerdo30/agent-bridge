import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { makeEnv } from "./helpers.js";
import { markJobProjection, storeJobRecords, type ArchiveSelection } from "../src/core/job-archive-index.js";
const race = vi.hoisted(() => ({ publish: false }));
vi.mock("../src/core/job-archive.js", async original => {
  const actual = await original<typeof import("../src/core/job-archive.js")>();
  return { ...actual, readArchivedJobSnapshot: (path: string, selection: ArchiveSelection = {}) => {
    const before = actual.readArchivedJobSnapshot(path, selection);
    if (race.publish && selection.metadata) {
      // Force the worker's commit between the row read and the projection check.
      race.publish = false;
      const jobs = JSON.parse(readFileSync(path, "utf8")).jobs;
      storeJobRecords(path, jobs); markJobProjection(path, jobs);
    }
    return before;
  } };
});
it("refuses job mail when an index projection becomes current after an older metadata read", async () => {
  const env = makeEnv();
  try {
    const sender = env.node("foreign-main"); await sender.start();
    const broker = (sender as any).broker;
    await broker.jobArchiveBackground.close();
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ id: "foreign", name: "codex-job-foreign", owner: "another-main", status: "running", startedAt: 1 }] }));
    race.publish = true;
    const error = await sender.send({ to: "codex-job-foreign", body: "must not silently disappear" }).catch(error => error);
    expect(error.message).toContain("Ask its supervisor");
    expect(error.message).toContain("No message was stored");
    expect(broker.store.unread("codex-job-foreign", 10)).toHaveLength(0);
  } finally { race.publish = false; await env.cleanup(); }
});
