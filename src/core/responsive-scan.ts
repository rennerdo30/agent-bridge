/** Shared traversal: offline callers drain immediately; broker readers yield
 * between bounded steps so a cold catalog cannot monopolize request dispatch.
 * A single native stat/read/JSON parse is indivisible; the slice bounds work
 * between those operations, not the duration of a damaged/oversized file parse. */
export function drainScan<T>(scan: Generator<void, T>): T {
  for (;;) { const step = scan.next(); if (step.done) return step.value; }
}

export async function drainScanResponsive<T>(scan: Generator<void, T>): Promise<T> {
  try {
    for (;;) {
      const started = performance.now();
      for (let steps = 0; steps < 32 && performance.now() - started < 4; steps++) {
        const step = scan.next();
        if (step.done) return step.value;
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  } finally { scan.return(undefined as T); }
}
