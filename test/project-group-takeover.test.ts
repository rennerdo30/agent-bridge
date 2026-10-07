import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { readRunnerState } from "../src/mcp/job-host.js";
import { readStore } from "../src/mcp/jobs.js";
import { parentFromEnv } from "../src/core/parent-link.js";
import { listPendingApprovals } from "../src/core/relay.js";
import { pidAlive, killPid } from "../src/core/delegate.js";

const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
let env: TestEnv, bin: string;
const transports: StdioClientTransport[] = [];
const clients: Client[] = [], ids: string[] = [], releases: string[] = [];
beforeEach(() => {
  env = makeEnv(); const dir = join(env.home, "bin"); mkdirSync(dir);
  const file = join(dir, "fake.mjs");
  writeFileSync(file, `#!/usr/bin/env node
import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
appendFileSync(${JSON.stringify(join(env.home, "fixture-pids"))}, String(process.pid)+'\\n');
if(process.argv.includes('queue')){appendFileSync(${JSON.stringify(join(env.home, "wake-calls"))}, 'wake');process.exit(0);}
let release,approved=false,asked=false,interval;
const send=value=>console.log(JSON.stringify(value));
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.id===999&&m.result){approved=true;writeFileSync(release+'.approved',String(m.result.decision==='accept'));return;}
 if(!m.method||m.id===undefined)return;
 let result={};
 if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'fixture-'+process.pid}};
 if(m.method==='turn/start')result={turn:{id:'turn-1'}};
 if(m.method==='turn/steer')result={turnId:'turn-1'};
 send({id:m.id,result});
 if(m.method!=='turn/start')return;
 const prompt=(m.params.input||[]).map(x=>x.text||'').join(' ');
 release=/release=(\\S+)/.exec(prompt)?.[1];
 const link=/link=(\\S+)/.exec(prompt)?.[1];
 if(link)writeFileSync(link,JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('AGENT_BRIDGE_PARENT_')))));
 interval=setInterval(()=>{
  if(prompt.includes('approve=yes')&&!approved){
   if(!asked&&existsSync(release+'.approve')){asked=true;send({id:999,method:'item/commandExecution/requestApproval',params:{command:'Takeover approval request',reason:'Fixture approval'}});}
   return;
  }
  if(release&&!existsSync(release))return;
  clearInterval(interval);
  send({method:'item/completed',params:{turnId:'turn-1',item:{type:'agentMessage',text:'Takeover result '+release}}});
  send({method:'turn/completed',params:{turn:{id:'turn-1',status:'completed'}}});
 },20);
});`);
  if (process.platform === "win32") { bin = join(dir, "codex.cmd"); writeFileSync(bin, '@ECHO off\r\n"%dp0%\\fake.mjs" %*\r\n'); }
  else { chmodSync(file, 0o755); bin = file; }
});
afterEach(async () => {
  for (const file of releases.splice(0)) { writeFileSync(file, ""); writeFileSync(file + ".approve", ""); }
  const runnerPids = ids.splice(0).map((id) => readRunnerState(env.home, id)?.pid).filter((pid): pid is number => Boolean(pid));
  for (const pid of runnerPids) if (pidAlive(pid)) killPid(pid);
  await until(() => runnerPids.every((pid) => !pidAlive(pid)), 5_000);
  const servers = transports.splice(0).map((t) => t.pid).filter((pid): pid is number => Boolean(pid));
  for (const client of clients.splice(0)) await client.close();
  await until(() => servers.every((pid) => !pidAlive(pid)), 5_000);
  const fixturePids = existsSync(join(env.home, "fixture-pids")) ? readFileSync(join(env.home, "fixture-pids"), "utf8").trim().split(/\s+/).map(Number) : [];
  for (const pid of fixturePids) if (pidAlive(pid)) killPid(pid);
  await until(() => fixturePids.every((pid) => !pidAlive(pid)), 5_000);
  // Windows can retain a detached process's directory handle briefly after its PID disappears.
  const deadline = Date.now() + 3_000;
  for (;;) {
    try { await env.cleanup(); break; }
    catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});
async function session(name: string, agent: "codex" | "claude" | "opencode") {
  const client = new Client({ name: "group-takeover", version: "1" }); clients.push(client);
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, `--agent=${agent}`], cwd: env.home, env: {
    ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_CODEX_BIN: bin, AGENT_BRIDGE_CLAUDE_BIN: bin, AGENT_BRIDGE_CODEX_EXEC: "0",
    AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_MAX_JOBS: "16", AGENT_BRIDGE_JOB_RUNNER: "1",
  } as Record<string, string>, stderr: "ignore" });
  transports.push(transport); await client.connect(transport);
  await call(client, "peers"); return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args, _meta: { threadId: "takeover-thread" } });
  return { text: (result.content as { text: string }[]).map((c) => c.text ?? "").join("\n"), error: result.isError };
}

it.each(["closed", "unavailable", "opencode"])("ten jobs survive a %s primary and the project master receives their work once", async (mode) => {
  // Keep a broker independent of the closing MCP process so the test isolates coordinator failover.
  const broker = env.node("broker", "other"); await broker.start();
  const primaryAgent = mode === "opencode" ? "opencode" : "claude";
  const primaryName = `${primaryAgent}-master`;
  const source = await session(primaryName, primaryAgent), target = await session("codex-master", "codex");
  const starts = await Promise.allSettled(Array.from({ length: 10 }, async (_, index) => {
    const release = join(env.home, `release-${index}`), link = `${release}.link`; releases.push(release);
    const started = await call(source, "spawn_codex", { prompt: `release=${release} link=${link} ${index === 2 ? "approve=yes" : ""} complete item ${index}`, title: `Takeover item ${index}` });
    expect(started.error, started.text).toBeFalsy();
    const name = /(?:codex|claude)-job-[a-f0-9]+/.exec(started.text)![0], id = name.split("-").at(-1)!; ids.push(id);
    return { name, id, release, link };
  }));
  const failed = starts.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  const jobs = starts.map((result) => (result as PromiseFulfilledResult<{ name: string; id: string; release: string; link: string }>).value);
  await until(() => jobs.every((j) => existsSync(j.link) && readRunnerState(env.home, j.id)?.sessionId && readRunnerState(env.home, j.id)?.live), 18_000);
  const children = jobs.map((j) => parentFromEnv(JSON.parse(readFileSync(j.link, "utf8")))!);
  // Leave one result and note pending in the starter's inbox before it becomes unavailable.
  await children[0]!.send("Pending before takeover");
  if (mode === "closed") await source.close();
  else expect((await call(source, "coordinator_availability", { unavailable: true })).error).toBeFalsy();
  expect(jobs.every((j) => pidAlive(readRunnerState(env.home, j.id)!.pid))).toBe(true);
  expect((await call(target, "peers")).text).toContain(jobs[9]!.name);
  expect((await call(target, "message_subagent", { job: jobs[1]!.name, message: "Continue under the project master", title: "Inherited project work" })).error).toBeFalsy();
  await Promise.all(children.map((child, i) => child.send(`After takeover note ${i}`)));
  writeFileSync(jobs[2]!.release + ".approve", "");
  await until(() => listPendingApprovals(env.home).some((a) => a.job === jobs[2]!.name), 5_000);
  expect((await call(target, "message_subagent", { job: jobs[2]!.name, message: "allow" })).error).toBeFalsy();
  await until(() => existsSync(jobs[2]!.release + ".approved"), 5_000);
  expect(readFileSync(jobs[2]!.release + ".approved", "utf8")).toBe("true");
  for (const job of jobs) writeFileSync(job.release, "");
  await until(() => jobs.every((j) => readRunnerState(env.home, j.id)?.status === "done"), 10_000);
  await until(() => existsSync(join(env.home, "wake-calls")), 5_000);
  let delivered = "";
  const deadline = Date.now() + 5_000;
  while ((delivered.match(/Subagent codex-job-[a-f0-9]+ \(codex\) done after/g) ?? []).length < 10 && Date.now() < deadline) {
    delivered += (await call(target, "inbox")).text;
    if ((delivered.match(/Subagent codex-job-[a-f0-9]+ \(codex\) done after/g) ?? []).length < 10) await new Promise((r) => setTimeout(r, 20));
  }
  expect((delivered.match(/Subagent codex-job-[a-f0-9]+ \(codex\) done after/g) ?? []).length, delivered).toBe(10);
  // A live answer to steering is separate from the final report. Each stable final envelope arrives once.
  const envelopes = [...delivered.matchAll(/<agent-bridge-message id="([^"]+)"[^>]*>([\s\S]*?)<\/agent-bridge-message>/g)];
  expect(new Set(envelopes.map((m) => m[1])).size).toBe(envelopes.length);
  for (const job of jobs) expect(envelopes.filter((m) => m[2]!.includes(`Subagent ${job.name} (codex) done after`))).toHaveLength(1);
  expect(delivered).toContain("Pending before takeover");
  expect(delivered).toContain("Takeover approval request");
  for (let i = 0; i < 10; i++) expect(delivered).toContain(`After takeover note ${i}`);
  expect((await call(target, "inbox")).text).not.toContain("Takeover result ");
  const returning = mode === "closed" ? await session(primaryName, primaryAgent) : source;
  if (mode !== "closed") await call(source, "coordinator_availability", { unavailable: false });
  expect((await call(returning, "inbox")).text).not.toContain("Takeover result ");
  // The durable primary never changed; restoring availability governs new envelopes only.
  expect(readStore(join(env.home, "jobs.json")).filter((j) => jobs.some((x) => x.id === j.id)).every((j) => j.owner === primaryName)).toBe(true);
});
