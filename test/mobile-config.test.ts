import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, promises as fs } from "node:fs";
import { resolve, join } from "node:path";
import { parseMobileConfig, privateAddress, readPrivateMaterial, windowsPrivateAcl } from "../src/mobile/config.js";
import { loadConfig, DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";

function home() { const root = resolve(".agent-bridge-test/mobile-activation"); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, "config-")); }
function valid(root: string) { return { enabled: true, pcId: "fixture-pc", origins: ["https://fixture.test:8443"], listeners: [{ origin: "https://fixture.test:8443", bindAddress: "192.168.1.2", port: 8443, certFile: join(root, "cert"), keyFile: join(root, "key") }] }; }
describe("home-only explicit mobile config", () => {
  it("preserves absent/disabled serialized defaults and ignores project/agent/environment activation", () => {
    const root = home(), project = home(); mkdirSync(join(project, ".agent-bridge"));
    writeFileSync(join(project, ".agent-bridge/config.json"), JSON.stringify({ mobile: valid(root), codex: { mobile: valid(root) } }));
    writeFileSync(join(root, "config.json"), JSON.stringify({ mobile: { enabled: false }, codex: { mobile: valid(root) } }));
    const cfg = loadConfig(root, "codex", nullLogger, { AGENT_BRIDGE_MOBILE: "true" }, project);
    expect(cfg).not.toHaveProperty("mobile"); expect(DEFAULT_CONFIG).not.toHaveProperty("mobile");
    expect(parseMobileConfig(undefined)).toBeUndefined(); expect(parseMobileConfig({ enabled: false, materialRef: "ignored" })).toBeUndefined();
  });
  it("rejects nonexact origins/port, public wildcard and inline credential keys", () => {
    const root = home(), base = valid(root);
    expect(parseMobileConfig(base)).toEqual(base);
    for (const value of [{ ...base, origins: ["http://fixture.test:8443"] }, { ...base, origins: ["https://fixture.test:8443/"] },
      { ...base, listeners: [{ ...base.listeners[0], port: 443 }] }, { ...base, listeners: [{ ...base.listeners[0], bindAddress: "0.0.0.0" }] },
      { ...base, accessToken: "fixture-token" }, { ...base, push: { provider: "expo", materialRef: "relative", projectId: "fixture", environment: "production" } }])
      expect(parseMobileConfig(value)).toEqual({ enabled: true, invalid: true });
  });
  it("never projects material paths in effective config diagnostics", () => {
    const root = home(), cfg = valid(root); writeFileSync(join(root, "config.json"), JSON.stringify({ mobile: cfg }));
    const debug = vi.fn(); expect(loadConfig(root, "codex", { ...nullLogger, debug }, {}).mobile).toEqual(cfg);
    expect(JSON.stringify(debug.mock.calls)).not.toContain(cfg.listeners[0]!.keyFile);
  });
  it("accepts only private LAN, loopback, Tailscale and ULA addresses", () => {
    for (const ip of ["10.0.0.1", "192.168.1.2", "172.31.1.2", "100.64.1.2", "127.0.0.1", "fd00::1", "::1"]) expect(privateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "0.0.0.0", "100.63.1.2", "172.32.1.2", "::", "2001:4860::1", "fixture.test"]) expect(privateAddress(ip)).toBe(false);
  });
});
describe("activation-only private material", () => {
  it.skipIf(process.platform !== "win32")("real ACL adapter denies synthetic lookup failure, including nonterminating PowerShell errors", async () => {
    expect(await windowsPrivateAcl(join(home(), "missing-synthetic"))).toBe(false);
  });
  it("bounds reads to max+1 when a synthetic file grows after metadata validation", async () => {
    const root = home(), file = join(root, "growing"); writeFileSync(file, "fixture");
    const original = fs.open.bind(fs); let observed = 0;
    const open = vi.spyOn(fs, "open").mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args), read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async options => {
        observed = Math.max(observed, options?.length ?? 0); writeFileSync(file, Buffer.alloc(256 * 1024)); return read(options);
      }); return handle;
    });
    await expect(readPrivateMaterial(file, { platform: "win32", acl: async () => true })).rejects.toMatchObject({ message: "material_unavailable" });
    expect(observed).toBe(64 * 1024 + 1); open.mockRestore();
  });
  it("fails closed on missing/unreadable files with no path or OS error", async () => {
    const root = home(), file = join(root, "private");
    await expect(readPrivateMaterial(file)).rejects.toMatchObject({ message: "material_unavailable" });
    writeFileSync(file, "synthetic token"); const open = vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("sensitive path"));
    await expect(readPrivateMaterial(file, { platform: "win32", acl: async () => true })).rejects.toMatchObject({ message: "material_unavailable" }); open.mockRestore();
  });
  it("refuses a synthetic symlink before reading it", async () => {
    const root = home(), target = join(root, "target"), link = join(root, "link"); writeFileSync(target, "synthetic token");
    symlinkSync(target, link);
    await expect(readPrivateMaterial(link, { platform: "win32", acl: async () => true })).rejects.toMatchObject({ message: "material_unavailable" });
  });
  it("rejects other-user Unix modes and broad Windows ACL, accepts a private fake file", async () => {
    const root = home(), file = join(root, "private"); writeFileSync(file, "synthetic token");
    await expect(readPrivateMaterial(file, { platform: "win32", acl: async () => false })).rejects.toMatchObject({ message: "material_unavailable" });
    // Keep path-component identity real; override only file permission metadata.
    const original = fs.lstat.bind(fs);
    const permissive = vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const result = await original(...args); return Object.assign(result, { mode: result.isFile() ? 0o100644 : result.mode });
    });
    await expect(readPrivateMaterial(file, { platform: "linux" })).rejects.toMatchObject({ message: "material_unavailable" }); permissive.mockRestore();
    expect((await readPrivateMaterial(file, { platform: "win32", acl: async () => true })).toString()).toBe("synthetic token");
  });
});
