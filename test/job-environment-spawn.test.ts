import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import { currentDelegateDepth, delegateToClaude, delegateToCodex, delegateToOpencode } from "../src/core/delegate.js";
import { delegateToAntigravity } from "../src/core/antigravity.js";
import { delegateToCodexAppServer } from "../src/core/codex-appserver.js";
import { delegateToOpencodeServed } from "../src/core/opencode-served.js";
import { nullLogger } from "../src/core/logger.js";
import { JobRunners } from "../src/mcp/job-host.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { BridgeNode } from "../src/core/node.js";
import type { Job } from "../src/mcp/jobs.js";

vi.mock("../src/core/antigravity-plugin.js", () => ({ requireAntigravityPlugin: vi.fn() }));
let home: string;
const script = String.raw`#!/usr/bin/env node
const fs = require("node:fs"), child = require("node:child_process");
const fields = ["DOTNET_ADD_GLOBAL_TOOLS_TO_PATH", "DOTNET_SKIP_FIRST_TIME_EXPERIENCE", "DOTNET_CLI_HOME", "PATH", "AGENT_BRIDGE_DELEGATE_DEPTH"];
const pick = () => Object.fromEntries(fields.map(key => [key, process.env[key]]));
const native = JSON.parse(child.execFileSync(process.execPath, ["-e", "console.log(JSON.stringify(Object.fromEntries("+JSON.stringify(fields)+".map(k=>[k,process.env[k]]))))"], {encoding:"utf8"}));
fs.writeFileSync(process.env.AB_ENV_RECORD || require("node:path").join(__dirname,"runner.env.json"), JSON.stringify({ env: pick(), native }));
const args = process.argv.slice(2), out = value => console.log(JSON.stringify(value));
if (args[0] === "--version") { console.log("opencode v1.0.24"); process.exit(0); }
if (args[0] === "app-server") {
  require("node:readline").createInterface({input:process.stdin}).on("line", line => {
    const request = JSON.parse(line); if (request.id === undefined) return;
    let result = {};
    if (request.method === "thread/start") result = {thread:{id:"native-thread"}};
    if (request.method === "turn/start") result = {turn:{id:"turn"}};
    out({id:request.id,result});
    if (request.method === "turn/start") {
      out({method:"item/completed",params:{turnId:"turn",item:{type:"agentMessage",text:"done"}}});
      out({method:"turn/completed",params:{turn:{id:"turn",status:"completed"}}});
    }
  });
} else if (args[0] === "serve") {
  require("node:http").createServer((req,res) => { res.statusCode=500;res.end("fixture stops after spawn"); })
    .listen(0,"127.0.0.1",function(){ console.log("opencode server listening on http://127.0.0.1:"+this.address().port); });
} else {
  process.stdin.resume();
  process.stdin.on("end", () => {
    if (process.env.AB_ENV_AGENT === "claude") out({type:"result",subtype:"success",is_error:false,result:"done",session_id:"native-session"});
    if (process.env.AB_ENV_AGENT === "codex") { out({type:"thread.started",thread_id:"native-thread"});out({type:"item.completed",item:{type:"agent_message",text:"done"}});out({type:"turn.completed",usage:{}}); }
    if (process.env.AB_ENV_AGENT === "opencode") out({type:"text",sessionID:"native-session",part:{messageID:"message",text:"done"}});
    if (process.env.AB_ENV_AGENT === "antigravity") out({event:"result",result:{conversation_id:"native-session",status:"SUCCESS",response:"done"}});
  });
}
`;
beforeEach(() => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!; mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "dotnet-environment-"));
  vi.stubEnv("DOTNET_ADD_GLOBAL_TOOLS_TO_PATH", undefined);
  vi.stubEnv("DOTNET_SKIP_FIRST_TIME_EXPERIENCE", undefined);
  vi.stubEnv("DOTNET_CLI_HOME", join(home, "selected-dotnet-home"));
  writeFileSync(join(home, "fixture.cjs"), script);
});
afterEach(() => { vi.unstubAllEnvs(); closeMetadataDbs(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
function cli() {
  const bin = process.platform === "win32" ? join(home, "fixture.cmd") : join(home, "fixture.cjs");
  if (process.platform === "win32") writeFileSync(bin, '@ECHO off\r\n"%dp0%\\fixture.cjs" %*\r\n');
  else chmodSync(bin, 0o755);
  return bin;
}
function assertEnvironment(file: string, add = "0", skip = "1", depth: string | null = String(currentDelegateDepth() + 1)) {
  const record = JSON.parse(readFileSync(file, "utf8"));
  // Compare PATH bytes without printing a user's machine-specific PATH on failure.
  expect(record.env.PATH === process.env.PATH).toBe(true);
  expect(record.native.PATH === process.env.PATH).toBe(true);
  const { PATH: _childPath, ...childFields } = record.env;
  const { PATH: _nativePath, ...nativeFields } = record.native;
  const expected = { DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: add, DOTNET_SKIP_FIRST_TIME_EXPERIENCE: skip,
    DOTNET_CLI_HOME: process.env.DOTNET_CLI_HOME, ...(depth !== null ? { AGENT_BRIDGE_DELEGATE_DEPTH: depth } : {}) };
  expect(childFields).toEqual(expected);
  expect(nativeFields).toEqual(expected);
}
it.each(["claude", "codex", "opencode", "antigravity"] as const)("passes defaults to %s and its native child without changing parent PATH", async agent => {
  const file = join(home, "delegate.env.json");
  const req = { bin: cli(), cwd: home, prompt: "environment fixture", timeoutSec: 10, log: nullLogger, extraEnv: { AB_ENV_AGENT: agent, AB_ENV_RECORD: file } };
  const result = agent === "claude" ? await delegateToClaude({ ...req, permissionMode: "manual" }) :
    agent === "codex" ? await delegateToCodex({ ...req, sandbox: "read-only" }) :
    agent === "opencode" ? await delegateToOpencode({ ...req, autoApprove: false }) :
    await delegateToAntigravity({ ...req, access: "read" });
  expect(result).toMatchObject({ text: "done", isError: false });
  assertEnvironment(file);
  expect(process.env.DOTNET_ADD_GLOBAL_TOOLS_TO_PATH).toBeUndefined();
  expect(process.env.DOTNET_SKIP_FIRST_TIME_EXPERIENCE).toBeUndefined();
}, 15_000);
it("preserves explicit empty and custom request environment values at actual spawn", async () => {
  const file = join(home, "override.env.json");
  await delegateToCodex({ bin: cli(), cwd: home, prompt: "environment fixture", sandbox: "read-only", timeoutSec: 10, log: nullLogger,
    extraEnv: { AB_ENV_AGENT: "codex", AB_ENV_RECORD: file, DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: "", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "custom" } });
  assertEnvironment(file, "", "custom");
});
it("inherits explicit parent values without replacing an empty string", async () => {
  vi.stubEnv("DOTNET_ADD_GLOBAL_TOOLS_TO_PATH", "");
  vi.stubEnv("DOTNET_SKIP_FIRST_TIME_EXPERIENCE", "user-choice");
  const file = join(home, "parent-values.env.json");
  await delegateToCodex({ bin: cli(), cwd: home, prompt: "environment fixture", sandbox: "read-only", timeoutSec: 10, log: nullLogger,
    extraEnv: { AB_ENV_AGENT: "codex", AB_ENV_RECORD: file } });
  assertEnvironment(file, "", "user-choice");
  expect(process.env.DOTNET_ADD_GLOBAL_TOOLS_TO_PATH).toBe("");
  expect(process.env.DOTNET_SKIP_FIRST_TIME_EXPERIENCE).toBe("user-choice");
});
it("covers Codex app-server and its native child", async () => {
  const file = join(home, "appserver.env.json");
  await delegateToCodexAppServer({ bin: cli(), cwd: home, prompt: "environment fixture", sandbox: "read-only", timeoutSec: 10, log: nullLogger, extraEnv: { AB_ENV_RECORD: file } });
  assertEnvironment(file);
});
it("covers served OpenCode's distinct spawn path", async () => {
  const file = join(home, "served.env.json");
  await expect(delegateToOpencodeServed({ bin: cli(), cwd: home, prompt: "environment fixture", timeoutSec: 10, log: nullLogger, extraEnv: { AB_ENV_RECORD: file }, onPermission: async () => ({allow:false, message:"fixture deny"}) })).rejects.toThrow("HTTP 500");
  assertEnvironment(file);
});
it.each([false, true])("passes defaults or explicit user values through the detached runner launcher (override=%s)", async override => {
  if (override) {
    vi.stubEnv("DOTNET_ADD_GLOBAL_TOOLS_TO_PATH", "");
    vi.stubEnv("DOTNET_SKIP_FIRST_TIME_EXPERIENCE", "user-choice");
  }
  const runnerCli = join(home, "fixture.cjs");
  const runners = new JobRunners({} as BridgeNode, home, runnerCli, nullLogger);
  const job = { id:"environment", name:"codex-job-environment", agent:"codex", model:null, prompt:"fixture", startedAt:Date.now(), args:{},
    sessionId:null, workdir:home, worktree:null, owner:"parent", allowedServers:new Set() } as Job;
  expect(runners.start(job, { target:"codex", args:{prompt:"fixture",title:"Environment"}, base:{prompt:"fixture",title:"Environment"},
    owner:"parent", byAgent:"codex", cwd:home, cfg:DEFAULT_CONFIG })).not.toBeNull();
  const file = join(home, "runner.env.json");
  await vi.waitFor(() => assertEnvironment(file, override ? "" : "0", override ? "user-choice" : "1", process.env.AGENT_BRIDGE_DELEGATE_DEPTH ?? null), { timeout: 10_000 });
});
