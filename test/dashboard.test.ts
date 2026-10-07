import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DashboardController, dashboardKey, findRunningDashboard, hostDashboard, readDashboardInfo } from "../src/cli/dashboard.js";
import { readFileSync, unlinkSync, writeFileSync, statSync } from "node:fs";
import { DASHBOARD_KEY_FILE } from "../src/cli/dashboard-key.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { join } from "node:path";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

describe("shared dashboard", () => {
  it("returns one URL for concurrent opens and repeated calls from another session", async () => {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const options = { home: env.home, pipe: env.pipe, port, log: nullLogger };
    const first = new DashboardController(options);
    const second = new DashboardController(options);
    try {
      const opened = await Promise.all([first.ensure(), first.ensure(), second.ensure()]);
      expect(opened[0]).toEqual(opened[1]);
      expect(opened[0]).toEqual(opened[2]);
      expect(await first.ensure()).toEqual(opened[0]);
    } finally { await first.close(); await second.close(); }
    const hosted = await hostDashboard(options);
    const reuse = new DashboardController({ ...options, port: hosted.info.port });
    try {
      expect(await reuse.ensure()).toEqual(hosted.info);
      expect(await reuse.ensure()).toEqual(hosted.info);
      await reuse.close();
      expect(await findRunningDashboard(env.home)).toEqual(hosted.info);
    } finally { await reuse.close(); await hosted.close(); }
  });

  it("does not reuse an unrelated server that answers forbidden on the old port", async () => {
    const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(env.home, "dashboard.json"), JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}/?t=${"a".repeat(48)}` }));
    const controller = new DashboardController({ home: env.home, pipe: env.pipe, port, log: nullLogger });
    try {
      expect(await findRunningDashboard(env.home)).toBeNull();
      const fallback = await controller.ensure();
      expect(fallback.port).not.toBe(port);
      expect(await findRunningDashboard(env.home)).toEqual(fallback);
      const other = new DashboardController({ home: env.home, pipe: env.pipe, port, log: nullLogger });
      expect(await other.ensure()).toEqual(fallback);
      await other.close();
      await controller.close();
      const restarted = await controller.ensure();
      expect(restarted.port).toBe(fallback.port);
    } finally { await controller.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("publishes its link, is found by others, and keeps its secret for the next host", async () => {
    expect(await findRunningDashboard(env.home)).toBeNull();
    const hosted = await hostDashboard({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    expect(readDashboardInfo(env.home)).toMatchObject({ port: hosted.info.port, pid: process.pid });
    const found = await findRunningDashboard(env.home);
    expect(found?.url).toBe(hosted.info.url);
    expect((await fetch(found!.url, { redirect: "manual" })).status).toBe(302);
    await hosted.close();
    expect(await findRunningDashboard(env.home)).toBeNull();
    const next = await hostDashboard({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    expect(new URL(next.info.url).searchParams.get("t")).toBe(new URL(hosted.info.url).searchParams.get("t"));
    await next.close();
  });

  it("fails when the port is taken instead of starting a second one", async () => {
    const first = await hostDashboard({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    await expect(hostDashboard({ home: env.home, pipe: env.pipe, port: first.info.port, log: nullLogger })).rejects.toMatchObject({ code: "EADDRINUSE" });
    await first.close();
  });

  it("concurrent sessions share the same fallback when the preferred port is occupied", async () => {
    const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const options = { home: env.home, pipe: env.pipe, port, log: nullLogger };
    const a = new DashboardController(options), b = new DashboardController(options);
    try {
      const [first, second] = await Promise.all([a.ensure(), b.ensure()]);
      expect(first).toEqual(second);
      expect(first.port).not.toBe(port);
    } finally { await a.close(); await b.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("adopts a legacy saved link and ignores stale owner PID when the host answers", async () => {
    const key = "a".repeat(48);
    writeFileSync(join(env.home, "dashboard.json"), JSON.stringify({ pid: -1, port: 1, url: `http://127.0.0.1:1/?t=${key}` }));
    expect(dashboardKey(env.home)).toBe(key);
    const hosted = await hostDashboard({ home: env.home, pipe: env.pipe, port: 0, preferSavedPort: false, log: nullLogger });
    try {
      writeFileSync(join(env.home, "dashboard.json"), JSON.stringify({ ...hosted.info, pid: -1 }));
      expect((await findRunningDashboard(env.home))?.port).toBe(hosted.info.port);
    } finally { await hosted.close(); }
  });
});
