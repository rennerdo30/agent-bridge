import { afterEach, describe, expect, it } from "vitest";
import { compareVersions, shouldYieldTo, watchParent } from "../src/mcp/server-lifecycle.js";

const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("AB-385 server version yield", () => {
  it("orders release versions numerically and pre-releases before their release", () => {
    expect(compareVersions("0.30.21", "0.30.17")).toBe(1);
    expect(compareVersions("0.30.9", "0.30.10")).toBe(-1);
    expect(compareVersions("0.30.21", "0.30.21")).toBe(0);
    expect(compareVersions("0.31.0-rc.1", "0.31.0")).toBe(-1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("not-a-version", "0.30.21")).toBeNull();
  });

  it("yields only to a strictly newer, known version", () => {
    expect(shouldYieldTo("0.30.21", "0.30.17")).toBe(true);
    expect(shouldYieldTo("0.30.21", "0.30.21")).toBe(false);
    expect(shouldYieldTo("0.30.17", "0.30.21")).toBe(false);
    // An older broker does not report the replacing server's version: keep the reclaim path.
    expect(shouldYieldTo(undefined, "0.30.17")).toBe(false);
    expect(shouldYieldTo("garbage", "0.30.17")).toBe(false);
  });
});

describe("AB-385 parent watchdog", () => {
  const watch = (overrides: Partial<Parameters<typeof watchParent>[0]>) => {
    const reasons: string[] = [];
    stops.push(watchParent({ ppid: 4242, identity: Promise.resolve("start-1"), onGone: (r) => reasons.push(r), checkMs: 5, identityCheckMs: 5,
      currentPpid: () => 4242, alive: () => true, readIdentity: async () => "start-1", ...overrides }));
    return reasons;
  };

  it("reports a parent PID that no longer exists, once", async () => {
    let exists = true;
    const reasons = watch({ alive: () => exists });
    await tick(40);
    expect(reasons).toEqual([]);
    exists = false;
    await tick(40);
    expect(reasons).toEqual(["parent 4242 ended"]);
  });

  it("treats a reused parent PID (another creation identity) as gone", async () => {
    const reasons = watch({ readIdentity: async () => "start-2" });
    await tick(60);
    expect(reasons).toEqual(["parent 4242 ended (PID reused)"]);
  });

  it("never treats unknown answers as gone", async () => {
    const unknownLiveness = watch({ alive: () => undefined, readIdentity: async () => "start-2" });
    const unreadable = watch({ readIdentity: async () => null });
    const unknownAtStart = watch({ identity: Promise.resolve(null), readIdentity: async () => "start-2" });
    await tick(60);
    expect([unknownLiveness, unreadable, unknownAtStart]).toEqual([[], [], []]);
  });

  it.skipIf(process.platform === "win32")("reports a re-parented process on POSIX", async () => {
    const reasons = watch({ currentPpid: () => 1 });
    await tick(40);
    expect(reasons).toEqual(["parent 4242 ended (re-parented)"]);
  });

  it("stops checking once stopped", async () => {
    let exists = true;
    const reasons: string[] = [];
    const stop = watchParent({ ppid: 4242, identity: Promise.resolve(null), onGone: (r) => reasons.push(r), checkMs: 5, currentPpid: () => 4242, alive: () => exists });
    stop();
    exists = false;
    await tick(40);
    expect(reasons).toEqual([]);
  });
});
