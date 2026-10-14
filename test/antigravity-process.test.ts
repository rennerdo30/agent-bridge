import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { delegateToAntigravity } from "../src/core/antigravity.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv } from "./helpers.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { pidAlive } from "../src/core/delegate.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { remoteSpawnArgsSchema } from "../src/network/remote-job-protocol.js";
import { parseJobSettings } from "../src/mcp/job-settings.js";

vi.mock("../src/core/antigravity-plugin.js", async original => ({ ...await original<typeof import("../src/core/antigravity-plugin.js")>(), requireAntigravityPlugin: vi.fn() }));

let gate: string, fixture: ReturnType<typeof makeEnv>;
beforeAll(async () => {
  fixture = makeEnv(); gate = join(fixture.home, "gate.mjs");
  await build({ stdin: { contents: 'import {runAntigravityHook} from "./src/cli/antigravity-hook.ts"; await runAntigravityHook(process.argv[2]);', resolveDir: join(import.meta.dirname, "..") }, outfile: gate, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
});
afterAll(async () => { await fixture.cleanup(); });

/** Real process/stdio and cancellation, with a local fake CLI and no provider calls. */
function fakeCli(home: string): string {
  const dir = join(home, "cli"); mkdirSync(dir);
  const file = join(dir, process.platform === "win32" ? "fake.cjs" : "agy");
  writeFileSync(file, `#!/usr/bin/env node
const {execFile} = require('node:child_process');
const {writeFileSync} = require('node:fs');
let input = ''; process.stdin.on('data', part => input += part);
process.stdin.on('end', async () => {
  const prompt = JSON.parse(input).message.content;
  const previous = process.argv.indexOf('--conversation');
  const id = previous > -1 ? process.argv[previous + 1] : 'fake-session';
  const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
  emit({event:'init',conversation_id:id,init:{model:'fake-model'}});
  if (prompt === 'hang') { setInterval(() => {}, 1000); return; }
  if (prompt.startsWith('permission')) {
    const toolCall = prompt === 'permission-mcp' ? {name:'call_mcp_tool',args:{ServerName:'pair-desk',ToolName:'update_issue',Arguments:{id:'AB-1'}}} : {name:'write_to_file',args:{TargetFile:process.env.AB_TEST_WRITE,Content:'approved'}};
    const decision = await new Promise((resolve,reject) => {
      const child = execFile(process.execPath,[process.env.AB_TEST_HOOK,'PreToolUse'],{env:process.env},(error,stdout)=>error?reject(error):resolve(JSON.parse(stdout)));
      if(process.env.AB_TEST_PIDS)writeFileSync(process.env.AB_TEST_PIDS,JSON.stringify([process.pid,child.pid]));
      child.stdin.end(JSON.stringify({toolCall,workspacePaths:[process.cwd()]}));
    });
    if(decision.decision === 'allow' && prompt === 'permission-write')writeFileSync(process.env.AB_TEST_WRITE,'approved');
    emit({event:'result',result:{conversation_id:id,status:decision.decision === 'allow'?'SUCCESS':'ERROR',response:JSON.stringify(decision)}}); return;
  }
  if (prompt === 'args') { emit({event:'result',result:{conversation_id:id,status:'SUCCESS',response:JSON.stringify(process.argv.slice(2))}}); return; }
  if (prompt === 'failure') { process.stderr.write('native provider failure'); emit({event:'result',result:{conversation_id:id,status:'ERROR',error:'provider unavailable'}}); process.exitCode=3; return; }
  emit({event:'step_update',step_update:{tool_name:'view_file',text_delta:'checking'}});
  emit({event:'result',result:{conversation_id:id,status:'SUCCESS',response:prompt,usage:{total_tokens:1}}});
});
`);
  if (process.platform !== "win32") { chmodSync(file, 0o755); return file; }
  const shim = join(dir, "agy.cmd"); writeFileSync(shim, '@echo off\nnode "%dp0%\\fake.cjs" %*\n'); return shim;
}

describe("Antigravity process protocol", () => {
  it("round trips literal prompts and resumes the same session through real stdin/stdout", async () => {
    const env = makeEnv();
    try {
      const bin = fakeCli(env.home), onSession = vi.fn(), onProgress = vi.fn(), onInfo = vi.fn();
      const base = { bin, cwd: env.home, access: "read" as const, timeoutSec: 5, log: nullLogger, onSession, onProgress, onInfo };
      const result = await delegateToAntigravity({ ...base, prompt: 'literal "quotes" $() and new\nline' });
      expect(result).toMatchObject({ sessionId: "fake-session", isError: false, text: 'literal "quotes" $() and new\nline' });
      expect(onSession).toHaveBeenCalledWith("fake-session");
      expect(onProgress).toHaveBeenCalledWith(expect.stringMatching(/step 1.*view_file/), expect.stringContaining("view_file"));
      expect(onInfo).toHaveBeenCalledWith(expect.objectContaining({ model: "fake-model", permission: "read" }));
      expect(await delegateToAntigravity({ ...base, prompt: "continued", sessionId: result.sessionId })).toMatchObject({ sessionId: "fake-session", text: "continued" });
    } finally { await env.cleanup(); }
  });
  it("cancels the process tree and retains the early conversation id", async () => {
    const env = makeEnv();
    try {
      const controller = new AbortController();
      await expect(delegateToAntigravity({ bin: fakeCli(env.home), cwd: env.home, prompt: "hang", access: "read", timeoutSec: 5, log: nullLogger, signal: controller.signal, onSession: () => controller.abort() })).rejects.toMatchObject({ kind: "aborted", sessionId: "fake-session" });
    } finally { await env.cleanup(); }
  });
  it.each([false, true])("keeps remote exact bypass=%s and terminal sandbox flags through an actual launch", async bypass => {
    const env = makeEnv();
    try {
      const args = remoteSpawnArgsSchema.parse({ title: "remote AG options", prompt: "args", cwd: env.home, model: "example", effort: "high", terminal_sandbox: true, bypass_permissions: bypass, access: "read" });
      expect(parseJobSettings({ terminal_sandbox: args.terminal_sandbox, bypass_permissions: args.bypass_permissions }, "codex")).toContain("only to antigravity");
      const result = await DELEGATION_TARGETS.antigravity.run({ ...DEFAULT_CONFIG, antigravityBin: fakeCli(env.home) }, { prompt: args.prompt, cwd: args.cwd, model: args.model, effort: args.effort, timeoutSec: 5, log: nullLogger, extraEnv: { AGENT_BRIDGE_HOME: env.home } }, args);
      const launched = JSON.parse(result.text);
      expect(launched).toEqual(expect.arrayContaining(["--sandbox", "--model", "example", "--effort", "high"]));
      expect(launched.includes("--dangerously-skip-permissions")).toBe(bypass);
      expect(existsSync(join(env.home, "antigravity-hooks")) ? readdirSync(join(env.home, "antigravity-hooks")) : []).toEqual([]);
    } finally { await env.cleanup(); }
  });
  it("enforces read access against native writes and MCP mutations with headless bypass present", async () => {
    const env = makeEnv();
    try {
      const bin = fakeCli(env.home), marker = join(env.home, "write.txt");
      const base = { bin, cwd: env.home, access: "read" as const, timeoutSec: 5, log: nullLogger, extraEnv: { AGENT_BRIDGE_HOME: env.home, AB_TEST_HOOK: gate, AB_TEST_WRITE: marker } };
      for (const prompt of ["permission-write", "permission-mcp"]) {
        const result = await delegateToAntigravity({ ...base, prompt });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.text)).toMatchObject({ decision: "deny" });
      }
      expect(existsSync(marker)).toBe(false);
    } finally { await env.cleanup(); }
  });
  it("relays a real native hook's ask decision and denies when no approver is eligible", async () => {
    const env = makeEnv();
    try {
      const bin = fakeCli(env.home), marker = join(env.home, "write.txt"), approve = vi.fn(async () => ({ allow: true as const }));
      const base = { bin, cwd: env.home, prompt: "permission-write", access: "ask" as const, timeoutSec: 5, log: nullLogger, approve, extraEnv: { AGENT_BRIDGE_HOME: env.home, AB_TEST_HOOK: gate, AB_TEST_WRITE: marker, AGENT_BRIDGE_RELAY_URL: "http://127.0.0.1:1/inherited", AGENT_BRIDGE_RELAY_TOKEN: "inherited" } };
      expect((await delegateToAntigravity({ ...base, canApprove: false })).isError).toBe(true);
      expect(approve).not.toHaveBeenCalled(); expect(existsSync(marker)).toBe(false);
      expect((await delegateToAntigravity({ ...base, canApprove: true })).isError).toBe(false);
      expect(readFileSync(marker, "utf8")).toBe("approved");
      expect(approve).toHaveBeenCalledWith(expect.objectContaining({ agent: "antigravity", tool: "write_to_file", cwd: env.home }));
    } finally { await env.cleanup(); }
  });
  it("cancels an unanswered native approval and terminates both CLI and hook subprocesses", async () => {
    const env = makeEnv(), controller = new AbortController();
    try {
      const pids = join(env.home, "pids.json"), marker = join(env.home, "write.txt");
      const approve = vi.fn(() => { controller.abort(); return new Promise<never>(() => {}); });
      await expect(delegateToAntigravity({ bin: fakeCli(env.home), cwd: env.home, prompt: "permission-write", access: "ask", canApprove: true, approve, signal: controller.signal, timeoutSec: 5, log: nullLogger, extraEnv: { AGENT_BRIDGE_HOME: env.home, AB_TEST_HOOK: gate, AB_TEST_WRITE: marker, AB_TEST_PIDS: pids } })).rejects.toMatchObject({ kind: "aborted", sessionId: "fake-session" });
      const owned = JSON.parse(readFileSync(pids, "utf8")) as number[];
      expect(owned).toHaveLength(2);
      await expect.poll(() => owned.every(pid => !pidAlive(pid)), { timeout: 5_000 }).toBe(true);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(env.home, "antigravity-hooks")) ? readdirSync(join(env.home, "antigravity-hooks")) : []).toEqual([]);
    } finally { await env.cleanup(); }
  });
  it("reports native nonzero errors and preserves timeout identity through real process IO", async () => {
    const env = makeEnv();
    try {
      const bin = fakeCli(env.home), base = { bin, cwd: env.home, access: "read" as const, timeoutSec: 1, log: nullLogger, extraEnv: { AGENT_BRIDGE_HOME: env.home } };
      expect(await delegateToAntigravity({ ...base, prompt: "failure" })).toMatchObject({ isError: true, sessionId: "fake-session", details: { exitCode: 3, error: expect.stringContaining("provider unavailable"), stderr: "native provider failure" } });
      await expect(delegateToAntigravity({ ...base, prompt: "hang" })).rejects.toMatchObject({ kind: "timeout", sessionId: "fake-session" });
      expect(existsSync(join(env.home, "antigravity-hooks")) ? readdirSync(join(env.home, "antigravity-hooks")) : []).toEqual([]);
    } finally { await env.cleanup(); }
  });
});
