import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrationLock } from "../src/core/migration-lock.js";
import { processIdentity } from "../src/core/process-identity.js";
import { ResourceSlots, SLOT_LEASE_MS } from "../src/core/resource-slots.js";
import { DatabaseSync } from "node:sqlite";

// AB-218: a dead owner's PID reused by an unrelated process must not look alive.
let dir: string, child: ChildProcess;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ab-pidreuse-"));
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  await new Promise((r) => child.once("spawn", r));
});
afterEach(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });

const hourAgo = (path: string) => { const t = new Date(Date.now() - 3_600_000); utimesSync(path, t, t); };

describe("resource slot owner liveness", () => {
  it("frees a slot whose owner PID was reused by a process started after the slot was last renewed", () => {
    const slots = new ResourceSlots(dir);
    slots.close();
    const db = new DatabaseSync(join(dir, "resource-slots.sqlite"));
    try {
      // Last renewed an hour ago (expiresAt = renewal + lease); the PID now belongs to a fresh process.
      db.prepare("INSERT INTO slots(resource, id, pid, held, expiresAt) VALUES ('gpu', 'dead-job', ?, 1, ?)").run(child.pid!, Date.now() - 3_600_000 + SLOT_LEASE_MS);
    } finally { db.close(); }
    const again = new ResourceSlots(dir);
    try { expect(again.list()).toEqual([]); } finally { again.close(); }
  });

  it("keeps a slot whose live owner matches, and records the owner's identity", () => {
    const slots = new ResourceSlots(dir);
    try {
      expect(slots.tryAcquire("gpu", 1, { id: "live-job", pid: child.pid! })).toBe(true);
      expect(slots.list().map((s) => s.id)).toEqual(["live-job"]);
    } finally { slots.close(); }
    const db = new DatabaseSync(join(dir, "resource-slots.sqlite"));
    try {
      expect(db.prepare("SELECT identity FROM slots").get()!.identity).toBe(processIdentity(child.pid!));
      db.exec("UPDATE slots SET identity = 'another-process'");
    } finally { db.close(); }
    const again = new ResourceSlots(dir);
    try { expect(again.list()).toEqual([]); } finally { again.close(); }
  });
});

describe("migration lock owner liveness", () => {
  it("recovers an older lock whose PID now belongs to a process started after the lock was written", () => {
    const file = join(dir, "history.db"), lock = `${file}.migration-lock`;
    writeFileSync(lock, JSON.stringify({ pid: child.pid, nonce: "stale" }));
    hourAgo(lock);
    const release = migrationLock(file);
    expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
    release();
    expect(existsSync(lock)).toBe(false);
  });

  it("recovers a lock whose recorded identity no longer matches the live PID", () => {
    const file = join(dir, "jobs.db"), lock = `${file}.migration-lock`;
    writeFileSync(lock, JSON.stringify({ pid: child.pid, nonce: "stale", identity: "not-the-same-process" }));
    migrationLock(file)();
  });

  it("keeps waiting for a live owner whose identity matches", () => {
    const file = join(dir, "live.db"), lock = `${file}.migration-lock`;
    const identity = processIdentity(child.pid!);
    expect(identity).toBeTruthy();
    writeFileSync(lock, JSON.stringify({ pid: child.pid, nonce: "live", identity }));
    hourAgo(lock);
    expect(() => migrationLock(file)).toThrow(/another session is migrating/);
    expect(existsSync(lock)).toBe(true);
  }, 30_000);
});
