import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMuse } from "../src/core/muse.js";
import { museContextDirectory } from "../src/core/muse-context.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const host = fileURLToPath(new URL("./fixtures/muse-msp/host.cjs", import.meta.url));
let env: TestEnv, bin: string;
beforeEach(() => {
  env = makeEnv();
  vi.stubEnv("AGENT_BRIDGE_MUSE_EXEC", "");
  const script = join(env.home, "muse.cjs");
  const body = readFileSync(host, "utf8").replaceAll("__dirname", JSON.stringify(dirname(host)));
  writeFileSync(script, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.MSP_TEST_ARGV, JSON.stringify(process.argv.slice(2)));\n${body}`);
  bin = process.platform === "win32" ? join(env.home, "muse.cmd") : script;
  if (process.platform === "win32") writeFileSync(bin, `@ECHO off\r\n"${process.execPath}" "%~dp0muse.cjs" %*\r\n`);
  else chmodSync(script, 0o755);
});
afterEach(async () => { vi.unstubAllEnvs(); await env.cleanup(); });
function request(extraEnv: Record<string, string> = {}) {
  return { bin, cwd: env.home, access: "read" as const, prompt: "Inspect the project", timeoutSec: 5, log: nullLogger,
    extraEnv: { MSP_TEST_LOG: join(env.home, "requests.jsonl"), MSP_TEST_PID: join(env.home, "host.pid"), MSP_TEST_ARGV: join(env.home, "argv.json"), ...extraEnv } };
}
function calls(): { method: string; params?: any }[] {
  return readFileSync(join(env.home, "requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}
function contextRemoved() {
  const pid = readFileSync(join(env.home, "host.pid"), "utf8");
  expect(existsSync(join(museContextDirectory(), `host-${pid}.json`))).toBe(false);
}

describe("Muse public delegation routing", () => {
  it("uses MSP by default and proves the native read gate before submitting", async () => {
    const onInfo = vi.fn();
    await expect(runMuse({ ...request(), onInfo })).resolves.toMatchObject({ text: "Completed native turn", details: { transport: "msp" } });
    expect(onInfo).toHaveBeenCalledWith({ permission: "Bridge read (native promptUnmatched)" });
    expect(JSON.parse(readFileSync(join(env.home, "argv.json"), "utf8"))).toEqual(["serve"]);
    expect(calls().map(call => call.method)).toEqual(["initialize", "initialized", "session/start", "hook/list", "turn/start"]);
    expect(calls().find(call => call.method === "session/start")?.params.approvalMode).toBe("promptUnmatched");
    contextRemoved();
  });

  it("refuses missing permission hooks without submitting or replaying through exec", async () => {
    await expect(runMuse(request({ MSP_TEST_HOOKS: "[]" }))).rejects.toMatchObject({ startupFailed: true });
    expect(calls().some(call => call.method === "turn/start")).toBe(false);
    expect(JSON.parse(readFileSync(join(env.home, "argv.json"), "utf8"))).toEqual(["serve"]);
    contextRemoved();
  });

  it("relays ask approvals through MSP after verifying native hooks", async () => {
    const approve = vi.fn(async () => ({ allow: true as const }));
    await expect(runMuse({ ...request({ MSP_TEST_MODE: "approval" }), access: "ask", canApprove: true, approve })).resolves.toMatchObject({ isError: false });
    expect(approve).toHaveBeenCalledOnce();
    expect(calls().map(call => call.method)).toContain("approval/decide");
    expect(calls().find(call => call.method === "session/start")?.params.approvalMode).toBe("promptUnmatched");
    contextRemoved();
  });

  it("does not replay a submitted provider failure and removes its private context", async () => {
    await expect(runMuse({ ...request({ MSP_TEST_MODE: "failure" }), access: "edit" })).rejects.toMatchObject({ startupFailed: false });
    expect(calls().filter(call => call.method === "turn/start")).toHaveLength(1);
    expect(calls().some(call => call.method === "hook/list")).toBe(true);
    contextRemoved();
  });

  it("requires explicit compatibility selection and keeps ask restricted in legacy exec", async () => {
    vi.stubEnv("AGENT_BRIDGE_MUSE_EXEC", "1");
    writeFileSync(join(env.home, "muse.cjs"), `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.MSP_TEST_ARGV, JSON.stringify(process.argv.slice(2)));\nfs.writeFileSync(process.env.MSP_TEST_PID, String(process.pid));\nprocess.stdin.resume(); process.stdin.once('end',()=>console.log(JSON.stringify({stream:{kind:'session',id:'legacy-session'},payload:{kind:'run_terminal',terminal:'completed',text:'legacy answer'}})));\n`);
    await expect(runMuse({ ...request(), access: "ask", permissionProfile: "review" })).resolves.toMatchObject({ sessionId: "legacy-session", text: "legacy answer" });
    const args: string[] = JSON.parse(readFileSync(join(env.home, "argv.json"), "utf8"));
    expect(args).toEqual(expect.arrayContaining(["exec", "--disable-write", "--disable-shell", "--permission-profile", "review"]));
    expect(args).not.toContain("--disable-approval");
    expect(args).not.toContain("--approval-mode");
    expect(existsSync(args[args.indexOf("--prompt-file") + 1]!)).toBe(false);
    contextRemoved();
  });
});
