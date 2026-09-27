import type { BridgeConfig } from "../core/config.js";
import { runProcess } from "../core/delegate.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import type { BridgeMessage } from "../core/protocol.js";

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

  constructor(
    private readonly node: BridgeNode,
    private readonly cfg: BridgeConfig,
    private readonly log: Logger,
  ) {
    node.on("message", (m) => this.onMessage(m));
  }

  setThreadId(id: string | null): void {
    if (id && id !== this.threadId) {
      this.threadId = id;
      this.log.debug("codex thread id learned", { threadId: id });
    }
  }

  setActivity(state: Activity): void {
    this.state = state;
    if (state === "idle" && this.node.autoWakeEnabled && this.node.unread().some((m) => m.hop < this.cfg.maxHops)) this.schedule();
  }

  private onMessage(m: BridgeMessage): void {
    if (m.hop >= this.cfg.maxHops) {
      this.log.info("not waking codex: hop limit reached", { id: m.id, hop: m.hop });
      return;
    }
    if (this.node.autoWakeEnabled && this.state === "idle") this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.inFlight) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.wake();
    }, WAKE_DEBOUNCE_MS);
    this.timer.unref();
  }

  private async wake(): Promise<void> {
    if (this.state !== "idle" || !this.node.autoWakeEnabled) return;
    if (!this.threadId) {
      this.log.warn("cannot auto-wake codex: thread id unknown until the session makes its first agent-bridge call");
      return;
    }
    this.inFlight = true;
    this.state = "busy";
    try {
      const res = await runProcess({
        bin: this.cfg.codexBin,
        args: ["queue", "--thread", this.threadId, "--message", WAKE_PROMPT],
        stdin: "",
        cwd: this.node.cwd,
        timeoutMs: QUEUE_TIMEOUT_MS,
        env: process.env,
        log: this.log,
      });
      if (res.code === 0) this.log.info("queued wake-up turn for codex", { threadId: this.threadId });
      else {
        this.state = "idle";
        this.log.warn("codex queue failed", { code: res.code, stderr: res.stderr.slice(-1000) });
      }
    } catch (err) {
      this.state = "idle";
      this.log.warn("codex queue failed", { err: (err as Error).message });
    } finally {
      this.inFlight = false;
    }
  }
}
