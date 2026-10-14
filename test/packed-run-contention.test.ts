import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDashboard } from "../src/core/dashboard-read.js";
import { packedRunRecords, RECHECK_MS } from "../src/core/finished-run-bundles.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

function fixtureDatabase(): DatabaseSync {
  const db = new DatabaseSync(env.db);
  try {
    // Schema initialization starts in rollback-journal mode before configuring WAL.
    db.exec("CREATE TABLE bridge_metadata (domain TEXT, key TEXT, value TEXT, updated_at INTEGER)");
    db.prepare("INSERT INTO bridge_metadata VALUES ('finished-runs',?,?,1)").run("retained-run", JSON.stringify({
      name: "retained-run", file: join(env.home, "cold", "retained-run.log"), updatedAt: 1,
      size: 42, signature: "retained-signature", archived: true, meta: { future: { keep: true } },
    }));
    return db;
  } catch (error) { db.close(); throw error; }
}

it("defers a cold packed-run read during initialization and recovers retained rows after commit", () => {
  const writer = fixtureDatabase();
  try {
    writer.exec("BEGIN EXCLUSIVE");
    expect(packedRunRecords(env.home)).toEqual([]);
    writer.exec("COMMIT");
    const records = packedRunRecords(env.home);
    expect(records).toMatchObject([{ name: "retained-run", archived: true, meta: { future: { keep: true } } }]);
    expect(packedRunRecords(env.home, new Set(["retained-run"]))).toEqual(records);
    expect(writer.prepare("SELECT count(*) n FROM bridge_metadata").get()!.n).toBe(1);
  } finally { writer.close(); }
});

it("keeps physical run listings available while the cold packed-run database is busy", async () => {
  const writer = fixtureDatabase(), runs = join(env.home, "runs");
  try {
    mkdirSync(runs);
    writeFileSync(join(runs, "2026-10-13-00-00-00-codex-abcd.log"), "00:00:00 codex\n00:00:01 finished after 1s · done\n");
    writer.exec("BEGIN EXCLUSIVE");
    const result = await readDashboard({ home: env.home, log: nullLogger, peers: () => [] }, { path: "/api/runs" });
    expect(result.status).toBe(200);
    expect((result.body as { runs: { name: string }[] }).runs.map(run => run.name)).toEqual(["2026-10-13-00-00-00-codex-abcd"]);
    writer.exec("COMMIT");
    expect(packedRunRecords(env.home)).toHaveLength(1);
  } finally { writer.close(); }
});

it("serves an unchanged warm cache during contention and keeps cold non-busy errors visible", () => {
  const writer = fixtureDatabase();
  try {
    const saved = packedRunRecords(env.home);
    writer.prepare("INSERT INTO bridge_metadata VALUES ('finished-runs-revision','revision','2',2)").run();
    const now = Date.now() + RECHECK_MS;
    vi.spyOn(Date, "now").mockReturnValue(now);
    writer.exec("BEGIN EXCLUSIVE");
    expect(packedRunRecords(env.home)).toEqual(saved);
    writer.exec("COMMIT");
    vi.restoreAllMocks();
  } finally { writer.close(); }
  const damaged = join(env.home, "damaged"); mkdirSync(damaged);
  writeFileSync(join(damaged, "bridge.db"), "retained invalid fixture bytes");
  expect(() => packedRunRecords(damaged)).toThrow(/not a database/);
});
