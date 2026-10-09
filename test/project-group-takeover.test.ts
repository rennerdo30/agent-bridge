import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { readRunnerState } from "../src/mcp/job-host.js";
import { readStore } from "../src/mcp/jobs.js";
import { parentFromEnv } from "../src/core/parent-link.js";
import { listPendingApprovals } from "../src/core/relay.js";
import { pidAlive, killPid } from "../src/core/delegate.js";
import { LOG_DIR_NAME, LOG_FILE_NAME } from "../src/core/constants.js";
import { STARTUP_CAPACITY } from "../src/core/startup-admission.js";

const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
function linkReady(path: string): boolean {
  try { return Boolean(JSON.parse(readFileSync(path, "utf8")).AGENT_BRIDGE_PARENT_URL); }
  catch { return false; }
}
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
let release,approved=false,asked=false,interval,reading=false,finished=false;
const send=value=>console.log(JSON.stringify(value));
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.id===999&&m.result){approved=true;writeFileSync(release+'.approved',String(m.result.decision==='accept'));return;}
 if(!m.method||m.id===undefined)return;
 let result={};
 if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'fixture-'+process.pid}};
 if(m.method==='turn/start')result={turn:{id:'turn-1'}};
 if(m.method==='turn/steer'){result={turnId:'turn-1'};if(release)writeFileSync(release+'.instruction',(m.params.input||[]).map(x=>x.text||'').join(' '));}
 send({id:m.id,result});
 if(m.method!=='turn/start')return;
 const prompt=(m.params.input||[]).map(x=>x.text||'').join(' ');
 release=/release=(\\S+)/.exec(prompt)?.[1];
 const link=/link=(\\S+)/.exec(prompt)?.[1];
 if(link)writeFileSync(link,JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('AGENT_BRIDGE_PARENT_')))));
 interval=setInterval(async()=>{
  if(finished)return;
  if(prompt.includes('instruction=yes')&&!reading){
   reading=true;
   try{
    const response=await fetch(process.env.AGENT_BRIDGE_PARENT_URL+'/inbox',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.AGENT_BRIDGE_PARENT_TOKEN},body:'{}'});
    const inbox=await response.json();
    if(inbox.messages?.length)writeFileSync(release+'.instruction',inbox.messages.map(x=>x.body).join(' '));
   }finally{reading=false;}
  }
  if(finished)return;
  if(prompt.includes('approve=yes')&&!approved){
   if(!asked&&existsSync(release+'.approve')){asked=true;send({id:999,method:'item/commandExecution/requestApproval',params:{command:'Takeover approval request',reason:'Fixture approval'}});}
   return;
  }
  if(release&&!existsSync(release))return;
  finished=true;clearInterval(interval);
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
      if (process.platform !== "win32" || !["EPERM", "EBUSY", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "") || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});
async function session(name: string, agent: "codex" | "claude" | "opencode") {
  const client = new Client({ name: "group-takeover", version: "1" }); clients.push(client);
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, `--agent=${agent}`], cwd: env.home, env: {
    ...process.env, AGENT_BRIDGE_HOME: env.home, CLAUDE_PROJECT_DIR: env.home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_CODEX_BIN: bin, AGENT_BRIDGE_CLAUDE_BIN: bin, AGENT_BRIDGE_CODEX_EXEC: "0",
    AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_MAX_JOBS: "16", AGENT_BRIDGE_JOB_RUNNER: "1",
  } as Record<string, string>, stderr: "ignore" });
  transports.push(transport); await client.connect(transport);
  await call(client, "peers"); return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args, _meta: { threadId: "takeover-thread" } });
  return { text: (result.content as { text: string }[]).map((c) => c.text ?? "").join("\n"), error: result.isError };
}

/** Failure evidence only: no specs, parent-link contents, prompts or environment. */
function diagnosticNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}
const diagnosticPid = (value: unknown) => diagnosticNumber(value, 1, 0xffff_ffff);
const diagnosticTime = (value: unknown) => diagnosticNumber(value, 0, 4_102_444_800_000);
function diagnosticProgress(value: unknown): string {
  switch (value) {
    case "queued: runner startup admission": return "initial-state-published";
    case "preparing run context": return "context-preparation";
    case "queued: waiting for root admission": return "root-admission";
    case "queued: waiting for machine startup admission": return "machine-admission";
    case "starting native CLI": return "native-starting";
    case "queued: waiting for compatible storage readers to retain run context": return "run-context-admission";
    default: return typeof value === "string" && /^started · follow live: agent-bridge watch [\w.-]+$/.test(value) ? "feed-started" : "unreported";
  }
}
function readinessStorage(home: string) {
  const select = (file: string, sql: string) => {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(home, file), { readOnly: true });
      db.exec("PRAGMA busy_timeout=0");
      return { rows: db.prepare(sql).all() };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { errorCode: ["ERR_SQLITE_ERROR", "ERR_SQLITE_BUSY", "SQLITE_BUSY", "SQLITE_LOCKED", "ENOENT", "EACCES", "EPERM"].includes(code ?? "") ? code : "UNAVAILABLE" };
    } finally { try { db?.close(); } catch { /* Diagnostics must not mask readiness failure. */ } }
  };
  const slots = select("resource-slots.sqlite", "SELECT resource,ticket,pid,held FROM slots ORDER BY ticket LIMIT 64");
  const limits = select("root-limits.sqlite", "SELECT root,capacity FROM root_limits ORDER BY root LIMIT 32");
  return {
    configuredStartupCapacity: diagnosticNumber(STARTUP_CAPACITY, 1, 1024),
    slots: "rows" in slots ? { rows: slots.rows!.flatMap(row => {
      const pid = diagnosticPid(row.pid), ticket = diagnosticNumber(row.ticket, 1, Number.MAX_SAFE_INTEGER);
      return typeof row.resource === "string" && /^(delegate-startup|root-[a-f0-9]{40})$/.test(row.resource) && pid && ticket && (row.held === 0 || row.held === 1)
        ? [{ resource: row.resource, ticket, pid, held: row.held === 1 }] : [];
    }) } : slots,
    rootLimits: "rows" in limits ? { rows: limits.rows!.flatMap(row => {
      const capacity = diagnosticNumber(row.capacity, 1, 1024);
      return typeof row.root === "string" && row.root.length <= 256 && capacity
        ? [{ resource: `root-${createHash("sha256").update(row.root).digest("hex").slice(0, 40)}`, capacity }] : [];
    }) } : limits,
  };
}

function readinessEvents(home: string, names: ReadonlySet<string>, runnerPids: ReadonlySet<number>) {
  let fd: number | undefined;
  try {
    fd = openSync(join(home, LOG_DIR_NAME, LOG_FILE_NAME), "r");
    const size = fstatSync(fd).size, start = Math.max(0, size - 256 * 1024), bytes = Buffer.alloc(Math.min(size, 256 * 1024));
    const read = readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.subarray(0, read).toString("utf8").split("\n");
    if (start) lines.shift();
    return lines.flatMap(line => {
      const match = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+\w+\s+\[[^\]]+\] pid=(\d+) (job process ownership established|job runner started) (\{.*\})$/.exec(line);
      if (!match) return [];
      try {
        const value = JSON.parse(match[4]!) as Record<string, unknown>, pid = diagnosticPid(Number(match[2]));
        if (!pid || diagnosticTime(Date.parse(match[1]!)) === undefined || !runnerPids.has(pid) && !(typeof value.job === "string" && names.has(value.job))) return [];
        return [{ at: match[1], event: match[3], pid,
          ...(typeof value.job === "string" && names.has(value.job) ? { job: value.job } : {}),
          ...(diagnosticPid(value.pid) ? { reportedPid: diagnosticPid(value.pid) } : {}),
          ...(diagnosticPid(value.runnerPid) ? { runnerPid: diagnosticPid(value.runnerPid) } : {}),
          ...(diagnosticPid(value.guardianPid) ? { guardianPid: diagnosticPid(value.guardianPid) } : {}),
        }];
      } catch { return []; }
    }).slice(-40);
  } catch { return []; }
  finally { try { if (fd !== undefined) closeSync(fd); } catch { /* Keep the original readiness failure. */ } }
}

it("routes a blocking ask to an available group master without returning its result to the limited caller", async () => {
  await env.node("broker", "other").start();
  const source = await session("claude-master", "claude"), target = await session("codex-master", "codex");
  const release = join(env.home, "blocking-release"), link = release + ".link"; releases.push(release);
  const pending = call(source, "ask_codex", { prompt: `release=${release} link=${link} blocking work`, title: "Limited caller work" });
  await until(() => linkReady(link), 10_000);
  expect((await call(source, "coordinator_availability", { unavailable: true })).error).toBeFalsy();
  const child = parentFromEnv(JSON.parse(readFileSync(link, "utf8")))!;
  await child.send("Blocking fallback note");
  writeFileSync(release, "");
  const reply = await pending;
  expect(reply.text).toContain("supervised by codex-master");
  expect(reply.text).not.toContain("Takeover result");
  let inbox = "";
  await expect.poll(async () => { inbox += (await call(target, "inbox")).text; return /Subagent codex-ask-[a-f0-9]+ \(codex\) done after/.test(inbox); }).toBe(true);
  expect((await call(target, "inbox", { include_quiet: true })).text).toContain("Blocking fallback note");
  expect((inbox.match(/Subagent codex-ask-[a-f0-9]+ \(codex\) done after/g) ?? [])).toHaveLength(1);
  expect((await call(source, "inbox")).text).not.toMatch(/Blocking fallback note|Takeover result/);
  expect(readStore(join(env.home, "jobs.json")).find((job) => job.name.startsWith("codex-ask-"))?.owner).toBe("claude-master");
});

it.each(["closed", "unavailable", "opencode"])("ten jobs survive a %s primary and the project master receives their work once", async (mode) => {
  // Closing tests also close the original broker; the surviving MCP master elects a replacement.
  if (mode !== "closed") await env.node("broker", "other").start();
  const primaryAgent = mode === "opencode" ? "opencode" : "claude";
  const primaryName = `${primaryAgent}-master`;
  const source = await session(primaryName, primaryAgent), target = await session("codex-master", "codex");
  const starts = await Promise.allSettled(Array.from({ length: 10 }, async (_, index) => {
    const release = join(env.home, `release-${index}`), link = `${release}.link`; releases.push(release);
    const started = await call(source, "spawn_codex", { prompt: `release=${release} link=${link} ${index === 2 ? "approve=yes" : ""} ${index === 1 ? "instruction=yes" : ""} complete item ${index}`, title: `Takeover item ${index}` });
    expect(started.error, started.text).toBeFalsy();
    const name = /(?:codex|claude)-job-[a-f0-9]+/.exec(started.text)![0], id = name.split("-").at(-1)!; ids.push(id);
    return { name, id, release, link };
  }));
  const failed = starts.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  const jobs = starts.map((result) => (result as PromiseFulfilledResult<{ name: string; id: string; release: string; link: string }>).value);
  try {
    await until(() => jobs.every((j) => linkReady(j.link) && readRunnerState(env.home, j.id)?.sessionId && readRunnerState(env.home, j.id)?.live), 18_000);
  } catch (cause) {
    let summary = "diagnostics unavailable";
    try {
      const observedAt = Date.now();
      const readiness = jobs.map((job) => {
        const state = readRunnerState(env.home, job.id);
        const pid = diagnosticPid(state?.pid), updatedAt = diagnosticTime(state?.updatedAt);
        const status = state && ["running", "done", "failed", "interrupted"].includes(state.status) ? state.status : "unknown";
        return { name: job.name, status, pid, updatedAt,
          heartbeatAgeMs: updatedAt !== undefined ? diagnosticNumber(Math.max(0, observedAt - updatedAt), 0, 4_102_444_800_000) : undefined,
          alive: pid ? pidAlive(pid) : false, session: Boolean(state?.sessionId), live: Boolean(state?.live), link: linkReady(job.link),
          progress: diagnosticProgress(state?.progress) };
      });
      const diagnostics = { version: 1, mode, observedAt, readiness, storage: readinessStorage(env.home),
        events: readinessEvents(env.home, new Set(jobs.map(job => job.name)), new Set(readiness.flatMap(row => row.pid ? [row.pid] : []))) };
      const json = JSON.stringify(diagnostics, null, 2) + "\n";
      const receiptName = `project-group-readiness-${observedAt}-${mode}.json`;
      // Keep the existing process/fixture teardown; retain only this bounded whitelist.
      try { writeFileSync(join(env.home, receiptName), json, { flag: "wx" }); }
      catch { /* Evidence publication must not replace the original failure. */ }
      try {
        const retained = join(import.meta.dirname, "..", ".agent-bridge-test"); mkdirSync(retained, { recursive: true });
        writeFileSync(join(retained, receiptName), json, { flag: "wx" });
      } catch { /* A fixture write failure must not prevent the retained receipt attempt. */ }
      summary = JSON.stringify(readiness);
      console.error(`Native takeover readiness diagnostics: ${JSON.stringify(diagnostics).slice(0, 16_384)}`);
    } catch { /* Diagnostic construction or output must never replace the readiness cause. */ }
    throw new Error(`Native takeover fixture did not become ready: ${summary}`, { cause });
  }
  const children = jobs.map((j) => parentFromEnv(JSON.parse(readFileSync(j.link, "utf8")))!);
  // Leave one result and note pending in the starter's inbox before it becomes unavailable.
  await children[0]!.send("Pending before takeover");
  if (mode === "closed") await source.close();
  else expect((await call(source, "coordinator_availability", { unavailable: true })).error).toBeFalsy();
  await expect.poll(async () => {
    try { return (await call(target, "peers")).text.includes(jobs[9]!.name); }
    catch { return false; } // A pipe request can straddle broker election.
  }, { timeout: 5000 }).toBe(true);
  expect(jobs.every((j) => pidAlive(readRunnerState(env.home, j.id)!.pid))).toBe(true);
  expect((await call(target, "peers")).text).toContain(jobs[9]!.name);
  expect((await call(target, "message_subagent", { job: jobs[1]!.name, message: "Continue under the project master", title: "Inherited project work" })).error).toBeFalsy();
  await until(() => existsSync(jobs[1]!.release + ".instruction") && readFileSync(jobs[1]!.release + ".instruction", "utf8").includes("Continue under the project master"), 5_000);
  expect(readFileSync(jobs[1]!.release + ".instruction", "utf8")).toContain("Continue under the project master");
  await Promise.all(children.map((child, i) => child.send(`After takeover note ${i}`, undefined, "note")));
  writeFileSync(jobs[2]!.release + ".approve", "");
  await until(() => listPendingApprovals(env.home).some((a) => a.job === jobs[2]!.name), 5_000);
  const approval = listPendingApprovals(env.home).find((a) => a.job === jobs[2]!.name)!;
  expect((await call(target, "decide", { approval_id: approval.id, decision: "allow" })).error).toBeFalsy();
  await until(() => existsSync(jobs[2]!.release + ".approved") && readFileSync(jobs[2]!.release + ".approved", "utf8") === "true", 5_000);
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
  expect(delivered).toContain("Takeover approval request");
  // Quiet supervision copies remain retained and explicitly discoverable after failover.
  const retainedNotes = (await call(target, "inbox", { include_quiet: true, limit: 100 })).text;
  expect(retainedNotes).toContain("Pending before takeover");
  for (let i = 0; i < 10; i++) expect(retainedNotes).toContain(`After takeover note ${i}`);
  expect((await call(target, "inbox")).text).not.toContain("Takeover result ");
  const returning = mode === "closed" ? await session(primaryName, primaryAgent) : source;
  if (mode !== "closed") await call(source, "coordinator_availability", { unavailable: false });
  expect((await call(returning, "inbox")).text).not.toContain("Takeover result ");
  // The durable primary never changed; restoring availability governs new envelopes only.
  expect(readStore(join(env.home, "jobs.json")).filter((j) => jobs.some((x) => x.id === j.id)).every((j) => j.owner === primaryName)).toBe(true);
});
