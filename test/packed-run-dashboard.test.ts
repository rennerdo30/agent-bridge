import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listRuns } from "../src/core/dashboard-read.js";
import { packArchivedRuns, packedRunRecords } from "../src/core/finished-run-bundles.js";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import * as preview from "../src/core/run-log-preview.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); closeMetadataDbs(); await env.cleanup(); });

it("lists a packed run with its preview and reads its retained copy only once across refreshes", () => {
  const archive = join(env.home, "runs", "archive");
  mkdirSync(archive, { recursive: true });
  const name = "2026-10-01-09-00-00-codex-job-packedview";
  writeFileSync(join(archive, `${name}.log`), "09:00:00 codex\n         packed task\n         ---\nsome output\n09:00:05 finished after 5s · done\n");
  writeFileSync(join(archive, `${name}.json`), JSON.stringify({ job: "codex-job-packedview", title: "packed run" }));
  packArchivedRuns(env.home);
  const [packed] = packedRunRecords(env.home);
  // The stored signature names the original log; the record points at the retained copy.
  expect(packed).toMatchObject({ name, packed: true });

  const reads = vi.spyOn(preview, "readRunLogPreview");
  const first = listRuns(env.home).find(run => run.name === name);
  // Before the fix the signature check against the copy threw, so the run was missing here.
  expect(first).toMatchObject({ name, archived: true, hasLog: true, recovered: false, status: "done" });
  expect(reads.mock.calls.filter(([file]) => file === packed!.file)).toHaveLength(1);
  expect(reads.mock.calls[0]![1]).toBeUndefined();

  // An unchanged refresh serves the cached summary: the retained copy is not opened again.
  reads.mockClear();
  expect(listRuns(env.home).find(run => run.name === name)).toMatchObject({ name, hasLog: true });
  expect(reads).not.toHaveBeenCalled();
});
