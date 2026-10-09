import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  BridgeClient
} from "./chunk-FYORZX5T.mjs";

// src/core/health.ts
import { monitorEventLoopDelay } from "node:perf_hooks";
var HealthMonitor = class {
  constructor(createDelay = () => monitorEventLoopDelay({ resolution: 20 })) {
    this.createDelay = createDelay;
    this.delay = createDelay();
  }
  createDelay;
  delay;
  sampled = false;
  timer = null;
  lastActivity = 0;
  closed = false;
  errors = [];
  /** Sample active request bursts, then stop the native 20 ms idle wakeup. */
  start() {
    if (this.closed) return;
    this.lastActivity = Date.now();
    if (this.timer) return;
    if (this.sampled) this.delay = this.createDelay();
    this.sampled = true;
    this.delay.enable();
    const expire = () => {
      const remaining = 5e3 - (Date.now() - this.lastActivity);
      if (remaining > 0) this.timer = setTimeout(expire, remaining);
      else {
        this.delay.disable();
        this.timer = null;
      }
      this.timer?.unref();
    };
    this.timer = setTimeout(expire, 5e3);
    this.timer.unref();
  }
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.delay.disable();
  }
  error(operation, code, at = Date.now()) {
    this.errors.push({ at, operation, code });
    if (this.errors.length > 10) this.errors.shift();
  }
  snapshot(version, history, backup = null) {
    const ms = (n) => Number.isFinite(n) ? Math.round(n / 1e6 * 10) / 10 : 0;
    return {
      brokerPid: process.pid,
      brokerVersion: version,
      uptimeSeconds: Math.floor(process.uptime()),
      checkedAt: Date.now(),
      eventLoopDelayMs: { p95: ms(this.delay.percentile(95)), max: ms(this.delay.max) },
      recentErrors: this.errors.map((e) => ({ ...e })),
      history: history && {
        phase: history.phase,
        percent: history.percent,
        etaSeconds: history.etaSeconds,
        paused: history.paused,
        completedRows: history.completedRows,
        totalRows: history.totalRows
      },
      backup: backup && {
        phase: backup.phase,
        lastVerifiedAt: backup.lastVerifiedAt,
        lastError: backup.lastError && ["broker_pressure", "backup_failed", "worker_failed"].includes(backup.lastError) ? backup.lastError : null
      }
    };
  }
};
function formatHealth(health) {
  const history = health.history;
  const eta = history?.etaSeconds == null ? "ETA pending" : `ETA ~${Math.ceil(history.etaSeconds / 60)} min`;
  return `Broker latency: ${health.roundTripMs == null ? "not measured" : `${Math.round(health.roundTripMs)} ms`} round trip; event loop p95 ${health.eventLoopDelayMs.p95} ms. ` + (history ? `History import: ${history.phase}, ~${history.percent.toFixed(1)}%, ${eta}${history.paused ? " (paused)" : ""}. ` : "History import: inactive. ") + (health.backup ? `Backup: ${health.backup.phase}${health.backup.lastVerifiedAt == null ? "" : `, last verified ${new Date(health.backup.lastVerifiedAt).toISOString()}`}${health.backup.lastError ? ` (${health.backup.lastError})` : ""}. ` : "Backup: disabled. ") + `Recent request errors: ${health.recentErrors.length}.`;
}
function brokerFailureState(error) {
  const code = error?.code;
  if (code === "ENOENT" || code === "ECONNREFUSED") return "offline";
  if (code === "ETIMEDOUT" || code === "timeout" || /timed out|timeout/i.test(String(error?.message))) return "slow";
  return "unavailable";
}
async function probeBrokerHealth(pipe, log) {
  const started = performance.now();
  const client = await BridgeClient.connect(pipe, log, 1e3);
  try {
    const ping = await client.request("ping", {}, 1e3);
    return ping.health ? { ...ping.health, roundTripMs: performance.now() - started } : null;
  } finally {
    client.close();
  }
}

export {
  HealthMonitor,
  formatHealth,
  brokerFailureState,
  probeBrokerHealth
};
