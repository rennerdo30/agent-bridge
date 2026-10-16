import * as feeds from "../src/core/job-recovery-feed.js";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeEnv, type TestEnv } from "./helpers.js";
import { recoverJobRecordAsync } from "../src/core/job-recovery.js";
const ioMocks = vi.hoisted(() => ({ open: vi.fn(), original: undefined as typeof import("node:fs/promises").open | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  ioMocks.original = actual.open;
  return { ...actual, open: ioMocks.open };
});
let env: TestEnv;
beforeEach(() => { ioMocks.open.mockReset().mockImplementation(ioMocks.original!); env = makeEnv(); vi.stubEnv("AGENT_BRIDGE_HISTORY_INGEST", "false"); vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0"); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); vi.unstubAllEnvs(); });

/** A JobManager-style label-only run: a header line and by/job metadata, no prompt section, no native session. */
function labelOnly(id: string, owner = "owner") {
  mkdirSync(join(env.home, "runs"), { recursive: true });
  const run = join(env.home, "runs", `2026-10-16-06-32-18-codex-${id}`), name = `codex-job-${id}`;
  writeFileSync(`${run}.log`, "06:32:18 codex\n");
  writeFileSync(`${run}.json`, JSON.stringify({ job: name, by: owner }));
  return { name, file: `${run}.log` };
}
const minimalRow = (id: string, owner = "owner") => ({ id, name: `codex-job-${id}`, agent: "codex", owner, status: "done", startedAt: 1 });

it("records a stable separator-less log as having no prompt section, and forgets it once the separator appears", async () => {
  const { file } = labelOnly("format");
  expect(await feeds.readRecoveryHeader(file)).toBeUndefined();
  expect(await feeds.recoveryHeaderLacksSeparator(file)).toBe(true);
  appendFileSync(file, "         exact task\n         ---\n");
  // The recorded file version changed: no longer a known label-only log.
  expect(await feeds.recoveryHeaderLacksSeparator(file)).toBe(false);
  expect((await feeds.readRecoveryHeader(file))?.prompt).toBe("exact task");
  expect(await feeds.recoveryHeaderLacksSeparator(file)).toBe(false);
});

it("never treats an IO failure or a later change as a label-only log", async () => {
  const { file } = labelOnly("ioerror");
  ioMocks.open.mockRejectedValueOnce(Object.assign(new Error("temporarily inaccessible"), { code: "EACCES" }));
  expect(await feeds.readRecoveryHeader(file)).toBeUndefined();
  expect(await feeds.recoveryHeaderLacksSeparator(file)).toBe(false);
  expect(await feeds.readRecoveryHeader(file)).toBeUndefined();
  expect(await feeds.recoveryHeaderLacksSeparator(file)).toBe(true);
  // Appended bytes without a separator: a new version that has not been read, so it is not known to lack one.
  appendFileSync(file, "         still writing\n");
  expect(await feeds.recoveryHeaderLacksSeparator(file)).toBe(false);
  // A failed read clears an earlier record for the same file.
  ioMocks.open.mockRejectedValueOnce(Object.assign(new Error("temporarily inaccessible"), { code: "EACCES" }));
  expect(await feeds.readRecoveryHeader(file)).toBeUndefined();
  expect(await feeds.recoveryHeaderLacksSeparator(file)).toBe(false);
});

for (const [shape, wrap] of [["versioned", (jobs: unknown[]) => ({ version: 4, jobs })], ["array", (jobs: unknown[]) => jobs]] as const) {
  it(`returns null for a minimal ${shape} history row with a label-only log, with a header_format reason`, async () => {
    const { name } = labelOnly(`minimal${shape}`);
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify(wrap([minimalRow(`minimal${shape}`)])));
    const observer = vi.fn();
    expect(await recoverJobRecordAsync(env.home, name, { onUnavailable: observer })).toBeUndefined();
    expect(observer).toHaveBeenCalledExactlyOnceWith({ reason: "recovery_context_unavailable", stage: "header_format" });
    // At the broker that is the pre-AB-439 null, not a named refusal.
    const owner = env.node("owner", "codex"); await owner.start();
    expect(await owner.jobAuthority(name)).toBeNull();
  });
}

it("treats a separator-less log as having no prompt even when its metadata names a native session", async () => {
  // As the original dashboard owner-chat routes require: a live local job keeps resolving through its manager.
  const { name, file } = labelOnly("minimalnative");
  writeFileSync(file.replace(/\.log$/, ".json"), JSON.stringify({ job: name, by: "owner", session: "native" }));
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [minimalRow("minimalnative")] }));
  const observer = vi.fn();
  expect(await recoverJobRecordAsync(env.home, name, { onUnavailable: observer })).toBeUndefined();
  expect(observer).toHaveBeenCalledExactlyOnceWith({ reason: "recovery_context_unavailable", stage: "header_format" });
});

it("keeps a failed header read of the same minimal job a named refusal", async () => {
  const { name } = labelOnly("minimalio");
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [minimalRow("minimalio")] }));
  ioMocks.open.mockRejectedValueOnce(Object.assign(new Error("temporarily inaccessible"), { code: "EACCES" }));
  const observer = vi.fn();
  expect(await recoverJobRecordAsync(env.home, name, { onUnavailable: observer })).toBeUndefined();
  expect(observer).toHaveBeenCalledExactlyOnceWith({ reason: "recovery_header_unavailable", stage: "header_read" });
});
