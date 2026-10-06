import { afterEach, describe, expect, it } from "vitest";
import { startUi } from "../src/cli/ui.js";
import { nullLogger } from "../src/core/logger.js";
import { formatCodexLimits } from "../src/core/usage.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
let ui: Awaited<ReturnType<typeof startUi>>;
afterEach(async () => {
  await ui?.close();
  await env?.cleanup();
});

describe("dashboard usage data (AB-71)", () => {
  it("keeps the shared credit wording and active balance in /api/usage", async () => {
    env = makeEnv();
    const report = formatCodexLimits({ ordinaryUsageAllowed: false, rateLimits: {
      planType: "pro", secondary: { usedPercent: 100, windowDurationMins: 10080 },
      credits: { hasCredits: true, balance: "45914" }, rateLimitReachedType: "rate_limit_reached",
    } });
    ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger, usage: async () => [report] });
    const first = await fetch(ui.url, { redirect: "manual" });
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const base = ui.url.replace(/\/\?t=.*$/, "");
    const response = await fetch(`${base}/api/usage`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.reports).toEqual([report]);
    expect(data.reports[0].lines[0]).toContain("usable, plan limit reached, running on credits (45,914 left)");
    expect(data.reports[0].credits).toEqual({ balance: "45,914", unlimited: false, inUse: true });
    expect(JSON.stringify(data)).not.toMatch(/unusable|LIMIT REACHED|does not allow ordinary usage/);
  });
});
