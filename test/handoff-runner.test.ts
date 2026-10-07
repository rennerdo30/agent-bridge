import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { readRunnerState } from "../src/mcp/job-host.js";
import { readStore } from "../src/mcp/jobs.js";
import { parentFromEnv } from "../src/core/parent-link.js";
import { pidAlive, killPid } from "../src/core/delegate.js";
import type { CodingAgent } from "../src/core/protocol.js";

const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
let env: TestEnv, bin: string;
const clients: Client[] = [];
const runnerIds: string[] = [];
const releases: string[] = [];
beforeEach(() => {
  env = makeEnv(); const dir = join(env.home, "bin"); mkdirSync(dir);
  const file = join(dir, "fake.mjs");
  writeFileSync(file, `#!/usr/bin/env node
import { existsSync, writeFileSync, renameSync } from 'node:fs';
let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',d=>prompt+=d);
process.stdin.on('end',async()=>{
 const args=process.argv.slice(2), session=args.includes('--resume')?args[args.indexOf('--resume')+1]:'fixture-'+process.pid;
 console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,model:'fixture'}));
 const release=/release=(\\S+)/.exec(prompt)?.[1], link=/link=(\\S+)/.exec(prompt)?.[1];
 if(link){writeFileSync(link+'.tmp',JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('AGENT_BRIDGE_PARENT_')))));renameSync(link+'.tmp',link);}
 while(release&&!existsSync(release))await new Promise(r=>setTimeout(r,30));
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Inherited runner finished',session_id:session}));
});`);
  if (process.platform === "win32") { bin = join(dir, "claude.cmd"); writeFileSync(bin, '@ECHO off\r\n"%dp0%\\fake.mjs" %*\r\n'); }
  else { chmodSync(file, 0o755); bin = file; }
});
afterEach(async () => {
  for (const file of releases.splice(0)) writeFileSync(file, "");
  for (const id of runnerIds.splice(0)) { const pid = readRunnerState(env.home, id)?.pid; if (pid && pidAlive(pid)) killPid(pid); }
  for (const client of clients.splice(0)) await client.close();
  await env.cleanup();
});
async function session(name: string, agent: CodingAgent, inline = false) {
  const client = new Client({ name: "handoff-test", version: "1" }); clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, `--agent=${agent}`], cwd: env.home, env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AGENT_BRIDGE_"))), AGENT_BRIDGE_HOME: env.home, CLAUDE_PROJECT_DIR: env.home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_CLAUDE_BIN: bin, AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_JOB_RUNNER: inline ? "0" : "1",
  } as Record<string, string>, stderr: "ignore" }));
  await call(client, "peers"); return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { text: (result.content as { text: string }[]).map((c) => c.text ?? "").join("\n"), error: result.isError };
}

it("hands off a blocking ask without returning results or notes to the old caller", async () => {
  const source = await session("codex-source", "codex", true), target = await session("claude-target", "claude");
  const release = join(env.home, "release"), linkFile = join(env.home, "link.json"); releases.push(release);
  const pending = call(source, "ask_claude", { prompt: `release=${release} link=${linkFile} blocking work`, title: "Blocking inherited job" });
  await until(() => existsSync(linkFile));
  const job = readStore(join(env.home, "jobs.json")).find((j) => j.name.startsWith("claude-ask-"))!;
  expect(job).toBeDefined();
  expect((await call(source, "handoff_subagents", { to: "claude-target" })).error).toBeFalsy();
  await call(source, "inbox");
  const child = parentFromEnv(JSON.parse(readFileSync(linkFile, "utf8")))!;
  await child.send("Foreground post-handoff note");
  expect(readStore(join(env.home, "jobs.json")).find((j) => j.id === job.id)!.deliveryHistory?.some((m) => m.body.includes("Foreground post-handoff note"))).toBe(true);
  writeFileSync(release, "");
  const originalReply = await pending;
  expect(originalReply.text).toContain("supervised by claude-target");
  expect(originalReply.text).not.toContain("Inherited runner finished");
  let inherited = "";
  await expect.poll(async () => { inherited += (await call(target, "inbox")).text; return inherited.includes("Inherited runner finished"); }, { timeout: 5000 }).toBe(true);
  expect(inherited).toContain("Foreground post-handoff note");
  expect((await call(source, "inbox")).text).not.toMatch(/Foreground post-handoff|Inherited runner finished/);
  expect(readStore(join(env.home, "jobs.json")).find((j) => j.id === job.id)!.deliveryHistory).toBeDefined();
});

it.each([
  ["codex", "claude", false], ["codex", "claude", true], ["opencode", "codex", false], ["codex", "opencode", false],
  ["antigravity", "opencode", false], ["codex", "antigravity", false],
] as const)("hands off %s to %s (inline=%s), delivers once and retains master controls", async (fromAgent, toAgent, inline) => {
  const source = await session("codex-source", fromAgent, inline), target = await session("claude-target", toAgent);
  const observer = env.node("observer", "opencode"); await observer.start();
  const release = join(env.home, "release"), linkFile = join(env.home, "link.json"); releases.push(release);
  const started = await call(source, "spawn_claude", { prompt: `release=${release} link=${linkFile} work on task`, title: "Inherited live runner" });
  expect(started.error).toBeFalsy(); const name = /claude-job-[a-f0-9]+/.exec(started.text)![0], id = name.split("-").at(-1)!;
  if (!inline) runnerIds.push(id);
  await until(() => existsSync(linkFile));
  const child = parentFromEnv(JSON.parse(readFileSync(linkFile, "utf8")))!;
  expect((await call(source, "handoff_subagents", { to: "claude-target", note: "Finish and review" })).error).toBeFalsy();
  expect((await call(source, "message_subagent", { job: name, message: "Former master instruction" })).error).toBeFalsy();
  await call(source, "inbox"); // Consume the one permitted handoff confirmation.
  await child.send("Post-handoff note");
  await child.escalate?.("Post-handoff approval request");
  await child.progress?.(65, "New supervisor progress");
  writeFileSync(release, "");
  await until(() => readStore(join(env.home, "jobs.json")).find((j) => j.name === name)?.status === "done", 12000);
  let inbox = "";
  const deadline = Date.now() + 5000;
  while (!inbox.includes("Inherited runner finished") && Date.now() < deadline) {
    inbox += (await call(target, "inbox")).text;
    if (!inbox.includes("Inherited runner finished")) await new Promise((resolve) => setTimeout(resolve, 30));
  }
  expect(inbox).toContain("Inherited runner finished");
  expect(inbox).toContain("Post-handoff approval request");
  expect((await call(source, "inbox")).text).not.toMatch(/Post-handoff|Inherited runner finished|Subagent .*done after/);
  expect((await call(target, "message_subagent", { job: name, message: "Continue with the next task" })).error).toBeFalsy();
  await until(() => readStore(join(env.home, "jobs.json")).find((j) => j.name === name)?.status === "done", 12000);
  expect(readStore(join(env.home, "jobs.json")).find((j) => j.name === name)!.owner).toBe("claude-target");
});
