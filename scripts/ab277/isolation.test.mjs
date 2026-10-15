import test from 'node:test';
import assert from 'node:assert/strict';
import cp, { execFile, execFileSync, spawn, spawnSync, exec, execSync, fork } from 'node:child_process';
import { childEnvironment, validateEnvironment, fixtureRoot, allowedIdentityCall, identityScripts, installLaunchGuard } from './isolation.mjs';
import { join, resolve } from 'node:path';

const root = resolve('.agent-bridge-test/ab277-memory/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
const nonce = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const script = '(Get-Process -Id 111 -ErrorAction Stop).StartTime.ToUniversalTime().Ticks';
const args = ['-NoProfile', '-NonInteractive', '-Command', script];

test('fresh environment excludes inherited credentials and job/session/runtime linkage', () => {
  const environment = childEnvironment(root, 'codex', nonce);
  assert.equal(environment.AGENT_BRIDGE_HISTORY_INGEST, '0');
  assert.equal(environment.AGENT_BRIDGE_JOB_RUNNER, '0');
  assert.equal(environment.HOME, join(root, 'codex', 'profile'));
  assert.throws(() => validateEnvironment(root, 'codex', nonce, { ...environment, AGENT_BRIDGE_PARENT_TOKEN: 'synthetic-rejected' }));
  assert.throws(() => validateEnvironment(root, 'codex', nonce, { ...environment, AGENT_BRIDGE_PIPE: '\\\\.\\pipe\\foreign' }));
  assert.throws(() => validateEnvironment(root, 'codex', nonce, { ...environment, HOME: resolve('..') }));
});

test('fixture roots and per-role endpoints cannot collide with a live default', () => {
  assert.equal(fixtureRoot(resolve('.'), root), root);
  assert.throws(() => fixtureRoot(resolve('.'), resolve('outside')));
  const endpoints = ['claude', 'codex', 'opencode'].map(role => childEnvironment(root, role, nonce).AGENT_BRIDGE_PIPE);
  assert.equal(new Set(endpoints).size, 3);
});

test('only exact creation-time literals for the two fixed owned PIDs are allowed', () => {
  assert(allowedIdentityCall('powershell.exe', args, {}, [111, 222], powershell));
  for (const bad of [script.replace('111', '333'), `${script}; Get-ChildItem`, script.replace('StartTime', 'CommandLine')]) {
    assert(!allowedIdentityCall('powershell.exe', [...args.slice(0, 3), bad], {}, [111, 222], powershell));
  }
  assert(!allowedIdentityCall('powershell.exe', args, { shell: true }, [111, 222], powershell));
  assert(!allowedIdentityCall('cmd.exe', args, {}, [111, 222], powershell));
  assert(!allowedIdentityCall('powershell.exe', [...args, '-Extra'], {}, [111, 222], powershell));
  assert(identityScripts([111, 222]).size >= 6);
});

test('early ESM named/default and later CommonJS destructured APIs are all guarded without executing hosts', async () => {
  const calls = [];
  const originals = { execFile(file, arguments_, options, callback) { calls.push({ file, arguments_, options }); callback?.(null, 'fixture-ticks', ''); return {}; }, execFileSync(file, arguments_, options) { calls.push({ file, arguments_, options }); return 'fixture-ticks'; } };
  const count = {};
  installLaunchGuard({ pids: [111, 222], powershell, environment: childEnvironment(root, 'claude', nonce), originals, count });
  const { createRequire } = await import('node:module');
  const cjs = createRequire(import.meta.url)('node:child_process');
  const { spawn: cjsSpawn, execFile: cjsExecFile } = cjs;
  for (const api of [spawn, spawnSync, exec, execSync, fork, cp.spawn, cjsSpawn]) assert.throws(() => api('codex.exe', []), { code: 'AB277_LAUNCH_DENIED' });
  assert.throws(() => execFile('powershell.exe', ['-Command', 'Get-CimInstance Win32_Process']), { code: 'AB277_LAUNCH_DENIED' });
  assert.throws(() => cjsExecFile('claude.exe', []), { code: 'AB277_LAUNCH_DENIED' });
  assert.throws(() => execFileSync('opencode.exe', []), { code: 'AB277_LAUNCH_DENIED' });
  execFile('powershell.exe', args, {}, () => {});
  assert.equal(execFileSync('powershell.exe', args, {}), 'fixture-ticks');
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.file === powershell && call.options.windowsHide && !call.options.shell));
  assert.equal(count.allowed, 2);
  assert(count.deniedPerApi.spawn >= 1);
  assert.equal(count.deniedPerApi.execFileSync, 1);
  if (process.env.AB277_GUARD_PROBE_FILE) {
    const { pathToFileURL } = await import('node:url');
    const probePath = resolve(process.env.AB277_GUARD_PROBE_FILE);
    fixtureRoot(resolve('.'), probePath);
    // Actual published modules load after the guard, as they do after --import in the MCP fixture.
    const probe = await import(pathToFileURL(probePath).href);
    assert.equal(await probe.readProcessIdentity(111), 'fixture-ticks');
    assert.deepEqual(await probe.inspectClaudeLaunch('agent-bridge', { debug() {} }), { channel: false, print: false, interactive: false });
    assert(calls.every(call => !call.arguments_.join(' ').includes('CommandLine')));
  }
});
