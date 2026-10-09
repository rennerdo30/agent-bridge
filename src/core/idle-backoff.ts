/** Bounded fallback discovery remains available when there is no event wake. */
export class IdleBackoff {
  private delay: number;
  constructor(private readonly minimum = 2_000, private readonly maximum = 30_000) { this.delay = minimum; }
  next(work: number, discovering: boolean): number {
    this.delay = work || discovering ? this.minimum : Math.min(this.maximum, this.delay * 2);
    return this.delay;
  }
  reset(): void { this.delay = this.minimum; }
}
