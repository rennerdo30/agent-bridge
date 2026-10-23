import { afterEach, expect, it, vi } from "vitest";
import { AdmissionObservation, observeAdmissionPhase } from "../src/core/admission-observation.js";
afterEach(() => vi.restoreAllMocks());
it("keeps observation out of later turns and nested unrelated owners, retaining bounded inclusive spans", async () => {
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  const outer = new AdmissionObservation(), inner = new AdmissionObservation();
  const pending = outer.scope(async () => {
    observeAdmissionPhase("main-schema", () => {
      now = 10; inner.scope(() => observeAdmissionPhase("history", () => { now = 15; }));
    });
    await Promise.resolve();
    observeAdmissionPhase("archive", () => { now = 20; });
  });
  await pending;
  expect(outer.snapshot().phases).toEqual([{ phase: "main-schema", calls: 1, ms: 15, pending: 0 }]);
  expect(inner.snapshot().phases).toEqual([{ phase: "history", calls: 1, ms: 5, pending: 0 }]);
  outer.measure("identity", () => { now = 70_000; expect(outer.snapshot()).toMatchObject({ elapsedMs: 60_000, phases: expect.arrayContaining([{ phase: "identity", calls: 0, ms: 60_000, pending: 1 }]) }); });
  expect(outer.snapshot().phases).toContainEqual({ phase: "identity", calls: 1, ms: 60_000, pending: 0 });
});
it.each([-86_400_000, 86_400_000])("measures diagnostic work monotonically through a wall-clock step of %s", wallStep => {
  let monotonic = 10, wall = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  const observation = new AdmissionObservation();
  observation.measure("main-schema", () => { monotonic += 2315; wall += wallStep; });
  expect(observation.snapshot()).toEqual({ elapsedMs: 2315, phases: [{ phase: "main-schema", calls: 1, ms: 2315, pending: 0 }] });
});
