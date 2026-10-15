import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { delegateToOpencode, OPENCODE_READ_ONLY_TOOLS, pidAlive } from "../src/core/delegate.js";
import { delegateToOpencodeServed, opencodePermissionRequest } from "../src/core/opencode-served.js";
import { classifyOpencodeNativeTool, createOpencodeNativeToolPlugin, hasOpencodeNativeTools, installOpencodeNativeToolGate, opencodeNativeGateReportError, parseOpencodeVersion, type OpencodeNativeAccess } from "../src/core/opencode-native-tools.js";
import { nullLogger } from "../src/core/logger.js";

const mutations = ["opencode_worktree_create", "opencode_session_move", "opencode_session_rename"];
const event = (tool: string) => ({ tool, sessionID: "ses_fixture", agent: "build", input: { sessionID: "ses_other", directory: "/foreign/unpushed", force: true } });

async function gate(access: OpencodeNativeAccess, assert = vi.fn(async (_: any) => {})) {
  let before!: (event: any) => Promise<void>;
  let evaluate!: (event: any) => void;
  await installOpencodeNativeToolGate({
    permission: { assert, hook: async (_: string, fn: typeof evaluate) => { evaluate = fn; } },
    tool: { hook: async (_: string, fn: typeof before) => { before = fn; } },
  }, access);
  return { before, evaluate, assert };
}

it.each(["read", "ask", "edit"] as const)("denies native removal before any permission/execution in %s", async access => {
  const g = await gate(access);
  for (const directory of ["/foreign/unpushed", "/own/dirty", "E:\\trees\\foreign", "e:/trees/foreign", "/link/to/worktree"]) {
    await expect(g.before({ ...event("opencode_worktree_remove"), input: { directory, force: true } })).rejects.toThrow("use Bridge cleanup");
  }
  expect(g.assert).not.toHaveBeenCalled();
});

it("blocks all three native mutations in read mode without changing ordinary reads", async () => {
  const g = await gate("read");
  for (const tool of mutations) await expect(g.before(event(tool))).rejects.toThrow("denied in read mode");
  await g.before(event("read"));
  await g.before(event("opencode_worktree_list"));
  expect(g.assert).not.toHaveBeenCalled();
  expect(OPENCODE_READ_ONLY_TOOLS).toMatchObject({ "*_*": false, bridge_send: true, bridge_report_progress: true });
});

it("asks again for every mutation with the complete target, and propagates denial", async () => {
  const g = await gate("ask");
  for (const tool of [...mutations, ...mutations]) await g.before(event(tool));
  expect(g.assert).toHaveBeenCalledTimes(6);
  expect(g.assert).toHaveBeenCalledWith({ sessionID: "ses_fixture", agent: "build", action: "native.opencode.session_move",
    resources: [JSON.stringify(event("").input)], save: [] });
  const evaluation = { action: "native.opencode.session_move", effect: "allow" };
  g.evaluate(evaluation);
  expect(evaluation.effect).toBe("ask");
  const unrelated = { action: "edit", effect: "deny" };
  g.evaluate(unrelated);
  expect(unrelated.effect).toBe("deny");
  const denied = await gate("ask", vi.fn(async () => { throw new Error("explicit denial"); }));
  await expect(denied.before(event(mutations[0]!))).rejects.toThrow("explicit denial");
  // Even an MCP server called "native.opencode" cannot turn this into a cached server grant.
  expect(opencodePermissionRequest({ permission: "native.opencode.session_move", patterns: ["full arguments"] }, ["native.opencode"], "/repo"))
    .toMatchObject({ tool: "native.opencode.session_move", detail: "full arguments" });
});

it("preserves editable creation and session tools, and serializes a standalone private plugin", async () => {
  const g = await gate("edit");
  for (const tool of mutations) await g.before(event(tool));
  expect(g.assert).not.toHaveBeenCalled();
  const plugin = createOpencodeNativeToolPlugin("read");
  try {
    const exported = (await import(/* @vite-ignore */ pathToFileURL(join(plugin.directory, "index.js")).href)).default;
    let hook: any;
    await exported.setup({ permission: { hook: async () => {} }, tool: { hook: async (_: string, fn: any) => { hook = fn; } } });
    await expect(hook(event("opencode_session_move"))).rejects.toThrow("denied in read mode");
  } finally { plugin.dispose(); }
  expect(existsSync(plugin.directory)).toBe(false);
});

it.each(["opencode v1.18.35", "2.0.26", "opencode v2.0.27", "opencode v2.0.29", "v2.1.0"])("selects the native boundary for %s", version => {
  expect(hasOpencodeNativeTools(version)).toBe(!/1\.18|2\.0\.26/.test(version));
});

it.each([1, 2])("keeps the V%i pre-native run flags and read restrictions unchanged", async major => {
  const cwd = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "opencode-old-"));
  const script = join(cwd, "fake.mjs");
  writeFileSync(script, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('opencode v${major === 1 ? "1.18.35" : "2.0.26"}');process.exit(0)}
appendFileSync(new URL('calls.jsonl',import.meta.url),JSON.stringify({args,config:process.env.OPENCODE_CONFIG_CONTENT})+'\\n');
process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'text',sessionID:'ses_fixture',part:{text:'done'}})));
`);
  const bin = process.platform === "win32" ? join(cwd, "opencode.cmd") : script;
  if (process.platform === "win32") writeFileSync(bin, '@ECHO off\r\n"%dp0%\\fake.mjs" %*\r\n');
  else chmodSync(script, 0o755);
  for (const autoApprove of [false, true]) await delegateToOpencode({ bin, cwd, prompt: "fixture", autoApprove, timeoutSec: 10, log: nullLogger });
  const calls = readFileSync(join(cwd, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls[0].args.includes("--standalone")).toBe(major === 2);
  expect(calls[0].args).not.toContain("--auto");
  expect(JSON.parse(calls[0].config)).toEqual({ permission: { edit: "ask", bash: "ask" }, tools: OPENCODE_READ_ONLY_TOOLS });
  expect(calls[1].args).toContain("--auto");
  expect(calls[1].config).toBeUndefined();
});

it("fails closed before prompting when the private native gate cannot activate", async () => {
  const cwd = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "opencode-gate-failed-"));
  const script = join(cwd, "fake.mjs");
  writeFileSync(script, `#!/usr/bin/env node
import {appendFileSync,writeFileSync} from 'node:fs';import {createServer} from 'node:http';
if(process.argv[2]==='--version'){console.log('opencode v2.0.29');process.exit(0)}
writeFileSync(new URL('pid',import.meta.url),String(process.pid));
writeFileSync(new URL('config.json',import.meta.url),process.env.OPENCODE_CONFIG_CONTENT);
createServer((req,res)=>{appendFileSync(new URL('paths',import.meta.url),req.url+'\\n');res.end(JSON.stringify({data:[{id:'agent-bridge-native-tools',state:{status:'failed'}}]}))})
.listen(0,'127.0.0.1',function(){console.log('listening on http://127.0.0.1:'+this.address().port)});
`);
  const bin = process.platform === "win32" ? join(cwd, "opencode.cmd") : script;
  if (process.platform === "win32") writeFileSync(bin, '@ECHO off\r\n"%dp0%\\fake.mjs" %*\r\n');
  else chmodSync(script, 0o755);
  await expect(delegateToOpencode({ bin, cwd, prompt: "must not execute", autoApprove: true, timeoutSec: 10, log: nullLogger }))
    .rejects.toThrow("native tool gate did not load");
  const config = JSON.parse(readFileSync(join(cwd, "config.json"), "utf8"));
  expect(config.plugins).toHaveLength(1);
  expect(existsSync(config.plugins[0])).toBe(false);
  expect(readFileSync(join(cwd, "paths"), "utf8")).not.toContain("/session");
  expect(pidAlive(Number(readFileSync(join(cwd, "pid"), "utf8")))).toBe(false);
});

/** A fake `opencode` that prints `version` and serves a plugin list with the gate in `status`. */
function fakeServedOpencode(name: string, version: string, status: string) {
  const cwd = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, `opencode-${name}-`));
  const script = join(cwd, "fake.mjs");
  writeFileSync(script, `#!/usr/bin/env node
import {appendFileSync,writeFileSync} from 'node:fs';import {createServer} from 'node:http';
if(process.argv[2]==='--version'){console.log(${JSON.stringify(version)});process.exit(0)}
appendFileSync(new URL('calls.jsonl',import.meta.url),JSON.stringify({args:process.argv.slice(2),config:process.env.OPENCODE_CONFIG_CONTENT??null})+'\\n');
if(process.argv[2]!=='serve'){process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'text',sessionID:'ses_fixture',part:{text:'done'}})));}
else{writeFileSync(new URL('pid',import.meta.url),String(process.pid));
createServer((req,res)=>{appendFileSync(new URL('paths',import.meta.url),req.url+'\\n');res.end(JSON.stringify({data:[{id:'agent-bridge-native-tools',state:{status:${JSON.stringify(status)}}}]}))})
.listen(0,'127.0.0.1',function(){console.log('listening on http://127.0.0.1:'+this.address().port)});}
`);
  const bin = process.platform === "win32" ? join(cwd, "opencode.cmd") : script;
  if (process.platform === "win32") writeFileSync(bin, '@ECHO off\r\n"%dp0%\\fake.mjs" %*\r\n');
  else chmodSync(script, 0o755);
  const read = (file: string) => existsSync(join(cwd, file)) ? readFileSync(join(cwd, file), "utf8") : "";
  return { bin, cwd, read, calls: () => read("calls.jsonl").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}

it.each([
  ["opencode v2.0.29-dev+abc123", "2.0.29-dev+abc123"], ["2.0.29+build.5", "2.0.29+build.5"],
  ["opencode v2.0.27-rc.1", "2.0.27-rc.1"], ["v2.0.26-dev", "2.0.26-dev"], ["opencode v2.1.0-beta.2+sha.f00", "2.1.0-beta.2+sha.f00"],
])("parses suffixed version %s and always requires the native gate", (output, version) => {
  expect(parseOpencodeVersion(output)).toEqual({ api: "v2-native", version });
  expect(hasOpencodeNativeTools(output)).toBe(true);
});

it("never runs a dev/build-suffixed 2.x without the enforcing plugin", async () => {
  const fake = fakeServedOpencode("dev-suffix", "opencode v2.0.29-dev+abc123", "failed");
  await expect(delegateToOpencode({ bin: fake.bin, cwd: fake.cwd, prompt: "must not execute", autoApprove: false, timeoutSec: 10, log: nullLogger }))
    .rejects.toThrow("native tool gate did not load");
  const calls = fake.calls();
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0]).toBe("serve");
  const config = JSON.parse(calls[0].config);
  expect(config.plugins).toHaveLength(1);
  expect(config.tools).toEqual(OPENCODE_READ_ONLY_TOOLS);
  expect(fake.read("paths")).not.toContain("/session");
  expect(pidAlive(Number(fake.read("pid")))).toBe(false);
});

it.each(["opencode version unknown", "", "opencode v3.0.0", "opencode v2.0.29 (local build)", "2.0.29-dev+abc+def",
  "opencode v2.0.29\nopencode v2.0.30", "opencode v2.0", "nightly"])("treats unknown version output %j as unknown", output => {
  expect(parseOpencodeVersion(output).api).toBe("unknown");
  expect(hasOpencodeNativeTools(output)).toBe(false);
});

it("refuses every delegated mode before starting opencode when the version output is unknown", async () => {
  const fake = fakeServedOpencode("unknown-version", "opencode dev build (unknown)", "active");
  const base = { bin: fake.bin, cwd: fake.cwd, prompt: "must not execute", timeoutSec: 10, log: nullLogger };
  for (const autoApprove of [false, true]) {
    await expect(delegateToOpencode({ ...base, autoApprove })).rejects.toThrow(/Unrecognized opencode version output .*cannot be proven gated/);
  }
  const onPermission = vi.fn(async () => ({ allow: true as const }));
  await expect(delegateToOpencodeServed({ ...base, onPermission })).rejects.toThrow("Unrecognized opencode version output");
  await expect(delegateToOpencodeServed({ ...base, onPermission, permissions: null })).rejects.toThrow("Unrecognized opencode version output");
  expect(fake.calls()).toEqual([]);
  expect(onPermission).not.toHaveBeenCalled();
});

it("gates unknown native tool identities: denied in read, approval in ask, removal-like denied everywhere", async () => {
  const unknown = ["opencode_session_delete", "opencode.session.fork", "worktree_checkout", "session.share", "OPENCODE_SESSION_MOVE"];
  const removalLike = ["opencode_worktree_delete", "opencode_worktree_prune", "worktree.remove", "OPENCODE_WORKTREE_REMOVE"];
  for (const tool of unknown) expect(classifyOpencodeNativeTool(tool)).toBe("unknown-native");
  for (const tool of removalLike) expect(classifyOpencodeNativeTool(tool)).toBe("remove");
  expect(classifyOpencodeNativeTool("bridge_get_conversation")).toBe("other");
  const read = await gate("read");
  for (const tool of unknown) await expect(read.before(event(tool))).rejects.toThrow("denied in read mode");
  expect(read.assert).not.toHaveBeenCalled();
  const ask = await gate("ask");
  for (const tool of unknown) await ask.before(event(tool));
  expect(ask.assert).toHaveBeenCalledTimes(unknown.length);
  expect(ask.assert).toHaveBeenCalledWith({ sessionID: "ses_fixture", agent: "build", action: "native.opencode.session_delete",
    resources: [JSON.stringify(event("").input)], save: [] });
  const denied = await gate("ask", vi.fn(async () => { throw new Error("explicit denial"); }));
  for (const tool of unknown) await expect(denied.before(event(tool))).rejects.toThrow("explicit denial");
  for (const access of ["read", "ask", "edit"] as const) {
    const g = await gate(access);
    for (const tool of removalLike) await expect(g.before(event(tool))).rejects.toThrow("use Bridge cleanup");
    expect(g.assert).not.toHaveBeenCalled();
  }
  // The startup inventory must contain the identities the gate was proven against.
  const report = (inventory: unknown, access: OpencodeNativeAccess = "read") =>
    opencodeNativeGateReportError({ contract: 1, access, hooks: ["permission.evaluate", "tool.execute.before"], inventory }, access);
  expect(report([...mutations, "opencode_worktree_remove", "opencode_session_delete", "read"])).toBeNull();
  expect(report([...mutations, "opencode_worktree_remove"], "ask")).toBeNull();
  expect(report(["opencode.worktree.create", "opencode.worktree.remove", "opencode.session.move", "opencode.session.rename"])).toMatch("native tool API is unknown");
  expect(report([...mutations], "ask")).toMatch("without opencode_worktree_remove");
  expect(report(null)).toMatch("could not read the native tool inventory");
  expect(report(null, "ask")).toMatch("could not read the native tool inventory");
  expect(report([...mutations, "opencode_worktree_remove", 7])).toMatch("could not read the native tool inventory");
});

it("fails closed on unexpected hook and plugin API shapes", async () => {
  for (const access of ["read", "ask", "edit"] as const) {
    const g = await gate(access);
    for (const shape of [undefined, null, "opencode_session_move", {}, { tool: 42 }, { tool: "" }, { name: "opencode_worktree_remove" }]) {
      await expect(g.before(shape)).rejects.toThrow("unexpected native tool hook shape");
    }
    expect(() => g.evaluate(undefined)).toThrow("unexpected native permission hook shape");
    const evaluation: any = { effect: "allow", permission: "native.opencode.session_move" };
    g.evaluate(evaluation);
    expect(evaluation.effect).toBe({ read: "deny", ask: "ask", edit: "allow" }[access]);
    expect(g.assert).not.toHaveBeenCalled();
  }
  const ask = await gate("ask");
  for (const sessionID of [undefined, 7, ""]) {
    await expect(ask.before({ ...event("opencode_session_move"), sessionID })).rejects.toThrow("unexpected native tool hook shape");
  }
  const cyclic: any = {}; cyclic.self = cyclic;
  await expect(ask.before({ ...event("opencode_session_rename"), input: cyclic })).rejects.toThrow("unexpected native tool hook shape");
  expect(ask.assert).not.toHaveBeenCalled();
  // Setup refuses a plugin API it cannot enforce through, so the plugin never becomes active.
  const hook = async () => {};
  await expect(installOpencodeNativeToolGate({ permission: { hook }, tool: {} }, "edit")).rejects.toThrow("lacks permission/tool hooks");
  await expect(installOpencodeNativeToolGate({ tool: { hook } }, "read")).rejects.toThrow("lacks permission/tool hooks");
  await expect(installOpencodeNativeToolGate({ permission: { hook }, tool: { hook } }, "ask")).rejects.toThrow("lacks permission.assert");
  // A report without the registered hooks or with another contract or access is not proof of enforcement.
  const inventory = [...mutations, "opencode_worktree_remove"];
  expect(opencodeNativeGateReportError(null, "edit")).toMatch("no enforcement contract");
  expect(opencodeNativeGateReportError({ contract: 2, access: "read", hooks: ["permission.evaluate", "tool.execute.before"], inventory }, "read")).toMatch("unsupported contract");
  expect(opencodeNativeGateReportError({ contract: 1, access: "edit", hooks: ["permission.evaluate", "tool.execute.before"], inventory }, "read")).toMatch("instead of");
  expect(opencodeNativeGateReportError({ contract: 1, access: "ask", hooks: ["tool.execute.before"], inventory }, "ask")).toMatch("enforcement hooks");
});

it("refuses before prompting when the gate is active but proves no enforcement contract", async () => {
  // The fake server lists the plugin as active but never runs it, so no gate report exists.
  const fake = fakeServedOpencode("gate-no-report", "opencode v2.0.29", "active");
  for (const autoApprove of [false, true]) {
    await expect(delegateToOpencode({ bin: fake.bin, cwd: fake.cwd, prompt: "must not execute", autoApprove, timeoutSec: 10, log: nullLogger }))
      .rejects.toThrow("native tool gate reported no enforcement contract");
  }
  expect(fake.read("paths")).toContain("/plugin");
  expect(fake.read("paths")).not.toContain("/session");
  for (const call of fake.calls()) expect(existsSync(JSON.parse(call.config).plugins[0])).toBe(false);
});

// Opt in to the installed native CLI. The fake provider emits exact tool calls: no model guesswork,
// external API or credentials. Native fixtures are retained; no manual worktree cleanup is performed.
const nativeBin = process.env.AB316_OPENCODE_BIN;
it.skipIf(!nativeBin).each(["read", "ask-deny", "ask-allow", "edit"] as const)("native Code Mode enforces %s in a generated repository", async mode => {
  const root = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, `ab316-${mode}-`));
  const cwd = join(root, "repo"), destination = join(root, "destination"), victim = join(root, "foreign-unpushed");
  mkdirSync(cwd); mkdirSync(destination);
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "rennerdo30", GIT_AUTHOR_EMAIL: "9086097+rennerdo30@users.noreply.github.com",
    GIT_COMMITTER_NAME: "rennerdo30", GIT_COMMITTER_EMAIL: "9086097+rennerdo30@users.noreply.github.com" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, timeout: 15_000, windowsHide: true, encoding: "utf8" });
  git("init", "-b", "main"); writeFileSync(join(cwd, "seed.txt"), "fixture\n"); git("add", "seed.txt"); git("commit", "-m", "Seed fixture");
  git("worktree", "add", "-b", "foreign-unpushed", victim);
  writeFileSync(join(victim, "untracked.txt"), "must survive\n");
  const attempts = [
    ["worktree_create", { name: "created" }],
    ["session_rename", { title: "AB316 renamed" }],
    ["session_rename", { title: "AB316 renamed again" }],
    ["session_move", { directory: destination }],
    ["worktree_remove", { directory: victim, force: true }],
  ];
  const code = `const results=[];for(const [name,input] of ${JSON.stringify(attempts)}){try{results.push({name,result:await tools.opencode[name](input)})}catch(e){results.push({name,error:String(e)})}}return results`;
  const requests: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const call = body.tools?.length && !body.messages.some((m: any) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: any, finish_reason: string | null = null) => res.write("data: " + JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n");
    send({ role: "assistant" });
    send(call ? { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "execute", arguments: JSON.stringify({ code }) } }] } : { content: "probe complete" });
    send({}, call ? "tool_calls" : "stop"); res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  const configDir = join(root, "config", "opencode"); mkdirSync(configDir, { recursive: true });
  const observer = join(root, "observer"); mkdirSync(observer);
  writeFileSync(join(observer, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
  writeFileSync(join(observer, "index.js"), `import {appendFileSync} from 'node:fs';export default {id:'ab316-observer',async setup(ctx){const log=x=>appendFileSync(${JSON.stringify(join(root, "native.jsonl"))},JSON.stringify(x)+'\\n');log({inventory:(await ctx.tool.list()).map(t=>t.id)});await ctx.tool.hook('execute.after',e=>log(e));}}`);
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugins: [observer], worktree: { directory: join(root, "trees") }, model: "probe/probe",
    // An explicit broad allow must still produce one approval for each native operation.
    permissions: [{ action: "native.opencode.*", resource: "*", effect: "allow" }],
    providers: { probe: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${port}/v1` }, models: { probe: { capabilities: { tools: true }, limit: { context: 128000, output: 4096 } } } } } }));
  const extraEnv = { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state") };
  const approvals: any[] = [], pids: number[] = [];
  const log = { ...nullLogger, info: (_: string, data?: any) => { if (data?.pid) pids.push(data.pid); } };
  try {
    const base = { bin: nativeBin!, cwd, extraEnv, model: "probe/probe", prompt: "Run the exact probe", timeoutSec: 45, log };
    const result = mode === "read" || mode === "edit" ? await delegateToOpencode({ ...base, autoApprove: mode === "edit" }) :
      await delegateToOpencodeServed({ ...base, onPermission: async r => {
        // No target has changed when its approval is first presented.
        if (r.tool.endsWith("worktree_create")) expect(existsSync(join(root, "trees", "created"))).toBe(false);
        approvals.push(r); return mode === "ask-allow" ? { allow: true } : { allow: false, message: "fixture explicit denial" };
      } });
    expect(result).toMatchObject({ text: "probe complete", isError: false });
    const native = readFileSync(join(root, "native.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(native.find(e => e.inventory).inventory).toEqual(expect.arrayContaining([...mutations, "opencode_worktree_remove"]));
    const results = JSON.parse(native.find(e => e.tool === "execute" && e.status === "completed").result.output.output);
    expect(results.at(-1).error).toContain("use Bridge cleanup");
    expect(readFileSync(join(victim, "untracked.txt"), "utf8")).toBe("must survive\n");
    expect(git("worktree", "list", "--porcelain")).toContain("foreign-unpushed");
    if (mode.startsWith("ask")) expect(approvals.map(r => r.tool)).toEqual(["native.opencode.worktree_create", "native.opencode.session_rename", "native.opencode.session_rename", "native.opencode.session_move"]);
    else expect(approvals).toEqual([]);
    if (mode === "ask-allow" || mode === "edit") {
      expect(results.slice(0, -1).every((r: any) => r.result && !r.error)).toBe(true);
      expect(existsSync(join(root, "trees", "created", "seed.txt"))).toBe(true);
    } else {
      expect(results.every((r: any) => r.error && !r.result)).toBe(true);
      expect(existsSync(join(root, "trees", "created"))).toBe(false);
    }
    writeFileSync(join(root, "evidence.json"), JSON.stringify({ mode, result, approvals, results, pids }, null, 2));
    console.log(`AB-316 native evidence: ${root}; PIDs ${pids.join(", ")}`);
  } finally {
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    for (const pid of pids) expect(pidAlive(pid)).toBe(false);
  }
}, 60_000);
