import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { codexLiveConfig, reportConnectedVersions, updateClaude, updateCodex } from "../src/cli/live-update.js";
import { BridgeClient } from "../src/core/client.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv } from "./helpers.js";
import { installOpencode } from "../src/cli/opencode-install.js";
import { atomicPluginWrite, publishPlugin, selectedWorker, selectRuntime } from "../src/core/plugin-runtime.js";
import { APP_VERSION, PROTOCOL_VERSION } from "../src/core/constants.js";
import { marketplaceFixture } from "./marketplace-fixture.js";

let dir: string, source: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ab-update-")); source = join(dir, "source");
  mkdirSync(join(source, "dist"), { recursive: true });
  writeFileSync(join(source, "dist", "worker.mjs"), "export const version = 'new';\n");
  writeFileSync(join(source, "dist", "server.mjs"), "// agent-bridge fixture\n");
  writeFileSync(join(source, "dist", "agent-bridge.js"), "export const AgentBridgePlugin = () => 'new'; // agent-bridge\n");
  mkdirSync(join(source, "skills", "agent-bridge"), { recursive: true });
  writeFileSync(join(source, "skills", "agent-bridge", "SKILL.md"), "agent-bridge skill");
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

describe("immutable live updates (mock Codex)", () => {
  it("selects an isolated runtime while keeping session reports in the shared home", async () => {
    const isolated = join(dir, "runtime"), shared = join(dir, "shared"), launcher = join(dir, "cached", "dist", "server.mjs");
    writeFileSync(join(source, "dist", "worker.mjs"), "console.log('selected-new');\n");
    selectRuntime(isolated, "codex", source, "0.1.1");
    await build({ entryPoints: [join(import.meta.dirname, "../src/mcp/launcher.ts")], outfile: launcher, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    writeFileSync(join(dir, "cached", "dist", "worker.mjs"), "console.log('cached-old');\n");
    const child = spawn(process.execPath, [launcher, "--agent=codex"], { env: { ...process.env, AGENT_BRIDGE_HOME: shared, AGENT_BRIDGE_PLUGIN_RUNTIME_HOME: isolated }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", (chunk) => output += chunk); child.stderr.on("data", (chunk) => output += chunk);
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    expect(code, output).toBe(0); expect(output).toContain("selected-new"); expect(output).not.toContain("cached-old");
    expect(JSON.parse(readFileSync(join(shared, "plugin-sessions", `${child.pid}.json`), "utf8"))).toMatchObject({ version: "0.1.1", client: "codex" });
    expect(existsSync(join(isolated, "plugin-sessions"))).toBe(false);
  });
  it("publishes a new cache without touching an old server or config preferences", async () => {
    const home = join(dir, "codex"), old = join(home, "plugins", "cache", "agent-bridge", "agent-bridge", "0.1.0");
    mkdirSync(join(old, "dist"), { recursive: true });
    writeFileSync(join(old, "dist", "server.mjs"), "export const version = 'old';\n");
    const config = '[marketplaces.agent-bridge]\nsource_type = "git"\nsource = "https://example.test/repo"\n\n[plugins."agent-bridge@agent-bridge"]\nenabled = false\n\n[other]\nsecret = "keep me"\n';
    writeFileSync(join(home, "config.toml"), config);
    const script = `import { createInterface } from 'node:readline'; import { version } from ${JSON.stringify(pathToFileURL(join(old, "dist", "server.mjs")).href)}; console.log(version); for await (const line of createInterface({input:process.stdin})) console.log(version);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: old, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", (chunk) => output += chunk);
    const until = async (predicate: () => boolean) => { for (let i = 0; i < 150 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10)); expect(predicate()).toBe(true); };
    try {
      await until(() => output.includes("old"));
      if (process.platform === "win32") expect(() => renameSync(old, `${old}-renamed`)).toThrow();
      const root = updateCodex(source, home, "0.1.1");
      expect(readFileSync(join(root, "dist", "worker.mjs"), "utf8")).toContain("new");
      child.stdin.write("still alive\n"); await until(() => output.split("old").length === 3);
      expect(readFileSync(join(old, "dist", "server.mjs"), "utf8")).toContain("old");
      expect(readFileSync(join(home, "config.toml"), "utf8")).toContain('enabled = false');
      expect(readFileSync(join(home, "config.toml"), "utf8")).toContain('secret = "keep me"');
      expect(readFileSync(join(home, readdirSync(home).find((file) => file.startsWith("config.toml.backup-"))!), "utf8")).toBe(config);
      expect(updateCodex(source, home, "0.1.1")).toBe(root);
      expect(readdirSync(join(home, "plugins", "cache", "agent-bridge", "agent-bridge"))).toEqual(["0.1.0", "0.1.1"]);
    } finally { child.stdin.end(); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
  });

  it("refuses mismatched same-version content, local precedence and downgrade without deletion", () => {
    const base = join(dir, "versions"); const root = publishPlugin(source, base, "0.1.1");
    writeFileSync(join(root, "owner-notes.txt"), "unique user data");
    expect(() => publishPlugin(source, base, "0.1.1")).toThrow("Immutable");
    expect(readFileSync(join(root, "owner-notes.txt"), "utf8")).toBe("unique user data");
    const home = join(dir, "codex"), cache = join(home, "plugins", "cache", "agent-bridge", "agent-bridge");
    mkdirSync(join(cache, "local"), { recursive: true });
    expect(() => updateCodex(source, home, "0.1.1")).toThrow("local");
    expect(existsSync(join(cache, "0.1.1"))).toBe(false);
    const newerHome = join(dir, "newer");
    updateCodex(source, newerHome, "0.1.2");
    expect(() => updateCodex(source, newerHome, "0.1.1")).toThrow("newer");
  });

  it("switches Claude entries with backups and preserves scopes, custom fields and other plugins", () => {
    const home = join(dir, "claude"), path = join(home, "plugins", "installed_plugins.json");
    mkdirSync(join(home, "plugins"), { recursive: true });
    const old = { version: 2, custom: "owner", plugins: { other: [{ installPath: "keep" }], "agent-bridge@agent-bridge": [{ scope: "user", installPath: "old", version: "0.1.0", extra: "keep" }, { scope: "project", projectPath: "project", installPath: "old" }] } };
    writeFileSync(path, JSON.stringify(old));
    const market = marketplaceFixture(dir, home);
    const root = updateClaude(source, home, "0.1.1"), next = JSON.parse(readFileSync(path, "utf8"));
    expect(next.custom).toBe("owner"); expect(next.plugins.other).toEqual(old.plugins.other);
    expect(JSON.parse(readFileSync(join(market.clone, ".claude-plugin", "marketplace.json"), "utf8")).plugins[0].version).toBe("0.1.1");
    expect(market.git(market.clone, "status", "--porcelain").trim()).toBe("");
    expect(next.plugins["agent-bridge@agent-bridge"]).toEqual([expect.objectContaining({ scope: "user", installPath: root, extra: "keep" }), expect.objectContaining({ scope: "project", projectPath: "project", installPath: root })]);
    expect(JSON.parse(readFileSync(join(home, "plugins", readdirSync(join(home, "plugins")).find((f) => f.startsWith("installed_plugins.json.backup-"))!), "utf8"))).toEqual(old);
    writeFileSync(path, JSON.stringify({ ...old, version: 99 }));
    expect(() => updateClaude(source, home, "0.1.2")).toThrow("Unsupported");
  });

  it("refuses dirty, divergent and wrong-release marketplaces before publishing selectors", () => {
    const home = join(dir, "claude"), path = join(home, "plugins", "installed_plugins.json");
    const market = marketplaceFixture(dir, home);
    const old = JSON.stringify({ version: 2, plugins: { "agent-bridge@agent-bridge": [{ scope: "user", installPath: "old", version: "0.1.0" }] } });
    writeFileSync(path, old);
    const notes = join(market.clone, "owner.txt"); writeFileSync(notes, "keep notes");
    expect(() => updateClaude(source, home, "0.1.1")).toThrow("local changes");
    expect(readFileSync(path, "utf8")).toBe(old);
    expect(existsSync(join(home, "plugins", "cache"))).toBe(false);
    market.git(market.clone, "add", "."); market.git(market.clone, "-c", "user.name=rennerdo30", "-c", "user.email=9086097+rennerdo30@users.noreply.github.com", "commit", "-m", "Preserve notes");
    expect(() => updateClaude(source, home, "0.1.1")).toThrow();
    expect(readFileSync(notes, "utf8")).toBe("keep notes");
    expect(readFileSync(path, "utf8")).toBe(old);
    expect(() => updateClaude(source, home, "0.1.2")).toThrow("differs");
  });

  it("refreshes retained native Codex clones alongside the active local marketplace", () => {
    const home = join(dir, "codex"), market = marketplaceFixture(dir, home, "codex");
    updateCodex(source, home, "0.1.1");
    expect(JSON.parse(readFileSync(join(market.clone, "plugins", "codex", ".codex-plugin", "plugin.json"), "utf8")).version).toBe("0.1.1");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("agent-bridge-marketplace");
  });

  it("selects compatible workers only and preserves future selector formats", () => {
    const home = join(dir, "bridge"), root = selectRuntime(home, "codex", source, "0.1.1");
    expect(selectedWorker(home, "codex", "fallback")).toEqual({ worker: join(root, "dist", "worker.mjs"), version: "0.1.1" });
    const path = join(home, "plugin-versions", "codex", "active.json");
    atomicPluginWrite(path, JSON.stringify({ schemaVersion: 1, version: "0.1.1", protocol: PROTOCOL_VERSION + 1 }));
    expect(selectedWorker(home, "codex", "fallback").worker).toBe("fallback");
    writeFileSync(path, '{"schemaVersion":99}');
    expect(() => selectRuntime(home, "codex", source, "0.1.2")).toThrow("Unknown");
    expect(readFileSync(path, "utf8")).toBe('{"schemaVersion":99}');
  });

  it("retains opencode's legacy server and imports the new immutable plugin", async () => {
    const cfg = join(dir, "opencode"), legacy = join(cfg, "plugins", "agent-bridge", "server.mjs");
    mkdirSync(join(cfg, "plugins", "agent-bridge"), { recursive: true });
    writeFileSync(legacy, "agent-bridge old server");
    const result = installOpencode(source, cfg);
    expect(readFileSync(legacy, "utf8")).toBe("agent-bridge old server");
    const wrapper = readFileSync(join(cfg, "plugins", "agent-bridge.js"), "utf8");
    expect(wrapper).toContain(`/plugin-versions/opencode/${APP_VERSION}/dist/agent-bridge.js`);
    const imported = await import(/* @vite-ignore */ pathToFileURL(join(result.files.find((f) => f.includes("plugin-versions"))!, "dist", "agent-bridge.js")).href);
    expect(imported.AgentBridgePlugin()).toBe("new");
  });

  it("refuses linked destinations and keeps unrelated TOML byte-for-byte", () => {
    const real = join(dir, "real"), linked = join(dir, "linked"); mkdirSync(real);
    symlinkSync(real, linked, process.platform === "win32" ? "junction" : "dir");
    expect(() => publishPlugin(source, linked, "0.1.1")).toThrow("links");
    expect(readdirSync(real)).toEqual([]);
    const text = '[owner]\npath = "unchanged"\n';
    expect(codexLiveConfig(text, "/safe")).toContain(text);
  });

  it("launches the selected worker while preserving the host's plugin root", async () => {
    writeFileSync(join(source, "dist", "worker.mjs"), "console.log(JSON.stringify({version:'selected', launchRoot:process.env.AGENT_BRIDGE_LAUNCH_PLUGIN_ROOT}));\n");
    selectRuntime(dir, "codex", source, "0.1.1");
    const launcher = join(import.meta.dirname, "..", "plugins", "codex", "dist", "server.mjs");
    const child = spawn(process.execPath, [launcher, "--agent=codex"], { env: { ...process.env, AGENT_BRIDGE_HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = ""; child.stdout.on("data", (chunk) => output += chunk); child.stderr.on("data", (chunk) => errors += chunk);
    const code = await new Promise((resolve) => child.once("exit", resolve));
    expect(errors).toBe(""); expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({ version: "selected", launchRoot: join(import.meta.dirname, "..", "plugins", "codex") });
    const records = readdirSync(join(dir, "plugin-sessions")).filter((file) => file.endsWith(".json"));
    expect(JSON.parse(readFileSync(join(dir, "plugin-sessions", records[0]!), "utf8"))).toMatchObject({ client: "codex", version: "0.1.1", pid: child.pid });
  });

  it("reports actual named mixed-version peers without disconnecting them", async () => {
    const env = makeEnv(), node = env.node("current", "codex"); let legacy: BridgeClient | null = null;
    try {
      await node.start(); legacy = await BridgeClient.connect(env.pipe, nullLogger);
      await legacy.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: { id: "legacy", name: "legacy", agent: "codex", pid: process.pid, agentPid: null, sessionId: null, autoWake: false, cwd: env.home, startedAt: Date.now(), version: "0.1.0" } });
      const lines: string[] = [];
      await reportConnectedVersions(env.home, ["codex"], APP_VERSION, (line) => lines.push(line));
      expect(lines.join("\n")).toContain("legacy: v0.1.0 (retained old code)");
      expect(lines.join("\n")).toContain("Switched mid-session: 0");
      expect((await legacy.request("peers", {})).map((peer) => peer.name)).toContain("legacy");
    } finally { legacy?.close(); await env.cleanup(); }
  });
});
