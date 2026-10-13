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
import { configuredMobileDashboard } from "../src/mobile/activation.js";
import * as dashboardModule from "../src/cli/dashboard.js";
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
function home() { const root = resolve(".agent-bridge-test/mobile-activation"); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, "ui-")); }
async function port() { const s = createServer(); await new Promise<void>(r => s.listen(0, "127.0.0.1", r)); const p = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return p; }
describe("owner Phones readiness and unchanged default HTML", () => {
  it("pins the original complete page source and returns its bytes without configuration", () => {
    const current = readFileSync("src/cli/ui-page.ts", "utf8").replaceAll("\r\n", "\n"), addition = current.slice(current.indexOf('\n/** Default HTML is byte-identical;'), current.indexOf('\n/**', current.indexOf('export function mobileDashboardPage')));
    expect(current).toContain(addition); expect(createHash("sha256").update(current.replace(addition, "")).digest("hex")).toBe(baseline.pageSha256);
    expect(mobileDashboardPage(false)).toBe(UI_PAGE); expect(mobileDashboardPage(true)).toContain('id="tabPhones"');
    expect(mobileDashboardPage(false, '<script>private material path</script>')).toContain('Phones unavailable: source_unavailable');
    expect(mobileDashboardPage(false, '<script>private material path</script>')).not.toContain('<script>private material path');
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
    expect(await (await fetch(origin, { headers })).text()).toContain('Phones unavailable: restart_required'); expect((await fetch(origin + "/mobile/phones", { headers })).status).toBe(503);
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
    const start = vi.fn(async () => ({ url: "fixture", port: 4321, pid: 0 })), ensure = vi.fn(async () => ({ url: "default", port: 4321, pid: 0 })), configure = vi.fn(async () => ({ start, status: () => "ready" }));
    const bindings = { cfg: { dashboard: true, dashboardPort: 4321 }, mobileAtStartup: enabled ? { enabled: true } : undefined, mobilePortAtStartup: 4321, node: { isBroker: true }, ctx: {} as { openDashboard?: () => Promise<unknown> }, home: "fixture", log: nullLogger, resolvePipePath: () => "fixture-pipe", openBrowser: vi.fn(),
      fixtureImport: async (path: string) => path.includes("activation") ? { configuredMobileDashboard: configure } : { DashboardController: class { ensure = ensure; } } };
    await execute(block + '\nreturn ctx.openDashboard();', bindings); expect(configure).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(start).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(ensure).toHaveBeenCalledTimes(enabled ? 0 : 1);
    expect(file).toContain('const mobileAtStartup = cfg.mobile;');
  });
  it.each([false, true])("existing CLI ui path selects activation=%s and disposes its owned node", async enabled => {
    const file = readFileSync("src/cli/main.ts", "utf8"), block = file.slice(file.indexOf('    case "ui": {'), file.indexOf('    case "watch": {'));
    const start = vi.fn(async () => {}), stop = vi.fn(async () => {}), node = { start, stop }, close = vi.fn(async () => {}), activation = { start: vi.fn(async () => ({ url: "configured", port: 4321, pid: 0 })), close, status: () => "ready" };
    const existing = vi.fn(async () => enabled ? null : ({ url: "existing", port: 4321, pid: 0 })), configure = vi.fn(async () => activation), makeNode = vi.fn(() => node), out = vi.fn();
    const bindings = { rest: ["--no-open"], command: "ui", home: "fixture", pipe: "fixture-pipe", log: nullLogger, makeNode, brokerDaemon: undefined, out, openBrowser: vi.fn(), t: (_key: string, args: unknown) => JSON.stringify(args), process: { once: (_event: string, cb: () => void) => cb() },
      loadConfig: () => ({ mobile: enabled ? { enabled: true } : undefined, dashboardPort: 4321 }), fixtureImport: async (path: string) => path.includes("activation") ? { configuredMobileDashboard: configure } : { findRunningDashboard: existing } };
    expect(await execute('switch(command){' + block + '}', bindings)).toBe(0); expect(configure).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(start).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(stop).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(close).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(existing).toHaveBeenCalledTimes(1);
  });
  it.each(["invalid", "missing"])("real %s mobile activation yields normal MCP desktop plus safe unavailable status", async failure => {
    const root = home(), p = await port(), node = { isBroker: true, initializeMobileOwnerQuestions: vi.fn(() => false), mobileHostContext: vi.fn(() => undefined) };
    const config = failure === "invalid" ? { enabled: true as const, invalid: true as const } : { enabled: true as const, pcId: "fixture", origins: ["https://fixture.test:8443"], listeners: [{ origin: "https://fixture.test:8443", bindAddress: "192.168.1.2", port: 8443, certFile: join(root, "missing-cert"), keyFile: join(root, "missing-key") }] };
    const file = readFileSync("src/mcp/server.ts", "utf8"), block = file.slice(file.indexOf('  /** Web dashboard hosted by this process'), file.indexOf('  const transport = new StdioServerTransport();'));
    const bindings = { cfg: { dashboard: true, dashboardPort: p }, mobileAtStartup: config, mobilePortAtStartup: p, node, ctx: {} as { openDashboard?: () => Promise<string> }, home: root, log: nullLogger, resolvePipePath: () => "fixture-unused", openBrowser: vi.fn(),
      fixtureImport: async (path: string) => path.includes("activation") ? { configuredMobileDashboard } : { ...dashboardModule, DashboardController: class extends dashboardModule.DashboardController { constructor(opts: dashboardModule.DashboardHostOptions) { super(opts); closers.push(() => this.close()); } } } };
    const url = await execute(block + '\nreturn ctx.openDashboard();', bindings) as string;
    expect(url).toContain('phonesStatus='); const visit = await fetch(url, { redirect: "manual" }), cookie = visit.headers.get("set-cookie")!.split(";")[0]!;
    const page = await fetch(new URL(visit.headers.get("location")!, url), { headers: { cookie } }); expect(page.status).toBe(200);
    const category = failure === "invalid" ? "config_invalid" : "material_unavailable";
    expect(await page.text()).toContain('Phones unavailable: ' + category); expect(await (await fetch(new URL('/api/mobile/status', url), { headers: { cookie } })).json()).toEqual({ state: category });
    expect(node.initializeMobileOwnerQuestions).not.toHaveBeenCalled(); expect(node.mobileHostContext).not.toHaveBeenCalled();
  });
  it("CLI nonowner opens the recognized existing desktop with exit 0, without materials/service or duplicate host", async () => {
    const root = home(), p = await port(), running = await dashboardModule.hostDashboard({ home: root, pipe: "fixture-unused", port: p, log: nullLogger }); closers.push(running.close);
    const node = { isBroker: false, start: vi.fn(async () => {}), stop: vi.fn(async () => {}), initializeMobileOwnerQuestions: vi.fn(() => false), mobileHostContext: vi.fn(() => undefined) }, material = vi.fn(async () => { throw new Error("should never read"); });
    const config = { enabled: true as const, pcId: "fixture", origins: ["https://fixture.test:8443"], listeners: [{ origin: "https://fixture.test:8443", bindAddress: "192.168.1.2", port: 8443, certFile: join(root, "missing-cert"), keyFile: join(root, "missing-key") }] };
    const file = readFileSync("src/cli/main.ts", "utf8"), block = file.slice(file.indexOf('    case "ui": {'), file.indexOf('    case "watch": {')), openBrowser = vi.fn(), createDesktop = vi.fn();
    const bindings = { rest: [], command: "ui", home: root, pipe: "fixture-unused", log: nullLogger, makeNode: () => node, out: vi.fn(), openBrowser, t: (_key: string, args: unknown) => JSON.stringify(args), process: { once: vi.fn() }, loadConfig: () => ({ mobile: config, dashboardPort: p }),
      fixtureImport: async (path: string) => path.includes("activation") ? { configuredMobileDashboard: (n: typeof node, c: typeof config, opts: Parameters<typeof configuredMobileDashboard>[2]) => configuredMobileDashboard(n, c, opts, { material }) } : { ...dashboardModule, DashboardController: createDesktop } };
    expect(await execute('switch(command){' + block + '}', bindings)).toBe(0); expect(createDesktop).not.toHaveBeenCalled(); expect(material).not.toHaveBeenCalled(); expect(node.initializeMobileOwnerQuestions).not.toHaveBeenCalled(); expect(node.start).not.toHaveBeenCalled();
    const url = openBrowser.mock.calls[0]![0] as string; expect(new URL(url).port).toBe(String(p));
    const visit = await fetch(url, { redirect: "manual" }), cookie = visit.headers.get("set-cookie")!.split(";")[0]!;
    const page = await fetch(new URL(visit.headers.get("location")!, url), { headers: { cookie } }); expect(page.status).toBe(200); expect(await page.text()).toContain('Phones unavailable: source_unavailable');
  });
  it.each(["invalid", "missing"])("CLI %s activation still hosts normal desktop with safe unavailable status and exits 0", async failure => {
    const root = home(), p = await port(), node = { isBroker: true, start: vi.fn(async () => {}), stop: vi.fn(async () => {}), initializeMobileOwnerQuestions: vi.fn(() => false), mobileHostContext: vi.fn(() => undefined) };
    const config = failure === "invalid" ? { enabled: true as const, invalid: true as const } : { enabled: true as const, pcId: "fixture", origins: ["https://fixture.test:8443"], listeners: [{ origin: "https://fixture.test:8443", bindAddress: "192.168.1.2", port: 8443, certFile: join(root, "missing-cert"), keyFile: join(root, "missing-key") }] };
    const file = readFileSync("src/cli/main.ts", "utf8"), block = file.slice(file.indexOf('    case "ui": {'), file.indexOf('    case "watch": {')); let signal!: () => void;
    const out = vi.fn(), bindings = { rest: ["--no-open"], command: "ui", home: root, pipe: "fixture-unused", log: nullLogger, makeNode: () => node, brokerDaemon: undefined, out, openBrowser: vi.fn(), t: (_key: string, args: unknown) => JSON.stringify(args), process: { once: (_event: string, cb: () => void) => { signal = cb; } }, loadConfig: () => ({ mobile: config, dashboardPort: p }),
      fixtureImport: async (path: string) => path.includes("activation") ? { configuredMobileDashboard } : { ...dashboardModule, DashboardController: class extends dashboardModule.DashboardController { constructor(opts: dashboardModule.DashboardHostOptions) { super(opts); closers.push(() => this.close()); } } } };
    const pending = execute('switch(command){' + block + '}', bindings);
    while (!signal) await new Promise<void>(resolve => setImmediate(resolve));
    const url = JSON.parse(out.mock.calls[0]![0] as string).url as string, visit = await fetch(url, { redirect: "manual" }), cookie = visit.headers.get("set-cookie")!.split(";")[0]!;
    const page = await fetch(new URL(visit.headers.get("location")!, url), { headers: { cookie } }); expect(page.status).toBe(200);
    expect(await page.text()).toContain('Phones unavailable: ' + (failure === "invalid" ? "config_invalid" : "material_unavailable"));
    expect(node.initializeMobileOwnerQuestions).not.toHaveBeenCalled(); signal(); expect(await pending).toBe(0);
  });
});
