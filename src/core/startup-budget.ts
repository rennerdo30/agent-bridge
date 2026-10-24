import { REQUEST_TIMEOUT_MS } from "./constants.js";
import { BridgeError } from "./protocol.js";
export const STARTUP_DEADLINE_ENV = "AGENT_BRIDGE_STARTUP_DEADLINE";
/** One attempt, never renewed by preparation, retry, auth, or final admission.
 * The optional child-process handoff can only tighten its own ten-second cap. */
export class StartupBudget {
  readonly deadline: number;
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(notAfter = Infinity, private readonly active: () => boolean = () => true) {
    this.deadline = Math.min(Date.now() + REQUEST_TIMEOUT_MS, notAfter);
    this.timer = setTimeout(() => this.abort(), Math.max(0, this.deadline - Date.now()));
  }
  abort(reason: unknown = new BridgeError("timeout", "Original ten-second startup budget expired; no later startup or request was admitted.")): void { this.controller.abort(reason); }
  remaining(): number {
    if (!this.active()) this.abort(new BridgeError('timeout','Startup owner stopped; no later phase admitted'));
    if (!Number.isFinite(this.deadline) || Date.now() >= this.deadline) this.abort();
    this.signal.throwIfAborted(); return this.deadline - Date.now();
  }
  wait<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const aborted = () => { this.signal.removeEventListener("abort", aborted); reject(this.signal.reason); };
      this.signal.addEventListener("abort", aborted, { once: true });
      work.then(value => { this.signal.removeEventListener("abort", aborted); try { this.remaining(); resolve(value); } catch (error) { reject(error); } }, error => { this.signal.removeEventListener("abort", aborted); reject(error); });
      if (this.signal.aborted) aborted();
    });
  }
  close(): void { clearTimeout(this.timer); }
}
