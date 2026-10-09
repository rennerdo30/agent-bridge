import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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
