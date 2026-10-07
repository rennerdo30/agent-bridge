import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  loadDashboardKey
} from "./chunk-LK52LQ4H.mjs";
import {
  protect
} from "./chunk-YAVVVLOG.mjs";

// src/cli/dashboard.ts
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
var DASHBOARD_FILE = "dashboard.json";
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
  return t;
}
function dashboardKey(home, reset = false) {
  return loadDashboardKey(home, previousSecret(home), reset);
}
function dashboardUrl(port, secret) {
  return `http://127.0.0.1:${port}/?t=${secret}`;
}
async function findRunningDashboard(home) {
  const info = readDashboardInfo(home);
  if (!info || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) return null;
  const secret = dashboardKey(home);
  if (await probeDashboard(info.port, secret)) return { ...info, url: dashboardUrl(info.port, secret) };
  return null;
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
  get isHosting() {
    return this.hosted !== null;
  }
  async open() {
    if (this.hosted) return { ...this.hosted.info, url: dashboardUrl(this.hosted.info.port, dashboardKey(this.opts.home)) };
    const running = await findRunningDashboard(this.opts.home);
    if (running) return running;
    const preferred = readDashboardInfo(this.opts.home)?.port || this.opts.port;
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
      for (let offset = 1; offset <= 32; offset++) {
        const winner = await findRunningDashboard(this.opts.home);
        if (winner) return winner;
        const port = (preferred + offset - 1) % 65535 + 1;
        try {
          this.hosted = await hostDashboard({ ...this.opts, port, preferSavedPort: false });
          return this.hosted.info;
        } catch (fallbackError) {
          if (fallbackError.code !== "EADDRINUSE") throw fallbackError;
          for (let attempt = 0; attempt < 10; attempt++) {
            const winner2 = await findRunningDashboard(this.opts.home);
            if (winner2) return winner2;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
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
  const { startUi } = await import("./ui-HTDNVHHA.mjs");
  dashboardKey(opts.home);
  const saved = readDashboardInfo(opts.home)?.port;
  const port = opts.preferSavedPort !== false && saved && Number.isInteger(saved) && saved > 0 && saved <= 65535 ? saved : opts.port;
  const ui = await startUi({ ...opts, port });
  const info = { url: ui.url, port: ui.port, pid: process.pid };
  const file = dashboardFile(opts.home);
  try {
    try {
      writeFileSync(file, "", { flag: "wx", mode: OWNER_ONLY });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    protect(file, OWNER_ONLY);
    writeFileSync(file, JSON.stringify(info, null, 2));
  } catch (err) {
    await ui.close();
    throw err;
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
  dashboardKey,
  findRunningDashboard,
  DashboardController,
  hostDashboard
};
