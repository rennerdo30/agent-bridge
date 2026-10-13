import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { packArchivedRuns, packFinishedRuns, packedRunRecords } from "../src/core/finished-run-bundles.js";
import { closeMetadataDbs, metadataDb } from "../src/core/metadata-db.js";
import { archiveOldRuns } from "../src/core/run-archive.js";
import { readRunLogs } from "../src/core/run-history.js";
import { HistoryIndex } from "../src/core/history.js";
import { historyDbPath, migrateHistoryStore, openHistoryStore } from "../src/core/history-store.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
const closes: (() => void)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const close of closes.splice(0).reverse()) close(); closeMetadataDbs(); await env.cleanup(); });

function archivedRun(name: string, text = "some output", meta: Record<string, unknown> = { job: `codex-job-${name.slice(-6)}` }): string {
  const archive = join(env.home, "runs", "archive");
  mkdirSync(archive, { recursive: true });
  const log = join(archive, `${name}.log`);
  writeFileSync(log, `09:00:00 started\n${text}\n09:00:05 finished after 5s · done`);
  writeFileSync(log.replace(/\.log$/, ".json"), JSON.stringify(meta));
  return log;
}

it("keeps a run listed when the finished-runs index write fails: nothing moves before the index commits (AB-227)", () => {
  const name = "2026-10-01-09-00-00-codex-job-crash01";
  const log = archivedRun(name);
  const db = metadataDb(env.home);
  db.exec("CREATE TRIGGER fail_index BEFORE INSERT ON bridge_metadata WHEN NEW.domain='finished-runs' BEGIN SELECT RAISE(ABORT,'simulated crash'); END");
  expect(() => packFinishedRuns(env.home, [log])).toThrow();
  db.exec("DROP TRIGGER fail_index");
  // Either still in place or packed and indexed; never moved and unlisted.
  expect(readRunLogs(env.home).map(r => r.name)).toContain(name);
  expect(existsSync(log)).toBe(true);
});

it("recovers runs that an earlier version moved to cold storage without an index row (AB-227)", () => {
  const name = "2026-10-01-09-00-00-codex-job-orphan1";
  const log = archivedRun(name, "orphaned output");
  packFinishedRuns(env.home, [log]);
  // The state a crash between move and index write left behind in 0.30.4 pre-releases.
  metadataDb(env.home).prepare("DELETE FROM bridge_metadata WHERE domain='finished-runs'").run();
  closeMetadataDbs();
  expect(readRunLogs(env.home).map(r => r.name)).not.toContain(name);
  packArchivedRuns(env.home);
  closeMetadataDbs();
  const [record] = packedRunRecords(env.home);
  expect(record).toMatchObject({ name, archived: true, meta: { job: "codex-job-rphan1" } });
  expect(readFileSync(record!.file, "utf8")).toContain("orphaned output");
  expect(readRunLogs(env.home).map(r => r.name)).toContain(name);
});

it("packs past a permanently failing run instead of retrying the same batch forever (AB-219)", () => {
  const bad = archivedRun("2026-10-01-08-00-00-codex-job-bad001");
  const good = ["2026-10-01-09-00-00-codex-job-good01", "2026-10-01-10-00-00-codex-job-good02", "2026-10-01-11-00-00-codex-job-good03"].map(name => archivedRun(name));
  // A prior import of the same path with different bytes makes this log unpackable.
  metadataDb(env.home).prepare("INSERT INTO bridge_imports VALUES (?,?,?,?,?,?)").run("runs/archive/2026-10-01-08-00-00-codex-job-bad001.log", "0".repeat(64), 1, "x", join(env.home, "cold", "x"), 1);
  for (let pass = 0; pass < 3; pass++) { try { packArchivedRuns(env.home, undefined, 2); } catch { /* the old batch threw */ } }
  closeMetadataDbs();
  expect(packedRunRecords(env.home).map(r => r.name).sort()).toEqual(good.map(log => log.split(/[\\/]/).at(-1)!.replace(/\.log$/, "")).sort());
  expect(existsSync(bad)).toBe(true);
  // The failure is recorded once, not silently swallowed.
  const failures = metadataDb(env.home).prepare("SELECT key FROM bridge_metadata WHERE domain='finished-run-pack-failures'").all();
  expect(failures.map(f => f.key)).toEqual(["runs/archive/2026-10-01-08-00-00-codex-job-bad001.log"]);
});

it("serves repeated packed-run reads from a cache without parsing every row per poll (AB-233, AB-245)", () => {
  const logs = Array.from({ length: 20 }, (_, i) => archivedRun(`2026-10-01-09-00-${String(i).padStart(2, "0")}-codex-job-poll${String(i).padStart(2, "0")}`));
  packFinishedRuns(env.home, logs);
  closeMetadataDbs();
  expect(packedRunRecords(env.home)).toHaveLength(20);
  const parse = vi.spyOn(JSON, "parse");
  for (let i = 0; i < 5; i++) expect(packedRunRecords(env.home)).toHaveLength(20);
  expect(parse).not.toHaveBeenCalled();
  // A filtered read touches only its own rows.
  expect(packedRunRecords(env.home, new Set(["2026-10-01-09-00-03-codex-job-poll03"])).map(r => r.name)).toEqual(["2026-10-01-09-00-03-codex-job-poll03"]);
  expect(parse.mock.calls.length).toBeLessThanOrEqual(1);
  // A newly packed run invalidates the cache.
  packFinishedRuns(env.home, [archivedRun("2026-10-02-09-00-00-codex-job-later1")]);
  closeMetadataDbs();
  expect(packedRunRecords(env.home)).toHaveLength(21);
});

it("keeps ordinary run archiving to its old contract: archived runs stay in runs/archive and bridge.db is not opened", () => {
  vi.stubEnv("AGENT_BRIDGE_ARCHIVE_AGE_MS", "10");
  const runs = join(env.home, "runs");
  mkdirSync(runs, { recursive: true });
  const name = "2026-10-01-09-00-00-codex-job-keep01";
  writeFileSync(join(runs, `${name}.log`), "09:00:00 started\n09:00:05 finished after 5s · done");
  utimesSync(join(runs, `${name}.log`), new Date(0), new Date(0));
  expect(archiveOldRuns(env.home)).toBe(1);
  expect(existsSync(join(runs, "archive", `${name}.log`))).toBe(true);
  expect(existsSync(join(env.home, "bridge.db"))).toBe(false);
});

it("keeps packed runs in history search, including after a reindex (AB-227)", async () => {
  const name = "2026-10-01-09-00-00-codex-job-search1";
  vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
  new MessageStore(env.db, nullLogger).close();
  packFinishedRuns(env.home, [archivedRun(name, "walnut packed needle", { job: "codex-job-search1", title: "packed walnut" })]);
  closeMetadataDbs();
  const history = openHistoryStore(historyDbPath(env.db)); closes.push(() => history.close());
  await migrateHistoryStore(env.db, history);
  const source = new DatabaseSync(env.db, { readOnly: true }); closes.push(() => source.close());
  const index = new HistoryIndex(history, env.home, { claude: join(env.home, "claude"), codex: join(env.home, "codex"), opencode: join(env.home, "opencode") }, source);
  closes.push(() => index.close());
  const drain = () => { for (let n = 0; n < 100; n++) { const r = index.tick(); if (!r.work && !r.discovering) return; } };
  drain();
  expect(index.search({ query: "needle" }).hits.map(h => h.run)).toContain(`${name}.log`);
  index.reset();
  drain();
  expect(index.search({ query: "needle" }).hits.map(h => h.run)).toContain(`${name}.log`);
});

it("packs archived runs in the broker's job archive worker and in doctor --archive, then releases bridge.db", async () => {
  const { JobArchiveBackground } = await import("../src/core/job-archive-background.js");
  const { runDoctor } = await import("../src/cli/doctor.js");
  const first = "2026-10-01-09-00-00-codex-job-worker";
  archivedRun(first);
  const background = new JobArchiveBackground(join(env.home, "jobs.json"), nullLogger);
  await background.close();
  expect(packedRunRecords(env.home).map(r => r.name)).toEqual([first]);
  const second = "2026-10-02-09-00-00-codex-job-doctor";
  archivedRun(second);
  expect(await runDoctor(["--archive", "--yes"], env.home, () => {}, async () => true)).toBe(0);
  expect(packedRunRecords(env.home).map(r => r.name).sort()).toEqual([first, second]);
  expect(existsSync(join(env.home, "runs", "archive", `${second}.log`))).toBe(false);
});
