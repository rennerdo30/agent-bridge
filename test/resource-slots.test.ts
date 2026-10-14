import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { describeResourceSlots, formatResourceSlots, ResourceSlots, resourceSlotHint, SLOT_LEASE_MS, SLOT_OWNER_ENV, SLOT_PID_ENV } from "../src/core/resource-slots.js";
import { runSlot } from "../src/cli/slot.js";

const TEST_ROOT = process.env.AGENT_BRIDGE_TEST_ROOT!;
const CLI = join(process.cwd(), "plugins/opencode/dist/cli.mjs");
const owner = (id: string) => ({ id, pid: process.pid });
let home: string;
let stores: ResourceSlots[];
beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
  home = mkdtempSync(join(TEST_ROOT, "slots-"));
  stores = [];
});
afterEach(() => {
  for (const store of stores) store.close();
  rmSync(home, { recursive: true, force: true });
});
const store = (live?: (pid: number) => boolean, now?: () => number) => {
  const s = new ResourceSlots(home, live, now);
  stores.push(s);
  return s;
};

describe("shared resource slots", () => {
  it("is opt-in with validated, machine-wide capacities", () => {
    expect(loadConfig(home, "codex", nullLogger, {}).resourceSlots).toEqual({});
    writeFileSync(join(home, "config.json"), JSON.stringify({ resourceSlots: { unity: 2 }, codex: { resourceSlots: { unity: 99 } } }));
    expect(loadConfig(home, "codex", nullLogger, {}).resourceSlots).toEqual({ unity: 2 });
    for (const invalid of [{ unity: 0 }, { unity: 1.5 }, { "../unity": 1 }, { unity: "2" }, []]) {
      writeFileSync(join(home, "config.json"), JSON.stringify({ resourceSlots: invalid }));
      expect(loadConfig(home, "other", nullLogger, {}).resourceSlots).toEqual({});
    }
    expect(resourceSlotHint({}, CLI)).toBeNull();
    expect(resourceSlotHint({ unity: 2 }, CLI)).toContain(`node "${CLI}" slot acquire`);
  });

  it("enforces limits across stores, makes acquire idempotent, and respects FIFO waiters", () => {
    const a = store();
    const b = store();
    expect(a.tryAcquire("unity", 1, owner("a"))).toBe(true);
    expect(a.tryAcquire("unity", 1, owner("a"))).toBe(true);
    expect(b.tryAcquire("unity", 1, owner("b"))).toBe(false);
    expect(a.tryAcquire("unity", 1, owner("c"))).toBe(false);
    a.release(owner("a"));
    expect(a.tryAcquire("unity", 1, owner("c"))).toBe(false);
    expect(b.tryAcquire("unity", 1, owner("b"))).toBe(true);
    b.release(owner("b"), "unity");
    expect(a.tryAcquire("unity", 1, owner("c"))).toBe(true);
    expect(a.list()).toMatchObject([{ id: "c", held: true }]);
  });

  it("shows a display snapshot without probing owners or pruning", () => {
    let probes = 0, alive = true, clock = Date.now();
    const s = store((() => { probes++; return alive; }) as (pid: number) => boolean, () => clock);
    expect(s.tryAcquire("unity", 1, owner("a"))).toBe(true);
    probes = 0; alive = false;
    // The dashboard read must not run (slow, blocking) liveness probes or write.
    expect(s.snapshot()).toMatchObject([{ id: "a", held: true }]);
    expect(probes).toBe(0);
    // An expired lease is hidden from the snapshot without being deleted; list() still prunes.
    clock += SLOT_LEASE_MS + 1;
    expect(s.snapshot()).toEqual([]);
    expect(s.list()).toEqual([]);
  });

  it("shares each resource separately and retains holders when capacity is reduced", () => {
    const s = store();
    expect(s.tryAcquire("unity", 2, owner("a"))).toBe(true);
    expect(s.tryAcquire("unity", 2, owner("b"))).toBe(true);
    expect(s.tryAcquire("gpu", 1, owner("c"))).toBe(true);
    expect(s.tryAcquire("unity", 1, owner("d"))).toBe(false);
    s.release(owner("a"));
    expect(s.tryAcquire("unity", 1, owner("d"))).toBe(false);
    s.release(owner("b"));
    expect(s.tryAcquire("unity", 1, owner("d"))).toBe(true);
    expect(s.list().filter((e) => e.resource === "gpu")).toHaveLength(1);
  });

  it("reclaims dead holders and waiters, and expires abandoned leases", () => {
    let clock = 0;
    const dead = new Set<number>();
    const s = store((pid) => !dead.has(pid), () => clock);
    expect(s.tryAcquire("unity", 1, { id: "crashed", pid: 10 })).toBe(true);
    expect(s.tryAcquire("unity", 1, { id: "waiter", pid: 11 })).toBe(false);
    dead.add(10); dead.add(11);
    expect(s.tryAcquire("unity", 1, owner("new"))).toBe(true);
    expect(s.list()).toHaveLength(1);
    clock = SLOT_LEASE_MS;
    expect(s.list()).toEqual([]);
    expect(s.tryAcquire("unity", 1, owner("another"))).toBe(true);
  });

  it("renews only live leases and cancels waiters without releasing another owner", async () => {
    let clock = 0;
    const s = store(undefined, () => clock);
    s.tryAcquire("unity", 1, owner("a"));
    clock = SLOT_LEASE_MS - 1;
    s.renew(owner("a"));
    clock = SLOT_LEASE_MS;
    expect(s.list()[0]?.held).toBe(true);
    const controller = new AbortController();
    const waiting = s.acquire("unity", 1, owner("b"), controller.signal);
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(s.list().map((e) => e.id)).toEqual(["a"]);
    s.release({ id: "a", pid: process.pid + 1 });
    expect(s.list()).toHaveLength(1);
    clock += SLOT_LEASE_MS;
    s.renew(owner("a"));
    expect(s.list()).toEqual([]);
  });

  it("rejects unknown resources instead of silently running unlimited", async () => {
    const output: string[] = [];
    expect(await runSlot(["acquire", "unity"], home, DEFAULT_CONFIG, (s) => output.push(s))).toBe(2);
    expect(output.join("\n")).toContain("configured");
  });

  it("queues real CLI processes and reclaims an owner process killed after acquiring", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ resourceSlots: { unity: 1 } }));
    const s = store();
    const run = (args: string[], id: string, pid = process.pid) => {
      const child = spawn(process.execPath, [CLI, "slot", ...args], { env: { ...process.env, AGENT_BRIDGE_HOME: home, [SLOT_OWNER_ENV]: id, [SLOT_PID_ENV]: String(pid) }, windowsHide: true });
      const done = new Promise<{ code: number | null; text: string }>((resolve, reject) => {
        let text = "";
        child.stdout.on("data", (d) => { text += d; });
        child.stderr.on("data", (d) => { text += d; });
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, text }));
      });
      return { child, done };
    };
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error("Slot contender did not arrive");
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const heavy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true });
    const contenders: ReturnType<typeof run>[] = [];
    try {
      expect((await run(["acquire", "unity"], "heavy", heavy.pid!).done).code).toBe(0);
      const first = run(["acquire", "unity"], "first"); contenders.push(first);
      await until(() => s.list().some((e) => e.id === "first"));
      const second = run(["acquire", "unity"], "second"); contenders.push(second);
      await until(() => s.list().some((e) => e.id === "second"));
      const exited = new Promise((resolve) => heavy.once("exit", resolve));
      heavy.kill();
      await exited;
      expect((await first.done).code).toBe(0);
      expect(s.list().map((e) => [e.id, e.held])).toEqual([["first", true], ["second", false]]);
      expect((await run(["release", "unity"], "first").done).code).toBe(0);
      expect((await second.done).code).toBe(0);
      expect((await run(["release", "unity"], "second").done).code).toBe(0);
      expect(s.list()).toEqual([]);
    } finally {
      heavy.kill();
      for (const c of contenders) c.child.kill();
      await Promise.all(contenders.map((c) => c.done));
    }
  }, 20_000);
});

it("shows holders first and the waiting queue in ticket order (AB-40)", () => {
  const a = store(), b = store(), c = store();
  expect(a.tryAcquire("unity", 1, owner("job-a"))).toBe(true);
  expect(b.tryAcquire("unity", 1, owner("job-b"))).toBe(false);
  expect(c.tryAcquire("unity", 1, owner("job-c"))).toBe(false);
  const [unity] = describeResourceSlots(a.list(), { unity: 1, blender: 2 }).filter(r => r.resource === "unity");
  expect(unity!.held.map(e => e.id)).toEqual(["job-a"]);
  expect(unity!.waiting.map(e => e.id)).toEqual(["job-b", "job-c"]);
  expect(formatResourceSlots(a.list(), { unity: 1, blender: 2 })).toEqual([`- unity (1/1): held by job-a [pid ${process.pid}]; waiting: job-b, job-c`]);
});
