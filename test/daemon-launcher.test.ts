import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyWindowsCreate, daemonEnvironment, RelaunchBackoff, superviseCreateHelper, windowsArgument, type CreateHelper } from "../src/core/daemon-launcher.js";

afterEach(() => { vi.useRealTimers(); });

/** A creation helper double: only its streams, close and kill are observable, as for the real PowerShell child. */
function helper() {
  const events = new EventEmitter(), stdin = new PassThrough(), stdout = new PassThrough();
  const kill = vi.fn(() => { setImmediate(() => events.emit("close", null)); return true; });
  const child = Object.assign(events, { stdin, stdout, kill }) as unknown as CreateHelper & EventEmitter;
  let input = ""; stdin.setEncoding("utf8").on("data", (chunk: string) => { input += chunk; });
  return { child, kill, input: () => input, close: (code: number | null, output = "") => { if (output) stdout.write(output); setImmediate(() => events.emit("close", code)); } };
}

describe("daemon creation evidence", () => {
  it("allows only complete known WMI failures to select degraded compatibility", () => {
    for (const code of [2, 3, 8, 9, 21, 22, 0xffffffff]) expect(classifyWindowsCreate(0, JSON.stringify({ code, pid: 0 })).kind).toBe("unavailable");
    for (const output of ["", "{}", '{"code":0,', '{"code":"2","pid":0}', '{"code":1234,"pid":0}', '{"code":2,"pid":123}', '{"code":0,"pid":0}', '{"code":0,"pid":123,"extra":true}']) {
      expect(classifyWindowsCreate(0, output).kind).toBe("unknown");
    }
    expect(classifyWindowsCreate(1, '{"code":2,"pid":0}').kind).toBe("unknown");
    expect(classifyWindowsCreate(null, '{"code":0,"pid":123}').kind).toBe("unknown");
    expect(classifyWindowsCreate(0, '{"code":0,"pid":123}').kind).toBe("created");
    expect(classifyWindowsCreate(1, '{"stage":"create","hresult":-2147467259}')).toEqual({ kind: "unknown", stage: "create", errorCode: -2147467259 });
  });
  it("quotes spaces, literal quotes and trailing backslashes as Windows argv", () => {
    expect(windowsArgument("a b")).toBe('"a b"');
    expect(windowsArgument('a"b')).toBe('"a\\"b"');
    expect(windowsArgument("a\\")).toBe('"a\\\\"');
    expect(() => windowsArgument("a\nb")).toThrow();
  });
  it("does not inherit session control credentials or arbitrary Node injection", () => {
    const env = daemonEnvironment({ cli: "fixture", home: "fixture-home", pipe: "fixture-pipe", cwd: "fixture" });
    expect(Object.keys(env).filter(key => /^AGENT_BRIDGE_(?:PARENT_|ROOT_|JOB_|DELEGATE_|INTERNAL$)/.test(key))).toEqual([]);
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.AGENT_BRIDGE_HOME).toBe("fixture-home");
    expect(env.AGENT_BRIDGE_PIPE).toBe("fixture-pipe");
  });
});

describe("relaunch backoff after late creation failures", () => {
  it("spaces attempts 5 s, doubling to a 5 min cap, and resets on registration", () => {
    let now = 0;
    const backoff = new RelaunchBackoff(() => now);
    expect(backoff.ready).toBe(true);
    const delays = Array.from({ length: 9 }, () => backoff.failed());
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
    expect(backoff.ready).toBe(false);
    now += 299_999; expect(backoff.ready).toBe(false);
    now += 1; expect(backoff.ready).toBe(true);
    backoff.reset();
    expect(backoff.ready).toBe(true);
    expect(backoff.failed()).toBe(5_000);
  });
});

describe("creation helper outliving the decision budget", () => {
  it("settles unknown at 5 s, does not kill before 30 s, and reports a late definite failure", async () => {
    vi.useFakeTimers();
    const h = helper(), late = vi.fn();
    const decision = superviseCreateHelper(h.child, '{"fixture":true}', late);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(decision).resolves.toEqual({ kind: "unknown" });
    expect(h.input()).toBe('{"fixture":true}');
    await vi.advanceTimersByTimeAsync(24_999);
    expect(h.kill).not.toHaveBeenCalled(); expect(late).not.toHaveBeenCalled();
    h.close(0, JSON.stringify({ code: 9, pid: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(late).toHaveBeenCalledExactlyOnceWith({ kind: "unavailable", reason: "windows_wmi_create_rejected" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.kill).not.toHaveBeenCalled(); // The 30 s bound is cleared by the helper's own close.
  });
  it("reports a late success without un-latching and bounds a hung helper at 30 s", async () => {
    vi.useFakeTimers();
    const ok = helper(), okLate = vi.fn();
    const first = superviseCreateHelper(ok.child, "{}", okLate);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(first).resolves.toEqual({ kind: "unknown" });
    ok.close(0, JSON.stringify({ code: 0, pid: 1234 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(okLate).toHaveBeenCalledExactlyOnceWith({ kind: "created" });
    const hung = helper(), hungLate = vi.fn();
    const second = superviseCreateHelper(hung.child, "{}", hungLate);
    await vi.advanceTimersByTimeAsync(29_999);
    await expect(second).resolves.toEqual({ kind: "unknown" });
    expect(hung.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hung.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(hungLate).toHaveBeenCalledExactlyOnceWith({ kind: "unknown" });
  });
  it("decides from a close inside the budget and reports nothing late", async () => {
    vi.useFakeTimers();
    const h = helper(), late = vi.fn();
    const decision = superviseCreateHelper(h.child, "{}", late);
    h.close(0, JSON.stringify({ code: 0, pid: 4321 }));
    await vi.advanceTimersByTimeAsync(1);
    await expect(decision).resolves.toEqual({ kind: "created" });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(late).not.toHaveBeenCalled(); expect(h.kill).not.toHaveBeenCalled();
  });
});
