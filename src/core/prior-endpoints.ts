import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { posix, resolve } from 'node:path';
import { APP_NAME, CONNECT_TIMEOUT_MS, WINDOWS_PIPE_PREFIX } from './constants.js';
import { maxSocketPathBytes, shortSocketDirectory, resolvePipePath } from './paths.js';
import { physicalPath } from './project-identity.js';
import { BridgeError } from './protocol.js';
import { assertCompatibleMailboxReadersAsync, withMailboxReaderAdmission } from './storage-lock.js';
import { ownProcessIdentity } from './process-identity.js';
import type { StartupBudget } from './startup-budget.js';
import type { Logger } from './logger.js';
import type { MessageStore } from './store.js';

/** Exact historical home-derived names only. No directory/network scanning. */
export function priorEndpoints(home: string, platform: NodeJS.Platform = process.platform, uid = process.getuid?.()): string[] {
  const homes = new Set([resolve(home),physicalPath(resolve(home))]);
  if (platform==='win32') for (const path of [...homes]) if (/^[de]:/i.test(path)) {
    homes.add(path.replace(/^[de]:/i,'E:'));
    homes.add(path.replace(/^[de]:/i,String.fromCharCode(68)+':'));
  }
  const endpoints = new Set<string>();
  for (const path of homes) for (const protocol of [undefined,2,3,4,5,6,7,8,9,10,11]) {
    const suffix = protocol===undefined ? '' : `-p${protocol}`;
    if (platform==='win32') endpoints.add(`${WINDOWS_PIPE_PREFIX}${APP_NAME}-${createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0,12)}${suffix}`);
    else {
      const name = `bridge${suffix}.sock`, local = posix.join(path,name);
      if (Buffer.byteLength(local)<=maxSocketPathBytes(platform)) endpoints.add(local);
      endpoints.add(posix.join(shortSocketDirectory(uid),`${createHash('sha256').update(path).digest('hex').slice(0,16)}-${name}`));
    }
  }
  return [...endpoints];
}

/** A two-second aggregate connection observation, never an initializer lifetime
 * or a proof that a previously returned old SQLite handle has been revoked. */
export async function guardPriorEndpoints(home: string, current: string, budget: StartupBudget, includeCurrent = false): Promise<void> {
  const deadline = Date.now()+Math.min(CONNECT_TIMEOUT_MS,budget.remaining());
  for (const endpoint of new Set([...priorEndpoints(home),...(includeCurrent ? [resolvePipePath(home,{})] : [])])) {
    budget.remaining();
    if (endpoint===current) continue;
    const left = Math.min(300,deadline-Date.now(),budget.remaining());
    if (left<=0) throw new BridgeError('timeout','Prior endpoint observation expired; no initializer admitted');
    await new Promise<void>((accept,reject)=> {
      let settled = false;
      const socket = connect(endpoint);
      const done = (error?:unknown) => {
        if (settled) return; settled=true; clearTimeout(timer); budget.signal.removeEventListener('abort',abort); socket.destroy();
        if (error) reject(error); else accept();
      };
      const abort = () => done(budget.signal.reason);
      const timer = setTimeout(()=>done(new BridgeError('protocol_mismatch','Prior endpoint is unresponsive; coordinated shutdown required')),left);
      socket.once('connect',()=>done(new BridgeError('protocol_mismatch','Prior endpoint active; no token, handover or mailbox operation submitted')));
      socket.once('error',error=>done(['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code??'') ? undefined : error));
      budget.signal.addEventListener('abort',abort,{once:true}); if (budget.signal.aborted) abort();
    });
  }
  budget.remaining();
}

/** A fresh endpoint/census check is adjacent to the synchronous effect. Common
 * migration exclusion and reader leases remain owned by the ordinary opener. */
export async function withOrdinaryAdmission<T>(home: string,current:string,budget:StartupBudget,effect:()=>T): Promise<T> {
  budget.remaining();
  const proof = await budget.wait(assertCompatibleMailboxReadersAsync(home,budget.signal,()=>budget.remaining()));
  await budget.wait(guardPriorEndpoints(home,current,budget));
  return withMailboxReaderAdmission(proof,()=> {proof.assert(home);budget.remaining();return effect();});
}
export async function openAdmittedMessageStore(file:string,home:string,current:string,log:Logger,budget:StartupBudget): Promise<MessageStore> {
  if (file!==':memory:' && !await budget.wait(ownProcessIdentity(budget.signal,()=>budget.remaining()))) throw new BridgeError('internal','Own process identity unknown; no storage initialized');
  const {openMessageStore} = await import('./store.js');
  budget.remaining();
  if (file===':memory:') return openMessageStore(file,log,()=>budget.remaining());
  return withOrdinaryAdmission(home,current,budget,()=>openMessageStore(file,log,()=>budget.remaining()));
}
