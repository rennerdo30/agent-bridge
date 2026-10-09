// Idle CPU/RSS benchmark for the bridge's long-lived processes (AB-147).
//
//   node scripts/idle-bench.mjs <label> [--sessions=6] [--runners=4] [--idle=45] [--settle=10] [--dist=<dir>] [--cpu-prof]
//                               [--retained=300] [--finished=12] [--messages=60]
//
// Builds the current source into a scratch dist under .agent-bridge-test/idle-bench/<label> (never plugins/*/dist),
// starts one broker and several real MCP servers (Claude and Codex sessions) plus detached job runners holding a
// generated provider, all on a fresh generated AGENT_BRIDGE_HOME with empty CLI homes. After settling it samples CPU
// time and RSS per process for the idle window and prints a per-role summary. No owner data, no provider CLI, no git.
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith("--")) ?? "run";
const opt = (name, fallback) => { const hit = args.find((a) => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : fallback; };
const SESSIONS = Number(opt("sessions", 6)), RUNNERS = Number(opt("runners", 4));
// History: retained job records seeded into jobs.json, jobs actually run to completion, and peer messages.
const RETAINED = Number(opt("retained", 300)), FINISHED = Number(opt("finished", 12)), MESSAGES = Number(opt("messages", 60));
const IDLE_S = Number(opt("idle", 45)), SETTLE_S = Number(opt("settle", 10));
const cpuProf = args.includes("--cpu-prof");
const output = resolve(ROOT, ".agent-bridge-test", "idle-bench", label);
mkdirSync(output, { recursive: true });

let dist = opt("dist", "");
if (!dist) {
  dist = join(output, "dist");
  await build({
    absWorkingDir: ROOT, preserveSymlinks: true,
    entryPoints: { server: "src/mcp/launcher.ts", worker: "src/mcp/main.ts", cli: "src/cli/main.ts", "history-worker": "src/core/history-worker.ts",
      "backup-worker": "src/core/backup-worker.ts", "outcome-worker": "src/core/outcome-worker.ts", "job-archive-worker": "src/core/job-archive-worker.ts" },
    outdir: dist, outExtension: { ".js": ".mjs" }, chunkNames: "chunks/[name]-[hash]", splitting: true, bundle: true,
    platform: "node", format: "esm", target: "node22", external: ["node:*"], logLevel: "warning",
    banner: { js: "import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);" },
  });
}
dist = resolve(dist);

const home = mkdtempSync(join(tmpdir(), "ab-idle-bench-"));
const project = join(home, "project");
mkdirSync(project, { recursive: true });
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !k.startsWith("AGENT_BRIDGE_") && !["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_PROJECT_DIR", "NODE_OPTIONS"].includes(k)));
const env = {
  ...inherited, AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_PLUGIN_RUNTIME_HOME: home, AGENT_BRIDGE_JOB_RUNNER: "1",
  GIT_CEILING_DIRECTORIES: home, CLAUDE_PROJECT_DIR: project,
  CLAUDE_CONFIG_DIR: join(home, "cli-claude"), CODEX_HOME: join(home, "cli-codex"),
  XDG_DATA_HOME: join(home, "cli-data"), ANTIGRAVITY_CLI_HOME: join(home, "cli-agy"),
  ...(cpuProf ? { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${join(output, "cpuprof")}` } : {}),
};
// Defaults stay on (history ingest, backups, dashboard host) so the idle work matches a real install; only
// outbound/OS-visible features are off.
writeFileSync(join(home, "config.json"), JSON.stringify({ autoWake: false, notifications: { approvals: false, finish: false, fail: false }, network: { enabled: false } }));
// A small generated Claude transcript set, so history ingest has something to watch.
for (let p = 0; p < 3; p++) {
  const dir = join(home, "cli-claude", "projects", `-generated-project-${p}`);
  mkdirSync(dir, { recursive: true });
  for (let s = 0; s < 5; s++) {
    const sid = `00000000-0000-4000-8000-${String(p * 100 + s).padStart(12, "0")}`;
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push(JSON.stringify({ type: i % 2 ? "assistant" : "user", sessionId: sid, cwd: project, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), uuid: `${sid.slice(0, 24)}${String(i).padStart(12, "0")}`, message: { role: i % 2 ? "assistant" : "user", content: `generated line ${i} of ${sid}` } }));
    writeFileSync(join(dir, `${sid}.jsonl`), lines.join("\n") + "\n");
  }
}
// Retained finished jobs from earlier sessions (the registry the broker and every supervisor read).
if (RETAINED) writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: 4, jobs: Array.from({ length: RETAINED }, (_, i) => ({
  id: `0000${String(i).padStart(4, "0")}`, name: `claude-job-0000${String(i).padStart(4, "0")}`, agent: "claude", model: "fixture",
  prompt: "Generated retained job. ".repeat(40), status: i % 7 ? "done" : "failed", owner: "bench-codex-2", supervisor: "bench-codex-2",
  startedAt: Date.UTC(2026, 0, 1) + i * 60_000, finishedAt: Date.UTC(2026, 0, 1) + i * 60_000 + 30_000, workdir: project,
  args: { title: `Retained ${i}` }, sessionId: `generated-retained-${i}` })) }) + "\n");
const wrapper = join(home, "worker-profile.mjs");
writeFileSync(wrapper, `import {writeFileSync} from 'node:fs';
writeFileSync(process.env.AB_PROFILE_PID_FILE,String(process.pid));
await import(process.env.AB_PROFILE_WORKER_URL);`);
// Each session gets its own host process (the bridge identifies a session by its parent pid), like separate CLIs.
const host = join(home, "session-host.mjs");
writeFileSync(host, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,process.argv.slice(2),{stdio:'inherit'});
child.on('exit',code=>process.exit(code??0));`);
const fake = join(home, "fake-provider.mjs");
writeFileSync(fake, `import {existsSync} from 'node:fs';
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>prompt+=x);
process.stdin.on('end',async()=>{
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'generated-'+process.pid,model:'fixture'}));
while(!prompt.includes('FINISH_NOW')&&!existsSync(process.env.AB_PROFILE_RELEASE))await new Promise(r=>setTimeout(r,250));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'fixture complete',session_id:'generated-'+process.pid}));
});`);
if (process.platform === "win32") {
  env.AGENT_BRIDGE_CLAUDE_BIN = join(home, "fixture-provider.cmd");
  writeFileSync(env.AGENT_BRIDGE_CLAUDE_BIN, `@ECHO off\r\n"${process.execPath}" "${fake}" %*\r\n`);
} else {
  env.AGENT_BRIDGE_CLAUDE_BIN = join(home, "fixture-provider.sh");
  writeFileSync(env.AGENT_BRIDGE_CLAUDE_BIN, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(env.AGENT_BRIDGE_CLAUDE_BIN, 0o755);
}
env.AB_PROFILE_RELEASE = join(home, "release-fixture");

const clients = [], peers = [], jobs = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, what) => { const deadline = Date.now() + 30_000; while (!fn()) { if (Date.now() >= deadline) throw new Error(`fixture deadline: ${what}`); await pause(50); } };
const call = (client, name, a = {}) => client.callTool({ name, arguments: a });
const content = (result) => result.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");

/** CPU ms and RSS bytes per pid, read from the OS without touching the processes. */
async function counters(pids) {
  if (process.platform === "win32") {
    const script = `Get-Process -Id @(${pids.join(",")}) -ErrorAction Stop | ForEach-Object { @{pid=$_.Id;cpuMs=$_.TotalProcessorTime.TotalMilliseconds;rss=$_.WorkingSet64} } | ConvertTo-Json -Compress`;
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    const rows = JSON.parse(stdout); return Array.isArray(rows) ? rows : [rows];
  }
  if (process.platform === "linux") {
    const tick = 1000 / 100; // USER_HZ
    return pids.map((pid) => {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
      const rssPages = Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]);
      return { pid, cpuMs: (Number(stat[11]) + Number(stat[12])) * tick, rss: rssPages * 4096 };
    });
  }
  const { stdout } = await exec("ps", ["-o", "pid=,time=,rss=", "-p", pids.join(",")]);
  return stdout.trim().split("\n").map((line) => {
    const [pid, time, rss] = line.trim().split(/\s+/);
    const parts = time.split(":").map(Number); const secs = parts.reduce((a, x) => a * 60 + x, 0);
    return { pid: Number(pid), cpuMs: secs * 1000, rss: Number(rss) * 1024 };
  });
}

let report, spawner;
try {
  for (let i = 0; i <= SESSIONS; i++) {
    const agent = i % 2 ? "claude" : "codex";
    const client = new Client({ name: "idle-bench", version: "1" }); clients.push(client);
    const pidFile = join(home, `worker-${i}.pid`);
    const transport = new StdioClientTransport({ command: process.execPath, args: [host, wrapper, `--agent=${agent}`], cwd: project, stderr: "ignore",
      env: { ...env, AGENT_BRIDGE_NAME: `bench-${agent}-${i}`, AB_PROFILE_PID_FILE: pidFile, AB_PROFILE_WORKER_URL: pathToFileURL(join(dist, "worker.mjs")).href } });
    await client.connect(transport); await call(client, "peers"); await wait(() => existsSync(pidFile), "session pid");
    const pid = Number(readFileSync(pidFile, "utf8"));
    const health = JSON.parse(content(await call(client, "health")));
    peers.push({ role: pid === health.brokerPid ? "broker" : "session", agent, pid });
  }
  // A non-broker Codex session supervises the jobs, so the broker's own idle work is measured separately.
  spawner = clients[2] ?? clients[0];
  // Some mail between the sessions, then jobs that run to completion, so stores and history have content.
  for (let i = 0; i < MESSAGES; i++) {
    const from = clients[i % clients.length], to = `bench-${(i + 1) % clients.length % 2 ? "claude" : "codex"}-${(i + 1) % clients.length}`;
    const result = await call(from, "send", { to, message: `Generated bench message ${i}: ` + "lorem ipsum ".repeat(20) });
    if (result.isError) throw new Error(`message ${i} to ${to}: ${content(result)}\n${content(await call(from, "peers"))}`);
  }
  const finished = [];
  for (let i = 0; i < FINISHED; i++) {
    const result = await call(spawner, "spawn_claude", { prompt: `FINISH_NOW generated finished job ${i}`, title: `Finished ${i}`, access: "edit" });
    if (result.isError) throw new Error(content(result));
    finished.push(/claude-job-[a-f0-9]+/.exec(content(result))?.[0]);
  }
  const doneDeadline = Date.now() + 120_000;
  for (;;) {
    let store = { jobs: [] };
    try { store = JSON.parse(readFileSync(join(home, "jobs.json"), "utf8")); } catch { /* being replaced */ }
    const open = finished.filter((name) => store.jobs?.find((j) => j.name === name)?.status === "running" || !store.jobs?.some((j) => j.name === name));
    if (!open.length) break;
    if (Date.now() > doneDeadline) throw new Error(`finished jobs still open: ${open.join(", ")}`);
    await pause(500);
  }
  for (let i = 0; i < RUNNERS; i++) {
    const result = await call(spawner, "spawn_claude", { prompt: "Generated idle fixture; wait for fixture release", title: `Idle runner ${i}`, access: "edit" });
    if (result.isError) throw new Error(content(result));
    const name = /claude-job-[a-f0-9]+/.exec(content(result))?.[0]; if (!name) throw new Error("missing job name: " + content(result)); jobs.push(name);
    const state = join(home, "jobs", name.split("-").at(-1) + ".json");
    await wait(() => existsSync(state) && JSON.parse(readFileSync(state, "utf8")).pid, "runner state");
    peers.push({ role: "runner", agent: "claude", pid: JSON.parse(readFileSync(state, "utf8")).pid });
  }
  await pause(SETTLE_S * 1000);
  const before = await counters(peers.map((p) => p.pid)); const started = performance.now();
  const rssTrace = [];
  for (let t = 0; t < IDLE_S; t += 15) {
    await pause(Math.min(15, IDLE_S - t) * 1000);
    rssTrace.push(await counters(peers.map((p) => p.pid)));
  }
  const after = rssTrace.at(-1); const elapsedMs = performance.now() - started;
  const samples = peers.map((peer) => {
    const a = before.find((x) => x.pid === peer.pid), b = after.find((x) => x.pid === peer.pid);
    if (!a || !b) throw new Error(`process ${peer.pid} (${peer.role}) exited during the idle window`);
    return { ...peer, cpuMs: Math.round(b.cpuMs - a.cpuMs), rssMiB: +(b.rss / 1048576).toFixed(1), rssTraceMiB: rssTrace.map((r) => +(r.find((x) => x.pid === peer.pid).rss / 1048576).toFixed(1)) };
  });
  const roles = Object.fromEntries(["broker", "session", "runner"].map((role) => {
    const rows = samples.filter((x) => x.role === role);
    const cpu = rows.reduce((s, x) => s + x.cpuMs, 0);
    return [role, { count: rows.length, cpuMsTotal: cpu, cpuMsPerProcess: Math.round(cpu / Math.max(1, rows.length)),
      cpuPctOfCorePerProcess: +((cpu / Math.max(1, rows.length)) / elapsedMs * 100).toFixed(3), rssMiBMean: +(rows.reduce((s, x) => s + x.rssMiB, 0) / Math.max(1, rows.length)).toFixed(1) }];
  }));
  report = { label, node: process.version, platform: process.platform, elapsedMs: Math.round(elapsedMs), sessions: SESSIONS, runners: RUNNERS, settleS: SETTLE_S, home, dist, roles, samples };
  writeFileSync(join(output, `report-${Date.now()}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ label, elapsedMs: report.elapsedMs, roles }, null, 2));
} finally {
  writeFileSync(env.AB_PROFILE_RELEASE, "");
  for (const name of jobs) await call(spawner ?? clients[0], "cancel_subagent", { job: name }).catch(() => {});
  for (const client of clients.reverse()) await client.close().catch(() => {});
  console.error("Generated fixture home (left in place, temp dir): " + home);
}
