import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
export function probeDashboard(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/state", timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(res.statusCode === 403 || res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** The running dashboard, if its owner is alive and it answers. */
export async function findRunningDashboard(home: string): Promise<DashboardInfo | null> {
  const info = readDashboardInfo(home);
  if (!info || !processAlive(info.pid)) return null;
  return (await probeDashboard(info.port)) ? info : null;
}

export interface HostedDashboard {
  info: DashboardInfo;
  close: () => Promise<void>;
}

/** Start the dashboard in this process and publish its link. Fails with EADDRINUSE if the port is taken. */
export async function hostDashboard(opts: { home: string; pipe: string; port: number; log: Logger }): Promise<HostedDashboard> {
  const secret = randomBytes(SECRET_BYTES).toString("hex");
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
      if (readDashboardInfo(opts.home)?.pid === process.pid) rmSync(file, { force: true });
    },
  };
}
