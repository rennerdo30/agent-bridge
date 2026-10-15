import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { codexHost } from "./helpers.js";
import { readRunnerState } from "../src/mcp/job-host.js";
import { readStore } from "../src/mcp/jobs.js";
import { parentFromEnv } from "../src/core/parent-link.js";
import { pidAlive } from "../src/core/delegate.js";
import { fixtureProcessExists, fixtureProcessGeneration } from "./fixture-process-generation.js";
import type { CodingAgent } from "../src/core/protocol.js";
import { migrateJobArchives } from "../src/core/job-archive-migration.js";
import { JSON_STORE_VERSION } from "../src/core/json-store.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
let env: TestEnv, bin: string;
let broker: ReturnType<TestEnv["node"]>;
const clients: Client[] = [];
const transports: StdioClientTransport[] = [];
const fixtureNodes: ReturnType<TestEnv["node"]>[] = [];
const runnerIds: string[] = [];
const releases: string[] = [];
const watchers: FSWatcher[] = [];
function created(path: string) {
  const ready = deferred<void>();
  const watcher = watch(join(path, ".."), () => { if (existsSync(path)) ready.resolve(); });
  watchers.push(watcher);
  if (existsSync(path)) ready.resolve();
  return ready.promise;
}
type StoredJob = ReturnType<typeof readStore>[number];
function admittedJob(matches: (job: StoredJob) => boolean): Promise<StoredJob> {
  const ready = deferred<StoredJob>();
  const check = () => {
    const job = readStore(join(env.home, "jobs.json")).find(job => matches(job) && job.sessionId);
    if (job) ready.resolve(job);
  };
  const watcher = watch(env.home, (_event, filename) => { if (String(filename) === "jobs.json") check(); });
  watchers.push(watcher); check();
  return ready.promise;
}
let responses: { at: number; name: string; args: Record<string, unknown>; text?: string; error?: unknown }[];
let captureErrors: unknown[];
const exec = promisify(execFile);
/** Runner admission budget, the same as stopOwnedRunner allows for a late admission. */
const RUNNER_START_MS = 30_000;
beforeEach(async () => {
  clients.length = transports.length = fixtureNodes.length = runnerIds.length = releases.length = 0;
  responses = [];
  captureErrors = [];
  env = makeEnv(); const dir = join(env.home, "bin"); mkdirSync(dir);
  // These are MCP hosts, not interactive CLI sessions. Keep wake helpers out of
  // the fixture and give the handoff protocol a broker independent of either host.
  writeFileSync(join(env.home, "config.json"), JSON.stringify({ wakeOnDirect: false, delivery: "hooks" }));
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: JSON_STORE_VERSION, jobs: [] }));
  await migrateJobArchives(join(env.home, "jobs.json"));
  broker = env.node("fixture-broker", "other"); fixtureNodes.push(broker); await broker.start();
  const file = join(dir, "fake.mjs");
  writeFileSync(file, `#!/usr/bin/env node
import { existsSync, writeFileSync, renameSync } from 'node:fs';
let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',d=>prompt+=d);
process.stdin.on('end',async()=>{
 // Model a slow native dependency independently of CPU load. Readiness must
 // come from the delegate, not the old five-second link-file polling budget.
 if(prompt.includes('blocking work'))await new Promise(r=>setTimeout(r,5500));
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
function diagnostics(stage: string): void {
  const json = (file: string) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) { return { inspectionError: String(error) }; } };
  const files = (directory: string) => {
    const path = join(env.home, directory);
    return existsSync(path) ? Object.fromEntries(readdirSync(path).filter(file => file.endsWith(".json") && !file.endsWith(".spec.json")).map(file => [file, json(join(path, file))])) : {};
  };
  writeFileSync(join(env.home, `handoff-diagnostics-${stage}.json`), JSON.stringify({ at: Date.now(), home: env.home, responses, runnerIds,
    jobs: existsSync(join(env.home, "jobs.json")) ? json(join(env.home, "jobs.json")) : null, states: files("jobs"), runs: files("runs") }, null, 2));
}
/**
 * CI keeps only the console: print where a job's reports went (durable envelopes, broker rows and routes,
 * and every warning the sessions logged), read-only, so a missing delivery can be traced without the fixture.
 */
function printDeliveryEvidence(jobId: string): void {
  const evidence: Record<string, unknown> = { home: env.home };
  try {
    const record = readStore(join(env.home, "jobs.json"), undefined, true).find((j) => j.id === jobId);
    evidence.job = record && { status: record.status, owner: record.owner, executionOwner: record.executionOwner, rootName: record.rootName, finishedAt: record.finishedAt,
      deliveryHistory: record.deliveryHistory?.map((m) => ({ id: m.id, to: m.to, conversation: m.conversationId, body: m.body.slice(0, 80) })) };
  } catch (error) { evidence.job = String(error); }
  try {
    const db = new DatabaseSync(env.db, { readOnly: true, timeout: 5_000 });
    try {
      evidence.messages = db.prepare("SELECT id, recipient, conversation_id, read_at, created_at, substr(body, 1, 80) AS body FROM messages WHERE from_id=?").all(`job:${jobId}`);
      evidence.routes = db.prepare("SELECT r.* FROM job_delivery_routes r JOIN messages m ON m.id=r.id WHERE m.from_id=?").all(`job:${jobId}`);
    } finally { db.close(); }
  } catch (error) { evidence.messages = String(error); }
  try {
    evidence.log = readFileSync(join(env.home, "logs", "agent-bridge.log"), "utf8").split("\n").filter((line) => /\b(WARN|ERROR)\b|inlineJobReport|report/.test(line)).slice(-80);
  } catch (error) { evidence.log = String(error); }
  console.error(`Handoff delivery evidence: ${JSON.stringify(evidence, null, 1)}`);
}
async function stopOwnedRunner(id: string): Promise<void> {
  // Admission may still be in flight when the test's link-file deadline expires.
  await until(() => {
    if (readRunnerState(env.home, id)?.pid) return true;
    const saved = readStore(join(env.home, "jobs.json")).find(job => job.id === id);
    return Boolean(saved && saved.status !== "running" && !saved.host);
  }, 30_000);
  const state = readRunnerState(env.home, id);
  if (!state?.pid) return;
  if (!fixtureProcessExists(state.pid, `Refusing unverified fixture runner ${state.pid}; retained at ${env.home}`)) return;
  const pid = state.pid;
  // A runner still in Windows job-ownership setup has not recorded its store presence yet; wait for it (or its exit)
  // instead of refusing, so a slow-starting runner is still verified and stopped.
  await until(() => storePresence(pid) !== null || !pidAlive(pid), 30_000).catch(() => {});
  if (!pidAlive(pid)) return;
  const presence = storePresence(pid);
  if (state.peer !== `claude-job-${id}` || presence?.pid !== pid || presence?.name !== state.peer ||
    typeof presence.processIdentity !== "string" || (process.platform === "win32" && !/^\d+$/.test(presence.processIdentity)))
    throw new Error(`Refusing unidentified fixture runner ${pid}; retained at ${env.home}`);
  if (!(await fixtureProcessGeneration(pid, presence.processIdentity, `Refusing unidentified fixture runner ${pid}; retained at ${env.home}`))) return;
  if (process.platform === "win32") {
    // Holding the handle fences PID reuse for both the final comparison and termination.
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($null -eq $p){exit 0}; try {$h=$p.SafeHandle; if($h.IsInvalid -or $h.IsClosed -or [string]$p.StartTime.ToUniversalTime().Ticks -ne '${presence.processIdentity}'){throw 'Fixture generation changed; no signal sent'}; $p.Kill(); if(-not $p.WaitForExit(5000)){throw 'Owned runner did not exit; no fallback'}} finally {$p.Dispose()}`], { windowsHide: true });
  } else {
    if (!(await fixtureProcessGeneration(pid, presence.processIdentity, "Fixture generation changed; no signal sent"))) return;
    try { process.kill(pid, "SIGTERM"); } catch (error) { if (pidAlive(pid)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 3_000));
    if (pidAlive(pid)) {
      if (!(await fixtureProcessGeneration(pid, presence.processIdentity, "Fixture generation changed; no delayed signal sent"))) return;
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (pidAlive(pid)) throw error; }
    }
  }
  await until(() => !pidAlive(pid), 30_000);
}
/** AB-208: a process's presence is a bridge.db metadata row; the file remains while the store is deferred. */
function storePresence(pid: number): Record<string, any> | null {
  if (existsSync(env.db)) {
    const db = new DatabaseSync(env.db, { readOnly: true, timeout: 5_000 });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_metadata'").get()) {
        const row = db.prepare("SELECT value FROM bridge_metadata WHERE domain='storage-capabilities' AND key=?").get(String(pid));
        if (row) return JSON.parse(String(row.value));
      }
    } finally { db.close(); }
  }
  const file = join(env.home, "storage-capabilities", `${pid}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}
afterEach(async context => {
  for (const watcher of watchers.splice(0)) watcher.close();
  let failed = context.task.result?.state === "fail";
  const errors: unknown[] = [...captureErrors];
  if (errors.length) failed = true;
  const attempt = async (action: () => Promise<unknown> | void) => { try { await action(); } catch (error) { failed = true; errors.push(error); } };
  if (failed) await attempt(() => diagnostics("before-cleanup"));
  for (const file of releases) await attempt(() => writeFileSync(file, ""));
  // Keep the broker alive while canceled or late-admitted native fixture runners settle.
  for (const id of runnerIds) {
    await attempt(async () => { if (clients[0]) await call(clients[0], "cancel_subagent", { job: `claude-job-${id}` }); });
    await attempt(() => stopOwnedRunner(id));
  }
  for (let index = 0; index < clients.length; index++) {
    const client = clients[index]!, transport = transports[index]!, pid = transport.pid;
    await attempt(() => client.close());
    await attempt(() => transport.close());
    if (pid) await attempt(() => until(() => !pidAlive(pid), 30_000));
  }
  for (const node of fixtureNodes) await attempt(() => node.stop());
  for (const error of captureErrors) if (!errors.includes(error)) { failed = true; errors.push(error); }
  if (failed) {
    await attempt(() => diagnostics("after-cleanup"));
    console.error(`Retained failed handoff fixture: ${env.home}`);
  } else await attempt(() => env.cleanup());
  if (errors.length) throw new AggregateError(errors, `Fixture cleanup failed; retained at ${env.home}`);
});
async function session(name: string, agent: CodingAgent, inline = false) {
  const registered = deferred<void>();
  const joined = (peer: { name: string }) => { if (peer.name === name) registered.resolve(); };
  broker.on("peer_joined", joined);
  const client = new Client({ name: "handoff-test", version: "1" }); clients.push(client);
  const codexHome = codexHost(client, env.home, agent, name);
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, `--agent=${agent}`], cwd: env.home, env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AGENT_BRIDGE_"))), CODEX_HOME: codexHome, AGENT_BRIDGE_HOME: env.home, CLAUDE_PROJECT_DIR: env.home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_CLAUDE_BIN: bin, AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_JOB_RUNNER: inline ? "0" : "1",
  } as Record<string, string>, stderr: "pipe" });
  transports.push(transport);
  const stderrPath = join(env.home, `session-${name}-${agent}.stderr.log`);
  const sessionResponses = responses, sessionErrors = captureErrors;
  transport.stderr?.on("data", data => { try { appendFileSync(stderrPath, data); } catch (error) { sessionResponses.push({ at: Date.now(), name: "stderr", args: {}, error: String(error) }); sessionErrors.push(error); } });
  try {
    await client.connect(transport);
    // The handshake precedes launch inspection. Non-Codex hosts join on their
    // own after inspection; an early tool call used to force a premature join
    // and race their post-handshake updatePeer/restore against the first job.
    if (agent !== "codex") await registered.promise;
    await call(client, "peers"); return client;
  } finally { broker.off("peer_joined", joined); }
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  try {
    const result = await client.callTool({ name, arguments: args });
    const response = { text: (result.content as { text: string }[]).map((c) => c.text ?? "").join("\n"), error: result.isError };
    responses.push({ at: Date.now(), name, args, ...response });
    return response;
  } catch (error) { responses.push({ at: Date.now(), name, args, error: String(error) }); throw error; }
}

it("hands off a blocking ask without returning results or notes to the old caller", async () => {
  const source = await session("codex-source", "codex", true), target = await session("claude-target", "claude");
  const release = join(env.home, "release"), linkFile = join(env.home, "link.json"); releases.push(release);
  const ready = created(linkFile);
  const pending = call(source, "ask_claude", { prompt: `release=${release} link=${linkFile} blocking work`, title: "Blocking inherited job" });
  // A later assertion can fail while the ask still owns its native delegate.
  // Cleanup closes that transport; keep its rejection observed until we await it.
  void pending.catch(() => {});
  await Promise.race([ready, pending.then(reply => { throw new Error(`Delegate ended before parent-link readiness: ${reply.text}`); })]);
  const job = await Promise.race([admittedJob(j => j.name.startsWith("claude-ask-")), pending.then(reply => { throw new Error(`Delegate ended before admission: ${reply.text}`); })]);
  expect(job).toBeDefined();
  expect((await call(source, "handoff_subagents", { to: "claude-target" })).error).toBeFalsy();
  await call(source, "inbox");
  const child = parentFromEnv(JSON.parse(readFileSync(linkFile, "utf8")))!;
  await child.send("Foreground post-handoff note");
  await expect.poll(() => readStore(join(env.home, "jobs.json")).find((j) => j.id === job.id)?.deliveryHistory?.some((m) => m.body.includes("Foreground post-handoff note"))).toBe(true);
  writeFileSync(release, "");
  const originalReply = await pending;
  expect(originalReply.text).toContain("supervised by claude-target");
  expect(originalReply.text).not.toContain("Inherited runner finished");
  let inherited = "";
  await expect.poll(async () => { inherited += (await call(target, "inbox")).text; return inherited.includes("Inherited runner finished"); }, { timeout: 5000 }).toBe(true)
    .catch((error: unknown) => { printDeliveryEvidence(job.id); throw error; });
  expect((await call(target, "inbox", { include_quiet: true })).text).toContain("Foreground post-handoff note");
  expect((await call(source, "inbox")).text).not.toMatch(/Foreground post-handoff|Inherited runner finished/);
  expect(readStore(join(env.home, "jobs.json")).find((j) => j.id === job.id)!.deliveryHistory).toBeDefined();
});

it.each([
  ["codex", "claude", false], ["codex", "claude", true], ["opencode", "codex", false], ["codex", "opencode", false],
  ["antigravity", "opencode", false], ["codex", "antigravity", false],
] as const)("hands off %s to %s (inline=%s), delivers once and retains master controls", async (fromAgent, toAgent, inline) => {
  const source = await session("codex-source", fromAgent, inline), target = await session("claude-target", toAgent);
  const observer = env.node("observer", "opencode"); fixtureNodes.push(observer); await observer.start();
  const release = join(env.home, "release"), linkFile = join(env.home, "link.json"); releases.push(release);
  const ready = created(linkFile);
  const started = await call(source, "spawn_claude", { prompt: `release=${release} link=${linkFile} work on task`, title: "Inherited live runner" });
  expect(started.error).toBeFalsy(); const name = /claude-job-[a-f0-9]+/.exec(started.text)![0], id = name.split("-").at(-1)!;
  // Even an inline first turn continues in a detached runner of the new (runner-hosting) supervisor.
  runnerIds.push(id);
  // A detached Windows runner first establishes its private job object (a PowerShell guardian) before the delegate
  // starts; on a loaded runner that alone takes 8-11 s. Admission and turn deadlines below allow for it.
  await ready;
  // The fake CLI writes its link immediately after emitting init. The executor
  // can still be persisting that init under jobs.json.lock; handing off before
  // that write completes races the broker's two-second metadata lease budget.
  await admittedJob(job => job.name === name);
  const child = parentFromEnv(JSON.parse(readFileSync(linkFile, "utf8")))!;
  expect((await call(source, "handoff_subagents", { to: "claude-target", note: "Finish and review" })).error).toBeFalsy();
  expect((await call(source, "message_subagent", { job: name, message: "Former master instruction" })).error).toBeFalsy();
  await call(source, "inbox"); // Consume the one permitted handoff confirmation.
  await child.send("Post-handoff note");
  await child.escalate?.("Post-handoff approval request");
  await child.progress?.(65, "New supervisor progress");
  writeFileSync(release, "");
  await until(() => readStore(join(env.home, "jobs.json")).find((j) => j.name === name)?.status === "done", RUNNER_START_MS);
  let inbox = "";
  const deadline = Date.now() + 5000;
  while (!inbox.includes("Inherited runner finished") && Date.now() < deadline) {
    inbox += (await call(target, "inbox")).text;
    if (!inbox.includes("Inherited runner finished")) await new Promise((resolve) => setTimeout(resolve, 30));
  }
  expect(inbox).toContain("Inherited runner finished");
  expect(inbox).toContain("Post-handoff approval request");
  expect((await call(source, "inbox")).text).not.toMatch(/Post-handoff|Inherited runner finished|Subagent .*done after/);
  // The first turn's "done" stays in the registry until the next turn is admitted: wait for the next turn's own
  // completion, or the afterEach would find no runner to stop while the new turn's runner still starts.
  const firstFinishedAt = readStore(join(env.home, "jobs.json")).find((j) => j.name === name)!.finishedAt ?? 0;
  expect((await call(target, "message_subagent", { job: name, message: "Continue with the next task" })).error).toBeFalsy();
  await until(() => { const job = readStore(join(env.home, "jobs.json")).find((j) => j.name === name); return job?.status === "done" && (job.finishedAt ?? 0) > firstFinishedAt; }, RUNNER_START_MS);
  expect(readStore(join(env.home, "jobs.json")).find((j) => j.name === name)!.owner).toBe("claude-target");
});
