/** Keep bounded backlog batches fast, then reduce maintenance wakes on an idle bridge. */
export class IdleBackoff {
  private delay = 2_000;
  next(active: boolean): number {
    if (active) return this.wake();
    const delay = this.delay;
    this.delay = Math.min(30_000, delay * 2);
    return delay;
  }
  wake(): number { this.delay = 2_000; return 100; }
}
