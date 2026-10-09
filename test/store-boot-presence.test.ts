import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { metadataDb } from "../src/core/metadata-db.js";
import { importMetadataDomain } from "../src/core/metadata-import.js";
import { liveStorePeers, writtenBeforeBoot } from "../src/core/store-compatibility.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

it("treats a presence written before this boot as dead, with a safety margin", () => {
  const now = 1_800_000_000_000, up = 3_600;
  const boot = now - up * 1000;
  expect(writtenBeforeBoot(boot - 120_000, now, up)).toBe(true);
  expect(writtenBeforeBoot(boot - 30_000, now, up)).toBe(false);
  expect(writtenBeforeBoot(boot + 1_000, now, up)).toBe(false);
  expect(writtenBeforeBoot(Number.NaN, now, up)).toBe(false);
  expect(writtenBeforeBoot(0, now, up)).toBe(false);
});

function legacyRecord(home: string, at?: number): string {
  const dir = join(home, "storage-capabilities");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, json: 4, sqlite: 8, pid: process.pid, name: "codex-job-legacy", version: "0.29.17", explicit: true }));
  if (at !== undefined) utimesSync(file, at / 1000, at / 1000);
  return file;
}
const beforeBoot = () => Date.now() - uptime() * 1000 - 3_600_000;

it("imports a presence row with its file's time, so a pre-boot legacy reader stays ignored (AB-256)", () => {
  legacyRecord(env.home, beforeBoot());
  importMetadataDomain(env.home, "storage-capabilities");
  const row = metadataDb(env.home).prepare("SELECT updated_at FROM bridge_metadata WHERE domain='storage-capabilities' AND key=?").get(String(process.pid));
  expect(Number(row!.updated_at)).toBeLessThan(Date.now() - uptime() * 1000);
  expect(liveStorePeers(env.home).map(peer => peer.pid)).not.toContain(process.pid);
});

it("repairs presence rows that an earlier import stamped with the import time, once (AB-256)", () => {
  legacyRecord(env.home, beforeBoot());
  importMetadataDomain(env.home, "storage-capabilities");
  const db = metadataDb(env.home);
  // Reproduce a 0.30.4 import: the row carries the import time while its retained original is from before the boot.
  const { imported_at: imported, cold_path: cold } = db.prepare("SELECT imported_at, cold_path FROM bridge_imports WHERE path=?").get(`storage-capabilities/${process.pid}.json`) as { imported_at: number; cold_path: string };
  db.prepare("UPDATE bridge_metadata SET updated_at=? WHERE domain='storage-capabilities' AND key=?").run(imported, String(process.pid));
  const old = beforeBoot();
  utimesSync(cold, old / 1000, old / 1000);
  expect(liveStorePeers(env.home).map(peer => peer.pid)).toContain(process.pid);
  importMetadataDomain(env.home, "storage-capabilities");
  expect(Math.abs(Number(db.prepare("SELECT updated_at FROM bridge_metadata WHERE domain='storage-capabilities' AND key=?").get(String(process.pid))!.updated_at) - old)).toBeLessThan(1_000);
  expect(liveStorePeers(env.home).map(peer => peer.pid)).not.toContain(process.pid);
  expect(readFileSync(cold, "utf8")).toContain("codex-job-legacy");
});

it("ignores a legacy reader record from before the boot even when its PID is alive again (AB-256)", () => {
  // The PID is live (this process); without an identity the record would block upgrades as an unknown reader.
  const dir = join(env.home, "storage-capabilities");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, json: 4, sqlite: 8, pid: process.pid, name: "codex-job-legacy", version: "0.29.17", explicit: true }));
  expect(liveStorePeers(env.home).map(peer => peer.pid)).toContain(process.pid);
  const beforeBoot = (Date.now() - uptime() * 1000 - 3_600_000) / 1000;
  utimesSync(file, beforeBoot, beforeBoot);
  expect(liveStorePeers(env.home).map(peer => peer.pid)).not.toContain(process.pid);
});
