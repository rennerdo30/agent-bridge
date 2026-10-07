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

describe("dashboard key lifecycle", () => {
  it("keeps the home key when discovery is lost, port changes, and a new host starts", async () => {
    const options = { home: env.home, pipe: env.pipe, port: 0, log: nullLogger };
    const first = await hostDashboard(options);
    const key = new URL(first.info.url).searchParams.get("t");
    const response = await fetch(first.info.url, { redirect: "manual" });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    await first.close();
    unlinkSync(join(env.home, "dashboard.json"));
    const next = await hostDashboard(options);
    try {
      expect(new URL(next.info.url).searchParams.get("t")).toBe(key);
      expect((await fetch(`http://127.0.0.1:${next.info.port}/`, { headers: { cookie } })).status).toBe(200);
      expect(readFileSync(join(env.home, DASHBOARD_KEY_FILE), "utf8")).toBe(key);
      if (process.platform !== "win32") expect(statSync(join(env.home, DASHBOARD_KEY_FILE)).mode & 0o777).toBe(0o600);
    } finally { await next.close(); }
  });

  it("explicit reset invalidates old links and cookies without restarting a live host", async () => {
    const controller = new DashboardController({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    const first = await controller.ensure();
    try {
      const cookie = (await fetch(first.url, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
      const reset = dashboardKey(env.home, true);
      expect(reset).not.toBe(new URL(first.url).searchParams.get("t"));
      expect((await fetch(first.url, { redirect: "manual" })).status).toBe(403);
      expect((await fetch(`http://127.0.0.1:${first.port}/`, { headers: { cookie } })).status).toBe(403);
      const current = await findRunningDashboard(env.home);
      expect(current?.port).toBe(first.port);
      expect(new URL(current!.url).searchParams.get("t")).toBe(reset);
      expect(await controller.ensure()).toEqual(current);
      expect((await fetch(current!.url, { redirect: "manual" })).status).toBe(302);
    } finally { await controller.close(); }
  });

  it("ui --reset-key prints a working current link and ordinary CLI opens preserve it", async () => {
    const hosted = await hostDashboard({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    const cli = join(import.meta.dirname, "..", "plugins", "claude", "dist", "cli.mjs");
    const run = (args: string[]) => promisify(execFile)(process.execPath, [cli, "ui", "--no-open", ...args], {
      env: { ...process.env, AGENT_BRIDGE_HOME: env.home }, windowsHide: true,
    });
    try {
      const before = dashboardKey(env.home);
      const reset = await run(["--reset-key"]);
      expect(dashboardKey(env.home)).not.toBe(before);
      const link = reset.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/)![0];
      expect((await fetch(link, { redirect: "manual" })).status).toBe(302);
      expect(new URL(link).port).toBe(String(hosted.info.port));
      expect((await run([])).stdout).toContain(link);
    } finally { await hosted.close(); }
  });

});
