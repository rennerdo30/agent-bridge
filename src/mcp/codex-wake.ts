import type { BridgeConfig } from "../core/config.js";
import { runProcess } from "../core/delegate.js";
import { ENV } from "../core/constants.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import { AGENT_KINDS, BROADCAST, isQuietMessage, type BridgeMessage } from "../core/protocol.js";

/** Collect bursts of messages into one wake-up. */
const WAKE_DEBOUNCE_MS = 1_500;
const QUEUE_TIMEOUT_MS = 30_000;
/**
 * Prompt for the queued turn. The actual messages are injected by the UserPromptSubmit hook when that
 * turn starts, so this stays short and free of shell metacharacters.
 */
export const WAKE_PROMPT =
  "agent-bridge: new message(s) from peer agents arrived. They are attached to this turn; read them and handle them, answering with the agent-bridge send tool.";

export type Activity = "busy" | "idle";

/**
 * Codex has no MCP push, but `codex queue` starts a turn on an idle thread. When auto-wake is on and
 * this Codex session is idle, a new peer message triggers one queued turn.
 */
export class CodexWaker {
  private state: Activity = "idle";
  private threadId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  /** Bumped on every activity report, so a finishing wake-up can tell whether hooks reported since it began. */
  private reports = 0;
  private arrivals = 0;

  constructor(
    private readonly node: BridgeNode,
    private readonly cfg: BridgeConfig,
    private readonly log: Logger,
    private readonly timings = { debounceMs: WAKE_DEBOUNCE_MS, queueTimeoutMs: QUEUE_TIMEOUT_MS },
  ) {
    node.on("message", (m) => this.onMessage(m));
    node.on("notification_waits_changed", () => { if (this.idleWithMail()) this.schedule(); });
  }

  setThreadId(id: string | null): void {
    if (id && id !== this.threadId) {
      this.threadId = id;
      this.log.debug("codex thread id learned", { threadId: id });
    }
  }

  setActivity(state: Activity): void {
    this.state = state;
    this.reports++;
    if (state === "idle" && this.hasWakeableMail()) this.schedule();
  }

  private hasWakeableMail(): boolean {
    return this.node.unread().some((m) => m.hop < this.cfg.maxHops && !isQuietMessage(m) &&
      (this.node.autoWakeEnabled || (m.from.id.startsWith("job:") && m.conversationId.endsWith(":fallback")) ||
        (!m.conversationId.endsWith(":note") && (this.node.isNotificationAwaited(m) ||
        (this.cfg.wakeOnDirect && (m.to === BROADCAST || (!(AGENT_KINDS as readonly string[]).includes(m.to) &&
          (m.to === this.node.name || m.to === this.node.id || m.recipient === this.node.name))))))));
  }

  private idleWithMail(): boolean {
    return this.state === "idle" && this.hasWakeableMail();
  }

  private onMessage(m: BridgeMessage): void {
    if (isQuietMessage(m)) return;
    if (m.hop >= this.cfg.maxHops) {
      this.log.info("not waking codex: hop limit reached", { id: m.id, hop: m.hop });
      return;
    }
    this.arrivals++;
    if (this.idleWithMail()) this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.inFlight) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.wake();
    }, this.timings.debounceMs);
    this.timer.unref();
  }

  private async wake(): Promise<void> {
    if (!this.idleWithMail()) return;
    if (!this.threadId) {
      this.log.warn("cannot auto-wake codex: thread id unknown until the session makes its first agent-bridge call");
      return;
    }
    this.inFlight = true;
    this.state = "busy";
    const reportsAtStart = this.reports;
    const arrivalsAtStart = this.arrivals;
    // The queued turn can start (and even end) while `codex queue` still runs. Hooks then report the real
    // state, which must win over our guess: a failed queue call only resets to idle if nobody reported since.
    const failed = () => {
      if (this.reports === reportsAtStart) this.state = "idle";
    };
    try {
      const res = await runProcess({
        bin: this.cfg.codexBin,
        args: ["queue", "--thread", this.threadId, "--message", WAKE_PROMPT],
        stdin: "",
        cwd: this.node.cwd,
        timeoutMs: this.timings.queueTimeoutMs,
        env: { ...process.env, [ENV.internal]: "1" },
        log: this.log,
      });
      if (res.code === 0) this.log.info("queued wake-up turn for codex", { threadId: this.threadId });
      else {
        failed();
        this.log.warn("codex queue failed", { code: res.code, stderr: res.stderr.slice(-1000) });
      }
    } catch (err) {
      failed();
      this.log.warn("codex queue failed", { err: (err as Error).message });
    } finally {
      this.inFlight = false;
      // Queue acceptance is not a host activity report. Without hooks, retaining this guess forever
      // strands every later message even after the native turn ends. A new arrival may queue again;
      // this does not retry existing mail, and an explicit busy report still wins.
      if (this.reports === reportsAtStart) this.state = "idle";
      // An idle report during the call could not schedule (inFlight); catch up on mail it left behind.
      // Without such a report nothing is retried, so a failing `codex queue` does not loop.
      if ((this.reports !== reportsAtStart || this.arrivals !== arrivalsAtStart) && this.idleWithMail()) this.schedule();
    }
  }
}
