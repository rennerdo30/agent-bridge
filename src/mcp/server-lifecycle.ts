import { readProcessIdentity } from "../core/process-identity.js";

/**
 * AB-385: how a stdio MCP server ends when its session no longer uses it. Claude Code's /reload-plugins and plugin
 * updates start a new server without closing the old one's stdin, so stdin "end" alone never retires it.
 */

/** A graceful shutdown that has not finished by then exits anyway; nothing may keep a retired server alive. */
export const SHUTDOWN_DEADLINE_MS = 8_000;
/** Cheap parent check (signal 0 and the current parent PID); no process is spawned. */
export const PARENT_CHECK_MS = 5_000;
/** The parent's creation identity is re-read this often, so a reused PID is not mistaken for the parent. */
export const PARENT_IDENTITY_CHECK_MS = 10 * 60_000;

/** Numeric dotted versions ("0.30.21"); a pre-release suffix sorts before its release. Unparseable: null. */
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
  return x.pre < y.pre ? -1 : 1;
}

/**
 * A server replaced by a newer version of agent-bridge for the same session is never the one the session uses:
 * the host started the newer plugin. A same-version or older replacement keeps the reclaim path (the host may
 * still call this one), and an unknown version (an older broker that does not report it) changes nothing.
 */
export function shouldYieldTo(replacementVersion: string | undefined, ownVersion: string): boolean {
  if (!replacementVersion) return false;
  return compareVersions(replacementVersion, ownVersion) === 1;
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
