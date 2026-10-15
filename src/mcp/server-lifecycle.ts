import { readProcessIdentity } from "../core/process-identity.js";

/**
 * AB-385: how a stdio MCP server ends when its session no longer uses it. Claude Code's /reload-plugins and plugin
 * updates start a new server without closing the old one's stdin, so stdin "end" alone never retires it.
 */

/** Budget of one ordinary shutdown step (closing delegates, the MCP transport, local endpoints). */
export const SHUTDOWN_STEP_MS = 3_000;
/** The bridge node gets its own, longer budget: a hosted broker closes its store and releases its locks. */
export const NODE_STOP_MS = 8_000;
/** Backstop over the whole shutdown (each step is bounded; this also covers a step that blocks synchronously). */
export const SHUTDOWN_DEADLINE_MS = 3 * SHUTDOWN_STEP_MS + NODE_STOP_MS + 1_000;
/** Cheap parent check (signal 0 and the current parent PID); no process is spawned. */
export const PARENT_CHECK_MS = 5_000;
/** The parent's creation identity is re-read this often, so a reused PID is not mistaken for the parent. */
export const PARENT_IDENTITY_CHECK_MS = 10 * 60_000;

/** Semver 2.0 pre-release precedence: numeric identifiers compare numerically and sort before alphanumeric ones. */
function comparePrerelease(a: string, b: string): number {
  const x = a.split("."), y = b.split(".");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i]!, q = y[i]!;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { const d = Number(p) - Number(q); if (d) return Math.sign(d); continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return Math.sign(x.length - y.length);
}

/** Numeric dotted versions ("0.30.21"); a pre-release sorts before its release (semver order). Unparseable: null. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => {
    const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
    return m ? { nums: m[1]!.split(".").map(Number), pre: m[2] ?? null } : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return comparePrerelease(x.pre, y.pre);
}

/** What the broker reports about the server that replaced this one (see the "replaced" event). */
export interface Replacement {
  version?: string;
  agentPid?: number | null;
  agentStartedAt?: string | null;
}
/** This server's own host process: its parent PID and that parent's creation identity. */
export interface OwnHost {
  version: string;
  ppid: number;
  parentIdentity: string | null;
}

/**
 * Yield (exit) only when the replacement is a strictly newer agent-bridge version started by the very same host
 * process (same parent PID and creation identity): then the host started the newer plugin and will never call this
 * server again. Another host process resuming the same session (a second terminal) never makes a server exit.
 * A same-version or older replacement keeps the reclaim path, and any unknown field (an older broker that does not
 * report it, an unreadable identity) changes nothing.
 */
export function shouldYieldTo(replacement: Replacement | undefined, own: OwnHost): boolean {
  if (!replacement?.version || compareVersions(replacement.version, own.version) !== 1) return false;
  if (!own.parentIdentity || !replacement.agentStartedAt || !Number.isSafeInteger(replacement.agentPid)) return false;
  return replacement.agentPid === own.ppid && replacement.agentStartedAt === own.parentIdentity;
}

export interface ShutdownStep {
  name: string;
  run: () => unknown;
  budgetMs?: number;
}

/**
 * Run shutdown steps in order, each bounded by its budget: a step that never settles is logged by name and left
 * behind, so the steps after it (above all the bridge node and a hosted broker) still run.
 */
export async function runShutdownSteps(steps: ShutdownStep[], opts: { onStep?: (name: string) => void; onTimeout?: (name: string, budgetMs: number) => void } = {}): Promise<void> {
  for (const step of steps) {
    opts.onStep?.(step.name);
    const budgetMs = step.budgetMs ?? SHUTDOWN_STEP_MS;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = Symbol("timeout");
    const outcome = await Promise.race([
      Promise.resolve().then(step.run).catch(() => undefined),
      new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), budgetMs); timer.unref(); }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === timedOut) opts.onTimeout?.(step.name, budgetMs);
  }
}

export interface ParentWatchOptions {
  /** The parent PID observed at start. */
  ppid: number;
  /** The parent's creation identity at start, or null when it could not be read (then only absence counts). */
  identity: Promise<string | null>;
  onGone: (reason: string) => void;
  checkMs?: number;
  identityCheckMs?: number;
  /** Test seams. */
  currentPpid?: () => number;
  alive?: (pid: number) => boolean | undefined;
  readIdentity?: (pid: number) => Promise<string | null>;
}

/** Signal 0: false only for a PID that does not exist, undefined when it cannot be told (EPERM). */
function pidExists(pid: number): boolean | undefined {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
}

/**
 * Backstop for a host that ends without closing our stdin: exit once the parent process is provably gone. The
 * parent is identified by PID plus creation identity, never by name. Unknown answers never count as gone.
 */
export function watchParent(opts: ParentWatchOptions): () => void {
  const checkMs = opts.checkMs ?? PARENT_CHECK_MS;
  const identityEvery = Math.max(1, Math.round((opts.identityCheckMs ?? PARENT_IDENTITY_CHECK_MS) / checkMs));
  const currentPpid = opts.currentPpid ?? (() => process.ppid);
  const alive = opts.alive ?? pidExists;
  const readIdentity = opts.readIdentity ?? ((pid: number) => readProcessIdentity(pid));
  let ticks = 0, busy = false, done = false;
  const gone = (reason: string) => { if (done) return; done = true; clearInterval(timer); opts.onGone(reason); };
  const timer = setInterval(() => {
    if (done || busy || !Number.isSafeInteger(opts.ppid) || opts.ppid <= 1) return;
    // POSIX re-parents an orphan (to init or a subreaper): the original parent has ended.
    if (process.platform !== "win32" && currentPpid() !== opts.ppid) return gone(`parent ${opts.ppid} ended (re-parented)`);
    const exists = alive(opts.ppid);
    if (exists === false) return gone(`parent ${opts.ppid} ended`);
    if (exists === undefined || ++ticks % identityEvery) return;
    busy = true;
    void (async () => {
      const [expected, current] = await Promise.all([opts.identity, readIdentity(opts.ppid)]);
      // A PID that now belongs to a process with another creation time is not our parent.
      if (expected && current && current !== expected) gone(`parent ${opts.ppid} ended (PID reused)`);
    })().catch(() => {}).finally(() => { busy = false; });
  }, checkMs);
  timer.unref();
  return () => { done = true; clearInterval(timer); };
}
