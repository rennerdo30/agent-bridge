import { monitorEventLoopDelay } from "node:perf_hooks";
import { BridgeClient } from "./client.js";
import type { Logger } from "./logger.js";
import type { BackupHealth } from "./backup-background.js";

export interface HistoryHealth {
  phase: string;
  percent: number;
  etaSeconds: number | null;
  paused: boolean;
  completedRows: number;
  totalRows: number;
}
export interface BrokerHealth {
  brokerPid: number;
  brokerVersion: string;
  uptimeSeconds: number;
  checkedAt: number;
  eventLoopDelayMs: { p95: number; max: number };
  recentErrors: { at: number; operation: string; code: string }[];
  history: HistoryHealth | null;
  backup: BackupHealth | null;
  roundTripMs?: number;
}

type EventLoopDelay = Pick<ReturnType<typeof monitorEventLoopDelay>, "enable" | "disable" | "percentile" | "max">;

/** Bounded in-memory diagnostics. Never load logs, archived records or database tables. */
export class HealthMonitor {
  private delay: EventLoopDelay;
  private sampled = false;
  private timer: NodeJS.Timeout | null = null;
  private lastActivity = 0;
  private closed = false;
  constructor(private readonly createDelay: () => EventLoopDelay = () => monitorEventLoopDelay({ resolution: 20 })) { this.delay = createDelay(); }
  private readonly errors: BrokerHealth["recentErrors"] = [];
  /** Sample active request bursts, then stop the native 20 ms idle wakeup. */
  start(): void {
    if (this.closed) return;
    this.lastActivity = Date.now();
    if (this.timer) return;
    // A re-enabled histogram measures its first interval from the tick before it was disabled, so the idle gap
    // would read as one huge delay. Each active window samples into a fresh histogram.
    if (this.sampled) this.delay = this.createDelay();
    this.sampled = true;
    this.delay.enable();
    const expire = () => {
      const remaining = 5_000 - (Date.now() - this.lastActivity);
      if (remaining > 0) this.timer = setTimeout(expire, remaining);
      else { this.delay.disable(); this.timer = null; }
      this.timer?.unref();
    };
    this.timer = setTimeout(expire, 5_000);
    this.timer.unref();
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.delay.disable();
  }
  error(operation: string, code: string, at = Date.now()): void {
    this.errors.push({ at, operation, code });
    if (this.errors.length > 10) this.errors.shift();
  }
  snapshot(version: string, history: HistoryHealth | null, backup: BackupHealth | null = null): BrokerHealth {
    const ms = (n: number) => Number.isFinite(n) ? Math.round(n / 1e6 * 10) / 10 : 0;
    return { brokerPid: process.pid, brokerVersion: version, uptimeSeconds: Math.floor(process.uptime()), checkedAt: Date.now(),
      eventLoopDelayMs: { p95: ms(this.delay.percentile(95)), max: ms(this.delay.max) },
      recentErrors: this.errors.map(e => ({ ...e })), history: history && { phase: history.phase, percent: history.percent,
        etaSeconds: history.etaSeconds, paused: history.paused, completedRows: history.completedRows, totalRows: history.totalRows },
      backup: backup && { phase: backup.phase, lastVerifiedAt: backup.lastVerifiedAt,
        lastError: backup.lastError && ["broker_pressure", "backup_failed", "worker_failed"].includes(backup.lastError) ? backup.lastError : null } };
  }
}

export function formatHealth(health: BrokerHealth): string {
  const history = health.history;
  const eta = history?.etaSeconds == null ? "ETA pending" : `ETA ~${Math.ceil(history.etaSeconds / 60)} min`;
  return `Broker latency: ${health.roundTripMs == null ? "not measured" : `${Math.round(health.roundTripMs)} ms`} round trip; event loop p95 ${health.eventLoopDelayMs.p95} ms. ` +
    (history ? `History import: ${history.phase}, ~${history.percent.toFixed(1)}%, ${eta}${history.paused ? " (paused)" : ""}. ` : "History import: inactive. ") +
    (health.backup ? `Backup: ${health.backup.phase}${health.backup.lastVerifiedAt == null ? "" : `, last verified ${new Date(health.backup.lastVerifiedAt).toISOString()}`}${health.backup.lastError ? ` (${health.backup.lastError})` : ""}. ` : "Backup: disabled. ") +
    `Recent request errors: ${health.recentErrors.length}.`;
}

/** Only a refused or missing endpoint proves absence. A timeout is inconclusive. */
export function brokerFailureState(error: unknown): "offline" | "slow" | "unavailable" {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ECONNREFUSED") return "offline";
  if (code === "ETIMEDOUT" || code === "timeout" || /timed out|timeout/i.test(String((error as Error)?.message))) return "slow";
  return "unavailable";
}

/** Read-only endpoint probe: no election, token creation or registration. */
export async function probeBrokerHealth(pipe: string, log: Logger): Promise<BrokerHealth | null> {
  const started = performance.now();
  const client = await BridgeClient.connect(pipe, log, 1_000);
  try {
    const ping = await client.request("ping", {}, 1_000);
    return ping.health ? { ...ping.health, roundTripMs: performance.now() - started } : null;
  } finally { client.close(); }
}
