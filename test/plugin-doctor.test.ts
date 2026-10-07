import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectPluginVersions, pluginDoctorPaths, type PluginDoctorPaths } from "../src/cli/plugin-doctor.js";
import { updateClaude, updateCodex } from "../src/cli/live-update.js";
import { installOpencode } from "../src/cli/opencode-install.js";
import { installAntigravity } from "../src/cli/antigravity-install.js";
import { recordRuntimeSession, selectRuntime } from "../src/core/plugin-runtime.js";
import { APP_VERSION } from "../src/core/constants.js";
import { marketplaceFixture } from "./marketplace-fixture.js";

let dir: string, paths: PluginDoctorPaths, source: string;
const put = (path: string, value: unknown) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ab-plugin-doctor-")); paths = pluginDoctorPaths(join(dir, "bridge"), dir, {}); source = join(dir, "source");
  put(join(source, ".claude-plugin", "plugin.json"), { name: "agent-bridge", version: APP_VERSION });
  put(join(source, ".codex-plugin", "plugin.json"), { name: "agent-bridge", version: APP_VERSION });
  put(join(source, "package.json"), { version: APP_VERSION, type: "module" }); put(join(source, "plugin.json"), { name: "agent-bridge" });
  put(join(source, "skills", "agent-bridge", "SKILL.md"), "agent-bridge");
  for (const name of ["server.mjs", "worker.mjs", "cli.mjs", "history-worker.mjs", "agent-bridge.js"]) put(join(source, "dist", name), "// agent-bridge fixture\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

function installed() {
  const market = marketplaceFixture(dir, paths.claude); market.release(APP_VERSION);
  put(join(paths.claude, "plugins", "installed_plugins.json"), { version: 2, plugins: { "agent-bridge@agent-bridge": [{ version: "0.1.0", installPath: "old", scope: "user" }] } });
  updateClaude(source, paths.claude); updateCodex(source, paths.codex);
  selectRuntime(paths.bridge, "claude", source); selectRuntime(paths.bridge, "codex", source);
  installOpencode(source, paths.opencode); installAntigravity(source, paths.antigravity);
  return market;
}
function snapshot(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? Object.entries(snapshot(join(root, entry.name))) : [[join(root, entry.name), readFileSync(join(root, entry.name)).toString("base64")]]));
}
describe("plugin doctor in a fake home", () => {
  it("agrees with all four native loaders and performs no writes", () => {
    installed(); const before = snapshot(dir);
    expect(inspectPluginVersions(paths)).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });
  it("reports the stale Claude marketplace, record and cache independently", () => {
    const market = installed();
    const manifest = join(market.clone, ".claude-plugin", "marketplace.json");
    const data = JSON.parse(readFileSync(manifest, "utf8")); data.plugins[0].version = "0.1.0"; put(manifest, data);
    const record = join(paths.claude, "plugins", "installed_plugins.json"), recordData = JSON.parse(readFileSync(record, "utf8")); recordData.plugins["agent-bridge@agent-bridge"][0].version = "0.1.1"; put(record, recordData);
    const before = snapshot(dir), results = inspectPluginVersions(paths).filter(f=>f.detail.startsWith("claude"));
    expect(results.map(f=>f.detail).join("\n")).toMatch(/marketplace record.*0.1.0/);
    expect(results.map(f=>f.detail).join("\n")).toMatch(/installed record.*0.1.1/);
    expect(results.map(f=>f.detail).join("\n")).toMatch(/cache manifest.*expected 0.1.1/);
    expect(results.every(f=>f.detail.includes("agent-bridge update claude --yes"))).toBe(true);
    expect(snapshot(dir)).toEqual(before);
  });
  it("detects Codex local precedence, opencode's legacy loader and Antigravity drift", () => {
    installed(); mkdirSync(join(paths.codex, "plugins", "cache", "agent-bridge", "agent-bridge", "local"));
    put(join(paths.opencode, "plugins", "agent-bridge.js"), "// agent-bridge legacy");
    const config = join(paths.antigravity, "mcp_config.json"), data = JSON.parse(readFileSync(config, "utf8")); data.mcpServers["agent-bridge"].args[0] = join(paths.antigravity, "dist", "server.mjs"); put(config, data);
    const results = inspectPluginVersions(paths);
    expect(results.some(f=>f.detail.includes("local (takes precedence)"))).toBe(true);
    expect(results.some(f=>f.detail.includes("opencode installed loader: legacy"))).toBe(true);
    expect(results.some(f=>f.detail.includes("antigravity installed MCP loader"))).toBe(true);
  });
  it("finds legacy running servers and retained workers without stopping them", () => {
    installed(); recordRuntimeSession(paths.bridge, { pid: process.pid, client: "codex", version: "0.1.0", worker: join(dir, "old-worker.mjs"), startedAt: "now" });
    const old = join(paths.claude, "plugins", "cache", "agent-bridge", "agent-bridge", "0.1.0", "dist", "server.mjs");
    const results = inspectPluginVersions(paths, [{ pid: 12345, command: `node "${old}" --agent=claude` }, { pid: 23456, command: "node other/server.mjs --agent=claude" }]);
    const running = results.filter(f=>f.code === "plugin-running-version");
    expect(running).toHaveLength(2);
    expect(running.some(f=>f.detail.includes("/reload-plugins"))).toBe(true);
    expect(running.some(f=>f.detail.includes(`pid ${process.pid}`))).toBe(true);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });
  it("reports damaged selectors and ignores clients that are not installed", () => {
    expect(inspectPluginVersions(paths)).toEqual([]);
    put(join(paths.opencode, "agent-bridge", "plugin-versions", "opencode", "active.json"), "broken");
    expect(inspectPluginVersions(paths)).toEqual([expect.objectContaining({ code: "plugin-version-unreadable", fixable: false })]);
  });
});
