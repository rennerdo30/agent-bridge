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

const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
let env: TestEnv, bin: string;
const clients: Client[] = [], ids: string[] = [], releases: string[] = [];
beforeEach(() => {
  env = makeEnv(); const dir = join(env.home, "bin"); mkdirSync(dir);
  const file = join(dir, "fake.mjs");
  writeFileSync(file, `#!/usr/bin/env node
import {existsSync,writeFileSync} from 'node:fs';
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>prompt+=d);
process.stdin.on('end',async()=>{
 const release=/release=(\\S+)/.exec(prompt)?.[1],link=/link=(\\S+)/.exec(prompt)?.[1];
 const thread='fixture-'+process.pid;
 console.log(JSON.stringify({type:'thread.started',thread_id:thread}));
 if(link)writeFileSync(link,JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('AGENT_BRIDGE_PARENT_')))));
 while(release&&!existsSync(release))await new Promise(r=>setTimeout(r,20));
 console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Takeover result '+release}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{}}));
});`);
  if (process.platform === "win32") { bin = join(dir, "codex.cmd"); writeFileSync(bin, '@ECHO off\r\n"%dp0%\\fake.mjs" %*\r\n'); }
  else { chmodSync(file, 0o755); bin = file; }
});
afterEach(async () => {
  for (const file of releases.splice(0)) writeFileSync(file, "");
  for (const id of ids.splice(0)) { const pid = readRunnerState(env.home, id)?.pid; if (pid && pidAlive(pid)) killPid(pid); }
  for (const client of clients.splice(0)) await client.close();
  await env.cleanup();
});
async function session(name: string, agent: "codex" | "claude" | "opencode") {
  const client = new Client({ name: "group-takeover", version: "1" }); clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, `--agent=${agent}`], cwd: env.home, env: {
    ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_CODEX_BIN: bin, AGENT_BRIDGE_CODEX_EXEC: "1",
    AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_MAX_JOBS: "16", AGENT_BRIDGE_JOB_RUNNER: "1",
  } as Record<string, string>, stderr: "ignore" }));
  await call(client, "peers"); return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { text: (result.content as { text: string }[]).map((c) => c.text ?? "").join("\n"), error: result.isError };
}

it.each(["closed", "unavailable", "opencode"])("ten jobs survive a %s primary and the project master receives their work once", async (mode) => {
  // Keep a broker independent of the closing MCP process so the test isolates coordinator failover.
  const broker = env.node("broker", "other"); await broker.start();
  const primaryAgent = mode === "opencode" ? "opencode" : "claude";
  const primaryName = `${primaryAgent}-master`;
  const source = await session(primaryName, primaryAgent), target = await session("codex-master", "codex");
  const jobs = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
    const release = join(env.home, `release-${index}`), link = `${release}.link`; releases.push(release);
    const started = await call(source, "spawn_codex", { prompt: `release=${release} link=${link} complete item ${index}`, title: `Takeover item ${index}` });
    expect(started.error, started.text).toBeFalsy();
    const name = /codex-job-[a-f0-9]+/.exec(started.text)![0], id = name.split("-").at(-1)!; ids.push(id);
    return { name, id, release, link };
  }));
  await until(() => jobs.every((j) => existsSync(j.link) && readRunnerState(env.home, j.id)?.sessionId), 18_000);
  const children = jobs.map((j) => parentFromEnv(JSON.parse(readFileSync(j.link, "utf8")))!);
  // Leave one result and note pending in the starter's inbox before it becomes unavailable.
  await children[0]!.send("Pending before takeover");
  if (mode === "closed") await source.close();
  else expect((await call(source, "coordinator_availability", { unavailable: true })).error).toBeFalsy();
  expect(jobs.every((j) => pidAlive(readRunnerState(env.home, j.id)!.pid))).toBe(true);
  expect((await call(target, "peers")).text).toContain(jobs[9]!.name);
  expect((await call(target, "message_subagent", { job: jobs[1]!.name, message: "Continue under the project master", title: "Inherited project work" })).error).toBeFalsy();
  await Promise.all(children.map((child, i) => child.send(`After takeover note ${i}`)));
  await children[2]!.escalate?.("Takeover approval request");
  for (const job of jobs) writeFileSync(job.release, "");
  await until(() => jobs.every((j) => readRunnerState(env.home, j.id)?.status === "done"), 10_000);
  let delivered = "";
  const deadline = Date.now() + 5_000;
  while ((delivered.match(/Takeover result /g) ?? []).length < 10 && Date.now() < deadline) {
    delivered += (await call(target, "inbox")).text;
    if ((delivered.match(/Takeover result /g) ?? []).length < 10) await new Promise((r) => setTimeout(r, 20));
  }
  expect((delivered.match(/Takeover result /g) ?? []).length).toBe(10);
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
