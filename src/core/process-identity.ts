import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { isMainThread, workerData } from "node:worker_threads";
import { readNativeIdentities, readNativeIdentitiesSync } from "./windows-process-identity.js";

const exec = promisify(execFile);
let parentIdentity: Promise<string | null> | undefined;
// Use the same Process.StartTime UTC ticks as Get-Process, without loading the
// Management cmdlet module in a sanitized native plugin environment (AB-330).
const windowsIdentityCommand = (pid: number) => `try { [Console]::Write([Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks) } catch { exit 1 }; exit 0`;
/** The single-PID PowerShell probe budget; a native read and its PowerShell fallback share it. */
const SINGLE_QUERY_TIMEOUT_MS = 5_000;
/**
 * A ready native host answers in about a millisecond (AB-427). It gets this slice of the caller's budget; on a
 * failure or no answer the PowerShell probe runs with what remains, so the total bound is unchanged.
 */
const NATIVE_QUERY_TIMEOUT_MS = 1_000;
function remaining(budget: number, started: number): number {
  const left = budget - (performance.now() - started);
  if (left <= 0) throw new Error("process identity query budget exhausted");
  return Math.max(1, Math.ceil(left));
}

/** A PID alone can be reused. Bind reload recovery to the CLI process's creation time. */
export function parentProcessIdentity(): Promise<string | null> {
  return parentIdentity ??= readProcessIdentity(process.ppid);
}

export async function readProcessIdentity(pid: number, signal?: AbortSignal): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || signal?.aborted) return null;
  try {
    if (process.platform === "linux") {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal }), readFile("/proc/sys/kernel/random/boot_id", { encoding: "utf8", signal })]);
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return start ? `${boot.trim()}:${start}` : null;
    }
    const started = performance.now();
    if (process.platform === "win32") {
      // Native first: "" (running, times unreadable) and a missing entry (not running) both stay unknown/null.
      const pending = readNativeIdentities([pid], NATIVE_QUERY_TIMEOUT_MS, signal);
      const native = pending && await pending;
      if (native) return native.get(pid) || null;
      if (signal?.aborted) return null;
    }
    const { stdout } = process.platform === "win32"
      ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsIdentityCommand(pid)], { windowsHide: true, timeout: remaining(SINGLE_QUERY_TIMEOUT_MS, started), signal })
      : await exec("ps", ["-p", String(pid), "-o", "lstart="], { timeout: SINGLE_QUERY_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" }, signal });
    return stdout.trim() || null;
  } catch { return null; }
}

/** A batch identity query that failed or timed out: no PID's absence was observed. */
export const IDENTITY_QUERY_FAILED = "EIDENTITYQUERY";
/** The batch query runs off hot paths; under load (many runners starting at once) PowerShell can take seconds. */
const BATCH_QUERY_TIMEOUT_MS = 15_000;

/**
 * One Windows process query rather than one PowerShell process per retained reader. A PID missing from the
 * result was absent from a successful query. A failed or timed-out query throws (code IDENTITY_QUERY_FAILED)
 * rather than returning an empty map, so callers never mistake it for every process being gone or unknown.
 */
export async function readProcessIdentities(pids: number[]): Promise<Map<number, string>> {
  const valid = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  const result = new Map<number, string>();
  if (!valid.length) return result;
  if (process.platform === "win32") {
    const started = performance.now();
    // One native request for the whole batch. As with Get-Process, a running process whose start time cannot
    // be read is left out of this (asynchronous) result.
    const pending = readNativeIdentities(valid, NATIVE_QUERY_TIMEOUT_MS);
    const native = pending && await pending;
    if (native) {
      for (const [pid, identity] of native) if (identity) result.set(pid, identity);
      return result;
    }
    let stdout: string;
    try {
      ({ stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id @(${valid.join(",")}) -ErrorAction SilentlyContinue | ForEach-Object { try { [string]$_.Id + '|' + [string]$_.StartTime.ToUniversalTime().Ticks } catch {} }; exit 0`], { windowsHide: true, timeout: remaining(BATCH_QUERY_TIMEOUT_MS, started) }));
    } catch (error) {
      throw Object.assign(new Error(`process identity query failed: ${(error as Error).message}`), { code: IDENTITY_QUERY_FAILED, cause: error });
    }
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^(\d+)\|(\d+)$/.exec(line.trim());
      if (match && valid.includes(Number(match[1]))) result.set(Number(match[1]), match[2]!);
    }
  } else {
    await Promise.all(valid.map(async pid => { const identity = await readProcessIdentity(pid); if (identity) result.set(pid, identity); }));
  }
  return result;
}

/**
 * Synchronous form of readProcessIdentities for a store upgrade check that must decide now (one query for all
 * unverified readers). Returns undefined when the query fails, so callers keep those readers blocking.
 */
export function readProcessIdentitiesSync(pids: number[]): Map<number, string> | undefined {
  const valid = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  const result = new Map<number, string>();
  if (!valid.length) return result;
  if (process.platform !== "win32") {
    for (const pid of valid) { const identity = processIdentity(pid); if (identity) result.set(pid, identity); }
    return result;
  }
  const started = performance.now();
  // Native: the same shape as below ("" = running, start time unreadable; no entry = not running).
  const native = readNativeIdentitiesSync(valid, NATIVE_QUERY_TIMEOUT_MS);
  if (native) return native;
  let stdout: string;
  try {
    stdout = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id @(${valid.join(",")}) -ErrorAction SilentlyContinue | ForEach-Object { $p = $_; try { [string]$p.Id + '|' + [string]$p.StartTime.ToUniversalTime().Ticks } catch { [string]$p.Id + '|' } }; exit 0`], { windowsHide: true, timeout: remaining(BATCH_QUERY_TIMEOUT_MS, started), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return undefined; }
  // A listed process whose start time cannot be read (elevated or protected) maps to "": present, identity unknown.
  // A PID not listed at all does not exist as a running process (an exited one, even if a handle keeps its PID).
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+)\|(\d*)$/.exec(line.trim());
    if (match && valid.includes(Number(match[1]))) result.set(Number(match[1]), match[2]!);
  }
  return result;
}

/** Bounded image-name evidence for listed processes whose creation identity cannot be read. Failures prove nothing. */
export function readProcessNamesSync(pids: number[]): Map<number, string> | undefined {
  const valid = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  const result = new Map<number, string>();
  if (!valid.length) return result;
  try {
    const stdout = process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(${valid.join(",")}) | ForEach-Object { try { $p = [System.Diagnostics.Process]::GetProcessById($_); [string]$p.Id + '|' + [string]$p.ProcessName } catch {} }; exit 0`], { windowsHide: true, timeout: BATCH_QUERY_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      : execFileSync("ps", ["-p", valid.join(","), "-o", "pid=,comm="], { timeout: BATCH_QUERY_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } });
    for (const line of stdout.split(/\r?\n/)) {
      const match = (process.platform === "win32" ? /^(\d+)\|(.+)$/ : /^(\d+)\s+(.+)$/).exec(line.trim());
      if (match && valid.includes(Number(match[1])) && match[2]!.trim()) result.set(Number(match[1]), match[2]!.trim());
    }
    return result;
  } catch { return undefined; }
}

// Only a constructor-owned same-process worker handoff may avoid the cold OS
// query. Unknown/malformed handoffs retain the ordinary probe and cooldown path.
const ownSeed = !isMainThread ? workerData?.ownProcessIdentity : undefined;
const validSeedIdentity = (identity: unknown): identity is string => typeof identity === "string" && identity.length > 0 && identity === identity.trim() &&
  (process.platform === "win32" ? /^\d+$/.test(identity) : process.platform === "linux" ? /^[0-9a-f-]{36}:\d+$/i.test(identity) : Number.isFinite(Date.parse(identity + " UTC")));
let ownIdentity: string | undefined = ownSeed?.pid === process.pid && validSeedIdentity(ownSeed.identity)
  ? ownSeed.identity : undefined;
const OWN_IDENTITY_COOLDOWN_MS = 1_000;
let ownProbeFailed = false;
let ownRetryAt = 0;
// The one in-flight asynchronous own-identity probe, shared by ownProcessIdentity() and the cooldown refresh.
let ownRefresh: Promise<string | undefined> | undefined;

function startOwnRefresh(): Promise<string | undefined> {
  // A failure is not cached: ownIdentity is only filled by a successful probe, so the next caller retries.
  return ownRefresh ??= readProcessIdentity(process.pid).then(identity => {
    if (identity) ownIdentity ??= identity;
    return ownIdentity;
  }).finally(() => {
    ownRetryAt = Date.now() + OWN_IDENTITY_COOLDOWN_MS;
    ownRefresh = undefined;
  });
}

function refreshOwnIdentity(immediate = false): void {
  if (ownRefresh || !immediate && Date.now() < ownRetryAt) return;
  // A failed native probe must not turn every metadata lease/peer write into
  // another synchronous process launch. Keep unknown fail-closed while one
  // bounded asynchronous probe tries to establish the current process's birth.
  void startOwnRefresh();
}

function ownIdentityUnavailable(): void {
  ownProbeFailed = true;
  ownRetryAt = Date.now() + OWN_IDENTITY_COOLDOWN_MS;
  // Start once now: a later one-shot caller must not be needed to initiate
  // recovery. Further refreshes remain caller-driven and cooldown-limited.
  refreshOwnIdentity(true);
}

/**
 * This process's creation identity without blocking the event loop. On Windows the query is a PowerShell
 * process (about 0.7 s on an idle PC, several seconds on a loaded one), so broker hosts start it early and
 * await it before the store's migration lock and the TCP fallback record need it. It joins the single
 * in-flight own-identity probe (starting one immediately, regardless of the failure cooldown). A success
 * fills the cache that processIdentity(process.pid) returns; a failure is not cached and never guessed.
 */
export function ownProcessIdentity(): Promise<string | undefined> {
  if (ownIdentity) return Promise.resolve(ownIdentity);
  return startOwnRefresh();
}

/** Creation identity for lock acquisition/recovery, never for polling hot paths. */
export function processIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid && ownIdentity) return ownIdentity;
  if (pid === process.pid && ownProbeFailed) { refreshOwnIdentity(); return undefined; }
  try {
    let identity: string | undefined;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (start) identity = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
    } else {
      const started = performance.now();
      const native = process.platform === "win32" ? readNativeIdentitiesSync([pid], NATIVE_QUERY_TIMEOUT_MS) : undefined;
      if (native) identity = native.get(pid) || undefined;
      else identity = (process.platform === "win32"
        ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsIdentityCommand(pid)], { windowsHide: true, timeout: remaining(SINGLE_QUERY_TIMEOUT_MS, started), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        : execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: SINGLE_QUERY_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } })).trim() || undefined;
    }
    if (pid === process.pid) {
      ownIdentity = identity;
      if (!identity) ownIdentityUnavailable();
    }
    return identity;
  } catch {
    if (pid === process.pid) ownIdentityUnavailable();
    return undefined;
  }
}

/** Unknown access/probe failures never authorize recovery of another owner's data. */
export function isProcessIdentityAlive(pid: number, identity: string): boolean | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !identity) return undefined;
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
  const current = processIdentity(pid);
  return current === undefined ? undefined : current === identity;
}

/** Wall-clock creation time of a process (epoch ms), or undefined when it cannot be read.
 * A process that started after a lock was written cannot own that lock, so this detects PID reuse. */
export function processStartMs(pid: number): number | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "win32") {
      const started = performance.now();
      const native = readNativeIdentitiesSync([pid], NATIVE_QUERY_TIMEOUT_MS);
      const ticks = native ? native.get(pid) ?? "" : execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: remaining(SINGLE_QUERY_TIMEOUT_MS, started), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (!/^\d+$/.test(ticks)) return undefined;
      // .NET ticks are 100 ns units since 0001-01-01 UTC.
      return Number(BigInt(ticks) / 10_000n - 62_135_596_800_000n);
    }
    // lstart is local time with second resolution; Date.parse reads it in the same local zone.
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).trim();
    const ms = Date.parse(started);
    return Number.isFinite(ms) ? ms : undefined;
  } catch { return undefined; }
}

/**
 * Whether the process an identity describes was started after `recordedAt` (epoch ms): then a PID recorded at
 * that time belonged to another, earlier process. Unknown formats answer false (conservatively still alive).
 */
export function identityStartedAfter(identity: string, recordedAt: number): boolean {
  if (process.platform === "win32" && /^\d+$/.test(identity)) {
    const startedAt = Number((BigInt(identity) - 621355968000000000n) / 10000n);
    return startedAt > recordedAt;
  }
  if (process.platform === "linux") {
    const match = /^(.+):(\d+)$/.exec(identity);
    if (!match) return false;
    try {
      if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== match[1]) return false;
      const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
      // Linux reports start times in clock ticks; USER_HZ is 100 on every supported build.
      return Number.isFinite(btime) && btime * 1000 + Number(match[2]) * 10 > recordedAt;
    } catch { return false; }
  }
  const startedAt = Date.parse(identity + " UTC");
  return Number.isFinite(startedAt) && startedAt > recordedAt;
}

/**
 * Liveness of a recorded owner (AB-218). With its identity: alive only while the process using that PID still
 * matches it. Without one (older records): dead when the process now using the PID started after the record was
 * written, which is PID reuse. Unknown answers stay alive, so recovery never takes over a living owner's data.
 */
export function recordedOwnerAlive(pid: number, identity: string | undefined, recordedAt: number): boolean {
  return recordedOwnerLiveness(pid, identity, recordedAt) !== false;
}

/**
 * `recordedOwnerAlive` with the unknown answers kept apart: true (verified live), false (provably gone), or
 * undefined (EPERM, an unreadable start time, an invalid PID). Callers decide unknown with `ownerGone`.
 */
export function recordedOwnerLiveness(pid: number, identity: string | undefined, recordedAt: number): boolean | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
  const current = processIdentity(pid);
  if (current === undefined) return undefined;
  if (identity) return current === identity;
  // A second of slack for coarse timestamps; a real owner exists before it writes its record.
  return !identityStartedAfter(current, recordedAt + 1_000);
}
