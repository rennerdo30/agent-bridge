import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as ui from "../src/cli/ui.js";
import { DashboardController, findRunningDashboard } from "../src/cli/dashboard.js";
import { createServer } from "node:http";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
  it("skips a reserved fallback port and shares the next listener", async () => {
    const realStart = ui.startUi;
    let deniedPort: number | undefined;
    vi.spyOn(ui, "startUi").mockImplementation(async (options) => {
      if (deniedPort === undefined) deniedPort = options.port;
      if (options.port === deniedPort || options.port === deniedPort % 65535 + 1) throw Object.assign(new Error("reserved port"), { code: "EACCES" });
      return realStart(options);
    });
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const options = { home: env.home, pipe: env.pipe, port, log: nullLogger };
    const a = new DashboardController(options), b = new DashboardController(options);
    try {
      const [first, second] = await Promise.all([a.ensure(), b.ensure()]);
      expect(first).toEqual(second);
      expect(first.port).not.toBe(deniedPort);
      expect(first.port).not.toBe(deniedPort! % 65535 + 1);
      expect(await findRunningDashboard(env.home)).toEqual(first);
    } finally { await a.close(); await b.close(); }
  });

