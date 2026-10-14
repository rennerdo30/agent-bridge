import { buildSync } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { museContextDirectory, museHostCommand, museHostPid, readMusePrivateJson, registerMuseContext, restoreMuseContext, writeMusePrivateJson } from "../src/core/muse-context.js";
import * as procinfo from "../src/core/procinfo.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const exec = promisify(execFile);
let env: TestEnv, path: string, module: string;
const releases: (() => void)[] = [];
beforeEach(() => {
  env = makeEnv(); vi.stubEnv("TMPDIR", env.home); vi.stubEnv("TMP", env.home); vi.stubEnv("TEMP", env.home);
  path = join(museContextDirectory(), `host-${process.pid}.json`);
  module = join(env.home, "context.mjs");
  buildSync({ entryPoints: [join(import.meta.dirname, "../src/core/muse-context.ts")], outfile: module, bundle: true, platform: "node", format: "esm" });
});
afterEach(async () => { vi.restoreAllMocks(); for (const release of releases.splice(0)) release(); vi.unstubAllEnvs(); await env.cleanup(); });
async function restore() {
  const script = `const {restoreMuseContext}=await import(${JSON.stringify(pathToFileURL(module).href)}); const env={MUSE_SESSION_ID:'native-session'}; const restored=await restoreMuseContext(env); console.log(JSON.stringify({restored,env}));`;
  const result = await exec(process.execPath, ["--input-type=module", "-e", script], { env: { HOME: env.home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE, TEMP: env.home, TMP: env.home, TMPDIR: env.home } });
  return JSON.parse(result.stdout);
}
function register() {
  releases.push(registerMuseContext(process.pid, { AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_DELEGATE_DEPTH: "2", AGENT_BRIDGE_PARENT_URL: "http://127.0.0.1:4321", AGENT_BRIDGE_PARENT_TOKEN: "fixture-token", AGENT_BRIDGE_MUSE_ACCESS: "read", AGENT_BRIDGE_PARENT_NAME: "parent", AGENT_BRIDGE_INTERNAL: "1", CODEX_HOME: join(env.home, "codex"), PATH: "poison", ARBITRARY_SECRET: "omit", AGENT_BRIDGE_UNREVIEWED_SECRET: "omit" }));
}

describe("Muse private host context", () => {
  it("authenticates the bound parent before querying an unavailable CIM service", async () => {
    releases.push(registerMuseContext(process.ppid, { AGENT_BRIDGE_INTERNAL: "1", CODEX_HOME: "owned-storage" }));
    const query = vi.spyOn(procinfo, "lookup").mockResolvedValue(null);
    const restored = { MUSE_SESSION_ID: "native-session", AGENT_BRIDGE_PARENT_TOKEN: "ambient-token" };
    expect(await restoreMuseContext(restored)).toBe(true);
    expect(restored).toEqual({ MUSE_SESSION_ID: "native-session", AGENT_BRIDGE_INTERNAL: "1", CODEX_HOME: "owned-storage" });
    expect(await museHostPid()).toBe(process.ppid);
    expect(query).not.toHaveBeenCalled();
  });
  it("waits for an authenticated handoff after an unavailable CIM query", async () => {
    vi.spyOn(procinfo, "lookup").mockImplementation(async pid => {
      setTimeout(() => releases.push(registerMuseContext(pid, { AGENT_BRIDGE_INTERNAL: "1" })), 50);
      return null;
    });
    const restored = { MUSE_SESSION_ID: "native-session" };
    expect(await restoreMuseContext(restored)).toBe(true);
    expect(restored).toEqual({ MUSE_SESSION_ID: "native-session", AGENT_BRIDGE_INTERNAL: "1" });
  });
  it("waits at a headless host instead of inheriting another ancestor's context", async () => {
    releases.push(registerMuseContext(process.pid, { AGENT_BRIDGE_INTERNAL: "1", CODEX_HOME: "wrong-ancestor" }));
    vi.spyOn(procinfo, "lookup").mockImplementation(async pid => {
      setTimeout(() => releases.push(registerMuseContext(pid, { AGENT_BRIDGE_INTERNAL: "1", CODEX_HOME: "owned-host" })), 50);
      return { pid, ppid: process.pid, cmdline: "muse serve" };
    });
    const restored = { MUSE_SESSION_ID: "native-session" };
    expect(await restoreMuseContext(restored)).toBe(true);
    expect(restored).toEqual({ MUSE_SESSION_ID: "native-session", AGENT_BRIDGE_INTERNAL: "1", CODEX_HOME: "owned-host" });
  });
  it("refuses unknown sanitized ancestry even when a session ID is supplied", async () => {
    expect(await restore()).toEqual({ restored: false, env: { MUSE_SESSION_ID: "native-session", AGENT_BRIDGE_INTERNAL: "1" } });
  });
  it("restores only sanctioned Bridge context into an actual sanitized subprocess", async () => {
    register();
    const record = readMusePrivateJson(path);
    expect(record.env).not.toHaveProperty("PATH"); expect(record.env).not.toHaveProperty("ARBITRARY_SECRET"); expect(record.env).not.toHaveProperty("AGENT_BRIDGE_UNREVIEWED_SECRET");
    record.env.PATH = "forged"; record.env.LD_PRELOAD = "forged"; record.env.MUSE_SESSION_ID = "forged";
    writeMusePrivateJson(path, record, "w");
    expect(await restore()).toEqual({ restored: true, env: { MUSE_SESSION_ID: "native-session", AGENT_BRIDGE_HOME: env.home,
      AGENT_BRIDGE_DELEGATE_DEPTH: "2", AGENT_BRIDGE_PARENT_URL: "http://127.0.0.1:4321", AGENT_BRIDGE_PARENT_TOKEN: "fixture-token", AGENT_BRIDGE_MUSE_ACCESS: "read", AGENT_BRIDGE_PARENT_NAME: "parent", AGENT_BRIDGE_INTERNAL: "1", CODEX_HOME: join(env.home, "codex") } });
  });
  it("restores from the child temp directory when it differs from the launcher", async () => {
    const childTemp = join(env.home, "child-temp"); mkdirSync(childTemp);
    releases.push(registerMuseContext(process.pid, { TMPDIR: childTemp, TMP: childTemp, TEMP: childTemp, AGENT_BRIDGE_INTERNAL: "1", CODEX_HOME: "owned-storage" }));
    expect(existsSync(path)).toBe(false);
    const result = await exec(process.execPath, ["--input-type=module", "-e", `const m=await import(${JSON.stringify(pathToFileURL(module).href)}); const env={}; console.log(JSON.stringify({restored:await m.restoreMuseContext(env), host:await m.museHostPid(), env}));`], {
      env: { HOME: env.home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE, TMPDIR: childTemp, TMP: childTemp, TEMP: childTemp },
    });
    expect(JSON.parse(result.stdout)).toEqual({ restored: true, host: process.pid, env: { AGENT_BRIDGE_INTERNAL: "1", CODEX_HOME: "owned-storage" } });
  });
  it.each(["AGENT_BRIDGE_PARENT_TOKEN", "AGENT_BRIDGE_DELEGATE_DEPTH", "AGENT_BRIDGE_MUSE_ACCESS"])("refuses missing delegated scope: %s", async key => {
    register(); const record = readMusePrivateJson(path); delete record.env[key]; writeMusePrivateJson(path, record, "w");
    expect(await restore()).toEqual({ restored: false, env: { MUSE_SESSION_ID: "native-session", AGENT_BRIDGE_INTERNAL: "1" } });
  });
  it.each(["corrupt", "reused-pid", "wrong-pid", "wrong-version", "unsafe-mode"])("refuses %s context and marks the child internal", async kind => {
    register(); const record = readMusePrivateJson(path);
    if (kind === "reused-pid") record.identity = "another-creation-identity";
    if (kind === "wrong-pid") record.pid++;
    if (kind === "wrong-version") record.version = 99;
    if (kind === "corrupt") writeFileSync(path, "{"); else writeMusePrivateJson(path, record, "w");
    if (kind === "unsafe-mode") { if (process.platform === "win32") writeFileSync(path, JSON.stringify(record)); else chmodSync(path, 0o644); }
    expect(await restore()).toEqual({ restored: false, env: { MUSE_SESSION_ID: "native-session", AGENT_BRIDGE_INTERNAL: "1" } });
  });
  it("refuses a symlink, an oversized context and a foreign owner", () => {
    const outside = join(env.home, "outside.json"); writeFileSync(outside, "{}", { mode: 0o600 });
    symlinkSync(outside, path); expect(() => readMusePrivateJson(path)).toThrow("Unsafe"); unlinkSync(path);
    writeFileSync(path, "x".repeat(64 * 1024 + 1), { mode: 0o600 }); expect(() => readMusePrivateJson(path)).toThrow("Unsafe");
    writeFileSync(path, "{}");
    if (process.getuid) { const uid = process.getuid(); vi.spyOn(process, "getuid").mockReturnValue(uid + 1); expect(() => readMusePrivateJson(path)).toThrow("Unsafe"); }
  });
  it("refuses unknown host identities and existing registrations", () => {
    expect(() => registerMuseContext(2_147_483_647, {})).toThrow("identity unavailable");
    register(); expect(() => registerMuseContext(process.pid, {})).toThrow();
  });
  it("does not delete a successor registration for the same live host", () => {
    register(); const first = readMusePrivateJson(path); unlinkSync(path);
    const successor = registerMuseContext(process.pid, { AGENT_BRIDGE_PARENT_NAME: "successor" });
    releases.push(successor); expect(readMusePrivateJson(path).identity).toBe(first.identity);
    releases[0]!();
    expect(existsSync(path)).toBe(true);
    expect(readMusePrivateJson(path).env.AGENT_BRIDGE_PARENT_NAME).toBe("successor");
  });
  it.each([['muse exec --json', true], ['"E:\\Program Files\\Muse\\muse-bin-1.4.7.exe" serve', true], ['muse-bin-unknown.exe serve', false], ['node "/host/muse.mjs" exec', true], ['node /host/muse-context.mjs exec', false], ['bash -c "muse exec"', false]])("recognizes only a Muse entrypoint: %s", (command, expected) => {
    expect(museHostCommand(String(command))).toBe(expected);
  });
});
