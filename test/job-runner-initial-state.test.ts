import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

// AB-278, 2026-10-11: with ~120 Node processes the Windows identity batch query was slow or failed, and the fixed
// 15 s initial-publication deadline failed every new job runner before its native turn started.
const calls = vi.hoisted(() => ({ refreshes: 0, failRefreshes: 0, writes: 0 }));
vi.mock("../src/core/store-compatibility.js", async (original) => ({
  ...await original<typeof import("../src/core/store-compatibility.js")>(),
  refreshStorePeerIdentities: async () => { calls.refreshes++; if (calls.failRefreshes > 0) { calls.failRefreshes--; throw new Error("identity query timed out"); } },
}));
vi.mock("../src/mcp/job-host.js", async (original) => ({
  ...await original<typeof import("../src/mcp/job-host.js")>(),
  writeRunnerState: () => { calls.writes++; },
}));
const { INITIAL_STATE_DEADLINE_MS, publishInitialRunnerState } = await import("../src/mcp/job-runner.js");

let env: TestEnv;
beforeEach(() => { env = makeEnv(); calls.refreshes = 0; calls.failRefreshes = 0; calls.writes = 0; });
afterEach(async () => { await env.cleanup(); });
const spec = () => ({ home: env.home, job: { id: "a1b2c3d4", name: "codex-job-a1b2c3d4" } }) as Parameters<typeof publishInitialRunnerState>[0];

it("allows minutes of store admission instead of the old 15 s", () => {
  expect(INITIAL_STATE_DEADLINE_MS).toBeGreaterThanOrEqual(60_000);
});

it("retries failed identity queries and then publishes, without writing before identities are ready", async () => {
  calls.failRefreshes = 3;
  await publishInitialRunnerState(spec(), nullLogger, 10_000);
  expect(calls.refreshes).toBe(4);
  expect(calls.writes).toBe(1);
});

it("still fails closed at its deadline while identities never resolve", async () => {
  calls.failRefreshes = Number.POSITIVE_INFINITY;
  await expect(publishInitialRunnerState(spec(), nullLogger, 400)).rejects.toThrow();
  expect(calls.writes).toBe(0);
});