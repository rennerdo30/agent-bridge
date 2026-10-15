import { afterEach, describe, expect, it } from "vitest";
import { compareVersions, NODE_STOP_MS, runShutdownSteps, SHUTDOWN_DEADLINE_MS, shouldYieldTo, watchParent } from "../src/mcp/server-lifecycle.js";

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

  it("orders pre-releases by semver identifiers", () => {
    expect(compareVersions("0.31.0-rc.10", "0.31.0-rc.9")).toBe(1);
    expect(compareVersions("0.31.0-rc.2", "0.31.0-rc.10")).toBe(-1);
    expect(compareVersions("0.31.0-1", "0.31.0-alpha")).toBe(-1);
    expect(compareVersions("0.31.0-alpha", "0.31.0-alpha.1")).toBe(-1);
    expect(compareVersions("0.31.0-beta", "0.31.0-alpha.9")).toBe(1);
  });

  const own = { version: "0.30.17", ppid: 4242, parentIdentity: "host-start" };
  const sameHost = { agentPid: 4242, agentStartedAt: "host-start" };

  it("yields only to a strictly newer version started by the same host process", () => {
    expect(shouldYieldTo({ version: "0.30.21", ...sameHost }, own)).toBe(true);
    expect(shouldYieldTo({ version: "0.30.17", ...sameHost }, own)).toBe(false);
    expect(shouldYieldTo({ version: "0.30.9", ...sameHost }, own)).toBe(false);
    // An older broker does not report the replacing server's version: keep the reclaim path.
    expect(shouldYieldTo({ ...sameHost }, own)).toBe(false);
    expect(shouldYieldTo({ version: "garbage", ...sameHost }, own)).toBe(false);
    expect(shouldYieldTo(undefined, own)).toBe(false);
  });

  it("never yields to another host process of the same session, or when the host cannot be identified", () => {
    // A second terminal resuming the same session: same session id, another CLI process.
    expect(shouldYieldTo({ version: "0.30.21", agentPid: 5151, agentStartedAt: "other-start" }, own)).toBe(false);
    // A reused PID: same number, another creation time.
    expect(shouldYieldTo({ version: "0.30.21", agentPid: 4242, agentStartedAt: "other-start" }, own)).toBe(false);
    expect(shouldYieldTo({ version: "0.30.21", agentPid: null, agentStartedAt: "host-start" }, own)).toBe(false);
    expect(shouldYieldTo({ version: "0.30.21", agentPid: 4242, agentStartedAt: null }, own)).toBe(false);
    expect(shouldYieldTo({ version: "0.30.21", ...sameHost }, { ...own, parentIdentity: null })).toBe(false);
  });
});

describe("AB-385 bounded shutdown steps", () => {
  it("leaves a hanging step behind after its budget, names it, and still runs the later steps", async () => {
    const ran: string[] = [], timedOut: [string, number][] = [];
    const startedAt = Date.now();
    await runShutdownSteps([
      { name: "delegates", run: () => { ran.push("delegates"); } },
      { name: "hangs", run: () => { ran.push("hangs"); return new Promise(() => {}); }, budgetMs: 50 },
      { name: "throws", run: () => { ran.push("throws"); throw new Error("boom"); } },
      { name: "bridge node", run: async () => { ran.push("bridge node"); } },
    ], { onTimeout: (name, budgetMs) => timedOut.push([name, budgetMs]) });
    expect(ran).toEqual(["delegates", "hangs", "throws", "bridge node"]);
    expect(timedOut).toEqual([["hangs", 50]]);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("budgets the whole shutdown within its backstop", () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThan(NODE_STOP_MS);
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThanOrEqual(30_000);
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
