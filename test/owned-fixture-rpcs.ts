/** Attach observation at creation, before a fixture can fail/close its client.
 * The original promise still rejects to its caller. Cleanup must inspect every
 * pending settlement explicitly; observation never converts an RPC to success. */
export class OwnedFixtureRpcs {
  private pending = new Set<Promise<void>>();
  private failures: unknown[] = [];
  own<T>(operation: Promise<T>): Promise<T> {
    const observed = operation.then(() => { this.pending.delete(observed); }, error => {
      this.pending.delete(observed); this.failures.push(error);
    });
    this.pending.add(observed);
    return operation;
  }
  async settle(timeoutMs?: number): Promise<unknown[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = Promise.all([...this.pending]);
      if (timeoutMs === undefined) await settled;
      else await Promise.race([settled, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Owned fixture RPC settlement is unproven; retain fixture")), timeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); }
    return this.failures.splice(0);
  }
}
