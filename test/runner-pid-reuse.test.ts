import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { pidAlive } from "../src/core/delegate.js";
import { processIdentity } from "../src/core/process-identity.js";
import { JobRunners, readRunnerState, writeRunnerState } from "../src/mcp/job-host.js";

// AB-236: a runner state whose PID now belongs to an unrelated process must not look alive or be killed.
let home: string, child: ChildProcess;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ab-runner-reuse-"));
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  await new Promise((r) => child.once("spawn", r));
});
afterEach(() => { child.kill(); rmSync(home, { recursive: true, force: true }); });

const runners = () => new JobRunners({} as never, home, "cli.mjs", nullLogger);
const job = (id: string) => ({ id, name: `codex-job-${id}`, host: null }) as never;

it("does not treat or kill a reused runner PID with a different identity", async () => {
  writeRunnerState(home, "aaaa1111", { pid: child.pid!, peer: "codex-job-aaaa1111", status: "running", updatedAt: Date.now(), identity: "another-process" });
  const host = runners();
  expect(host.alive(job("aaaa1111"), readRunnerState(home, "aaaa1111"))).toBe(false);
  host.kill(job("aaaa1111"));
  await new Promise((r) => setTimeout(r, 300));
  expect(pidAlive(child.pid!)).toBe(true);
});

it("does not treat an identity-less runner state as alive when its PID's process started after the last heartbeat", () => {
  writeRunnerState(home, "bbbb2222", { pid: child.pid!, peer: "codex-job-bbbb2222", status: "running", updatedAt: Date.now() - 3_600_000, identity: undefined });
  expect(runners().alive(job("bbbb2222"), { ...readRunnerState(home, "bbbb2222")!, identity: undefined })).toBe(false);
});

it("still sees a live runner whose identity matches", () => {
  writeRunnerState(home, "cccc3333", { pid: child.pid!, peer: "codex-job-cccc3333", status: "running", updatedAt: Date.now(), identity: processIdentity(child.pid!) });
  expect(runners().alive(job("cccc3333"), readRunnerState(home, "cccc3333"))).toBe(true);
});
