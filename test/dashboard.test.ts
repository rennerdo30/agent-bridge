import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dashboardFile, findRunningDashboard, hostDashboard, readDashboardInfo } from "../src/cli/dashboard.js";
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
  it("publishes its link, is found by others, and cleans up on close", async () => {
    expect(await findRunningDashboard(env.home)).toBeNull();
    const hosted = await hostDashboard({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    expect(readDashboardInfo(env.home)).toMatchObject({ port: hosted.info.port, pid: process.pid });
    const found = await findRunningDashboard(env.home);
    expect(found?.url).toBe(hosted.info.url);
    expect((await fetch(found!.url, { redirect: "manual" })).status).toBe(302);
    await hosted.close();
    expect(existsSync(dashboardFile(env.home))).toBe(false);
    expect(await findRunningDashboard(env.home)).toBeNull();
  });

  it("fails when the port is taken instead of starting a second one", async () => {
    const first = await hostDashboard({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    await expect(hostDashboard({ home: env.home, pipe: env.pipe, port: first.info.port, log: nullLogger })).rejects.toMatchObject({ code: "EADDRINUSE" });
    await first.close();
  });
});
