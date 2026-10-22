import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { codexHost } from "./helpers.js";
import { readRunnerState, writeRunnerState } from "../src/mcp/job-host.js";
import { readStore } from "../src/mcp/jobs.js";
import { parentFromEnv } from "../src/core/parent-link.js";
import { listPendingApprovals } from "../src/core/relay.js";
import { pidAlive, killPid } from "../src/core/delegate.js";
import { readProcessIdentities } from "../src/core/process-identity.js";
import { LOG_DIR_NAME, LOG_FILE_NAME } from "../src/core/constants.js";
import { STARTUP_CAPACITY } from "../src/core/startup-admission.js";
import { completionMessageId } from "../src/core/completion.js";
import { resolveDbPath } from "../src/core/paths.js";
import { unquarantined } from "../src/core/sqlite-maintenance.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { ReadJournal } from "../src/core/read-journal.js";
import { readJournalIdentities } from "../src/core/read-journal.js";
import { fixturePeer, markOwned, ownedMessage } from "./owned-mail.js";
import { ownershipFromKey } from "../src/core/recipient-ownership.js";
import { jobWaitSnapshot } from "./job-wait-diagnostics.js";

const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
function linkReady(path: string): boolean {
  try { return Boolean(JSON.parse(readFileSync(path, "utf8")).AGENT_BRIDGE_PARENT_URL); }
  catch { return false; }
}
let env: TestEnv, bin: string;
const transports: StdioClientTransport[] = [];
const clients: Client[] = [], ids: string[] = [], releases: string[] = [];
/** Failure evidence: which wait a takeover case was in, and since when. */
let phases: { name: string; at: number }[] = [];
let failureEvidence: (() => void) | undefined;
/** Aborted by teardown: a body still running after a test timeout must not start or wait for anything else. */
let fixture = new AbortController();
const phase = (name: string) => { phases.push({ name, at: Date.now() }); };
beforeEach(() => {
  phases = []; failureEvidence = undefined; fixture = new AbortController();
  env = makeEnv(); const dir = join(env.home, "bin"); mkdirSync(dir);
  const file = join(dir, "fake.mjs");
  writeFileSync(file, `#!/usr/bin/env node
import {existsSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
// Its own process generation, in the bridge's identity format (Unix teardown signals only a matching PID).
let identity='';
try{if(process.platform==='linux'){const stat=readFileSync('/proc/self/stat','utf8');identity=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];}
else if(process.platform!=='win32')identity=execFileSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'}}).trim();}catch{}
appendFileSync(${JSON.stringify(join(env.home, "fixture-pids"))}, String(process.pid)+' '+encodeURIComponent(identity)+'\\n');
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
  fixture.abort();
  if (phases.length && phases.at(-1)!.name !== "done") {
    const start = phases[0]!.at;
    console.error(`Native takeover phases (ms since start): ${phases.map((p) => `${p.name}+${p.at - start}`).join(", ")}; teardown+${Date.now() - start}`);
    failureEvidence?.();
  }
  for (const file of releases.splice(0)) { writeFileSync(file, ""); writeFileSync(file + ".approve", ""); }
  // A process is signalled only when a successful query shows the generation it recorded at startup: the PID
  // of an exited fixture process can already belong to another process. Teardown waits at most this long.
  const deadline = Date.now() + 60_000, retained: string[] = [];
  const states = ids.splice(0).map((id) => readRunnerState(env.home, id)).filter((state): state is NonNullable<typeof state> => Boolean(state?.pid));
  const live = await generations(states.map((state) => state.pid));
  const runners = new Map(states.flatMap((state) => state.identity && live?.get(state.pid) === state.identity ? [[state.pid, state.identity] as const] : []));
  // Alive but unverified (no recorded identity, or no successful query): never signalled; reported and retained.
  for (const state of states) if (!runners.has(state.pid) && pidAlive(state.pid) && (!live || live.has(state.pid) && !state.identity)) retained.push(`runner ${state.pid} (unverified)`);
  for (const pid of runners.keys()) killPid(pid);
  retained.push(...(await exited(runners, deadline)).map((pid) => `runner ${pid}`));
  // Servers are this process's own children, alive until their transport closes.
  const servers = await generations(transports.splice(0).map((t) => t.pid).filter((pid): pid is number => Boolean(pid))) ?? new Map<number, string>();
  for (const client of clients.splice(0)) await client.close();
  retained.push(...(await exited(servers, deadline)).map((pid) => `server ${pid}`));
  if (process.platform === "win32") {
    // Each runner's job guardian (PowerShell, working directory in this home) exits after its runner, and the
    // fixture CLIs end with the runner's job object. The home is removed once the guardians are gone (EBUSY otherwise).
    retained.push(...(await exited(await runnerGuardians(env.home, new Set(states.map((state) => state.pid))), deadline)).map((pid) => `guardian ${pid}`));
  } else {
    const recorded = recordedFixtures(join(env.home, "fixture-pids"));
    const current = await generations([...recorded.keys()]);
    const fixtures = new Map([...recorded].filter(([pid, identity]) => identity && current?.get(pid) === identity));
    for (const pid of fixtures.keys()) killPid(pid);
    retained.push(...(await exited(fixtures, deadline)).map((pid) => `fixture ${pid}`));
  }
  if (retained.length) throw new Error(`Fixture home retained at ${env.home}; processes still running or unverified: ${retained.join(", ")}`);
  // Windows can retain a detached process's directory handle briefly after its PID disappears.
  const removal = Date.now() + 3_000;
  for (;;) {
    try { await env.cleanup(); break; }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EBUSY", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "") || Date.now() >= removal) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});
async function session(name: string, agent: "codex" | "claude" | "opencode") {
  const client = new Client({ name: "group-takeover", version: "1" }); clients.push(client);
  const codexHome = codexHost(client, env.home, agent, name);
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, `--agent=${agent}`], cwd: env.home, env: {
    ...process.env, CODEX_HOME: codexHome, AGENT_BRIDGE_HOME: env.home, CLAUDE_PROJECT_DIR: env.home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_CODEX_BIN: bin, AGENT_BRIDGE_CLAUDE_BIN: bin, AGENT_BRIDGE_CODEX_EXEC: "0",
    AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_MAX_JOBS: "16", AGENT_BRIDGE_JOB_RUNNER: "1",
  } as Record<string, string>, stderr: "ignore" });
  transports.push(transport); await client.connect(transport);
  await call(client, "peers"); return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  fixture.signal.throwIfAborted();
  const result = await client.callTool({ name, arguments: args, _meta: { threadId: "takeover-thread" } });
  return { text: (result.content as { text: string }[]).map((c) => c.text ?? "").join("\n"), error: result.isError };
}

/**
 * Waits for an explicit readiness condition instead of a wall-clock budget: these fixtures run ten native runners
 * whose Windows startup and failover take a load-dependent time. It stops early only on evidence that the
 * condition can no longer hold (`impossible` names it); a genuine hang still fails at the test timeout.
 */
async function waitFor(ready: () => boolean | Promise<boolean>, impossible: () => string | undefined = () => undefined, stepMs = 100): Promise<void> {
  const signal = fixture.signal;
  for (;;) {
    signal.throwIfAborted();
    if (await ready()) return;
    const reason = impossible();
    // The condition can hold just before its evidence ends it (a runner reports, then exits).
    if (reason) { if (await ready()) return; throw new Error(reason); }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Start identities of the live PIDs; a PID the query did not see has exited. Undefined: the query failed. */
async function queryGenerations(pids: readonly number[]): Promise<Map<number, string> | undefined> {
  try { return await readProcessIdentities([...pids]); } catch { return undefined; }
}

/** Start identities of these PIDs from a successful query (one retry); undefined when both queries failed. */
async function generations(pids: readonly number[]): Promise<Map<number, string> | undefined> {
  return await queryGenerations(pids) ?? await queryGenerations(pids);
}

/**
 * Waits until owned process generations exit (a PID that now belongs to another process has exited), at most
 * until the teardown deadline. Returns the PIDs still running then, so teardown reports them and keeps the home.
 */
async function exited(owned: ReadonlyMap<number, string>, deadline: number): Promise<number[]> {
  let pending = [...owned.keys()];
  for (let round = 1; ; round++) {
    pending = pending.filter((pid) => pidAlive(pid));
    if (pending.length && round % 20 === 0) {
      const current = await queryGenerations(pending);
      if (current) pending = pending.filter((pid) => current.get(pid) === owned.get(pid));
    }
    if (!pending.length || Date.now() >= deadline) return pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Fixture CLIs as recorded at their startup: PID and own process generation (empty when unavailable). */
function recordedFixtures(file: string): Map<number, string> {
  if (!existsSync(file)) return new Map();
  return new Map(readFileSync(file, "utf8").split("\n").flatMap((line) => {
    const [pid, identity = ""] = line.trim().split(" ");
    return Number.isSafeInteger(Number(pid)) && Number(pid) > 0 ? [[Number(pid), decodeURIComponent(identity)] as const] : [];
  }));
}

/**
 * The live Windows job guardians the bridge log names for these runners. A guardian is owned only when its
 * process started before the runner logged the ownership (Windows identities are UTC start ticks).
 */
async function runnerGuardians(home: string, runnerPids: ReadonlySet<number>): Promise<Map<number, string>> {
  let log: string;
  try { log = readFileSync(join(home, LOG_DIR_NAME, LOG_FILE_NAME), "utf8"); } catch { return new Map(); }
  const logged = new Map(log.split("\n").flatMap((line) => {
    const match = /^(\S+)\s.* job process ownership established (\{.*\})$/.exec(line.trim());
    if (!match) return [];
    try {
      const value = JSON.parse(match[2]!) as { runnerPid?: unknown; guardianPid?: unknown };
      const at = Date.parse(match[1]!);
      return typeof value.runnerPid === "number" && runnerPids.has(value.runnerPid) && typeof value.guardianPid === "number" && Number.isFinite(at)
        ? [[value.guardianPid, at] as const] : [];
    } catch { return []; }
  }));
  const live = await generations([...logged.keys()]) ?? new Map<number, string>();
  const startedAt = (ticks: string) => /^\d+$/.test(ticks) ? Number((BigInt(ticks) - 621_355_968_000_000_000n) / 10_000n) : Infinity;
  return new Map([...live].filter(([pid, ticks]) => startedAt(ticks) <= logged.get(pid)!));
}

/** Names a job whose runner process has exited; `terminal` also counts a runner that already finished. */
function runnerGone(home: string, jobs: readonly TakeoverJob[], terminal = false): string | undefined {
  for (const job of jobs) {
    const state = readRunnerState(home, job.id);
    if (state?.pid && !pidAlive(state.pid)) return `${job.name}: runner ${state.pid} exited (${state.status})`;
    if (terminal && state && state.status !== "running") return `${job.name}: runner finished early (${state.status})`;
  }
  return undefined;
}

/** Delivery cannot complete any more: a runner exited without a delivered or stored final report. */
function finalReportLost(home: string, jobs: readonly TakeoverJob[]): string | undefined {
  const ready = finalReportStates(home, jobs);
  const lost = jobs.find((job, index) => {
    const state = readRunnerState(home, job.id);
    return !ready[index] && Boolean(state?.pid) && !pidAlive(state!.pid);
  });
  return lost ? `${lost.name}: runner exited without a delivered or stored final report` : undefined;
}

/**
 * A child message or note through the parent link. Under load the runner can answer after the link's response deadline:
 * the documented result is "unconfirmed; it may already be queued". The test then checks arrival explicitly
 * (the retained copies below) instead of trusting or resending; every other error still fails.
 */
async function sendThroughLink(send: () => Promise<unknown>): Promise<void> {
  try { await send(); }
  catch (error) { if (!/^Delivery is unconfirmed after the parent-link response timed out/.test(String((error as Error).message))) throw error; }
}

/** Failure evidence only: no specs, parent-link contents, prompts or environment. */
function diagnosticNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}
const diagnosticPid = (value: unknown) => diagnosticNumber(value, 1, 0xffff_ffff);
const diagnosticTime = (value: unknown) => diagnosticNumber(value, 0, 4_102_444_800_000);
const diagnosticUuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) ? value : undefined;
type TakeoverJob = { name: string; id: string };

/** A terminal state precedes the runner's final send; wait for its durable envelope, too. */
function finalReportsReady(home: string, jobs: readonly TakeoverJob[]): boolean {
  return finalReportStates(home, jobs).every(Boolean);
}

/** Per job: done, and its final report delivered or durably stored. */
function finalReportStates(home: string, jobs: readonly TakeoverJob[]): boolean[] {
  const states = jobs.map(job => readRunnerState(home, job.id));
  const done = states.map(state => state?.status === "done");
  if (states.every((state, index) => !done[index] || state?.delivered === true)) return states.map((state, index) => done[index]! && state?.delivered === true);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(resolveDbPath(home), { readOnly: true });
    db.exec("PRAGMA busy_timeout=0");
    const stored = db.prepare(`SELECT 1 FROM messages WHERE id=? AND from_id=? AND ${unquarantined("messages")} LIMIT 1`);
    return states.map((state, index) => done[index]! && (state?.delivered === true || Boolean(diagnosticUuid(state?.reportId) &&
      stored.get(completionMessageId(`job:${jobs[index]!.id}`, state!.reportId!), `job:${jobs[index]!.id}`))));
  } catch { return jobs.map(() => false); }
  finally { try { db?.close(); } catch { /* Readiness must not retain a fixture database handle. */ } }
}

/** Failure-only receipt evidence: ten jobs, at most four rows per receipt, no bodies or specs. */
function finalReportDiagnostics(home: string, jobs: readonly TakeoverJob[], primary: string, mode: string, inboxReads: number, delivered: string) {
  let db: DatabaseSync | undefined;
  const safeError = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException)?.code;
    return ["ERR_SQLITE_ERROR", "ERR_SQLITE_BUSY", "SQLITE_BUSY", "SQLITE_LOCKED", "ENOENT", "EACCES", "EPERM"].includes(code ?? "") ? code : "UNAVAILABLE";
  };
  const recipient = (value: unknown) => value === primary || value === "codex-master" ? value : "other-recipient";
  let databaseError: string | undefined;
  try { db = new DatabaseSync(resolveDbPath(home), { readOnly: true }); db.exec("PRAGMA busy_timeout=0"); }
  catch (error) { databaseError = safeError(error); }
  const select = (sql: string, id: string) => {
    try { return db ? { rows: db.prepare(sql).all(id) } : { errorCode: databaseError ?? "UNAVAILABLE" }; }
    catch (error) { return { errorCode: safeError(error) }; }
  };
  try {
    const rows = jobs.slice(0, 10).map(job => {
      let state: ReturnType<typeof readRunnerState> = null, stateError: string | undefined;
      try { state = readRunnerState(home, job.id); } catch (error) { stateError = safeError(error); }
      const reportId = diagnosticUuid(state?.reportId), messageId = reportId ? completionMessageId(`job:${job.id}`, reportId) : undefined;
      const envelopes = messageId ? select(`SELECT recipient,read_at FROM messages WHERE id=? AND ${unquarantined("messages")} LIMIT 4`, messageId) : undefined;
      const routes = messageId ? select("SELECT recipient,consumed_at FROM job_delivery_routes WHERE id=? LIMIT 4", messageId) : undefined;
      const reads = messageId ? select("SELECT identity,read_at FROM bridge_read_receipts WHERE message_id=? LIMIT 4", messageId) : undefined;
      const identities = [primary, "codex-master"].map(name => ({ label: name, hash: createHash("sha256").update(`name:${name}`).digest("hex") }));
      identities.push({ label: "fixture-thread", hash: createHash("sha256").update("session:takeover-thread").digest("hex") });
      if (messageId && db) {
        // Diagnostics identify current receipts from their complete retained
        // per-copy owner and namespace, rather than inferring read authority
        // from a name. Historical marks above remain visible as evidence.
        const proofs = select("SELECT recipient,state,owner,mailbox FROM message_frontends WHERE id=? LIMIT 4", messageId);
        if ("rows" in proofs) for (const proof of proofs.rows!) {
          try {
            const evidence = ownershipFromKey(`${proof.state === "hosted" ? "hosted" : "native"}:${proof.owner}`);
            const generation = db.prepare("SELECT generation FROM job_mail_succession WHERE id=? AND recipient=? ORDER BY generation DESC LIMIT 1").get(messageId, proof.recipient!);
            for (const identity of readJournalIdentities(String(proof.recipient), null, evidence.recipientFrontend, evidence.recipientNative, JSON.parse(String(proof.mailbox)),
              generation ? { grant: messageId, generation: Number(generation.generation) } : undefined))
              identities.push({ label: String(recipient(proof.recipient)), hash: createHash("sha256").update(identity).digest("hex") });
          } catch { /* Invalid historical evidence is not current read authority. */ }
        }
      }
      return { name: job.name, state: {
        status: state && ["running", "done", "failed", "cancelled", "interrupted"].includes(state.status) ? state.status : "unknown",
        pid: diagnosticPid(state?.pid), alive: state?.pid ? pidAlive(state.pid) : false,
        updatedAt: diagnosticTime(state?.updatedAt), finishedAt: diagnosticTime(state?.finishedAt),
        delivered: typeof state?.delivered === "boolean" ? state.delivered : undefined,
        reportPresent: typeof state?.report === "string" && state.report.length > 0, reportId, messageId, errorCode: stateError,
      },
        envelopes: envelopes && ("rows" in envelopes ? { rows: envelopes.rows!.map(row => ({ recipient: recipient(row.recipient), readAt: row.read_at === null ? null : diagnosticTime(row.read_at) })) } : envelopes),
        routes: routes && ("rows" in routes ? { rows: routes.rows!.map(row => ({ recipient: recipient(row.recipient), consumedAt: row.consumed_at === null ? null : diagnosticTime(row.consumed_at) })) } : routes),
        consumption: reads && ("rows" in reads ? { rows: reads.rows!.map(row => ({ identity: identities.find(identity => identity.hash === row.identity)?.label ?? "other-identity", readAt: row.read_at === null ? null : diagnosticTime(row.read_at) })) } : reads),
      };
    });
    return { version: 2, mode, phase: phases.at(-1)?.name, observedAt: Date.now(), inboxReads, finalCount: (delivered.match(/Subagent codex-job-[a-f0-9]+ \(codex\) done after/g) ?? []).length, jobs: rows,
      admission: jobWaitSnapshot(home, jobs.map(job => job.id)), storage: readinessStorage(home) };
  } finally { try { db?.close(); } catch { /* Diagnostics must not mask the original failure. */ } }
}

function printFinalReportDiagnostics(home: string, jobs: readonly TakeoverJob[], primary: string, mode: string, inboxReads: number, delivered: string): void {
  try { console.error(`Native takeover final-report diagnostics: ${JSON.stringify(finalReportDiagnostics(home, jobs, primary, mode, inboxReads, delivered)).slice(0, 65_536)}`); }
  catch { console.error("Native takeover final-report diagnostics unavailable"); }
}
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

it("observes a stored final and consumption receipts on a separate read-only connection before delivery confirmation", () => {
  const job = { id: "00ab0292", name: "codex-job-00ab0292" }, reportId = "11111111-1111-4111-8111-111111111111";
  const report = "Subagent codex-job-00ab0292 (codex) done after 0s.\n\nREPORT_BODY_EXCLUDED_FROM_DIAGNOSTICS";
  const store = new MessageStore(env.db, nullLogger);
  try {
    const recipient = fixturePeer(store, "codex-master", { agent: "codex" });
    writeRunnerState(env.home, job.id, { pid: process.pid, peer: job.name, status: "done", updatedAt: Date.now(), report, reportId, delivered: false });
    expect(finalReportsReady(env.home, [job])).toBe(false);
    const id = completionMessageId(`job:${job.id}`, reportId);
    store.insertJobDelivery(ownedMessage(store, recipient, { id, from: { id: `job:${job.id}`, name: job.name, agent: "codex" }, to: "codex-master", recipient: "codex-master",
      conversationId: `job-${job.id}:fallback`, replyTo: null, hop: 0, body: report, createdAt: Date.now(), readAt: null }));
    expect(readRunnerState(env.home, job.id)?.delivered).toBe(false);
    expect(finalReportsReady(env.home, [job])).toBe(true);
    const pending = finalReportDiagnostics(env.home, [job], "opencode-master", "opencode", 0, "");
    expect(pending.jobs[0]?.envelopes).toEqual({ rows: [{ recipient: "codex-master", readAt: null }] });
    expect(pending.jobs[0]?.routes).toEqual({ rows: [{ recipient: "codex-master", consumedAt: null }] });
    const at = Date.now();
    expect(markOwned(store, recipient, [id], at)).toBe(1);
    const copy = store.byId(id)!;
    for (const identity of readJournalIdentities(recipient.name, recipient.sessionId, recipient.frontend, copy.recipientNative, copy.recipientMailbox, copy.jobRoute)) new ReadJournal(env.home).append(identity, [id]);
    const consumed = finalReportDiagnostics(env.home, [job], "opencode-master", "opencode", 1, "");
    expect(consumed.jobs[0]?.envelopes).toEqual({ rows: [{ recipient: "codex-master", readAt: at }] });
    expect(consumed.jobs[0]?.routes).toEqual({ rows: [{ recipient: "codex-master", consumedAt: at }] });
    expect(consumed.jobs[0]?.consumption).toMatchObject({ rows: [{ identity: "codex-master", readAt: expect.any(Number) }] });
    expect(JSON.stringify(consumed)).not.toContain("REPORT_BODY_EXCLUDED_FROM_DIAGNOSTICS");
  } finally { store.close(); }
});

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
  // Completion envelopes arrive through spawned fixture runners and child MCP
  // servers: allow slow runners past the 1 s default (AB-255).
  await expect.poll(async () => { inbox += (await call(target, "inbox")).text; return /Subagent codex-ask-[a-f0-9]+ \(codex\) done after/.test(inbox); }, { timeout: 10_000 }).toBe(true);
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
  phase("sessions");
  const source = await session(primaryName, primaryAgent), target = await session("codex-master", "codex");
  phase("spawns");
  // One spawn request at a time. A spawn is synchronous work in the primary's server, so ten concurrent
  // requests queued behind each other and the last ones outlived the MCP client's 60 s request timeout on
  // loaded Windows runners. The runners themselves still start concurrently: each spawn returns at once.
  const jobs: { name: string; id: string; release: string; link: string }[] = [];
  let delivered = "", inboxReads = 0;
  failureEvidence = () => printFinalReportDiagnostics(env.home, jobs, primaryName, mode, inboxReads, delivered);
  for (let index = 0; index < 10; index++) {
    phase(`spawn-${index}-rpc`);
    const release = join(env.home, `release-${index}`), link = `${release}.link`; releases.push(release);
    const started = await call(source, "spawn_codex", { prompt: `release=${release} link=${link} ${index === 2 ? "approve=yes" : ""} ${index === 1 ? "instruction=yes" : ""} complete item ${index}`, title: `Takeover item ${index}` });
    expect(started.error, started.text).toBeFalsy();
    const name = /(?:codex|claude)-job-[a-f0-9]+/.exec(started.text)![0], id = name.split("-").at(-1)!; ids.push(id);
    jobs.push({ name, id, release, link });
  }
  phase("native-readiness");
  try {
    // Ready: every native turn is live and holds its parent link. Startup admission serializes the Windows job
    // guardians and CLI handshakes, so this takes a load-dependent time; a runner that exits or finishes first
    // can never become ready.
    await waitFor(() => jobs.every((j) => linkReady(j.link) && readRunnerState(env.home, j.id)?.sessionId && readRunnerState(env.home, j.id)?.live),
      () => runnerGone(env.home, jobs, true), 250);
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
  phase("takeover");
  await sendThroughLink(() => children[0]!.send("Pending before takeover"));
  if (mode === "closed") await source.close();
  else expect((await call(source, "coordinator_availability", { unavailable: true })).error).toBeFalsy();
  phase("failover");
  // The project master lists the surviving job once failover (and, for a closed primary, broker re-election)
  // completed; every runner must still be alive meanwhile.
  await waitFor(async () => {
    try { return (await call(target, "peers")).text.includes(jobs[9]!.name); }
    catch { return false; } // A pipe request can straddle broker election.
  }, () => runnerGone(env.home, jobs), 250);
  expect(jobs.every((j) => pidAlive(readRunnerState(env.home, j.id)!.pid))).toBe(true);
  expect((await call(target, "peers")).text).toContain(jobs[9]!.name);
  phase("steering");
  expect((await call(target, "message_subagent", { job: jobs[1]!.name, message: "Continue under the project master", title: "Inherited project work" })).error).toBeFalsy();
  phase("steering-native-instruction");
  await waitFor(() => existsSync(jobs[1]!.release + ".instruction") && readFileSync(jobs[1]!.release + ".instruction", "utf8").includes("Continue under the project master"),
    () => runnerGone(env.home, [jobs[1]!], true));
  expect(readFileSync(jobs[1]!.release + ".instruction", "utf8")).toContain("Continue under the project master");
  phase("notes");
  for (const [i, child] of children.entries()) { phase(`note-${i}-send`); await sendThroughLink(() => child.send(`After takeover note ${i}`, undefined, "note")); }
  phase("approval");
  writeFileSync(jobs[2]!.release + ".approve", "");
  await waitFor(() => listPendingApprovals(env.home).some((a) => a.job === jobs[2]!.name), () => runnerGone(env.home, [jobs[2]!], true));
  const approval = listPendingApprovals(env.home).find((a) => a.job === jobs[2]!.name)!;
  phase("approval-decision-rpc");
  expect((await call(target, "decide", { approval_id: approval.id, decision: "allow" })).error).toBeFalsy();
  phase("approval-native-witness");
  await waitFor(() => existsSync(jobs[2]!.release + ".approved") && readFileSync(jobs[2]!.release + ".approved", "utf8") === "true",
    () => runnerGone(env.home, [jobs[2]!], true));
  expect(readFileSync(jobs[2]!.release + ".approved", "utf8")).toBe("true");
  phase("final-reports");
  for (const job of jobs) writeFileSync(job.release, "");
  // Each final report is delivered or durably stored before its runner exits; a runner that exits without
  // either has lost it, which fails at once with the receipt diagnostics.
  try { await waitFor(() => finalReportsReady(env.home, jobs), () => finalReportLost(env.home, jobs), 250); }
  catch (error) { printFinalReportDiagnostics(env.home, jobs, primaryName, mode, 0, ""); throw error; }
  phase("wake");
  await waitFor(() => existsSync(join(env.home, "wake-calls")));
  phase("inbox");
  // Every final is stored for the project master now: read until all ten arrived (duplicates are checked below).
  while ((delivered.match(/Subagent codex-job-[a-f0-9]+ \(codex\) done after/g) ?? []).length < 10) {
    delivered += (await call(target, "inbox")).text;
    inboxReads++;
    if ((delivered.match(/Subagent codex-job-[a-f0-9]+ \(codex\) done after/g) ?? []).length < 10) await new Promise((r) => setTimeout(r, 20));
  }
  try {
    expect((delivered.match(/Subagent codex-job-[a-f0-9]+ \(codex\) done after/g) ?? []).length, delivered).toBe(10);
    // A live answer to steering is separate from the final report. Each stable final envelope arrives once.
    const envelopes = [...delivered.matchAll(/<agent-bridge-message id="([^"]+)"[^>]*>([\s\S]*?)<\/agent-bridge-message>/g)];
    expect(new Set(envelopes.map((m) => m[1])).size).toBe(envelopes.length);
    for (const job of jobs) expect(envelopes.filter((m) => m[2]!.includes(`Subagent ${job.name} (codex) done after`))).toHaveLength(1);
  } catch (error) { printFinalReportDiagnostics(env.home, jobs, primaryName, mode, inboxReads, delivered); throw error; }
  expect(delivered).toContain("Takeover approval request");
  phase("retained");
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
  phase("done");
});
