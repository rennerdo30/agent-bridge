import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { processIdentity } from "../src/core/process-identity.js";
import { assertStoreUpgrade } from "../src/core/store-compatibility.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let reader: ChildProcess;
beforeEach(() => {
  env = makeEnv();
  reader = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
});
afterEach(async () => {
  reader.kill();
  await new Promise(resolve => reader.exitCode !== null || reader.signalCode !== null ? resolve(undefined) : reader.once("exit", resolve));
  await env.cleanup();
});

function presence(identity: string, json: number): void {
  const dir = join(env.home, "storage-capabilities");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${reader.pid}.json`), JSON.stringify({ schemaVersion: 1, json, sqlite: 9, jobArchive: 1, pid: reader.pid, name: "codex-job-fresh", version: "0.30.7", explicit: true, processIdentity: identity }));
}

it("verifies a just-started reader directly instead of blocking a store write on a cold identity cache", async () => {
  let identity: string | undefined;
  await until(() => Boolean(identity = processIdentity(reader.pid!)), 15_000);
  presence(identity!, 4);
  // No identity refresh ran in this process: the reader is unverified, but its record matches the live process.
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).not.toThrow();
});

it("treats an unverified reader whose PID now belongs to another process as gone (PID reuse)", async () => {
  await until(() => Boolean(processIdentity(reader.pid!)), 15_000);
  // An old json-0 reader recorded under this PID; the live process has a different identity.
  presence("an-earlier-process", 0);
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).not.toThrow();
});

it("keeps blocking an unverified reader whose record carries no identity", async () => {
  await until(() => Boolean(processIdentity(reader.pid!)), 15_000);
  const dir = join(env.home, "storage-capabilities");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${reader.pid}.json`), JSON.stringify({ schemaVersion: 1, json: 0, sqlite: 8, pid: reader.pid, name: "legacy-reader", version: "0.29.17", explicit: true }));
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow("Waiting to upgrade json store 0→4");
});

it("keeps blocking a verified reader that cannot read the target format", async () => {
  let identity: string | undefined;
  await until(() => Boolean(identity = processIdentity(reader.pid!)), 15_000);
  presence(identity!, 3);
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow("Waiting to upgrade json store 0→4");
});
