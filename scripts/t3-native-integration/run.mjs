// This entry point installs dependencies ONLY in an owned GitHub-hosted Linux
// scratch checkout. It is intentionally unusable as a local install helper.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sha256, treeHash, verifyFiles, validateReport, productionTest, mutations } from './gate.mjs';

const artifact = import.meta.dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(artifact, 'manifest.json'), 'utf8'));
verifyFiles(artifact, manifest.artifacts);
if (sha256(fs.readFileSync(path.resolve(artifact, '../../.github/workflows/t3-native-integration.yml'))) !== manifest.workflowSha256) {
  throw new Error('Workflow hash mismatch');
}
if (process.argv[2] === '--verify') {
  console.log(JSON.stringify({ verified: manifest.artifacts.length, patches: manifest.patchOrder,
    effectiveTreeSha256: manifest.effectiveTreeSha256 }));
} else {
  if (process.argv[2] !== '--hosted' || process.platform !== 'linux' || process.arch !== 'x64' ||
      process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !process.env.RUNNER_TEMP ||
      process.versions.node !== manifest.tools.node) {
    throw new Error('Only exact-Node GitHub-hosted Linux x64 runner may fetch/install/run this package');
  }
  await hosted();
}

async function hosted() {
  const runnerTemp = fs.realpathSync(process.env.RUNNER_TEMP);
  const scratch = fs.mkdtempSync(path.join(runnerTemp, 'ab458-'));
  const checkout = path.join(scratch, 't3'), tools = path.join(scratch, 'tools');
  const evidence = path.join(runnerTemp, 'ab458-evidence');
  // Never reuse evidence or a checkout from a preceding attempt.
  fs.mkdirSync(evidence); fs.mkdirSync(checkout); fs.mkdirSync(tools);
  const receipt = { schema: 1, runnerPid: process.pid, bridgeHead: process.env.AB458_BRIDGE_HEAD,
    t3Pin: manifest.upstream.commit, manifestSha256: sha256(fs.readFileSync(path.join(artifact, 'manifest.json'))),
    patchOrder: manifest.patchOrder, effectiveTreeSha256: manifest.effectiveTreeSha256,
    node: process.versions.node, platform: process.platform, arch: process.arch, steps: [], outcome: 'running' };
  const save = () => fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2)+'\n');
  save();
  // Child commands receive a small public environment. No Actions tokens,
  // ambient npm/git credentials or provider variables enter dependency scripts.
  const env = {
    PATH: `${tools}:${process.env.PATH}`, HOME: path.join(scratch, 'home'),
    CI: 'true', LANG: 'C.UTF-8', TMPDIR: path.join(scratch, 'tmp'),
    XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_CONFIG_HOME: path.join(scratch, 'config'),
    npm_config_userconfig: path.join(scratch, 'empty.npmrc'),
    npm_config_cache: path.join(scratch, 'npm-cache'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1',
  };
  for (const directory of [env.HOME, env.TMPDIR, env.XDG_CACHE_HOME, env.XDG_CONFIG_HOME]) fs.mkdirSync(directory);
  fs.writeFileSync(env.npm_config_userconfig, '');
  let sequence = 0;
  async function run(label, command, args, timeoutMs = 15_000, expected = 0, cwd = checkout) {
    const record = { label, command, args, cwd, timeoutMs, expected, pid: null, exit: null, signal: null, timedOut: false };
    receipt.steps.push(record); save();
    const prefix = `${String(++sequence).padStart(2, '0')}-${label}`;
    const stdoutFd = fs.openSync(path.join(evidence, prefix+'.stdout.log'), 'w');
    const stderrFd = fs.openSync(path.join(evidence, prefix+'.stderr.log'), 'w');
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', stdoutFd, stderrFd] });
        record.pid = child.pid ?? null; save();
        // The detached group belongs solely to this captured child. Never use a
        // name/path search to select termination targets.
        const killOwned = (signal) => { if (record.pid) { try { process.kill(-record.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
        const timer = setTimeout(() => { record.timedOut = true; killOwned('SIGKILL'); }, timeoutMs);
        child.once('error', (error) => { clearTimeout(timer); record.error = error.code ?? 'spawn-error'; save(); reject(error); });
        child.once('close', (exit, signal) => {
          clearTimeout(timer); record.exit = exit; record.signal = signal; save();
          // Owned grandchildren cannot outlive a completed command/group.
          killOwned('SIGKILL');
          if (record.timedOut || signal || exit !== expected) reject(new Error(`${label}: unexpected exit/timeout (see receipt)`));
          else resolve();
        });
      });
    } finally { fs.closeSync(stdoutFd); fs.closeSync(stderrFd); }
    return { stdout: fs.readFileSync(path.join(evidence, prefix+'.stdout.log'), 'utf8').trim(),
      stderr: fs.readFileSync(path.join(evidence, prefix+'.stderr.log'), 'utf8').trim(), record };
  }
  const pnpm = path.join(tools, 'pnpm');
  const checkTree = () => {
    verifyFiles(checkout, manifest.effectiveFiles);
    const actual = manifest.effectiveFiles.map((file) => ({ path: file.path, sha256: sha256(fs.readFileSync(path.join(checkout, file.path))) }));
    if (treeHash(actual) !== manifest.effectiveTreeSha256) throw new Error('Effective patched tree mismatch');
  };
  async function testRun(label, mutation) {
    const reportFile = path.join(evidence, label+'.json');
    const args = ['exec', 'vp', 'test', 'run', '--config', '.ab458-ci.vitest.config.ts',
      '--reporter=json', '--outputFile='+reportFile];
    if (mutation) args.push('apps/server/src/orchestration-v2/Adapters/CodexBridgeDynamicTools.adapter.test.ts', '-t', productionTest);
    const result = await run(label, pnpm, args, mutation ? 60_000 : 120_000, mutation ? 1 : 0);
    if (/unhandled (error|rejection|exception)|failed to (load|collect)|cannot (find|resolve)|syntaxerror|worker exited|Bridge owned connection disposal incomplete/i.test(result.stdout+'\n'+result.stderr)) {
      throw new Error(`${label}: infrastructure/unhandled failure, not mutation evidence`);
    }
    const proof = validateReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')),
      { expectedTest: productionTest, mutation: !!mutation, marker: mutation?.marker,
        requiredFiles: mutation ? [] : [
          'apps/server/src/orchestration-v2/Adapters/CodexBridgeDynamicTools.test.ts',
          'apps/server/src/orchestration-v2/Adapters/CodexBridgeDynamicTools.replay.test.ts',
          'apps/server/src/orchestration-v2/Adapters/CodexBridgeDynamicTools.adapter.test.ts',
          'packages/effect-codex-app-server/src/PrivateRequestAdmission.test.ts',
          'packages/effect-codex-app-server/src/PrivateProtocolLifecycle.test.ts',
          'packages/effect-codex-app-server/src/protocol.test.ts',
        ] });
    result.record.reportSha256 = sha256(fs.readFileSync(reportFile)); result.record.testProof = proof; save();
  }
  try {
    await run('git-init', 'git', ['init', '--quiet']);
    await run('fetch-official-pin', 'git', ['fetch', '--depth=1', manifest.upstream.repository, manifest.upstream.commit], 60_000);
    await run('checkout-pin', 'git', ['checkout', '--detach', '--quiet', 'FETCH_HEAD']);
    if ((await run('exact-head', 'git', ['rev-parse', 'HEAD'])).stdout !== manifest.upstream.commit ||
        (await run('clean-source', 'git', ['status', '--porcelain'])).stdout) throw new Error('Wrong/dirty upstream checkout');
    verifyFiles(checkout, manifest.sources);
    for (const name of manifest.patchOrder) {
      await run(`check-${name}`, 'git', ['apply', '--check', path.join(artifact, name)]);
      await run(`apply-${name}`, 'git', ['apply', path.join(artifact, name)]);
    }
    checkTree();
    await run('effective-diff', 'git', ['diff', '--no-ext-diff', '--stat']);
    // Download the exact public pnpm Linux binary archive; no bootstrap lifecycle
    // scripts, global npm install, package-manager auto-upgrade or PATH write.
    const response = await fetch(manifest.tools.pnpmArchive.url, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
    if (!response.ok) throw new Error('Public pinned pnpm archive unavailable');
    const archive = Buffer.from(await response.arrayBuffer());
    if ('sha512-'+createHash('sha512').update(archive).digest('base64') !== manifest.tools.pnpmArchive.integrity) throw new Error('pnpm archive integrity mismatch');
    fs.writeFileSync(path.join(scratch, 'pnpm.tgz'), archive);
    receipt.pnpmArchiveSha256 = sha256(archive); save();
    await run('extract-pnpm', 'tar', ['-xzf', path.join(scratch, 'pnpm.tgz'), '--strip-components=1', '-C', tools]);
    fs.chmodSync(pnpm, 0o755);
    if ((await run('pnpm-version', pnpm, ['--version'])).stdout !== manifest.tools.pnpm) throw new Error('pnpm version mismatch');
    receipt.pnpmBinarySha256 = sha256(fs.readFileSync(pnpm)); save();
    await run('install-lockfile', pnpm, ['--filter', '@t3tools/monorepo', '--filter', 't3...', '--filter', 'effect-codex-app-server...',
      'install', '--frozen-lockfile', '--store-dir', path.join(scratch, 'store')], 600_000);
    // Upstream prepare runs normally, including effect-tsgo patch/vp config.
    // No ignore-scripts fallback or undeclared native/system dependencies.
    verifyFiles(checkout, manifest.sources.filter((source) => /(^package.json$|pnpm-lock.yaml$|pnpm-workspace.yaml$)/.test(source.path)));
    checkTree();
    for (const [name, relative, version] of manifest.installedPackages) {
      const file = path.join(checkout, relative, 'node_modules', name, 'package.json');
      if (JSON.parse(fs.readFileSync(file, 'utf8')).version !== version) throw new Error(`Installed version mismatch: ${name}`);
    }
    fs.copyFileSync(path.join(artifact, 'ci.vitest.config.ts'), path.join(checkout, '.ab458-ci.vitest.config.ts'));
    fs.copyFileSync(path.join(artifact, 'ci.typecheck.json'), path.join(checkout, '.ab458-ci.typecheck.json'));
    await run('compiler-version', pnpm, ['exec', 'tsc-rs', '--version']);
    await run('test-tool-version', pnpm, ['exec', 'vp', '--version']);
    await run('pinned-typecheck', pnpm, ['exec', 'tsc-rs', '--noEmit', '-p', '.ab458-ci.typecheck.json'], 180_000);
    await testRun('baseline');
    for (const mutation of mutations()) {
      checkTree();
      const target = path.join(checkout, mutation.path), original = fs.readFileSync(target);
      const changed = mutation.change(original.toString('utf8'));
      const proof = { name: mutation.name, path: mutation.path, baseTreeSha256: manifest.effectiveTreeSha256,
        originalSha256: sha256(original), mutationSha256: sha256(changed), expectedTest: productionTest, marker: mutation.marker };
      fs.writeFileSync(path.join(evidence, mutation.name+'-source.json'), JSON.stringify(proof, null, 2)+'\n');
      try { fs.writeFileSync(target, changed); await testRun('mutation-'+mutation.name, mutation); }
      finally { fs.writeFileSync(target, original); checkTree(); receipt.restoredTreeSha256 = manifest.effectiveTreeSha256; save(); }
    }
    receipt.outcome = 'passed-hosted-mocked-integration';
  } catch (error) {
    receipt.outcome = 'failed-or-inconclusive'; receipt.failure = error.message; throw error;
  } finally {
    // Exact hashes and exit evidence only; never upload the checkout, HOME,
    // node_modules, caches, app records, or any configuration/credentials.
    receipt.finished = true; save();
    const hashes = fs.readdirSync(evidence).filter((name) => name !== 'evidence-hashes.json').map((name) =>
      ({ path: name, sha256: sha256(fs.readFileSync(path.join(evidence, name))) }));
    fs.writeFileSync(path.join(evidence, 'evidence-hashes.json'), JSON.stringify(hashes, null, 2)+'\n');
  }
}
