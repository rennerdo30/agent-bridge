/** Diagnostic spans only. They carry no admission/reader/lease authority. The
 * ambient observer is synchronous and restored before returning any promise. */
const PHASES = ["inspection", "identity", "endpoints", "readers", "effect", "constructor-readers", "leases", "main-open", "main-schema", "overlay", "main-configure", "archive", "history"] as const;
export type AdmissionPhase = typeof PHASES[number];
type Span = { phase: AdmissionPhase; start: number };
let active: AdmissionObservation | undefined;
const elapsed = (start: number) => Math.max(0, Math.min(60_000, Math.round(performance.now() - start)));
export class AdmissionObservation {
  private readonly start = performance.now();
  private readonly spans = new Set<Span>();
  private readonly totals = new Map<AdmissionPhase, { calls: number; ms: number }>();
  private begin(phase: AdmissionPhase): () => void {
    if (!PHASES.includes(phase)) throw new Error("Unknown admission observation phase");
    const span = { phase, start: performance.now() }; this.spans.add(span);
    return () => {
      this.spans.delete(span);
      const prior = this.totals.get(phase) ?? { calls: 0, ms: 0 };
      this.totals.set(phase, { calls: Math.min(65_535, prior.calls + 1), ms: Math.min(60_000, prior.ms + elapsed(span.start)) });
    };
  }
  measure<T>(phase: AdmissionPhase, effect: () => T): T {
    const end = this.begin(phase); try { return effect(); } finally { end(); }
  }
  async wait<T>(phase: AdmissionPhase, effect: () => Promise<T>): Promise<T> {
    const end = this.begin(phase); try { return await effect(); } finally { end(); }
  }
  scope<T>(effect: () => T): T {
    const previous = active; active = this;
    try { return effect(); } finally { active = previous; }
  }
  snapshot() {
    return { elapsedMs: elapsed(this.start), phases: PHASES.flatMap(phase => {
      const done = this.totals.get(phase), pending = [...this.spans].filter(span => span.phase === phase);
      return done || pending.length ? [{ phase, calls: done?.calls ?? 0, ms: Math.min(60_000, (done?.ms ?? 0) + pending.reduce((ms, span) => ms + elapsed(span.start), 0)), pending: pending.length }] : [];
    }) };
  }
}
export function observeAdmissionPhase<T>(phase: AdmissionPhase, effect: () => T): T {
  return active ? active.measure(phase, effect) : effect();
}
