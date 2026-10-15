import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildSync } from "esbuild";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { delegateToMuse } from "../src/core/muse.js";
import { museHookFile, readMusePrivateJson, registerMuseContext, writeMusePrivateJson } from "../src/core/muse-context.js";
import { MuseHooks } from "../src/mcp/muse-hooks.js";
import { ParentLink } from "../src/core/parent-link.js";
import { nullLogger } from "../src/core/logger.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv } from "./helpers.js";

const SERVER = join(import.meta.dirname, "../plugins/muse/dist/server.mjs");
const CLI = join(import.meta.dirname, "../plugins/muse/dist/cli.mjs");
const cleanups: (() => void | Promise<void>)[] = [];
const exec = promisify(execFile);
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
function fixture() { const env = makeEnv(); vi.stubEnv("TMPDIR", env.home); vi.stubEnv("TMP", env.home); vi.stubEnv("TEMP", env.home); cleanups.push(() => env.cleanup()); cleanups.push(registerMuseContext(process.ppid, { TEMP: env.home, TMP: env.home, TMPDIR: env.home, AGENT_BRIDGE_INTERNAL: "1" })); return env; }
const text = (result: any) => result.content?.map((item: any) => item.text ?? "").join("\n") ?? "";

/** A real Muse-shaped host: the MCP child receives Muse's sanitized plugin environment. */
function host(env: ReturnType<typeof makeEnv>, delegated = false, invalid: string | null = null) {
  const file = join(env.home, "muse.mjs");
  const context = join(env.home, "context.mjs");
  buildSync({ entryPoints: [join(import.meta.dirname, "../src/core/muse-context.ts")], outfile: context, bundle: true, platform: "node", format: "esm" });
  writeFileSync(file, `#!/usr/bin/env node
import {spawn,execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {writeFileSync,readFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
import {StdioClientTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/stdio.js"))};
const {readMusePrivateJson,writeMusePrivateJson}=await import(${JSON.stringify(pathToFileURL(context).href)});
const session='native-root';
const nativeEnv={HOME:process.env.HOME,PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE,TEMP:process.env.TEMP,TMP:process.env.TMP,TMPDIR:process.env.TMPDIR,MUSE_SESSION_ID:session};
if (${delegated}) {
 if (${JSON.stringify(invalid)} !== 'early-mcp') { process.stdin.resume(); await new Promise(resolve=>process.stdin.once('end',resolve)); }
 const invalid=${JSON.stringify(invalid)};
 if(invalid && invalid!=='early-mcp'){
  const path=join(tmpdir(),'agent-bridge-muse-'+(process.getuid?.()??'user'),'host-'+process.pid+'.json');
  const record=readMusePrivateJson(path);
  if(invalid==='reused-pid')record.identity='stale-identity';
  if(invalid==='wrong-pid')record.pid++;
  if(invalid==='corrupt')writeFileSync(path,'{');else writeMusePrivateJson(path,record,'w');
  if(invalid==='unsafe-mode'){if(process.platform==='win32')writeFileSync(path,JSON.stringify(record));else chmodSync(path,0o644);}
 }
 const client=new Client({name:'sanitized-muse-child',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(SERVER)},'--agent=muse'],cwd:process.cwd(),env:nativeEnv,stderr:'inherit'});
 await client.connect(transport);
 const names=(await client.listTools()).tools.map(t=>t.name);
 const peers=await client.callTool({name:'peers',arguments:{}});
 const refused=invalid && invalid!=='early-mcp';
 const send=refused?null:await client.callTool({name:'send',arguments:{to:'parent',message:'sanitized child report'}});
 const progress=refused?null:await client.callTool({name:'report_progress',arguments:{percent:50,note:'registry restored'}});
 const hook=refused?null:await new Promise((resolve,reject)=>{
  execFile(process.execPath,[${JSON.stringify(CLI)},'muse-hook','UserPromptSubmit'],{env:nativeEnv,timeout:10000},(error,stdout)=>error?reject(error):resolve(JSON.parse(stdout))).stdin.end('{}');
 });
 await client.close();
 console.log(JSON.stringify({stream:{kind:'session',id:session},payload:{kind:'run_terminal',terminal:'completed',text:JSON.stringify({names,peers,send,progress,hook})}}));
} else {
 const child=spawn(process.execPath,[${JSON.stringify(SERVER)},'--agent=muse'],{cwd:process.cwd(),env:{...process.env,MUSE_SESSION_ID:session},stdio:['pipe','pipe','inherit']});
 process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);
 const control=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
  const input=JSON.stringify(body.input??{});
  execFile(process.execPath,[${JSON.stringify(CLI)},'muse-hook',body.event],{env:{...process.env,MUSE_SESSION_ID:session,...(body.thread?{MUSE_THREAD_ID:body.thread}:{})},timeout:10000},(error,stdout)=>{res.writeHead(error?500:200,{'content-type':'application/json'}).end(stdout||'{}');}).stdin.end(input);
 });
 await new Promise(resolve=>control.listen(0,'127.0.0.1',resolve));
 writeFileSync(${JSON.stringify(join(env.home, "host.json"))},JSON.stringify({pid:process.pid,port:control.address().port}));
 child.on('exit',code=>{control.close();process.exit(code??0)});
 process.on('SIGTERM',()=>{child.kill('SIGTERM');control.close()});
}
`);
  chmodSync(file, 0o755); if (process.platform === "win32") { const shim=join(env.home,"muse.cmd"); writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0\\muse.mjs" %*\r\n`); return shim; } return file;
}

async function native() {
  const env = fixture(); host(env);
  const file = join(env.home, "muse.mjs"), client = new Client({ name: "muse-native-owner", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [file], cwd: env.home, stderr: "inherit",
    env: { ...process.env, HOME: env.home, TEMP: env.home, TMP: env.home, TMPDIR: env.home, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_NAME: "muse-owner", AGENT_BRIDGE_MUSE_ACCESS: "read", AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_AUTO_WAKE: "off", AGENT_BRIDGE_WAKE_ON_DIRECT: "off" } as Record<string, string> });
  await client.connect(transport); cleanups.push(() => client.close());
  const observer = env.node("observer", "other"); await observer.start();
  await client.callTool({ name: "peers", arguments: {} });
  await expect.poll(() => existsSync(join(env.home, "host.json"))).toBe(true);
  const info = JSON.parse(readFileSync(join(env.home, "host.json"), "utf8"));
  // Hooks publish in the host's own TMPDIR, not the test process's TMPDIR.
  vi.stubEnv("TMPDIR", env.home);
  await expect.poll(() => existsSync(museHookFile(info.pid, "native-root"))).toBe(true);
  const reg = readMusePrivateJson(museHookFile(info.pid, "native-root"));
  const hook = async (event: string, thread?: string, input: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${info.port}`, { method: "POST", body: JSON.stringify({ event, thread, input: { cwd: env.home, ...input } }) });
    expect(response.status).toBe(200); return response.json();
  };
  return { env, observer, client, hook, reg, registration: museHookFile(info.pid, "native-root") };
}

describe("Muse native bootstrap and hook delivery", () => {
  it("binds native injected session identity and delivers root mail before and after tools", async () => {
    const { observer, hook, client } = await native();
    expect((await observer.peers()).find(peer => peer.name === "muse-owner")).toMatchObject({ agent: "muse", sessionId: "native-root" });
    for (const event of ["UserPromptSubmit", "PreLLMCall", "PostToolUse"]) {
      await observer.send({ to: "muse-owner", body: `mail for ${event}` });
      expect(JSON.stringify(await hook(event))).toContain(`mail for ${event}`);
    }
    await client.callTool({ name: "send", arguments: { to: "observer", message: "open conversation" } });
    await observer.send({ to: "muse-owner", body: "mail at Stop" });
    expect(await hook("Stop")).toMatchObject({ decision: "block", reason: expect.stringContaining("mail at Stop") });
  });
  it("prevents native child hooks and spoofed session input from consuming root mail or activity", async () => {
    const { observer, hook, client } = await native();
    await hook("Stop");
    const initial = (await observer.peers()).find(peer => peer.name === "muse-owner")!;
    await observer.send({ to: "muse-owner", body: "root retained mail" });
    for (const event of ["UserPromptSubmit", "PreLLMCall", "PostToolUse", "Stop", "SessionStart", "SessionEnd"]) {
      expect(await hook(event, "native-child")).toEqual({});
      expect(await hook(event, undefined, { session_id: "spoofed-session" })).toEqual({});
    }
    expect((await observer.peers()).find(peer => peer.name === "muse-owner")).toMatchObject({ id: initial.id, sessionId: "native-root", activity: initial.activity });
    expect(text(await client.callTool({ name: "inbox", arguments: { mark_read: false } }))).toContain("root retained mail");
    await client.callTool({ name: "hook_event", arguments: { event: "UserPromptSubmit", session_id: "spoofed-mcp-session" } });
    expect((await observer.peers()).find(peer => peer.name === "muse-owner")).toMatchObject({ sessionId: "native-root", activity: initial.activity });
  });
  it("authenticates the endpoint and verifies host and server creation identities", async () => {
    const { hook, reg, registration } = await native();
    expect((await fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${reg.port}/other`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}` }, body: "{}" })).status).toBe(403);
    expect(await (await fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}` }, body: JSON.stringify({ session: "wrong", event: "Stop" }) })).json()).toEqual({});
    for (const patch of [{ hostIdentity: "reused-host-pid" }, { identity: "reused-server-pid" }, { session: "foreign-session" }, { pid: 2_147_483_647 }]) {
      writeMusePrivateJson(registration, { ...reg, ...patch }, "w");
      expect(await hook("PreToolUse", undefined, { tool_name: "read_file" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "agent-bridge permission gate unavailable" } });
    }
    writeMusePrivateJson(registration, reg, "w");
    expect(await hook("PreToolUse", "native-child", { tool_name: "read_file" })).toEqual({});
    writeFileSync(registration, "{");
    expect(await hook("PreToolUse", undefined, { tool_name: "read_file" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it.each([1, 2])("restores a sanitized delegated MCP child's parent and depth with cap %i", async cap => {
    const env = fixture(), reports: string[] = [], progress: number[] = [];
    vi.stubEnv("TMPDIR", env.home);
    const observer = env.node("observer", "other"); await observer.start();
    const link = new ParentLink("native-parent", body => reports.push(body), nullLogger, percent => progress.push(percent));
    await link.start(); cleanups.push(async () => { await link.close(); }); link.post("private parent instructions");
    const result = await delegateToMuse({ bin: host(env, true), prompt: "fixture task", cwd: env.home, access: "read", timeoutSec: 20, log: nullLogger,
      extraEnv: { ...link.childEnv(), HOME: env.home, TEMP: env.home, TMP: env.home, TMPDIR: env.home, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_MAX_DELEGATE_DEPTH: String(cap), AGENT_BRIDGE_PARENT_JOB: "muse-job-parent", AGENT_BRIDGE_ROOT_SESSION: "root", AGENT_BRIDGE_ROOT_NAME: "root-owner", ARBITRARY_SECRET: "must not escape" } });
    const output = JSON.parse(result.text);
    expect(result.sessionId).toBe("native-root");
    expect(text(output.peers)).toContain("native-parent"); expect(output.send.isError).not.toBe(true); expect(reports).toEqual(["sanitized child report"]);
    expect(progress).toEqual([50]); expect(JSON.stringify(output.hook)).toContain("private parent instructions");
    expect(output.names.includes("ask_muse")).toBe(cap > 1); expect(output.names).toContain("report_progress");
    expect((await observer.peers()).map(peer => peer.name)).toEqual(["observer"]);
  });
  it("authenticates an MCP child launched before the handoff is published", async () => {
    const env = fixture(), reports: string[] = [];
    const observer = env.node("observer", "other"); await observer.start();
    const link = new ParentLink("early-parent", body => reports.push(body), nullLogger);
    await link.start(); cleanups.push(async () => { await link.close(); });
    const result = await delegateToMuse({ bin: host(env, true, "early-mcp"), prompt: "fixture task", cwd: env.home, access: "read", timeoutSec: 25, log: nullLogger,
      extraEnv: { ...link.childEnv(), HOME: env.home, TEMP: env.home, TMP: env.home, TMPDIR: env.home, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_PARENT_JOB: "early-job", AGENT_BRIDGE_ROOT_SESSION: "root", AGENT_BRIDGE_ROOT_NAME: "root-owner" } });
    const output = JSON.parse(result.text);
    expect(text(output.peers)).toContain("early-parent"); expect(output.send.isError).not.toBe(true);
    expect(reports).toEqual(["sanitized child report"]);
    expect((await observer.peers()).map(peer => peer.name)).toEqual(["observer"]);
  });
  it.each(["corrupt", "reused-pid", "wrong-pid", "unsafe-mode"])("refuses top-level registration after a %s delegated host record", async invalid => {
    const env = fixture(); vi.stubEnv("TMPDIR", env.home);
    const observer = env.node("observer", "other"); await observer.start();
    const result = await delegateToMuse({ bin: host(env, true, invalid), prompt: "fixture task", cwd: env.home, access: "read", timeoutSec: 20, log: nullLogger,
      extraEnv: { HOME: env.home, TEMP: env.home, TMP: env.home, TMPDIR: env.home, AGENT_BRIDGE_HOME: env.home } });
    const output = JSON.parse(result.text);
    expect(output.peers.isError).toBe(true); expect(output.names).not.toContain("report_progress");
    expect((await observer.peers()).map(peer => peer.name)).toEqual(["observer"]);
  });
});

describe("Muse hook permission enforcement", () => {
  it("binds a late SDK root identity only through the authenticated host endpoint", async () => {
    fixture();
    const bind = vi.fn(async () => {});
    const node = Object.assign(new EventEmitter(), { setSessionId: bind });
    const hooks = new MuseHooks({ node, headless: true, log: nullLogger } as unknown as ServerContext, "");
    await hooks.start(); cleanups.push(() => hooks.stop());
    const reg = readMusePrivateJson(museHookFile(process.ppid, "bootstrap"));
    expect(reg.session).toBeNull();
    const call = (session: string, thread?: string, secret = reg.secret) => fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ session, thread, event: "PreToolUse", input: { tool_name: "read_file" } }) });
    expect((await call("late-root", undefined, "wrong")).status).toBe(403);
    expect((await call("late-root", "native-child")).status).toBe(500);
    expect(bind).not.toHaveBeenCalled();
    expect((await call("late-root")).status).toBe(200);
    expect(bind).toHaveBeenCalledExactlyOnceWith("late-root");
    expect((await call("foreign-root")).status).toBe(500);
    expect(bind).toHaveBeenCalledTimes(1);
  });
  it.each(["read", "ask", "edit"])("enforces %s access over native allow rules, including native children", async access => {
    const env = fixture(); vi.stubEnv("TMPDIR", env.home); vi.stubEnv("MUSE_SESSION_ID", "permission-root"); vi.stubEnv("AGENT_BRIDGE_MUSE_ACCESS", access);
    const node = Object.assign(new EventEmitter(), { currentSessionId: "permission-root" });
    const hooks = new MuseHooks({ node } as unknown as ServerContext);
    await hooks.start(); cleanups.push(() => hooks.stop());
    const reg = readMusePrivateJson(museHookFile(process.ppid, "permission-root"));
    const call = async (tool: string) => (await fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}` }, body: JSON.stringify({ session: "permission-root", thread: "child", event: "PreToolUse", input: { tool_name: tool } }) })).json();
    for (const tool of ["write_file", "bash", "mcp__dangerous_server__delete_everything"]) {
      expect(await call(tool)).toEqual(access === "edit" ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: access === "read" ? "deny" : "ask", ...(access === "read" ? { permissionDecisionReason: "agent-bridge read access forbids this tool" } : {}) } });
    }
    for (const tool of ["read_file", "grep"]) expect(await call(tool)).toEqual({});
    for (const tool of ["mcp__plugin_agent_bridge_bridge__inbox", "mcp__plugin_agent_bridge_bridge__send", "mcp__agent_bridge__ask_muse"]) expect(await call(tool)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("share the root MCP") } });
    node.emit("replaced");
    expect((await fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}` }, body: "{}" })).status).toBe(403);
    node.emit("reclaimed"); expect(await call("read_file")).toEqual({});
  });
  it.each(["read", "ask", "internal", "missing-session"])("fails closed when the %s delegated permission gate is unavailable", async access => {
    const env = fixture();
    const pending = exec(process.execPath, [CLI, "muse-hook", "PreToolUse"], { timeout: 10_000, env: { HOME: env.home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE, TEMP: env.home, TMP: env.home, TMPDIR: env.home,
      ...(access === "missing-session" ? { AGENT_BRIDGE_INTERNAL: "1" } : { MUSE_SESSION_ID: "missing-endpoint" }), ...(access === "internal" ? { AGENT_BRIDGE_INTERNAL: "1" } : { AGENT_BRIDGE_MUSE_ACCESS: access }) } });
    pending.child.stdin!.end("{}");
    const result = await pending;
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "agent-bridge permission gate unavailable" } });
  });
  it("old hook cleanup retains a successor endpoint registration", async () => {
    const env = fixture(); vi.stubEnv("TMPDIR", env.home); vi.stubEnv("MUSE_SESSION_ID", "successor-root");
    const ctx = { node: new EventEmitter() } as unknown as ServerContext;
    const old = new MuseHooks(ctx), successor = new MuseHooks(ctx);
    await old.start(); cleanups.push(() => old.stop()); await successor.start(); cleanups.push(() => successor.stop());
    const file = museHookFile(process.ppid, "successor-root"), record = readMusePrivateJson(file);
    await old.stop(); expect(readMusePrivateJson(file)).toEqual(record);
    expect(ctx.node!.listenerCount("replaced")).toBe(1);
    expect(ctx.node!.listenerCount("reclaimed")).toBe(1);
    await successor.stop();
    expect(ctx.node!.listenerCount("replaced")).toBe(0);
    expect(ctx.node!.listenerCount("reclaimed")).toBe(0);
  });
  it("republishes the owned endpoint when a predecessor reclaims its native host", async () => {
    const env = fixture(); vi.stubEnv("TMPDIR", env.home); vi.stubEnv("MUSE_SESSION_ID", "reclaimed-root");
    const ctx = { node: new EventEmitter() } as unknown as ServerContext;
    const old = new MuseHooks(ctx), successor = new MuseHooks({ node: new EventEmitter() } as unknown as ServerContext);
    await old.start(); cleanups.push(() => old.stop());
    const file = museHookFile(process.ppid, "reclaimed-root"), original = readMusePrivateJson(file);
    ctx.node!.emit("replaced"); await successor.start(); cleanups.push(() => successor.stop());
    expect(readMusePrivateJson(file).secret).not.toBe(original.secret);
    await successor.stop(); ctx.node!.emit("reclaimed");
    expect(readMusePrivateJson(file)).toEqual(original);
    const response = await fetch(`http://127.0.0.1:${original.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${original.secret}` }, body: JSON.stringify({ session: "reclaimed-root", thread: "child", event: "PreToolUse", input: { tool_name: "read_file" } }) });
    expect(response.status).toBe(200);
  });
});
