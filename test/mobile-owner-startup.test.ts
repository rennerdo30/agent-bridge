import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_PAGE, mobileDashboardPage } from "../src/cli/ui-page.js";
import { startUi } from "../src/cli/ui.js";
import { nullLogger } from "../src/core/logger.js";
import baseline from "./fixtures/mobile-activation-baseline.json" with { type: "json" };
import type { MobileDesktopAdmin } from "../src/mobile/desktop.js";
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
function home() { const root = resolve(".agent-bridge-test/mobile-activation"); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, "ui-")); }
async function port() { const s = createServer(); await new Promise<void>(r => s.listen(0, "127.0.0.1", r)); const p = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return p; }
describe("owner Phones readiness and unchanged default HTML", () => {
  it("pins the original complete page source and returns its bytes without configuration", () => {
    const current = readFileSync("src/cli/ui-page.ts", "utf8").replaceAll("\r\n", "\n"), addition = '\n/** Default HTML is byte-identical; the fixed local entry is inserted only for a ready prepared host. */\nexport function mobileDashboardPage(ready: boolean): string {\n  return ready ? UI_PAGE.replace(\'<nav class="side-nav">\', \'<nav class="side-nav"><a href="/mobile/phones" id="tabPhones"><span class="ico" aria-hidden="true">▣</span>Phones</a>\') : UI_PAGE;\n}\n';
    expect(current).toContain(addition); expect(createHash("sha256").update(current.replace(addition, "")).digest("hex")).toBe(baseline.pageSha256);
    expect(mobileDashboardPage(false)).toBe(UI_PAGE); expect(mobileDashboardPage(true)).toContain('id="tabPhones"');
  });
  it("gates Phones and status behind desktop auth, readiness and exact host, and removes the link after loss", async () => {
    const p = await port(), origin = `http://127.0.0.1:${p}`; let ready = true, state = "ready";
    const admin = { localOrigin: origin, isReady: () => ready, handle: vi.fn() } as unknown as MobileDesktopAdmin;
    const ui = await startUi({ home: home(), pipe: "fixture-unused", port: p, log: nullLogger, secret: "a".repeat(64), mobileAdmin: admin, mobileStatus: () => state }); closers.push(ui.close);
    expect((await fetch(origin + "/api/mobile/status")).status).toBe(403);
    const visit = await fetch(ui.url, { redirect: "manual" }), cookie = visit.headers.get("set-cookie")!.split(";")[0]!, headers = { cookie };
    expect(await (await fetch(origin, { headers })).text()).toContain('id="tabPhones"'); expect((await fetch(origin + "/mobile/phones", { headers })).status).toBe(200);
    expect(await (await fetch(origin + "/api/mobile/status", { headers })).json()).toEqual({ state: "ready" });
    ready = false; state = "restart_required";
    expect(await (await fetch(origin, { headers })).text()).toBe(UI_PAGE); expect((await fetch(origin + "/mobile/phones", { headers })).status).toBe(503);
    expect(await (await fetch(origin + "/api/mobile/status", { headers })).json()).toEqual({ state: "restart_required" }); expect(admin.handle).not.toHaveBeenCalled();
  });
});
/** Execute the unchanged caller blocks with fake dependencies, without starting CLI/MCP or live endpoints. */
function execute(source: string, bindings: Record<string, unknown>, prelude = "") {
  const code = stripTypeScriptTypes("async function fixtureCaller(){" + prelude + source + "}", { mode: "strip" }).replaceAll('import(', 'fixtureImport(');
  return new Function(...Object.keys(bindings), code + "\nreturn fixtureCaller();")(...Object.values(bindings));
}
describe("existing owner startup caller blocks", () => {
  it.each([false, true])("MCP dashboard hook selects configured activation=%s without changing default startup", async enabled => {
    const file = readFileSync("src/mcp/server.ts", "utf8"), block = file.slice(file.indexOf('  /** Web dashboard hosted by this process'), file.indexOf('  const transport = new StdioServerTransport();'));
    const start = vi.fn(async () => ({ url: "fixture", port: 4321, pid: 0 })), ensure = vi.fn(async () => ({ url: "default", port: 4321, pid: 0 })), configure = vi.fn(async () => ({ start }));
    const bindings = { cfg: { dashboard: true, dashboardPort: 4321 }, mobileAtStartup: enabled ? { enabled: true } : undefined, mobilePortAtStartup: 4321, node: { isBroker: true }, ctx: {} as { openDashboard?: () => Promise<unknown> }, home: "fixture", log: nullLogger, resolvePipePath: () => "fixture-pipe", openBrowser: vi.fn(),
      fixtureImport: async (path: string) => path.includes("activation") ? { configuredMobileDashboard: configure } : { DashboardController: class { ensure = ensure; } } };
    await execute(block + '\nreturn ctx.openDashboard();', bindings); expect(configure).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(start).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(ensure).toHaveBeenCalledTimes(enabled ? 0 : 1);
    expect(file).toContain('const mobileAtStartup = cfg.mobile;');
  });
  it.each([false, true])("existing CLI ui path selects activation=%s and disposes its owned node", async enabled => {
    const file = readFileSync("src/cli/main.ts", "utf8"), block = file.slice(file.indexOf('    case "ui": {'), file.indexOf('    case "watch": {'));
    const start = vi.fn(async () => {}), stop = vi.fn(async () => {}), node = { start, stop }, close = vi.fn(async () => {}), activation = { start: vi.fn(async () => ({ url: "configured", port: 4321, pid: 0 })), close };
    const existing = vi.fn(async () => ({ url: "existing", port: 4321, pid: 0 })), configure = vi.fn(async () => activation), makeNode = vi.fn(() => node), out = vi.fn();
    const bindings = { rest: ["--no-open"], command: "ui", home: "fixture", pipe: "fixture-pipe", log: nullLogger, makeNode, out, openBrowser: vi.fn(), t: (_key: string, args: unknown) => JSON.stringify(args), process: { once: (_event: string, cb: () => void) => cb() },
      loadConfig: () => ({ mobile: enabled ? { enabled: true } : undefined, dashboardPort: 4321 }), fixtureImport: async (path: string) => path.includes("activation") ? { configuredMobileDashboard: configure } : { findRunningDashboard: existing } };
    expect(await execute('switch(command){' + block + '}', bindings)).toBe(0); expect(configure).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(start).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(stop).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(close).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(existing).toHaveBeenCalledTimes(enabled ? 0 : 1);
  });
});
