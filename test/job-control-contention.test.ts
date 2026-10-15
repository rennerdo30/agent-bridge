import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { JobManager, readStore } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";

let home: string, jobs: JobManager, child: ChildProcess | undefined;
const answer = { text: "retained answer", sessionId: "native-session", isError: false, details: {} };

beforeEach(async () => {
  home = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "job-control-contention-"));
  const node = new LocalCoordinator("owner", "owner-session");
  jobs = new JobManager(node, nullLogger, join(home, "jobs.json"), 2);
  const bundle = await build({ entryPoints: ["src/core/metadata-file-lease.ts"], bundle: true, platform: "node", format: "esm", packages: "external", write: false });
  writeFileSync(join(home, "lease.mjs"), bundle.outputFiles[0]!.contents);
  // A separate process can release its lease while the caller's bounded wait runs.
  writeFileSync(join(home, "writer.mjs"), 'import { metadataFileLease } from "./lease.mjs"; const release = metadataFileLease(process.argv[2]); process.on("message", () => setTimeout(() => { release(); process.disconnect(); }, 200)); process.send({ ready: true });\n');
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, "exit");
    child.kill("SIGKILL");
    await stopped;
  }
  child = undefined;
  jobs.setDormant(true); jobs.cancelAll();
});

async function briefWriter(path: string): Promise<void> {
  child = spawn(process.execPath, [join(home, "writer.mjs"), path], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const proc = child;
  await new Promise<void>((resolve, reject) => {
    proc.once("message", () => resolve());
    proc.once("error", reject);
    proc.once("exit", code => reject(new Error(`writer exited before acquiring its lease: ${code}`)));
  });
  proc.send({ release: true });
}

it.each(["transition", "claim"])("continues once after brief %s lease contention, retaining every queued message", async lock => {
  const calls: string[] = [];
  const job = jobs.start("codex", null, "initial context", async () => answer, body => {
    calls.push(body); return async () => answer;
  });
  await expect.poll(() => job.status).toBe("done");
  const path = lock === "claim" ? join(home, "jobs.json.lock") : join(home, "job-controls", `${createHash("sha256").update(job.id).digest("hex")}.lock`);
  await briefWriter(path);
  expect(jobs.followUp(job.name, "accepted continuation").outcome).toBe("started");
  await expect.poll(() => job.status).toBe("done");
  expect(calls).toEqual(["accepted continuation"]);
  expect(readStore(join(home, "jobs.json"))[0]).toMatchObject({ status: "done", sessionId: "native-session", queuedMessages: [] });
});

it("records cancellation after brief store contention before aborting the original turn", async () => {
  const job = jobs.start("codex", null, "retained original context", () => new Promise(() => {}));
  jobs.note(job, { sessionId: "native-session" });
  await briefWriter(join(home, "jobs.json.lock"));
  expect(jobs.cancel(job.name)).toBe(true);
  expect(job.controller.signal.aborted).toBe(true);
  expect(readStore(join(home, "jobs.json"))[0]).toMatchObject({ prompt: "retained original context", sessionId: "native-session", cancellingTurn: job.startedAt });
});
