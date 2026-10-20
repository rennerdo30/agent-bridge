/** AB-454: retained test-only measurement, default off. The fixture explicitly
 * enables this with AGENT_BRIDGE_SCAN_DIAGNOSTICS=1. No observers, timers, IO,
 * clocks or CPU probes are installed on the disabled path. */
import { isMainThread, threadId } from "node:worker_threads";

type Cpu = { user: number; system: number };
type Span = {
  kind: "next" | "between-next"; scan: number; ordinal: number;
  start: number; end: number; wallMs: number; threadCpuUs: Cpu | null;
};
type Window = { start: number; end: number; wallMs: number; nextCount: number;
  nextMs: number; betweenNextMs: number; spanCount: number; spans: Span[] };
export const SCAN_DIAGNOSTIC_SPANS = 8;
export const SCAN_DIAGNOSTIC_BYTES = 8192;

/** Never substitute process.cpuUsage(): it includes unrelated worker threads.
 * Older Node 22 versions have no threadCpuUsage; a rejected probe is unavailable. */
export function threadCpuReader(host: { threadCpuUsage?: () => Cpu }): (() => Cpu) | undefined {
  if (typeof host.threadCpuUsage !== "function") return undefined;
  return () => host.threadCpuUsage!();
}

export function scanDiagnostics(enabled: boolean, probes: { now: () => number; threadCpu?: () => Cpu }) {
  if (!enabled) return undefined;
  let window: Window | undefined, worst: Window | undefined;
  let boundary: number | undefined, scanId = 0, lastScan = 0, lastOrdinal = 0, emitted = false;
  let cpu = probes.threadCpu;
  const readCpu = (): Cpu | null => {
    try {
      const value = cpu?.();
      if (value && Number.isFinite(value.user) && Number.isFinite(value.system)) return value;
    } catch { /* Optional thread API may be unsupported on this host. */ }
    cpu = undefined;
    return null;
  };
  const record = (span: Span) => {
    if (!window) return;
    window.spanCount++;
    if (span.kind === "next") { window.nextCount++; window.nextMs += span.wallMs; }
    else window.betweenNextMs += span.wallMs;
    // Keep only the eight longest spans in this timer window, not corpus history.
    const spans = window.spans;
    let at = spans.findIndex(value => value.wallMs < span.wallMs);
    if (at < 0) at = spans.length;
    if (at < SCAN_DIAGNOSTIC_SPANS) {
      spans.splice(at, 0, span);
      if (spans.length > SCAN_DIAGNOSTIC_SPANS) spans.pop();
    }
  };
  const gap = (end: number) => {
    if (boundary !== undefined) record({ kind: "between-next", scan: lastScan, ordinal: lastOrdinal,
      start: boundary, end, wallMs: end - boundary, threadCpuUs: null });
    boundary = end;
  };
  return {
    interval(at: number) {
      gap(at);
      if (window) {
        window.end = at; window.wallMs = at - window.start;
        if (!worst || window.wallMs > worst.wallMs) worst = window;
      }
      window = { start: at, end: at, wallMs: 0, nextCount: 0, nextMs: 0, betweenNextMs: 0, spanCount: 0, spans: [] };
    },
    wrap<T>(scan: Generator<void, T>): Generator<void, T> {
      const id = ++scanId;
      let ordinal = 0;
      return {
        next(...args: [] | [unknown]) {
          const start = probes.now(); gap(start);
          lastScan = id; lastOrdinal = ++ordinal;
          const before = readCpu();
          try { return scan.next(...args); }
          finally {
            const after = readCpu(), end = probes.now();
            record({ kind: "next", scan: id, ordinal, start, end, wallMs: end - start,
              threadCpuUs: before && after ? { user: after.user - before.user, system: after.system - before.system } : null });
            boundary = end;
          }
        },
        return(value: T) { return scan.return(value); },
        throw(error: unknown) { return scan.throw(error); },
        [Symbol.iterator]() { return this; },
        [Symbol.dispose]() { scan[Symbol.dispose](); },
      };
    },
    snapshot() { return worst ? structuredClone(worst) : null; },
    /** Best effort, once, after measurement. No error or generator value is serialized. */
    emit(write: (line: string) => void) {
      if (emitted) return;
      emitted = true;
      try {
        const line = JSON.stringify({ diagnostic: "AB-454", node: process.version,
          platform: process.platform, arch: process.arch, threadId, isMainThread,
          cpuScope: "current worker thread only when supported; never process-wide",
          worstInterval: worst ?? null,
          coverage: "consecutive timer callbacks only; longest spans retained; between-next includes yields and other unobserved work",
          interpretation: "thread CPU supports active work; low CPU inside next cannot distinguish native blocking from descheduling" });
        write((line.length <= SCAN_DIAGNOSTIC_BYTES - 1 ? line : '{"diagnostic":"AB-454","truncated":true}') + "\n");
      } catch { /* Diagnostics must never replace the original test/scan failure. */ }
    },
  };
}
