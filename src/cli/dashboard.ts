import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { Logger } from "../core/logger.js";
import { loadDashboardKey } from "./dashboard-key.js";
import { protect } from "../network/pairing.js";

/**
 * The dashboard runs inside whichever process hosts the bridge (or a manual `agent-bridge ui`).
 * Its address lives in dashboard.json and its long-lived key in dashboard-key (owner-only), so any session or
 * terminal of this user can open it without starting a second one.
 */
export const DASHBOARD_FILE = "dashboard.json";
const PROBE_TIMEOUT_MS = 1_500;
const OWNER_ONLY = 0o600;

export interface DashboardInfo {
  url: string;
  port: number;
  pid: number;
}

export function dashboardFile(home: string): string {
  return join(home, DASHBOARD_FILE);
}

export function readDashboardInfo(home: string): DashboardInfo | null {
  try {
    const d = JSON.parse(readFileSync(dashboardFile(home), "utf8")) as DashboardInfo;
    return typeof d.url === "string" && typeof d.port === "number" && typeof d.pid === "number" ? d : null;
  } catch {
    return null;
  }
}

/** Is an agent-bridge dashboard answering on this port? (It returns 403 without the secret.) */
export function probeDashboard(port: number, secret?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: secret ? `/?t=${secret}` : "/api/state", timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(secret
        ? res.statusCode === 302 && res.headers["set-cookie"]?.some((cookie) => cookie.startsWith(`ab_ui=${secret};`)) === true
        : res.statusCode === 403 || res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Adopt the last link on upgrade so existing bookmarks and cookies survive. */
function previousSecret(home: string): string | undefined {
  const t = readDashboardInfo(home)?.url.match(/[?&]t=([0-9a-f]{16,})/)?.[1];
  return t;
}

export function dashboardKey(home: string, reset = false): string {
  return loadDashboardKey(home, previousSecret(home), reset);
}

function dashboardUrl(port: number, secret: string): string {
  return `http://127.0.0.1:${port}/?t=${secret}`;
}

/** Authenticate the actual listener; a saved PID can be stale after a handover. */
export async function findRunningDashboard(home: string): Promise<DashboardInfo | null> {
  const info = readDashboardInfo(home);
  if (!info || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) return null;
  const secret = dashboardKey(home);
  if (await probeDashboard(info.port, secret)) return { ...info, url: dashboardUrl(info.port, secret) };
  return null;
}

export interface HostedDashboard {
  info: DashboardInfo;
  close: () => Promise<void>;
}

/** Share startup attempts inside a session and recover a winner in another session's race. */
export class DashboardController {
  private hosted: HostedDashboard | null = null;
  private starting: Promise<DashboardInfo> | null = null;
  constructor(private readonly opts: { home: string; pipe: string; port: number; log: Logger }) {}

  ensure(): Promise<DashboardInfo> {
    return this.starting ??= this.open().finally(() => { this.starting = null; });
  }

  get isHosting(): boolean { return this.hosted !== null; }

  private async open(): Promise<DashboardInfo> {
    if (this.hosted) return { ...this.hosted.info, url: dashboardUrl(this.hosted.info.port, dashboardKey(this.opts.home)) };
    const running = await findRunningDashboard(this.opts.home);
    if (running) return running;
    const preferred = readDashboardInfo(this.opts.home)?.port || this.opts.port;
    try {
      this.hosted = await hostDashboard(this.opts);
      return this.hosted.info;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      // The successful host may still be publishing dashboard.json after binding its listener.
      for (let attempt = 0; attempt < 10; attempt++) {
        const winner = await findRunningDashboard(this.opts.home);
        if (winner) return winner;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // Deterministic fallback ports let concurrent sessions race for the same listener,
      // rather than each opening a different ephemeral port.
      for (let offset = 1; offset <= 32; offset++) {
        const winner = await findRunningDashboard(this.opts.home);
        if (winner) return winner;
        const port = (preferred + offset - 1) % 65535 + 1;
        try {
          this.hosted = await hostDashboard({ ...this.opts, port, preferSavedPort: false });
          return this.hosted.info;
        } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException).code !== "EADDRINUSE") throw fallbackError;
          for (let attempt = 0; attempt < 10; attempt++) {
            const winner = await findRunningDashboard(this.opts.home);
            if (winner) return winner;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.starting?.catch(() => {});
    await this.hosted?.close();
    this.hosted = null;
  }
}

/** Start the dashboard in this process and publish its link. Fails with EADDRINUSE if the port is taken. */
export async function hostDashboard(opts: { home: string; pipe: string; port: number; log: Logger; preferSavedPort?: boolean }): Promise<HostedDashboard> {
  const { startUi } = await import("./ui.js");
  // A session taking over keeps the previous secret: open dashboard tabs (and saved links) keep working.
  dashboardKey(opts.home);
  const saved = readDashboardInfo(opts.home)?.port;
  const port = opts.preferSavedPort !== false && saved && Number.isInteger(saved) && saved > 0 && saved <= 65535 ? saved : opts.port;
  const ui = await startUi({ ...opts, port });
  const info: DashboardInfo = { url: ui.url, port: ui.port, pid: process.pid };
  const file = dashboardFile(opts.home);
  try {
    try { writeFileSync(file, "", { flag: "wx", mode: OWNER_ONLY }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    protect(file, OWNER_ONLY);
    writeFileSync(file, JSON.stringify(info, null, 2));
  }
  catch (err) { await ui.close(); throw err; }
  opts.log.info("dashboard started", { port: ui.port });
  return {
    info,
    close: async () => {
      await ui.close();
    },
  };
}
