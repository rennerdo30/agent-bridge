import { installLaunchGuard, validateEnvironment, ROLES } from './isolation.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = process.env.AB277_FIXTURE_ROOT;
const nonce = process.env.AB277_FIXTURE_NONCE;
const role = process.env.AGENT_BRIDGE_AGENT;
if (process.platform !== 'win32' || !root || !nonce || !ROLES.includes(role) || typeof process.send !== 'function') throw new Error('fixture preload requires owned Windows IPC child');
validateEnvironment(root, role, nonce, process.env);
if (homedir() !== process.env.USERPROFILE || process.cwd() !== process.env.CLAUDE_PROJECT_DIR) throw new Error('fixture OS home or cwd mismatch');
const launches = {};
installLaunchGuard({ pids: [process.pid, process.ppid], powershell: join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), environment: process.env, count: launches });

process.on('message', async message => {
  if (message?.nonce !== nonce || !Number.isSafeInteger(message.id)) return;
  if (message.kind === 'sample') {
    const { rss, heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
    process.send({ type: 'ab277-sample', id: message.id, pid: process.pid, ppid: process.ppid, uptime: process.uptime(), rss, heapUsed, heapTotal, external, arrayBuffers, launches: { ...launches } });
  } else if (message.kind === 'inventory') {
    // Attach only after the final memory sample. No inspector port, source retrieval or profiling.
    const { Session } = await import('node:inspector');
    const session = new Session();
    const urls = new Set();
    session.on('Debugger.scriptParsed', ({ params }) => { if (params.url.startsWith('file:')) urls.add(params.url); });
    session.connect();
    try {
      await new Promise((resolve, reject) => session.post('Debugger.enable', {}, error => error ? reject(error) : resolve()));
      process.send({ type: 'ab277-inventory', id: message.id, urls: [...urls] });
    } finally { session.disconnect(); }
  } else if (message.kind === 'guard-state') {
    process.send({ type: 'ab277-guard-state', id: message.id, installed: true, allowedCreationQueries: launches.allowed ?? 0,
      deniedCalls: launches.denied ?? 0, deniedPerApi: { ...launches.deniedPerApi }, deniedCategory: 'launch_not_allowlisted' });
  }
});
process.channel.unref();
