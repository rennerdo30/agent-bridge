import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readWorktreeState, saveWorktreeStateWithRetry, type WorktreeState } from "../src/core/worktree-state.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const mocks = vi.hoisted(() => ({ failuresLeft: 0, checks: 0, refreshes: 0, nonDeferred: false }));
vi.mock("../src/core/store-compatibility.js", async original => {
  const actual = await original<typeof import("../src/core/store-compatibility.js")>();
  const deferred = () => Object.assign(
    new Error("Waiting to upgrade json store 0→4: claude-unity-upgrade (vunknown, pid 35096, reads 0). Existing sessions keep their code and data; retry when these readers finish naturally."),
    { code: "STORE_UPGRADE_DEFERRED" },
  );
  return {
    ...actual,
    assertStoreUpgrade: (...args: Parameters<typeof actual.assertStoreUpgrade>) => {
      mocks.checks++;
      if (mocks.nonDeferred) throw Object.assign(new Error("disk failed"), { code: "EIO" });
      if (mocks.failuresLeft > 0) { mocks.failuresLeft--; throw deferred(); }
      return actual.assertStoreUpgrade(...args);
    },
    refreshStorePeerIdentities: async (...args: Parameters<typeof actual.refreshStorePeerIdentities>) => {
      mocks.refreshes++;
      return actual.refreshStorePeerIdentities(...args);
    },
  };
});

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
  mocks.failuresLeft = 0; mocks.checks = 0; mocks.refreshes = 0; mocks.nonDeferred = false;
});
afterEach(async () => { await env.cleanup(); });

function wt(path: string) {
  return { path, cwd: path, repoRoot: env.home, base: "base", branch: "" };
}

function value(path: string): WorktreeState {
  return { contractVersion: 1, path, repoRoot: env.home, base: "base", rootId: "test-root", libraries: [], lastContinuation: Date.now(), processesStopped: false };
}

it("retries a briefly unverifiable reader then succeeds, so the turn-time write does not fail the job", async () => {
  const path = join(env.home, "wt");
  mocks.failuresLeft = 2;

  // The job-runner turn catches a throw as a failed job; success here means the job is not failed.
  let status: "done" | "failed" = "done";
  try {
    await saveWorktreeStateWithRetry(env.home, wt(path), value(path), { deadlineMs: 5_000 });
  } catch {
    status = "failed";
  }
  expect(status).toBe("done");
  expect(mocks.checks).toBeGreaterThanOrEqual(3);
  expect(mocks.refreshes).toBeGreaterThanOrEqual(2);
  expect(readWorktreeState(env.home, wt(path))!).toMatchObject({ path, rootId: "test-root" });
});

it("fails with the same blocker message after the injectable deadline when readers stay deferred", async () => {
  const path = join(env.home, "wt");
  mocks.failuresLeft = 1_000;

  await expect(saveWorktreeStateWithRetry(env.home, wt(path), value(path), { deadlineMs: 300 }))
    .rejects.toMatchObject({ code: "STORE_UPGRADE_DEFERRED", message: expect.stringContaining("Waiting to upgrade json store 0→4") });
  expect(mocks.refreshes).toBeGreaterThanOrEqual(1);
});

it("propagates a non-deferred write failure without retry", async () => {
  const path = join(env.home, "wt");
  mocks.nonDeferred = true;

  await expect(saveWorktreeStateWithRetry(env.home, wt(path), value(path), { deadlineMs: 5_000 }))
    .rejects.toMatchObject({ code: "EIO" });
  expect(mocks.checks).toBe(1);
  expect(mocks.refreshes).toBe(0);
});
