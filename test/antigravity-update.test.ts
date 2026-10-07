import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installAntigravity, uninstallAntigravity } from "../src/cli/antigravity-install.js";
import { antigravityHookCommand, antigravityRuntimeDir, antigravityRuntimeHome, requireAntigravityPlugin } from "../src/core/antigravity-plugin.js";
import { pluginFiles } from "../src/core/plugin-runtime.js";
import { until } from "./helpers.js";

let home: string, source: string, target: string;
const children: ChildProcess[] = [];
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ab-native-update-")); source = join(home, "source"); target = join(home, "plugin");
  mkdirSync(join(source, "dist"), { recursive: true });
  writeFileSync(join(source, "plugin.json"), '{"name":"agent-bridge"}');
  writeFileSync(join(source, "package.json"), '{"version":"0.1.0"}');
  writeFileSync(join(source, "dist", "worker.mjs"), "export const version='old'; console.log(version);\n");
  for (const file of ["cli.mjs", "history-worker.mjs"]) writeFileSync(join(source, "dist", file), "// fixture\n");
  await build({ entryPoints: [join(import.meta.dirname, "../src/mcp/launcher.ts")], outfile: join(source, "dist", "server.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
});
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); })));
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});
const bump = () => { writeFileSync(join(source, "package.json"), '{"version":"0.1.1"}'); writeFileSync(join(source, "dist", "worker.mjs"), "export const version='new'; console.log(version);\n"); };

it("updates beside a locked old runtime, preserves its files and makes a cached launcher start new code", async () => {
  installAntigravity(source, target);
  const oldRoot = antigravityRuntimeDir(target), before = new Map(pluginFiles(oldRoot).map((file) => [file, readFileSync(join(oldRoot, file))]));
  const cachedConfig = JSON.parse(readFileSync(join(target, "mcp_config.json"), "utf8")).mcpServers["agent-bridge"];
  const script = `import {version} from ${JSON.stringify(pathToFileURL(join(oldRoot, "dist", "worker.mjs")).href)}; for await (const line of process.stdin) console.log(version);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: oldRoot, stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
  let output = ""; child.stdout!.on("data", (chunk) => output += chunk); await until(() => output.includes("old"));
  if (process.platform === "win32") expect(() => renameSync(oldRoot, `${oldRoot}-moved`)).toThrow();
  mkdirSync(join(target, "dist")); writeFileSync(join(target, "dist", "legacy.mjs"), "legacy bytes"); writeFileSync(join(target, "owner-note.txt"), "keep me");
  bump(); installAntigravity(source, target);
  expect(antigravityRuntimeDir(target)).not.toBe(oldRoot);
  for (const [file, bytes] of before) expect(readFileSync(join(oldRoot, file))).toEqual(bytes);
  child.stdin!.write("still working\n"); await until(() => output.split("old").length === 3);
  expect(readFileSync(join(target, "dist", "legacy.mjs"), "utf8")).toBe("legacy bytes"); expect(readFileSync(join(target, "owner-note.txt"), "utf8")).toBe("keep me");
  const next = spawn(cachedConfig.command, cachedConfig.args, { env: { ...process.env, ...cachedConfig.env, AGENT_BRIDGE_HOME: join(home, "shared") }, stdio: ["ignore", "pipe", "pipe"] }); children.push(next);
  let nextOutput = ""; next.stdout!.on("data", (chunk) => nextOutput += chunk); next.stderr!.on("data", (chunk) => nextOutput += chunk);
  const code = await new Promise<number | null>((resolve, reject) => { next.once("error", reject); next.once("exit", resolve); });
  expect(code, nextOutput).toBe(0); expect(nextOutput).toContain("new"); expect(nextOutput).not.toContain("old");
  expect(() => requireAntigravityPlugin(target)).not.toThrow();
  expect(JSON.parse(readFileSync(join(target, "hooks.json"), "utf8"))["agent-bridge"].PreToolUse[0].hooks[0].command).toBe(antigravityHookCommand(join(antigravityRuntimeDir(target), "dist", "cli.mjs"), "PreToolUse"));
});

it("preserves native custom metadata, disabled gates and binary assets with protected backups", () => {
  writeFileSync(join(source, "icon.bin"), Buffer.from([0, 128, 255, 10])); installAntigravity(source, target);
  const config = JSON.parse(readFileSync(join(target, "mcp_config.json"), "utf8"));
  config.owner = "keep"; config.mcpServers.other = { command: "owner-helper" }; config.mcpServers["agent-bridge"].env.AGENT_BRIDGE_HOME = "owner-shared-home";
  writeFileSync(join(target, "mcp_config.json"), JSON.stringify(config));
  const hooks = JSON.parse(readFileSync(join(target, "hooks.json"), "utf8")); hooks["agent-bridge"].enabled = false; hooks.owner = { enabled: true }; writeFileSync(join(target, "hooks.json"), JSON.stringify(hooks));
  bump(); installAntigravity(source, target);
  expect(JSON.parse(readFileSync(join(target, "mcp_config.json"), "utf8"))).toMatchObject({ owner: "keep", mcpServers: { other: { command: "owner-helper" }, "agent-bridge": { env: { AGENT_BRIDGE_HOME: "owner-shared-home" } } } });
  expect(JSON.parse(readFileSync(join(target, "hooks.json"), "utf8"))).toMatchObject({ "agent-bridge": { enabled: false }, owner: { enabled: true } });
  expect(() => requireAntigravityPlugin(target)).toThrow("enabled agent-bridge");
  expect(readFileSync(join(target, "icon.bin"))).toEqual(Buffer.from([0, 128, 255, 10]));
  expect(readdirSync(target).some((file) => file.startsWith("mcp_config.json.backup-"))).toBe(true);
});

it("keeps immutable runtimes after native uninstall and refuses changed same-version releases", () => {
  installAntigravity(source, target); const runtime = antigravityRuntimeDir(target);
  writeFileSync(join(source, "dist", "worker.mjs"), "changed same version");
  const before = readFileSync(join(target, "mcp_config.json"));
  expect(() => installAntigravity(source, target)).toThrow("Immutable plugin version differs");
  expect(readFileSync(join(target, "mcp_config.json"))).toEqual(before);
  expect(uninstallAntigravity(target).files).toEqual([target]);
  expect(existsSync(join(runtime, "dist", "worker.mjs"))).toBe(true);
});

it("refuses unknown selectors and incomplete packages before changing native metadata", () => {
  installAntigravity(source, target); const before = readFileSync(join(target, "hooks.json"));
  const selector = join(antigravityRuntimeHome(target), "plugin-versions", "antigravity", "active.json");
  writeFileSync(selector, '{"schemaVersion":99,"version":"0.1.0"}'); bump();
  expect(() => installAntigravity(source, target)).toThrow("Unknown runtime selector");
  expect(readFileSync(join(target, "hooks.json"))).toEqual(before);
  rmSync(join(source, "dist", "history-worker.mjs"));
  expect(() => installAntigravity(source, target)).toThrow("Missing Antigravity runtime");
  expect(readFileSync(join(target, "hooks.json"))).toEqual(before);
});
