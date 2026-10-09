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

it("keeps blocking an unverified reader whose recorded identity does not match the live process", async () => {
  await until(() => Boolean(processIdentity(reader.pid!)), 15_000);
  presence("not-this-process", 4);
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow("Waiting to upgrade json store 0→4");
});

it("keeps blocking a verified reader that cannot read the target format", async () => {
  let identity: string | undefined;
  await until(() => Boolean(identity = processIdentity(reader.pid!)), 15_000);
  presence(identity!, 3);
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow("Waiting to upgrade json store 0→4");
});
