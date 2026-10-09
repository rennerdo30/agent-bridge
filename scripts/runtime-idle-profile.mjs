// Windows generated-fixture profile of actual MCP workers and detached runners.
// The caller snapshots baseline bundles separately; this script never runs git.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
if (process.platform !== 'win32') throw new Error('This profile uses read-only Windows process counters');
const [label, distArg] = process.argv.slice(2);
if (!label || !distArg) throw new Error('Usage: node scripts/runtime-idle-profile.mjs <label> <dist-directory>');
const dist = resolve(distArg);
const home = mkdtempSync(join(tmpdir(), 'ab-runtime-idle-'));
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_BRIDGE_')));
const env = { ...inherited, AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_PLUGIN_RUNTIME_HOME: home,
  AGENT_BRIDGE_HISTORY_INGEST: '0', AGENT_BRIDGE_DASHBOARD: 'off', AGENT_BRIDGE_JOB_RUNNER: '1',
  AGENT_BRIDGE_BACKUP_INTERVAL_MS: '0', GIT_CEILING_DIRECTORIES: home,
  CLAUDE_PROJECT_DIR: home, CLAUDE_CONFIG_DIR: join(home, 'empty-claude'), CODEX_HOME: join(home, 'empty-codex'),
  XDG_DATA_HOME: join(home, 'empty-data'), ANTIGRAVITY_CLI_HOME: join(home, 'empty-agy') };
writeFileSync(join(home, 'config.json'), JSON.stringify({ dashboard: false, autoWake: false, wakeOnDirect: false,
  history: { ingest: false }, notifications: { approvals: false, finish: false, fail: false }, network: { enabled: false } }));
const wrapper = join(home, 'worker-profile.mjs');
writeFileSync(wrapper, `import {writeFileSync} from 'node:fs';
writeFileSync(process.env.AB_PROFILE_PID_FILE,String(process.pid));
await import(process.env.AB_PROFILE_WORKER_URL);`);
const fake = join(home, 'fake-provider.mjs');
writeFileSync(fake, `import {existsSync} from 'node:fs';
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>prompt+=x);
process.stdin.on('end',async()=>{
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'generated-'+process.pid,model:'fixture'}));
while(!existsSync(process.env.AB_PROFILE_RELEASE))await new Promise(r=>setTimeout(r,100));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'fixture complete',session_id:'generated-'+process.pid}));
});`);
const fakeCommand = join(home, 'fixture-provider.cmd');
writeFileSync(fakeCommand, `@ECHO off\r\n"${process.execPath}" "${fake}" %*\r\n`);
env.AGENT_BRIDGE_CLAUDE_BIN = fakeCommand;
env.AB_PROFILE_RELEASE = join(home, 'release-owned-fixture');
const clients = [], peers = [], jobs = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
const wait = async fn => { const deadline = Date.now() + 20_000; while (!fn()) { if (Date.now() >= deadline) throw new Error('Fixture startup deadline'); await pause(50); } };
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const content = result => result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
const counters = async pids => {
  const script = `Get-Process -Id @(${pids.join(',')}) -ErrorAction Stop | ForEach-Object { @{pid=$_.Id;identity=[string]$_.StartTime.ToUniversalTime().Ticks;cpuMs=$_.TotalProcessorTime.TotalMilliseconds;rss=$_.WorkingSet64} } | ConvertTo-Json -Compress`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  const rows = JSON.parse(stdout); return Array.isArray(rows) ? rows : [rows];
};
try {
  for (let i = 0; i < 17; i++) {
    const client = new Client({ name: 'generated-idle-profile', version: '1' }); clients.push(client);
    const pidFile = join(home, `worker-${i}.pid`);
    const transport = new StdioClientTransport({ command: process.execPath, args: [wrapper, '--agent=codex'], cwd: home, stderr: 'ignore',
      env: { ...env, AGENT_BRIDGE_NAME: `profile-session-${i}`, AB_PROFILE_PID_FILE: pidFile, AB_PROFILE_WORKER_URL: new URL('worker.mjs', 'file:///' + dist.replaceAll('\\', '/') + '/').href } });
    await client.connect(transport); await call(client, 'peers'); await wait(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const health = JSON.parse(content(await call(client, 'health')));
    peers.push({ role: pid === health.brokerPid ? 'broker' : 'session', pid });
  }
  for (let i = 0; i < 7; i++) {
    const result = await call(clients[0], 'spawn_claude', { prompt: 'Generated idle fixture; wait for fixture release', title: `Generated idle runner ${i}`, access: 'edit' });
    if (result.isError) throw new Error(content(result));
    const name = /claude-job-[a-f0-9]+/.exec(content(result))?.[0]; if (!name) throw new Error('Missing generated job name'); jobs.push(name);
    const state = join(home, 'jobs', name.split('-').at(-1) + '.json');
    // The runner layout is read solely inside this fresh generated home.
    await wait(() => existsSync(state));
    peers.push({ role: 'runner', pid: JSON.parse(readFileSync(state, 'utf8')).pid });
  }
  await pause(7_000);
  const before = await counters(peers.map(p => p.pid)), started = performance.now();
  await pause(30_000);
  const after = await counters(peers.map(p => p.pid)), elapsedMs = performance.now() - started;
  const samples = peers.map(peer => {
    const a = before.find(x => x.pid === peer.pid), b = after.find(x => x.pid === peer.pid);
    if (!a || !b || a.identity !== b.identity) throw new Error('Fixture process identity changed');
    return { role: peer.role, cpuMs: b.cpuMs - a.cpuMs, rssMiB: b.rss / 1048576 };
  });
  const roles = Object.fromEntries(['broker', 'session', 'runner'].map(role => {
    const rows = samples.filter(x => x.role === role);
    return [role, { count: rows.length, cpuMs: rows.reduce((sum, x) => sum + x.cpuMs, 0), rssMiB: rows.reduce((sum, x) => sum + x.rssMiB, 0) / rows.length }];
  }));
  const report = { label, node: process.version, elapsedMs, method: 'Actual compiled MCP workers and seven detached runners, generated provider; Windows process counters; settled 7s, sampled 30s; no owner storage or provider CLI', roles, samples };
  const output = resolve('.agent-bridge-test', 'runtime-idle-' + label); mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'report-' + Date.now() + '.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  writeFileSync(env.AB_PROFILE_RELEASE, '');
  for (const name of jobs) await call(clients[0], 'cancel_subagent', { job: name }).catch(() => {});
  for (const client of clients.reverse()) await client.close();
  console.error('Retained generated runtime fixture: ' + home);
}
