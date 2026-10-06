import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { Logger } from "../core/logger.js";
import { startUi } from "./ui.js";

/**
 * The dashboard runs inside whichever process hosts the bridge (or a manual `agent-bridge ui`).
 * Its address and secret live in ~/.agent-bridge/dashboard.json (owner-only on Unix), so any session or
 * terminal of this user can open it without starting a second one.
 */
export const DASHBOARD_FILE = "dashboard.json";
const SECRET_BYTES = 24;
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
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

/** The secret of the last dashboard (the file stays after it stops; its dead pid marks it as not running). */
function previousSecret(home: string): string | null {
  const t = readDashboardInfo(home)?.url.match(/[?&]t=([0-9a-f]{16,})/)?.[1];
  return t ?? null;
}

/** The running dashboard, if its owner is alive and it answers. */
export async function findRunningDashboard(home: string): Promise<DashboardInfo | null> {
  const info = readDashboardInfo(home);
  if (!info || !processAlive(info.pid)) return null;
  const secret = info.url.match(/[?&]t=([0-9a-f]{16,})/)?.[1];
  if (!secret) return null;
  return (await probeDashboard(info.port, secret)) ? info : null;
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

  private async open(): Promise<DashboardInfo> {
    if (this.hosted) return this.hosted.info;
    const running = await findRunningDashboard(this.opts.home);
    if (running) return running;
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
export async function hostDashboard(opts: { home: string; pipe: string; port: number; log: Logger }): Promise<HostedDashboard> {
  // A session taking over keeps the previous secret: open dashboard tabs (and saved links) keep working.
  const secret = previousSecret(opts.home) ?? randomBytes(SECRET_BYTES).toString("hex");
  const ui = await startUi({ ...opts, secret });
  const info: DashboardInfo = { url: ui.url, port: ui.port, pid: process.pid };
  const file = dashboardFile(opts.home);
  writeFileSync(file, JSON.stringify(info, null, 2), { mode: OWNER_ONLY });
  try {
    chmodSync(file, OWNER_ONLY);
  } catch {
    // Windows ignores POSIX modes; the file lives in the user's profile.
  }
  opts.log.info("dashboard started", { port: ui.port });
  return {
    info,
    close: async () => {
      await ui.close();
    },
  };
}
