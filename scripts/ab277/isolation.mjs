import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

export const ROLES = ['claude', 'codex', 'opencode'];
export const BASE = '7e80ac79bc20c804985f0463125e7832308222b0';
export const IDLE_MS = 600_000;

export function within(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function unlinked(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('linked path refused');
    if (dirname(current) === current) return;
  }
}

export function fixtureRoot(worktree, path) {
  const root = resolve(path);
  const allowed = join(worktree, '.agent-bridge-test', 'ab277-memory');
  if (!within(allowed, root) || root === resolve(allowed)) throw new Error('fixture root outside dedicated namespace');
  unlinked(root);
  return root;
}

export function fixtureConfig(role) {
  if (!ROLES.includes(role)) throw new Error('unknown fixture role');
  return {
    name: `ab277-fixture-${role}`, dashboard: false, delivery: 'hooks',
    autoWake: false, wakeOnDirect: false, history: { ingest: false, budgetBytes: 0 },
    network: { enabled: false, discovery: false, remoteJobs: { enabled: false, allowRoots: [], agents: [], allowPeers: [] } },
    jobCloseCleanup: false, autoApproveTools: [], notifications: { approvals: false, finish: false, fail: false },
  };
}

export function childEnvironment(root, role, nonce, systemRoot = 'C:\\Windows') {
  if (!ROLES.includes(role) || !/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('invalid fixture identity');
  const home = join(root, role, 'home');
  const profile = join(root, role, 'profile');
  const project = join(root, role, 'project');
  const environment = {
    SystemRoot: systemRoot, WINDIR: systemRoot,
    PATH: join(systemRoot, 'System32'),
    HOME: profile, USERPROFILE: profile,
    APPDATA: join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: join(profile, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(profile, '.config'), XDG_DATA_HOME: join(profile, '.local', 'share'),
    XDG_CACHE_HOME: join(profile, '.cache'), CODEX_HOME: join(profile, '.codex'),
    CLAUDE_CONFIG_DIR: join(profile, '.claude'), TMP: join(root, role, 'tmp'), TEMP: join(root, role, 'tmp'),
    CLAUDE_PROJECT_DIR: project,
    AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_PLUGIN_RUNTIME_HOME: home,
    AGENT_BRIDGE_PIPE: `\\\\.\\pipe\\ab277-fixture-${nonce}-${role}`,
    AGENT_BRIDGE_NAME: `ab277-fixture-${role}`, AGENT_BRIDGE_AGENT: role,
    AGENT_BRIDGE_LOG_LEVEL: 'error', AGENT_BRIDGE_LOG_CONSOLE: 'false',
    AGENT_BRIDGE_HISTORY_INGEST: '0', AGENT_BRIDGE_AUTO_BACKUP: '0',
    AGENT_BRIDGE_DASHBOARD: 'false', AGENT_BRIDGE_AUTO_WAKE: 'false', AGENT_BRIDGE_WAKE_ON_DIRECT: 'false',
    AGENT_BRIDGE_DELIVERY: 'hooks', AGENT_BRIDGE_JOB_RUNNER: '0',
    AGENT_BRIDGE_CLAUDE_BIN: join(root, role, 'not-an-executable', 'claude.exe'),
    AGENT_BRIDGE_CODEX_BIN: join(root, role, 'not-an-executable', 'codex.exe'),
    AGENT_BRIDGE_OPENCODE_BIN: join(root, role, 'not-an-executable', 'opencode.exe'),
    AB277_FIXTURE_ROOT: root, AB277_FIXTURE_NONCE: nonce,
  };
  validateEnvironment(root, role, nonce, environment);
  return environment;
}

export function validateEnvironment(root, role, nonce, environment) {
  if (!within(root, environment.AGENT_BRIDGE_HOME) || environment.AGENT_BRIDGE_HOME !== join(root, role, 'home')) throw new Error('home mismatch');
  if (environment.AGENT_BRIDGE_PIPE !== `\\\\.\\pipe\\ab277-fixture-${nonce}-${role}`) throw new Error('pipe mismatch');
  if (environment.AGENT_BRIDGE_PLUGIN_RUNTIME_HOME !== environment.AGENT_BRIDGE_HOME) throw new Error('runtime home mismatch');
  if (Object.keys(environment).some(key => /TOKEN|SECRET|API_KEY|SESSION|PARENT|ROOT_JOB|DELEGATE|NODE_OPTIONS/.test(key))) throw new Error('linkage or credential environment refused');
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TMP', 'TEMP', 'CLAUDE_PROJECT_DIR']) {
    if (!within(root, environment[key])) throw new Error('profile path escaped fixture');
  }
  for (const key of ['AGENT_BRIDGE_HISTORY_INGEST', 'AGENT_BRIDGE_AUTO_BACKUP', 'AGENT_BRIDGE_JOB_RUNNER']) {
    if (environment[key] !== '0') throw new Error('background feature enabled');
  }
}

export function identityScripts(pids) {
  const ids = [...new Set(pids)];
  if (ids.length !== 2 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('invalid owned identities');
  const lists = [[ids[0]], [ids[1]], ids, [...ids].reverse()];
  return new Set([
    ...ids.map(id => `(Get-Process -Id ${id} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`),
    ...lists.flatMap(list => [
      `Get-Process -Id @(${list.join(',')}) -ErrorAction SilentlyContinue | ForEach-Object { try { [string]$_.Id + '|' + [string]$_.StartTime.ToUniversalTime().Ticks } catch {} }; exit 0`,
      `Get-Process -Id @(${list.join(',')}) -ErrorAction SilentlyContinue | ForEach-Object { $p = $_; try { [string]$p.Id + '|' + [string]$p.StartTime.ToUniversalTime().Ticks } catch { [string]$p.Id + '|' } }; exit 0`,
    ]),
  ]);
}

export function allowedIdentityCall(file, args, options, pids, powershell) {
  return (file === 'powershell.exe' || file === powershell)
    && Array.isArray(args) && args.length === 4
    && args[0] === '-NoProfile' && args[1] === '-NonInteractive' && args[2] === '-Command'
    && identityScripts(pids).has(args[3]) && !options?.shell;
}

export function installLaunchGuard({ pids, powershell, environment, originals = cp, count = {} }) {
  const rawExecFile = originals.execFile.bind(originals);
  const rawExecFileSync = originals.execFileSync.bind(originals);
  const reject = api => {
    count.denied = (count.denied ?? 0) + 1;
    count.deniedPerApi ??= {};
    count.deniedPerApi[api] = (count.deniedPerApi[api] ?? 0) + 1;
    throw Object.assign(new Error('fixture launch denied'), { code: 'AB277_LAUNCH_DENIED' });
  };
  const optionsFor = options => ({ encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, env: environment,
    ...(options?.stdio ? { stdio: ['ignore', 'pipe', 'ignore'] } : {}) });
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'fork']) cp[name] = () => reject(name);
  cp.execFile = (file, args, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (!allowedIdentityCall(file, args, options, pids, powershell)) return reject('execFile');
    count.allowed = (count.allowed ?? 0) + 1;
    return rawExecFile(powershell, args, optionsFor(options), callback);
  };
  cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) => {
    cp.execFile(file, args, options ?? {}, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  cp.execFileSync = (file, args, options) => {
    if (!allowedIdentityCall(file, args, options, pids, powershell)) return reject('execFileSync');
    count.allowed = (count.allowed ?? 0) + 1;
    return rawExecFileSync(powershell, args, optionsFor(options));
  };
  syncBuiltinESMExports();
}
