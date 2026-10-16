import * as feeds from "../src/core/job-recovery-feed.js";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeEnv, type TestEnv } from "./helpers.js";
import { recoverJobRecordAsync } from "../src/core/job-recovery.js";
const ioMocks = vi.hoisted(() => ({
  open: vi.fn(), stat: vi.fn(),
  original: undefined as typeof import("node:fs/promises").open | undefined,
  originalStat: undefined as typeof import("node:fs/promises").stat | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  ioMocks.original = actual.open; ioMocks.originalStat = actual.stat;
  return { ...actual, open: ioMocks.open, stat: ioMocks.stat };
});
let env: TestEnv;
beforeEach(() => {
  ioMocks.open.mockReset().mockImplementation(ioMocks.original!);
  ioMocks.stat.mockReset().mockImplementation(ioMocks.originalStat!);
  env = makeEnv(); vi.stubEnv("AGENT_BRIDGE_HISTORY_INGEST", "false"); vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
});
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); vi.unstubAllEnvs(); });
const failure = () => Object.assign(new Error("temporarily inaccessible"), { code: "EACCES" });

/** A JobManager-style label-only run: a header line and by/job metadata, no prompt section. */
function labelOnly(id: string, owner = "owner") {
  mkdirSync(join(env.home, "runs"), { recursive: true });
  const run = join(env.home, "runs", `2026-10-16-06-32-18-codex-${id}`), name = `codex-job-${id}`;
  writeFileSync(`${run}.log`, "06:32:18 codex\n");
  writeFileSync(`${run}.json`, JSON.stringify({ job: name, by: owner }));
  return { name, file: `${run}.log` };
}
const minimalRow = (id: string, owner = "owner") => ({ id, name: `codex-job-${id}`, agent: "codex", owner, status: "done", startedAt: 1 });
async function read(file: string) {
  const noPrompt = vi.fn();
  const value = await feeds.readRecoveryHeader(file, noPrompt);
  return { value, noPrompt: noPrompt.mock.calls.length > 0 };
}

it("reports a whole, unchanged separator-less read to its own caller only, and a separator read normally", async () => {
  const { file } = labelOnly("format");
  expect(await read(file)).toEqual({ value: undefined, noPrompt: true });
  // The public result is unchanged and nothing is cached: a caller without the callback just sees undefined.
  expect(await feeds.readRecoveryHeader(file)).toBeUndefined();
  appendFileSync(file, "         exact task\n         ---\n");
  expect(await read(file)).toEqual({ value: { header: "06:32:18 codex", prompt: "exact task" }, noPrompt: false });
});

it("never reports an IO failure or a failed upfront stat as a label-only log, even after an earlier one", async () => {
  const { file } = labelOnly("ioerror");
  expect((await read(file)).noPrompt).toBe(true);
  ioMocks.open.mockRejectedValueOnce(failure());
  expect(await read(file)).toEqual({ value: undefined, noPrompt: false });
  // An earlier label-only observation of the same, unchanged version does not stand in for this failed stat.
  ioMocks.stat.mockRejectedValueOnce(failure());
  expect(await read(file)).toEqual({ value: undefined, noPrompt: false });
});

it("binds the outcome to each overlapping call: a joined read shares it, a caller whose own stat failed does not", async () => {
  const { file } = labelOnly("overlap");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  ioMocks.open.mockImplementationOnce(async (...args: Parameters<typeof import("node:fs/promises").open>) => { await held; return ioMocks.original!(...args); });
  const first = read(file);
  await vi.waitFor(() => expect(ioMocks.open).toHaveBeenCalledTimes(1));
  const joined = read(file);
  ioMocks.stat.mockRejectedValueOnce(failure());
  const failed = read(file);
  release();
  expect(await first).toEqual({ value: undefined, noPrompt: true });
  expect(await joined).toEqual({ value: undefined, noPrompt: true });
  expect(await failed).toEqual({ value: undefined, noPrompt: false });
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

it("keeps a failed header read of a minimal job a named refusal, also after an earlier label-only lookup", async () => {
  const { name } = labelOnly("minimalio");
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [minimalRow("minimalio")] }));
  const first = vi.fn();
  expect(await recoverJobRecordAsync(env.home, name, { onUnavailable: first })).toBeUndefined();
  expect(first).toHaveBeenCalledExactlyOnceWith({ reason: "recovery_context_unavailable", stage: "header_format" });
  // The stat fault first: directly after the label-only lookup, nothing else has touched this file.
  for (const fault of ["stat", "open"] as const) {
    if (fault === "open") ioMocks.open.mockRejectedValueOnce(failure());
    // The recovery's own stats run before the header read; fail the header read's stat (the last stat of this file).
    else ioMocks.stat.mockImplementation(async (...args: Parameters<typeof import("node:fs/promises").stat>) => {
      if (String(args[0]).endsWith("minimalio.log")) { ioMocks.stat.mockImplementation(ioMocks.originalStat!); throw failure(); }
      return ioMocks.originalStat!(...args);
    });
    const observer = vi.fn();
    expect(await recoverJobRecordAsync(env.home, name, { onUnavailable: observer })).toBeUndefined();
    expect(observer).toHaveBeenCalledExactlyOnceWith({ reason: "recovery_header_unavailable", stage: "header_read" });
  }
});
