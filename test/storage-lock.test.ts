import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { maintenanceLock, storageLease } from "../src/core/storage-lock.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
const children: ChildProcess[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { for (const child of children.splice(0)) child.kill(); await env.cleanup(); });

/** A live process that started now, i.e. after any lease written earlier. */
async function liveChild(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  children.push(child);
  await new Promise(resolve => child.once("spawn", resolve));
  // Let the OS report a start time.
  await new Promise(resolve => setTimeout(resolve, 200));
  return child.pid!;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
  await new Promise(resolve => child.once("exit", resolve));
  return child.pid!;
}

it("AB-217: a maintenance lock left by a killed command is recovered once its owner is provably gone", async () => {
  const pid = await deadPid();
  writeFileSync(join(env.home, ".maintenance-lock"), JSON.stringify({ pid, nonce: "x", createdAt: Date.now() - 60_000 }));
  const release = storageLease(env.home);
  release();
  expect(existsSync(join(env.home, ".maintenance-lock"))).toBe(false);
  maintenanceLock(env.home)();
});

it("AB-217: a live owner's maintenance lock is never broken, and the error names the lock file", async () => {
  const pid = await liveChild();
  writeFileSync(join(env.home, ".maintenance-lock"), JSON.stringify({ pid, nonce: "x", createdAt: Date.now() }));
  expect(() => storageLease(env.home)).toThrow(/maintenance is in progress.*\.maintenance-lock/s);
  expect(() => maintenanceLock(env.home)).toThrow(/\.maintenance-lock/);
  expect(existsSync(join(env.home, ".maintenance-lock"))).toBe(true);
});

it("AB-217: a lock without owner identity (older version) is kept, with its path in the error", () => {
  writeFileSync(join(env.home, ".maintenance-lock"), "");
  expect(() => storageLease(env.home)).toThrow(/\.maintenance-lock/);
  expect(existsSync(join(env.home, ".maintenance-lock"))).toBe(true);
});

it("AB-217: the maintenance lock records its owner", () => {
  const release = maintenanceLock(env.home);
  try {
    const owner = JSON.parse(readFileSync(join(env.home, ".maintenance-lock"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(typeof owner.nonce).toBe("string");
  } finally { release(); }
  expect(existsSync(join(env.home, ".maintenance-lock"))).toBe(false);
});

it("AB-214: a storage lease whose PID now belongs to a newer process is stale and does not block maintenance", async () => {
  const pid = await liveChild();
  const dir = join(env.home, ".storage-users");
  mkdirSync(dir, { recursive: true });
  const lease = join(dir, `${pid}-00000000-0000-4000-8000-000000000000`);
  writeFileSync(lease, "");
  // The lease was written an hour before the process now holding this PID started.
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(lease, old, old);
  maintenanceLock(env.home)();
  expect(readdirSync(dir)).toEqual([]);
});

it("AB-214: a live process's lease still blocks maintenance and the error names the lease", async () => {
  const pid = await liveChild();
  const dir = join(env.home, ".storage-users");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}-00000000-0000-4000-8000-000000000001`), JSON.stringify({ pid, nonce: "n", createdAt: Date.now() }));
  expect(() => maintenanceLock(env.home)).toThrow(new RegExp(`storage is in use.*${pid}`, "s"));
  expect(readdirSync(dir)).toHaveLength(1);
});
