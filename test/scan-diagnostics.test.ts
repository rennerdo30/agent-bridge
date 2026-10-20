import { afterEach, expect, it, vi } from "vitest";
import * as responsiveScan from "../src/core/responsive-scan.js";
import { scanDiagnostics, threadCpuReader, SCAN_DIAGNOSTIC_BYTES, SCAN_DIAGNOSTIC_SPANS } from "./scan-diagnostics.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(cpuSupported = true) {
  let wall = 0, user = 0;
  const diagnostics = scanDiagnostics(true, { now: () => wall,
    threadCpu: cpuSupported ? () => ({ user, system: 0 }) : undefined })!;
  diagnostics.interval(0);
  return { diagnostics, advance(ms: number, us = 0) { wall += ms; user += us; }, now: () => wall };
}

it("takes no clocks or CPU probes unless explicitly enabled", () => {
  const probe = vi.fn(() => { throw new Error("disabled probe"); });
  expect(scanDiagnostics(false, { now: probe, threadCpu: probe })).toBeUndefined();
  expect(probe).not.toHaveBeenCalled();
});

it.each([240_000, 0])("correlates synchronous next wall time and thread CPU %i without inferring a scheduler cause", user => {
  const f = fixture();
  const result = { retained: true };
  const scan = f.diagnostics.wrap((function* () { f.advance(280, user); return result; })());
  expect(scan.next()).toEqual({ done: true, value: result });
  f.diagnostics.interval(281);
  const worst = f.diagnostics.snapshot()!;
  expect(worst).toMatchObject({ start: 0, end: 281, wallMs: 281, nextCount: 1, nextMs: 280, betweenNextMs: 1 });
  expect(worst.spans[0]).toEqual({ kind: "next", scan: 1, ordinal: 1, start: 0, end: 280, wallMs: 280,
    threadCpuUs: { user, system: 0 } });
  const lines: string[] = [];
  f.diagnostics.emit(line => lines.push(line));
  expect(JSON.parse(lines[0]!).interpretation).toContain("low CPU inside next cannot distinguish native blocking from descheduling");
});

it("uses the fixture's module spy to observe actual driver steps and a delayed mocked yield", async () => {
  const f = fixture();
  vi.spyOn(performance, "now").mockImplementation(f.now);
  const immediate = vi.fn((resolve: () => void) => { f.advance(270); f.diagnostics.interval(f.now()); resolve(); });
  vi.stubGlobal("setImmediate", immediate);
  const drain = responsiveScan.drainScanResponsive;
  vi.spyOn(responsiveScan, "drainScanResponsive").mockImplementation(scan => drain(f.diagnostics.wrap(scan)));
  const result = { retained: "result" };
  const scan = (function* () { f.advance(30, 29_000); yield; return result; })();
  const close = vi.spyOn(scan, "return");
  expect(await responsiveScan.drainScanResponsive(scan)).toBe(result);
  expect(immediate).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledExactlyOnceWith(undefined);
  const worst = f.diagnostics.snapshot()!;
  expect(worst).toMatchObject({ wallMs: 300, nextCount: 1, nextMs: 30, betweenNextMs: 270 });
  expect(worst.spans[0]).toMatchObject({ kind: "between-next", start: 30, end: 300, wallMs: 270, threadCpuUs: null });
  expect(worst.spans[1]).toMatchObject({ kind: "next", wallMs: 30, threadCpuUs: { user: 29_000, system: 0 } });
});

it("forwards exact next/error/return/throw behavior and keeps the driver's finally on failure", async () => {
  const f = fixture(), error = new Error("private error must not be emitted");
  const step = { done: false as const, value: undefined };
  const original = (function* () { yield; })();
  vi.spyOn(original, "next").mockReturnValue(step);
  expect(f.diagnostics.wrap(original).next()).toBe(step);
  const final = { done: true as const, value: 42 };
  const returning = vi.spyOn(original, "return").mockReturnValue(final as never);
  const throwing = vi.spyOn(original, "throw").mockImplementation(() => { throw error; });
  const wrapped = f.diagnostics.wrap(original);
  expect(wrapped.return(undefined)).toBe(final);
  expect(returning).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(() => wrapped.throw(error)).toThrow(error);
  expect(throwing).toHaveBeenCalledExactlyOnceWith(error);

  let finalized = 0;
  const failing = (function* () { try { f.advance(280); throw error; yield; } finally { finalized++; } })();
  const close = vi.spyOn(failing, "return");
  await expect(responsiveScan.drainScanResponsive(f.diagnostics.wrap(failing))).rejects.toBe(error);
  expect(close).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(finalized).toBe(1);
});

it("bounds retained spans, keeps the worst consecutive interval and emits once even through a failing assertion", () => {
  const f = fixture(false);
  const scan = f.diagnostics.wrap((function* () { for (let n = 0; n < 100; n++) { f.advance(3); yield; } })());
  for (let n = 0; n < 100; n++) scan.next();
  f.diagnostics.interval(301);
  f.diagnostics.interval(302); // A shorter interval cannot replace the retained maximum.
  const worst = f.diagnostics.snapshot()!;
  expect(worst).toMatchObject({ wallMs: 301, nextCount: 100, nextMs: 300, betweenNextMs: 1, spanCount: 201 });
  expect(worst.spans).toHaveLength(SCAN_DIAGNOSTIC_SPANS);
  expect(worst.spans.every(span => span.threadCpuUs === null)).toBe(true);
  worst.spans.length = 0;
  expect(f.diagnostics.snapshot()!.spans).toHaveLength(SCAN_DIAGNOSTIC_SPANS);
  const lines: string[] = [], failure = new Error("original assertion");
  expect(() => { try { throw failure; } finally { f.diagnostics.emit(line => lines.push(line)); } }).toThrow(failure);
  f.diagnostics.emit(line => lines.push(line));
  expect(lines).toHaveLength(1);
  expect(Buffer.byteLength(lines[0]!)).toBeLessThanOrEqual(SCAN_DIAGNOSTIC_BYTES);
  expect(JSON.parse(lines[0]!).worstInterval.wallMs).toBe(301);
  expect(lines[0]).not.toContain(failure.message);
  const g = fixture();
  expect(() => { try { throw failure; } finally { g.diagnostics.emit(() => { throw new Error("stderr failure"); }); } }).toThrow(failure);
});

it("feature detects absent or rejected thread CPU without a process-wide fallback", () => {
  const processCpu = vi.fn(() => { throw new Error("process-wide CPU is forbidden"); });
  const host = { cpuUsage: processCpu, threadCpuUsage: undefined };
  expect(threadCpuReader(host)).toBeUndefined();
  const read = vi.fn(() => { throw new Error("thread API unavailable"); });
  const f = scanDiagnostics(true, { now: () => 0, threadCpu: threadCpuReader({ threadCpuUsage: read }) })!;
  f.interval(0);
  const scan = f.wrap((function* () { yield; })());
  scan.next(); scan.next(); f.interval(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.snapshot()!.spans.every(span => span.threadCpuUs === null)).toBe(true);
  expect(processCpu).not.toHaveBeenCalled();
});
