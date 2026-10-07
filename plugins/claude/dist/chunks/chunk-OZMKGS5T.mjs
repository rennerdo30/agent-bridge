import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/cli/dashboard.ts
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
var DASHBOARD_FILE = "dashboard.json";
var SECRET_BYTES = 24;
var PROBE_TIMEOUT_MS = 1500;
var OWNER_ONLY = 384;
function dashboardFile(home) {
  return join(home, DASHBOARD_FILE);
}
function readDashboardInfo(home) {
  try {
    const d = JSON.parse(readFileSync(dashboardFile(home), "utf8"));
    return typeof d.url === "string" && typeof d.port === "number" && typeof d.pid === "number" ? d : null;
  } catch {
    return null;
  }
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function probeDashboard(port, secret) {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: secret ? `/?t=${secret}` : "/api/state", timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(secret ? res.statusCode === 302 && res.headers["set-cookie"]?.some((cookie) => cookie.startsWith(`ab_ui=${secret};`)) === true : res.statusCode === 403 || res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}
function previousSecret(home) {
  const t = readDashboardInfo(home)?.url.match(/[?&]t=([0-9a-f]{16,})/)?.[1];
  return t ?? null;
}
async function findRunningDashboard(home) {
  const info = readDashboardInfo(home);
  if (!info || !processAlive(info.pid)) return null;
  const secret = info.url.match(/[?&]t=([0-9a-f]{16,})/)?.[1];
  if (!secret) return null;
  return await probeDashboard(info.port, secret) ? info : null;
}
var DashboardController = class {
  constructor(opts) {
    this.opts = opts;
  }
  opts;
  hosted = null;
  starting = null;
  ensure() {
    return this.starting ??= this.open().finally(() => {
      this.starting = null;
    });
  }
  async open() {
    if (this.hosted) return this.hosted.info;
    const running = await findRunningDashboard(this.opts.home);
    if (running) return running;
    try {
      this.hosted = await hostDashboard(this.opts);
      return this.hosted.info;
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
      for (let attempt = 0; attempt < 10; attempt++) {
        const winner = await findRunningDashboard(this.opts.home);
        if (winner) return winner;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw err;
    }
  }
  async close() {
    await this.starting?.catch(() => {
    });
    await this.hosted?.close();
    this.hosted = null;
  }
};
async function hostDashboard(opts) {
  const { startUi } = await import("./ui-LY2K35HM.mjs");
  const secret = previousSecret(opts.home) ?? randomBytes(SECRET_BYTES).toString("hex");
  const ui = await startUi({ ...opts, secret });
  const info = { url: ui.url, port: ui.port, pid: process.pid };
  const file = dashboardFile(opts.home);
  writeFileSync(file, JSON.stringify(info, null, 2), { mode: OWNER_ONLY });
  try {
    chmodSync(file, OWNER_ONLY);
  } catch {
  }
  opts.log.info("dashboard started", { port: ui.port });
  return {
    info,
    close: async () => {
      await ui.close();
    }
  };
}

export {
  DASHBOARD_FILE,
  dashboardFile,
  readDashboardInfo,
  probeDashboard,
  findRunningDashboard,
  DashboardController,
  hostDashboard
};
