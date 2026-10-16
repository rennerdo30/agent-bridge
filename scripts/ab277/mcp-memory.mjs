import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BASE, IDLE_MS, ROLES, childEnvironment, fixtureConfig, fixtureRoot, unlinked, within } from './isolation.mjs';

const WORKTREE = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRELOAD = join(WORKTREE, 'scripts/ab277/fixture-preload.mjs');
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const save = (path, data) => { unlinked(path); writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' }); };
const pause = ms => new Promise(resolve_ => setTimeout(resolve_, ms));

function label(path, dependencies) {
  if (within(WORKTREE, path)) return relative(WORKTREE, path).replaceAll('\\', '/');
  if (within(dependencies, path)) return `dependency/${relative(dependencies, path).replaceAll('\\', '/')}`;
  throw new Error('unapproved build input');
}

async function prepare() {
  if (process.platform !== 'win32') throw new Error('Windows-only reviewed fixture');
  const dependencies = resolve(option('--dependencies') ?? '');
  if (basename(dependencies) !== 'node_modules' || !existsSync(join(dependencies, 'esbuild'))) throw new Error('explicit existing dependency cache required');
  const nonce = randomUUID();
  const purpose = option('--purpose') ?? 'measurement';
  if (!['measurement', 'startup-diagnostic'].includes(purpose)) throw new Error('fixture purpose invalid');
  const root = fixtureRoot(WORKTREE, join(WORKTREE, '.agent-bridge-test/ab277-memory', nonce));
  mkdirSync(root, { recursive: false });
  const bundle = join(root, 'bundle');
  const entries = { server: 'src/mcp/launcher.ts', worker: 'src/mcp/main.ts', cli: 'src/cli/main.ts', 'history-worker': 'src/core/history-worker.ts', 'backup-worker': 'src/core/backup-worker.ts', 'outcome-worker': 'src/core/outcome-worker.ts', 'job-archive-worker': 'src/core/job-archive-worker.ts' };
  const { build } = createRequire(join(dependencies, 'esbuild/package.json'))('esbuild');
  const built = await build({ absWorkingDir: WORKTREE, preserveSymlinks: true, nodePaths: [dependencies], entryPoints: entries,
    outdir: bundle, outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]', splitting: true,
    bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['node:*'], legalComments: 'eof', logLevel: 'warning', metafile: true,
    banner: { js: "import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);" } });
  const sourceGraph = Object.entries(built.metafile.inputs).map(([path, input]) => ({ module: label(resolve(WORKTREE, path), dependencies), bytes: input.bytes,
    imports: input.imports.map(item => ({ module: item.external ? item.path : label(resolve(WORKTREE, item.path), dependencies), kind: item.kind, external: Boolean(item.external) })) }));
  const outputs = Object.entries(built.metafile.outputs).map(([path, output]) => {
    const absolute = resolve(WORKTREE, path);
    if (!within(bundle, absolute)) throw new Error('build output escaped fixture');
    return { file: relative(root, absolute).replaceAll('\\', '/'), bytes: output.bytes, sha256: digest(absolute),
      sources: Object.entries(output.inputs).map(([input, contribution]) => ({ module: label(resolve(WORKTREE, input), dependencies), bytesInOutput: contribution.bytesInOutput })) };
  });
  save(join(root, 'module-graph.json'), { baseline: BASE, inputs: sourceGraph, outputs });
  const probe = join(root, 'guard-probe.mjs');
  await build({ absWorkingDir: WORKTREE, stdin: { contents: "export { readProcessIdentity, readProcessIdentities, readProcessIdentitiesSync } from './src/core/process-identity.ts'; export { inspectClaudeLaunch } from './src/core/procinfo.ts';", resolveDir: WORKTREE },
    outfile: probe, bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['node:*'], logLevel: 'warning' });
  const environments = {};
  for (const role of ROLES) {
    const env = childEnvironment(root, role, nonce, process.env.SystemRoot ?? 'C:\\Windows');
    environments[role] = env;
    for (const path of ['AGENT_BRIDGE_HOME', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TEMP', 'CLAUDE_PROJECT_DIR'].map(key => env[key])) mkdirSync(path, { recursive: true });
    mkdirSync(join(env.CLAUDE_PROJECT_DIR, '.git'));
    save(join(env.AGENT_BRIDGE_HOME, 'config.json'), fixtureConfig(role));
  }
  save(join(root, 'prepared.json'), { schema: 1, baseline: BASE, nonce, root, purpose, nodeVersion: process.version, node: process.execPath, idleMs: IDLE_MS, environments,
    outputs, preloadSha256: digest(PRELOAD), guardSha256: digest(join(WORKTREE, 'scripts/ab277/isolation.mjs')), controllerSha256: digest(fileURLToPath(import.meta.url)),
    probe: relative(root, probe), configSha256: Object.fromEntries(ROLES.map(role => [role, digest(join(root, role, 'home/config.json'))])) });
  checkPrepared(root);
  console.log(JSON.stringify({ prepared: true, fixtureRoot: root, baseline: BASE, nodeVersion: process.version, roleCount: ROLES.length, graphInputs: sourceGraph.length, outputs: outputs.length, mcpStarted: false }));
}

function checkPrepared(root) {
  const data = json(join(root, 'prepared.json'));
  unlinked(root);
  if (data.root !== root || data.baseline !== BASE || data.idleMs !== IDLE_MS || data.node !== process.execPath) throw new Error('prepared runtime mismatch');
  if (data.preloadSha256 !== digest(PRELOAD) || data.guardSha256 !== digest(join(WORKTREE, 'scripts/ab277/isolation.mjs')) || data.controllerSha256 !== digest(fileURLToPath(import.meta.url))) throw new Error('instrumentation changed since prepare');
  for (const role of ROLES) {
    const expected = childEnvironment(root, role, data.nonce, process.env.SystemRoot ?? 'C:\\Windows');
    if (JSON.stringify(expected) !== JSON.stringify(data.environments[role])) throw new Error('environment changed since prepare');
    for (const path of Object.values(expected).filter(value => typeof value === 'string' && within(root, value))) unlinked(path);
    unlinked(join(root, role, 'home/config.json'));
    if (data.configSha256[role] !== digest(join(root, role, 'home/config.json'))) throw new Error('config changed since prepare');
    if (existsSync(join(root, role, 'home/plugin-versions'))) throw new Error('unexpected fixture runtime selector');
  }
  for (const output of data.outputs) {
    const path = resolve(root, output.file);
    if (!within(join(root, 'bundle'), path) || digest(path) !== output.sha256) throw new Error('bundle identity mismatch');
    unlinked(path);
  }
  return data;
}

async function fixturePing(pipe) {
  return new Promise((resolve_, reject) => {
    const socket = createConnection(pipe);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('fixture ping timeout')); }, 1000);
    let buffer = '';
    socket.on('connect', () => socket.write(JSON.stringify({ t: 'req', id: 1, op: 'ping', args: {} }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      clearTimeout(timer); socket.destroy();
      try { const response = JSON.parse(buffer.split('\n')[0]); if (response.ok) resolve_(response.result); else reject(new Error('fixture ping rejected')); }
      catch { reject(new Error('fixture ping malformed')); }
    });
    socket.on('error', () => { clearTimeout(timer); reject(new Error('fixture endpoint not ready')); });
  });
}

function sanitizedFailure(stderr, data) {
  const text = stderr.toString('utf8');
  const messages = ['fixture preload requires owned Windows IPC child', 'fixture OS home or cwd mismatch', 'home mismatch', 'pipe mismatch', 'runtime home mismatch',
    'linkage or credential environment refused', 'profile path escaped fixture', 'background feature enabled', 'fixture launch denied'];
  const tags = ['owned_ipc_unavailable', 'os_home_or_cwd_mismatch', 'home_mismatch', 'pipe_mismatch', 'runtime_home_mismatch', 'unsafe_linkage_environment', 'profile_path_escape', 'background_enabled', 'launch_denied'];
  const constructors = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError'];
  const codes = ['AB277_LAUNCH_DENIED', 'ERR_MODULE_NOT_FOUND', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_STATE', 'ERR_IPC_CHANNEL_CLOSED', 'ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE',
    'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_UNSUPPORTED_DIR_IMPORT', 'ENOENT', 'EPERM', 'EACCES', 'EADDRINUSE', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTDIR', 'EEXIST'];
  const syscalls = ['spawn', 'open', 'connect', 'read', 'write', 'stat', 'lstat', 'mkdir', 'rename', 'unlink'];
  const lines = text.split(/\r?\n/);
  const known = messages.find(message => lines.some(line => line === `Error: ${message}`));
  const constructor = constructors.find(name => lines.some(line => line.startsWith(`${name}:`) || codes.some(code => line.startsWith(`${name} [${code}]:`)))) ?? 'unknown';
  const code = codes.find(value => lines.some(line => constructors.some(name => line.startsWith(`${name} [${value}]:`)) || line.trim() === `code: '${value}',` || line.trim() === `code: '${value}'`)) ?? 'unknown';
  const syscall = syscalls.find(value => lines.some(line => line.trim() === `syscall: '${value}',` || line.trim() === `syscall: '${value}'`)) ?? 'unknown';
  const frames = [];
  const files = ['fixture-preload.mjs', 'isolation.mjs', ...data.outputs.map(output => basename(output.file))];
  for (const line of lines.filter(value => /^\s+at /.test(value))) {
    if (frames.length === 3) break;
    for (const file of files) {
      const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(line);
      if (match) { frames.push({ source: file, line: Number(match[1]), column: Number(match[2]) }); break; }
    }
  }
  return { category: known ? 'reviewed_fixture_error' : 'unclassified_fixture_startup_failure',
    ...(known ? { reviewedErrorTag: tags[messages.indexOf(known)] } : {}), constructor, code, syscall, stackSourceLabels: frames };
}

function startFixture(role, data, captureFailure = false) {
  const child = spawn(process.execPath, ['--import', PRELOAD, join(data.root, 'bundle/server.mjs'), `--agent=${role}`], {
    cwd: join(data.root, role, 'project'), env: data.environments[role], windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], shell: false,
  });
  const rpc = new Map(); const ipc = new Map(); let nextId = 1; let buffer = ''; let stderrBytes = 0;
  let captured = Buffer.alloc(0); let lifecycleError = null;
  child.stdin.on('error', () => {});
  save(join(data.root, `${role}-spawned.json`), { role, pid: child.pid ?? null, ppid: process.pid, spawnedAt: new Date().toISOString() });
  const failPending = reason => {
    lifecycleError = reason;
    for (const map of [rpc, ipc]) { for (const pending of map.values()) pending.reject(new Error(reason)); map.clear(); }
  };
  let exit = null;
  const exited = new Promise(resolve_ => {
    child.on('exit', (code, signal) => { exit = { code, signal }; failPending('fixture child exited before request completion'); });
    child.on('error', () => { failPending('fixture child spawn error'); exit = { code: null, signal: null, spawnError: true }; });
    child.on('close', () => resolve_(exit ?? { code: null, signal: null, closeWithoutExit: true }));
  });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (captureFailure && captured.length < 65536) captured = Buffer.concat([captured, chunk.subarray(0, 65536 - captured.length)]);
  });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) { buffer = ''; failPending('fixture RPC frame too large'); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { const frame = JSON.parse(line); if (rpc.has(frame.id)) { rpc.get(frame.id).resolve(frame); rpc.delete(frame.id); } }
      catch { /* Do not retain raw response or stderr content. */ }
    }
  });
  child.on('message', frame => { if (ipc.has(frame.id)) { ipc.get(frame.id).resolve(frame); ipc.delete(frame.id); } });
  function wait(map, id, send) {
    return new Promise((resolve_, reject) => {
      if (lifecycleError) { reject(new Error(lifecycleError)); return; }
      const timer = setTimeout(() => { map.delete(id); reject(new Error('fixture request timeout')); }, 30_000);
      map.set(id, { resolve: frame => { clearTimeout(timer); resolve_(frame); }, reject: error => { clearTimeout(timer); reject(error); } });
      try { send(); } catch { clearTimeout(timer); map.delete(id); reject(new Error('fixture request channel closed')); }
    });
  }
  return { role, child,
    failed: () => lifecycleError,
    failure: () => ({ ...sanitizedFailure(captured, data), stderrBytes, capturedBytes: captured.length, truncated: stderrBytes > captured.length }),
    request: (method, params) => { const id = nextId++; return wait(rpc, id, () => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')); },
    initialized: () => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'),
    telemetry: kind => { const id = nextId++; return wait(ipc, id, () => child.send({ id, kind, nonce: data.nonce })); },
    async close() {
      child.stdin.end();
      const outcome = await Promise.race([exited, pause(15_000).then(() => null)]);
      if (!outcome) { child.unref(); return { exited: false, pid: child.pid, actionRequired: 'owned fixture EOF shutdown timed out; no kill attempted', stderrBytes }; }
      return { exited: true, pid: child.pid ?? null, ...exit, stderrBytes };
    },
  };
}

async function run() {
  const root = fixtureRoot(WORKTREE, option('--fixture-root') ?? '');
  const data = checkPrepared(root);
  if (data.purpose !== 'measurement') throw new Error('fixture purpose mismatch');
  save(join(root, 'run-started.json'), { at: new Date().toISOString(), baseline: BASE });
  const fixtures = [];
  const results = [];
  const abort = new AbortController();
  let tasks = [];
  try {
    for (const role of ROLES) fixtures.push(startFixture(role, data));
    tasks = fixtures.map(async fixture => {
      const result = { role: fixture.role, samples: [], tool: { name: 'health', calls: 0 } };
      results.push(result);
      const initialized = await fixture.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ab277-owned-fixture', version: '1' } });
      if (initialized.error) throw new Error('fixture initialize failed');
      fixture.initialized();
      let ready = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        const ping = await fixturePing(data.environments[fixture.role].AGENT_BRIDGE_PIPE).catch(() => null);
        if (ping?.brokerPid === fixture.child.pid) { ready = true; break; }
        if (ping && ping.brokerPid !== fixture.child.pid) throw new Error('foreign fixture broker identity');
        await pause(250);
      }
      if (!ready) throw new Error('owned fixture broker not ready');
      const tools = await fixture.request('tools/list', {});
      if (!tools.result?.tools?.some(tool => tool.name === 'health')) throw new Error('health missing from fixture tool inventory');
      result.samples.push({ phase: 'startup_ready', ...(await fixture.telemetry('sample')) });
      result.tool.calls++;
      const response = await fixture.request('tools/call', { name: 'health', arguments: {} });
      let health;
      try { health = JSON.parse(response.result?.content?.find(item => item.type === 'text')?.text ?? 'null'); } catch { health = null; }
      result.tool.success = !response.error && !response.result?.isError && Boolean(health);
      if (!result.tool.success) throw new Error('safe health tool failed');
      result.samples.push({ phase: 'after_health', ...(await fixture.telemetry('sample')) });
      save(join(root, `${fixture.role}-early.json`), result);
      console.log(JSON.stringify({ role: fixture.role, phase: 'after_health', toolSuccess: true, pid: fixture.child.pid }));
      const idleStarted = performance.now();
      await delay(IDLE_MS, undefined, { signal: abort.signal });
      result.samples.push({ phase: 'idle_10min', idleElapsedMs: performance.now() - idleStarted, ...(await fixture.telemetry('sample')) });
      const inventory = await fixture.telemetry('inventory');
      const approved = new Map(data.outputs.map(output => [resolve(root, output.file).toLowerCase(), output]));
      const loadedBundles = new Map(); let omittedFileScripts = 0;
      for (const url of inventory.urls) {
        let path; try { path = fileURLToPath(url); } catch { omittedFileScripts++; continue; }
        const output = approved.get(resolve(path).toLowerCase());
        if (!output || !within(join(root, 'bundle'), path)) { omittedFileScripts++; continue; }
        loadedBundles.set(output.file, { ...output, observedBytes: statSync(path).size });
      }
      result.loadedBundles = [...loadedBundles.values()];
      result.omittedFileScripts = omittedFileScripts;
      result.inventoryMeaning = 'Parsed fixture bundle/chunk files after final memory sample; source byte contributions are build attribution, not retained heap or per-source evaluation proof.';
      save(join(root, `${fixture.role}-result.json`), result);
      console.log(JSON.stringify({ role: fixture.role, phase: 'idle_10min', loadedBundles: result.loadedBundles.length }));
    });
    await Promise.all(tasks);
  } catch (error) {
    abort.abort();
    await Promise.allSettled(tasks);
    throw error;
  } finally {
    const shutdown = await Promise.all(fixtures.map(async fixture => ({ role: fixture.role, ...(await fixture.close()) })));
    save(join(root, 'summary.json'), { baseline: BASE, nodeVersion: process.version, results, shutdown,
      limitations: ['one concurrent fixture per role, all own elected broker', 'preload/launch guard overhead included', 'history ingestion/dashboard/network/backup disabled', 'unknown Claude native launch, no real agent CLI', 'full production-style build graph is not the set of loaded modules', 'inspector enabled only after all memory samples', 'RSS is not private committed memory; source bytes are not heap attribution', 'no GC forced; ten-minute roles may contend'] });
  }
}

async function diagnostic() {
  const root = fixtureRoot(WORKTREE, option('--fixture-root') ?? '');
  const data = checkPrepared(root);
  if (data.purpose !== 'startup-diagnostic') throw new Error('fixture purpose mismatch');
  save(join(root, 'run-started.json'), { purpose: data.purpose, at: new Date().toISOString(), baseline: BASE, hashChecksPassed: true });
  const fixtures = [];
  let results = [];
  try {
    for (const role of ROLES) fixtures.push(startFixture(role, data, true));
    results = await Promise.all(fixtures.map(async fixture => {
      const result = { role: fixture.role, pid: fixture.child.pid ?? null, initialize: false, ready: false, healthCalls: 0,
        guardState: { installed: 'unknown', reason: 'not observed before early failure' } };
      try {
        const initialized = await fixture.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ab277-startup-diagnostic', version: '1' } });
        if (initialized.error) throw new Error('fixture initialize rejected');
        result.initialize = true;
        fixture.initialized();
        result.guardState = await fixture.telemetry('guard-state');
        const deadline = performance.now() + 30_000;
        while (performance.now() < deadline && !fixture.failed()) {
          const ping = await fixturePing(data.environments[fixture.role].AGENT_BRIDGE_PIPE).catch(() => null);
          if (ping?.brokerPid === fixture.child.pid) { result.ready = true; break; }
          if (ping && ping.brokerPid !== fixture.child.pid) throw new Error('fixture broker identity mismatch');
          await pause(250);
        }
        if (!result.ready) throw new Error('fixture diagnostic readiness failed');
      } catch (error) { result.controllerCategory = error.message; }
      return result;
    }));
  } finally {
    const shutdown = await Promise.all(fixtures.map(async fixture => ({ role: fixture.role, ...(await fixture.close()) })));
    results = results.map(result => ({ ...result, failure: fixtures.find(fixture => fixture.role === result.role).failure() }));
    save(join(root, 'diagnostic-summary.json'), { purpose: data.purpose, baseline: BASE, nodeVersion: process.version, hashChecksPassedAtStart: true, results, shutdown });
    console.log(JSON.stringify({ diagnostic: true, results, shutdown }));
    if (results.some(result => !result.ready) || shutdown.some(result => !result.exited || result.code !== 0)) process.exitCode = 1;
  }
}

try {
  if (args.includes('--prepare')) {
    const namespace = join(WORKTREE, '.agent-bridge-test/ab277-memory');
    unlinked(namespace);
    mkdirSync(namespace, { recursive: true });
    await prepare();
  } else if (args.includes('--run')) await run();
  else if (args.includes('--diagnostic-startup')) await diagnostic();
  else throw new Error('choose --prepare or --run explicitly');
} catch (error) {
  console.error(JSON.stringify({ failed: true, reason: ['fixture', 'prepared', 'owned', 'safe', 'health', 'instrumentation', 'config', 'bundle', 'environment', 'Windows', 'explicit', 'unapproved'].some(prefix => error.message.startsWith(prefix)) ? error.message : 'measurement harness failure; inspect source/isolated non-content state' }));
  process.exitCode = 1;
}
