import { createServer, type Socket } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthMonitor, brokerFailureState, formatHealth, probeBrokerHealth } from "../src/core/health.js";
import { nullLogger } from "../src/core/logger.js";
import { startUi } from "../src/cli/ui.js";
import { registerTools } from "../src/mcp/server.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { makeEnv, type TestEnv } from "./helpers.js";

describe("cheap broker diagnostics", () => {
  it("stops native delay sampling while idle and resumes on request activity", async () => {
    vi.useFakeTimers();
    const enable = vi.fn(), disable = vi.fn();
    // Each histogram reports its own maximum: the first saw a 20 ms delay, a later one only 1 ms.
    const created: number[] = [20_000_000, 1_000_000];
    const monitor = new HealthMonitor(() => { const ns = created.shift() ?? 1_000_000; return { enable, disable, percentile: () => ns, max: ns } as any; });
    try {
      monitor.start(); await vi.advanceTimersByTimeAsync(4_000); monitor.start();
      expect(enable).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_999); expect(disable).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(disable).toHaveBeenCalledTimes(1);
      expect(monitor.snapshot("fixture", null).eventLoopDelayMs).toEqual({ p95: 20, max: 20 });
      // Re-enabling after an idle gap uses a fresh histogram, so the gap never reads as a delay (AB-257).
      monitor.start(); expect(enable).toHaveBeenCalledTimes(2);
      expect(monitor.snapshot("fixture", null).eventLoopDelayMs).toEqual({ p95: 1, max: 1 });
      monitor.close(); await vi.advanceTimersByTimeAsync(10_000); monitor.start();
      expect(enable).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    } finally { monitor.close(); vi.useRealTimers(); }
  });
  let env: TestEnv;
  beforeEach(() => { env = makeEnv(); writeFileSync(join(env.home, "config.json"), JSON.stringify({ history: { ingest: false } })); });
  afterEach(async () => { await env.cleanup(); });

  it("only reports an absent broker for a missing or refused endpoint", () => {
    expect(brokerFailureState({ code: "ENOENT" })).toBe("offline");
    expect(brokerFailureState({ code: "ECONNREFUSED" })).toBe("offline");
    expect(brokerFailureState({ code: "ETIMEDOUT" })).toBe("slow");
    expect(brokerFailureState(new Error("broker request timed out: peers"))).toBe("slow");
    expect(brokerFailureState(new Error("connection to broker closed"))).toBe("unavailable");
  });

  it("bounds request errors and excludes history paths and user error text", () => {
    const monitor = new HealthMonitor();
    for (let i = 0; i < 20; i++) monitor.error("send", "store_busy", i);
    const health = monitor.snapshot("test", { phase: "copy", percent: 50, etaSeconds: 120, paused: false, completedRows: 50, totalRows: 100, snapshot: "private-path", error: "private-error" } as any);
    expect(health.recentErrors).toHaveLength(10);
    expect(health.recentErrors[0]!.at).toBe(10);
    expect(JSON.stringify(health)).not.toContain("private-");
    expect(formatHealth(health)).toContain("History import: copy, ~50.0%, ETA ~2 min");
    health.recentErrors.length = 0;
    expect(monitor.snapshot("test", null).recentErrors).toHaveLength(10);
    monitor.close();
  });

  it("exposes latency through ping without credential IO or session registration", async () => {
    const node = env.node("codex-health", "codex"); await node.start();
    const before = (await node.peers()).length;
    const health = await probeBrokerHealth(env.pipe, nullLogger);
    expect(health).toMatchObject({ brokerPid: process.pid, recentErrors: [] });
    expect(health!.history).not.toBeNull();
    expect(health!.backup?.phase).not.toBe("paused");
    expect(health!.roundTripMs).toBeGreaterThanOrEqual(0);
    expect((await node.peers()).length).toBe(before);
    expect(await node.health()).toMatchObject({ brokerPid: process.pid });
  });

  it("reports cached backup progress without leaking extra fields or error bodies", () => {
    const monitor = new HealthMonitor();
    const cached = { phase: "verified", lastVerifiedAt: 1_000, lastError: null, path: "private-path" } as const;
    const health = monitor.snapshot("test", null, cached);
    expect(health.backup).toEqual({ phase: "verified", lastVerifiedAt: 1_000, lastError: null });
    expect(formatHealth(health)).toContain("Backup: verified, last verified 1970-01-01T00:00:01.000Z");
    expect(JSON.stringify(health)).not.toContain("private-path");
    const failed = monitor.snapshot("test", null, { phase: "failed", lastVerifiedAt: null, lastError: "worker_failed" });
    expect(failed.backup?.lastError).toBe("worker_failed");
    expect(monitor.snapshot("test", null, { ...cached, lastError: "private error body" }).backup?.lastError).toBeNull();
    monitor.close();
  });

  it("dashboard reports a stalled broker as slow, keeping absence separate", async () => {
    const sockets = new Set<Socket>();
    const server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(env.pipe, resolve));
    const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    try {
      const auth = await fetch(ui.url, { redirect: "manual" });
      const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
      const base = new URL(ui.url).origin;
      const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json() as any;
      expect(state).toMatchObject({ brokerState: "slow", brokerPid: null });
      const page = await (await fetch(base, { headers: { cookie } })).text();
      expect(page).toContain("Bridge responding slowly");
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      const offline = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json() as any;
      expect(offline.brokerState).toBe("offline");
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await ui.close();
    }
  });

  it("delegated MCP servers expose health without an independent peer", async () => {
    const node = env.node("codex-health", "codex"); await node.start();
    const callbacks = new Map<string, any>();
    registerTools({ registerTool: (name: string, _config: unknown, cb: any) => callbacks.set(name, cb) } as any,
      { node: null, home: env.home, cfg: DEFAULT_CONFIG, agent: "codex", log: nullLogger, cwd: () => env.home, channelActive: () => false }, []);
    expect(callbacks.has("health")).toBe(true);
    expect(callbacks.has("ask_owner")).toBe(false);
    const result = await callbacks.get("health")({}, {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ brokerPid: process.pid });
    expect(await node.peers()).toHaveLength(1);
  });
});
