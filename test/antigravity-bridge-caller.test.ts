import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { registerAntigravityRoot } from "../src/core/antigravity-plugin.js";
import { processIdentity } from "../src/core/process-identity.js";
import { makeEnv } from "./helpers.js";

// Linux argv0 supplies a hermetic native executable identity to the real /proc
// ancestor walker. Both host and PreToolUse subprocess run production code.
it.skipIf(process.platform !== "linux")("blocks shared-server native child tools without changing builtin permissions", async () => {
  const env = makeEnv(), gate = join(env.home, "gate.mjs"), script = join(env.home, "host.cjs"), executions = join(env.home, "executions.jsonl");
  let host: ChildProcess | undefined, release: (() => void) | undefined;
  try {
    await build({ stdin: { contents: 'import {runAntigravityHook} from "./src/cli/antigravity-hook.ts"; await runAntigravityHook(process.argv[2]);', resolveDir: join(import.meta.dirname, "..") }, outfile: gate, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    writeFileSync(script, `
const {execFileSync} = require('node:child_process');
const {appendFileSync} = require('node:fs');
const {createInterface} = require('node:readline');
console.log(JSON.stringify({ready:true}));
(async () => {
  for await (const line of createInterface({input:process.stdin})) {
    const request=JSON.parse(line), env={...process.env};
    if(request.access === undefined)delete env.AGENT_BRIDGE_ANTIGRAVITY_ACCESS;
    else env.AGENT_BRIDGE_ANTIGRAVITY_ACCESS=request.access;
    const decision=JSON.parse(execFileSync(process.execPath,[process.env.AB_TEST_GATE,'PreToolUse'],{input:JSON.stringify(request.input),env,encoding:'utf8'}));
    if(decision.decision === 'allow' && request.input.toolCall.name === 'call_mcp_tool')appendFileSync(process.env.AB_TEST_EXECUTIONS,JSON.stringify(request.input)+'\\n');
    console.log(JSON.stringify(decision));
  }
})();
`);
    host = spawn(process.execPath, [script], { argv0: "agy", env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AB_TEST_GATE: gate, AB_TEST_EXECUTIONS: executions }, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: host.stdout! })[Symbol.asyncIterator]();
    expect(JSON.parse((await lines.next()).value!)).toEqual({ ready: true });
    const call = async (input: Record<string, unknown>, access?: string) => {
      host!.stdin!.write(JSON.stringify({ input, access }) + "\n");
      return JSON.parse((await lines.next()).value!) as Record<string, unknown>;
    };
    const bridge = (conversationId: unknown, tool = "inbox", server = "agent-bridge_agent-bridge") => ({ conversationId, toolCall: { name: "call_mcp_tool", args: { ServerName: server, ToolName: tool } }, workspacePaths: [env.home] });
    const deny = { decision: "deny", reason: expect.stringContaining("unverified conversation") };
    // Even the root cannot claim the shared connection without independent evidence.
    expect(await call(bridge("root"), "edit")).toMatchObject(deny);
    expect(existsSync(executions)).toBe(false);
    release = registerAntigravityRoot(env.home, host.pid!, "root");
    for (const access of [undefined, "read", "ask", "edit"]) {
      for (const tool of ["inbox", "send", "spawn_codex", "decide"]) {
        expect(await call(bridge("child", tool), access)).toMatchObject(deny);
        expect(await call(bridge(undefined, tool, "agent-bridge"), access)).toMatchObject(deny);
      }
    }
    expect(existsSync(executions)).toBe(false);
    for (const access of [undefined, "read", "ask", "edit"]) {
      expect(await call(bridge("root"), access)).toEqual({ decision: "allow", permissionOverrides: ["mcp(agent-bridge_agent-bridge/inbox)"] });
    }
    expect(readFileSync(executions, "utf8").trim().split("\n")).toHaveLength(4);
    expect(await call({ conversationId: "child", toolCall: { name: "view_file" } }, "read")).toEqual({ decision: "allow" });
    expect(await call({ conversationId: "child", toolCall: { name: "write_to_file" } }, "edit")).toEqual({});
    expect(await call({ conversationId: "child", toolCall: { name: "write_to_file" } })).toEqual({});
    // Restored native hook registrations are another trusted root path; PID
    // reuse and a replaced/dead owner cannot authorize a child or unknown root.
    release(); release = undefined;
    const file = join(env.home, "antigravity-hooks", `${host.pid}.json`);
    const record = { hostIdentity: processIdentity(host.pid!), identity: processIdentity(process.pid), pid: process.pid, conversationId: "root" };
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    expect(await call(bridge("root", "send", "agent-bridge"), "edit")).toMatchObject({ decision: "allow" });
    expect(await call(bridge("child", "send", "agent-bridge"), "edit")).toMatchObject(deny);
    const before = readFileSync(executions, "utf8");
    writeFileSync(file, JSON.stringify({ ...record, hostIdentity: "previous-host-generation" }));
    expect(await call(bridge("root"), "edit")).toMatchObject(deny);
    writeFileSync(file, JSON.stringify({ ...record, identity: "previous-mcp-generation" }));
    expect(await call(bridge("root"))).toMatchObject(deny);
    unlinkSync(file);
    expect(await call(bridge("root"), "ask")).toMatchObject(deny);
    expect(readFileSync(executions, "utf8")).toBe(before);
  } finally {
    release?.();
    if (host && host.exitCode === null && host.signalCode === null) await new Promise<void>(resolve => { host!.once("close", () => resolve()); host!.kill(); });
    await env.cleanup();
  }
});
