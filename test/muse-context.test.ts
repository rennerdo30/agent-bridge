import { buildSync } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { museContextDirectory, museHostCommand, readMusePrivateJson, registerMuseContext } from "../src/core/muse-context.js";
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
  const script = `const {restoreMuseContext}=await import(${JSON.stringify(module)}); const env={MUSE_SESSION_ID:'native-session'}; const restored=await restoreMuseContext(env); console.log(JSON.stringify({restored,env}));`;
  const result = await exec(process.execPath, ["--input-type=module", "-e", script], { env: { HOME: env.home, PATH: process.env.PATH, TMPDIR: env.home } });
  return JSON.parse(result.stdout);
}
function register() {
  releases.push(registerMuseContext(process.pid, { AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_DELEGATE_DEPTH: "2", AGENT_BRIDGE_PARENT_NAME: "parent", AGENT_BRIDGE_INTERNAL: "1", CODEX_HOME: join(env.home, "codex"), PATH: "poison", ARBITRARY_SECRET: "omit" }));
}

describe("Muse private host context", () => {
  it("restores only sanctioned Bridge context into an actual sanitized subprocess", async () => {
    register();
    const record = readMusePrivateJson(path);
    expect(record.env).not.toHaveProperty("PATH"); expect(record.env).not.toHaveProperty("ARBITRARY_SECRET");
    record.env.PATH = "forged"; record.env.LD_PRELOAD = "forged"; record.env.MUSE_SESSION_ID = "forged";
    writeFileSync(path, JSON.stringify(record));
    expect(await restore()).toEqual({ restored: true, env: { MUSE_SESSION_ID: "native-session", AGENT_BRIDGE_HOME: env.home,
      AGENT_BRIDGE_DELEGATE_DEPTH: "2", AGENT_BRIDGE_PARENT_NAME: "parent", AGENT_BRIDGE_INTERNAL: "1", CODEX_HOME: join(env.home, "codex") } });
  });
  it.each(["corrupt", "reused-pid", "wrong-pid", "wrong-version", "unsafe-mode"])("refuses %s context and marks the child internal", async kind => {
    register(); const record = readMusePrivateJson(path);
    if (kind === "reused-pid") record.identity = "another-creation-identity";
    if (kind === "wrong-pid") record.pid++;
    if (kind === "wrong-version") record.version = 99;
    writeFileSync(path, kind === "corrupt" ? "{" : JSON.stringify(record));
    if (kind === "unsafe-mode") chmodSync(path, 0o644);
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
  it.each([['muse exec --json', true], ['node "/host/muse.mjs" exec', true], ['node /host/muse-context.mjs exec', false], ['bash -c "muse exec"', false]])("recognizes only a Muse entrypoint: %s", (command, expected) => {
    expect(museHostCommand(String(command))).toBe(expected);
  });
});
