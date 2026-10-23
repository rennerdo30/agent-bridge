import { expect, it } from "vitest";
import { OwnedFixtureRpcs } from "./owned-fixture-rpcs.js";
it("owns delayed connection-close rejection from creation and retains the exact failure for caller and cleanup", async () => {
  const owned = new OwnedFixtureRpcs(); let reject!: (error: unknown) => void;
  const operation = owned.own(new Promise<void>((_, fail) => { reject = fail; }));
  const failure = new Error("fixture connection closed"); let settled = false;
  const cleanup = owned.settle().then(errors => { settled = true; return errors; });
  await Promise.resolve(); expect(settled).toBe(false); reject(failure);
  expect(await cleanup).toEqual([failure]); await expect(operation).rejects.toBe(failure);
  expect(await owned.settle()).toEqual([]);
});
