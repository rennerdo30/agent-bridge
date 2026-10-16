import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isMainThread, MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";

/**
 * Windows process creation identities through direct kernel32 calls (AB-427): OpenProcess, WaitForSingleObject,
 * GetExitCodeProcess and GetProcessTimes, in ONE long-lived Windows PowerShell host per Node process instead of
 * one PowerShell launch per query. Node has no FFI and a native addon would need a build step, so the host calls
 * the kernel32 P/Invoke declarations .NET Framework already ships (System.dll Microsoft.Win32.NativeMethods, by
 * reflection: nothing is compiled or emitted) and answers line requests.
 *
 * - Lazy: nothing starts until the first Windows identity query. A cold host never delays a caller: that call
 *   uses the PowerShell probe while the host starts (its first start in a process takes about 2 s on a
 *   Defender-scanned PC; later restarts about 0.25 s).
 * - Idle: the host blocks in a pipe read (no CPU, no polling) and is closed after IDLE_MS without requests. It
 *   exits on EOF, i.e. with this process, and it is started (and only ever stopped) by this module, by PID.
 * - Spawned on the main thread only: on Windows a child inherits every inheritable handle that exists while it is
 *   created, and libuv's child-side stdio handles are inheritable during a spawn. A long-lived host spawned from
 *   another thread could inherit, and hold open, the stdout pipe of a concurrent main-thread spawn (a probe would
 *   then wait for an EOF that never comes). The worker therefore only connects to the host's named pipe.
 * - Synchronous callers: the worker owns the pipe connection, so the main thread can block in Atomics.wait
 *   (bounded) while the worker pumps the pipe, then read the answer with receiveMessageOnPort.
 * - Format: ticks are computed exactly like Process.StartTime.ToUniversalTime().Ticks (DateTime.FromFileTime of the
 *   creation FILETIME), so readings equal the stored PowerShell identities and need no migration.
 * - Every failure answers undefined, and the caller falls back to the PowerShell probe; nothing is guessed.
 *
 * Result map: pid -> ticks for a running process; pid -> "" for a running process whose times cannot be read
 * (access denied, protected); no entry for a PID that is not a running process (invalid PID, or exited).
 */

const READY = 1, FAILED = 2;
/** Close an idle host: a resident PowerShell costs memory in every bridge process. */
const IDLE_MS = 5 * 60_000;
/** A host that cannot start (no PowerShell, blocked script) is not retried for this long. */
const FAILURE_COOLDOWN_MS = 60_000;
const STARTUP_TIMEOUT_MS = 15_000;
/** After this many failed starts, native reads stay off for the rest of the process (no restart churn). */
const MAX_START_FAILURES = 3;

// $pipe is prepended by startHost; the script arrives on stdin (no -EncodedCommand). Before "ready" the host checks
// its own reading against .NET's StartTime of itself, so a broken native path exits (a start failure) instead of
// answering. Its pipe allows only the current user. It prints "ready" once the pipe exists, then serves one connection.
// One request line: "<id> <pid> <pid> ...". One answer line: "<id> <pid>=<value> ..." where value is the tick
// string, "-" (not a running process) or "?" (running, times unreadable; or an unexpected error: absence unproven).
// [Type]::new rather than New-Object: New-Object autoloads the Utility module (about 0.7 s more per start).
const HOST = String.raw`
$ErrorActionPreference = 'Stop'
$native = [Diagnostics.Process].Assembly.GetType('Microsoft.Win32.NativeMethods', $true)
$flags = [Reflection.BindingFlags]'NonPublic, Public, Static'
$openProcess = $native.GetMethod('OpenProcess', $flags)
$getProcessTimes = $native.GetMethod('GetProcessTimes', $flags)
$getExitCodeProcess = $native.GetMethod('GetExitCodeProcess', $flags)
if ($null -eq $openProcess -or $null -eq $getProcessTimes -or $null -eq $getExitCodeProcess) { exit 3 }
$waiter = [Threading.ManualResetEvent]::new($false)
function Read-Identity([int]$id) {
  # PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE; without SYNCHRONIZE fall back to the exit code.
  $sync = $true
  $handle = $openProcess.Invoke($null, [object[]]@(0x00101000, $false, $id))
  if ($handle.IsInvalid) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq 87) { return '-' }
    if ($err -ne 5) { return '?' }
    $sync = $false
    $handle = $openProcess.Invoke($null, [object[]]@(0x00001000, $false, $id))
    if ($handle.IsInvalid) {
      if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 87) { return '-' }
      return '?'
    }
  }
  try {
    # An exited process whose handle someone still holds keeps its PID but is not running (as Get-Process).
    if ($sync) {
      $waiter.SafeWaitHandle = [Microsoft.Win32.SafeHandles.SafeWaitHandle]::new($handle.DangerousGetHandle(), $false)
      if ($waiter.WaitOne(0)) { return '-' }
    } else {
      $exit = [object[]]@($handle, 0)
      if (!$getExitCodeProcess.Invoke($null, $exit)) { return '?' }
      if ($exit[1] -ne 259) { return '-' }
    }
    $times = [object[]]@($handle, [long]0, [long]0, [long]0, [long]0)
    if (!$getProcessTimes.Invoke($null, $times)) { return '?' }
    # Process.StartTime is DateTime.FromFileTime(creation); the stored identity is its UTC ticks.
    return [string][DateTime]::FromFileTime([long]$times[1]).ToUniversalTime().Ticks
  } finally { $handle.Dispose() }
}
if ((Read-Identity $PID) -ne [string][Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks) { exit 5 }
$security = [IO.Pipes.PipeSecurity]::new()
$security.SetAccessRuleProtection($true, $false)
$security.AddAccessRule([IO.Pipes.PipeAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,
  [IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
$server = [IO.Pipes.NamedPipeServerStream]::new($pipe, [IO.Pipes.PipeDirection]::InOut, 1,
  [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096, $security)
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
$connecting = $server.BeginWaitForConnection($null, $null)
if (!$connecting.AsyncWaitHandle.WaitOne(15000)) { exit 4 }
$server.EndWaitForConnection($connecting)
$utf8 = [Text.UTF8Encoding]::new($false)
$reader = [IO.StreamReader]::new($server, $utf8)
$writer = [IO.StreamWriter]::new($server, $utf8)
while ($null -ne ($line = $reader.ReadLine())) {
  $parts = $line.Trim() -split ' '
  if ($parts.Length -lt 1 -or $parts[0] -notmatch '^\d+$') { continue }
  $answer = [Text.StringBuilder]::new()
  $null = $answer.Append($parts[0])
  for ($i = 1; $i -lt $parts.Length; $i++) {
    if ($parts[$i] -notmatch '^\d{1,10}$') { continue }
    $value = '?'
    # Windows PIDs fit in an int; a larger number cannot be a running process.
    if ([long]$parts[$i] -gt [int]::MaxValue) { $value = '-' }
    else { try { $value = Read-Identity ([int]$parts[$i]) } catch { $value = '?' } }
    $null = $answer.Append(' ').Append($parts[$i]).Append('=').Append($value)
  }
  $writer.WriteLine($answer.ToString()); $writer.Flush()
}
`;

// The worker owns the pipe connection. Messages: { type: "connect", path }, { type: "query", id, pids, sync },
// { type: "close" }. Answers go to the sync port (then the shared counter is bumped and notified) or to the parent
// port. It never spawns a process (see the module comment).
const WORKER = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const net = require("node:net");
const { idleMs, syncPort } = workerData;
const state = new Int32Array(workerData.state);
let socket = null, buffer = "", idle = null;
const outstanding = new Map();
function answer(message, sync) {
  if (sync) { syncPort.postMessage(message); Atomics.add(state, 0, 1); Atomics.notify(state, 0); }
  else parentPort.postMessage(message);
}
function failAll(error) {
  for (const [id, sync] of outstanding) answer({ id, error }, sync);
  outstanding.clear();
}
function armIdle() {
  clearTimeout(idle);
  idle = setTimeout(() => { if (socket && !outstanding.size) socket.end(); }, idleMs);
}
function connect(path) {
  if (socket) return;
  buffer = "";
  const connection = net.connect(path);
  socket = connection;
  connection.setEncoding("utf8");
  connection.on("connect", () => {
    if (socket !== connection) return;
    Atomics.store(state, 1, ${READY});
    parentPort.postMessage({ type: "connected" });
    armIdle();
  });
  connection.on("data", chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      const parts = line.split(" ");
      const id = Number(parts[0]);
      if (!outstanding.has(id)) continue;
      const sync = outstanding.get(id); outstanding.delete(id);
      answer({ id, results: parts.slice(1) }, sync);
    }
  });
  connection.on("error", () => {});
  connection.on("close", () => {
    if (socket !== connection) return;
    const wasReady = Atomics.load(state, 1) === ${READY};
    socket = null; clearTimeout(idle);
    Atomics.store(state, 1, 0);
    parentPort.postMessage({ type: "disconnected", failed: !wasReady });
    failAll("identity host connection closed");
  });
}
parentPort.on("message", message => {
  if (message.type === "connect") return connect(message.path);
  if (message.type === "close") { if (socket) socket.destroy(); return; }
  if (message.type !== "query") return;
  if (!socket || Atomics.load(state, 1) !== ${READY}) return answer({ id: message.id, error: "identity host not connected" }, message.sync);
  outstanding.set(message.id, message.sync);
  socket.write(message.id + " " + message.pids.join(" ") + "\n");
  armIdle();
});
`;

interface Helper {
  worker: Worker;
  /** [0] answer counter for synchronous waits, [1] connection state (READY or 0), [2] host PID. */
  state: Int32Array;
  syncPort: MessagePort;
  pending: Map<number, (message: { id: number; results?: string[]; error?: string }) => void>;
  host?: ChildProcess;
  /** Callers of nativeIdentityHostStarted waiting for the current start attempt. */
  started: Array<(ready: boolean) => void>;
}

let helper: Helper | undefined;
let failedAt = 0;
let startFailures = 0;
let nextId = 0;

/** A failed host start: cool down, and after MAX_START_FAILURES keep native reads off for this process. */
function startFailed(): void {
  failedAt = Date.now();
  startFailures++;
}

/**
 * Native reads are on by default on Windows, on the main thread only: a host spawned from a worker thread (history,
 * job-archive and outcome workers take metadata leases and migration/storage locks) could inherit a concurrent
 * main-thread child's stdio handles and hold them open for minutes. Workers keep the PowerShell probe.
 * AGENT_BRIDGE_NATIVE_PROCESS_IDENTITY=0 restores the PowerShell probes everywhere.
 */
function enabled(): boolean {
  return process.platform === "win32" && isMainThread && process.env.AGENT_BRIDGE_NATIVE_PROCESS_IDENTITY !== "0" &&
    startFailures < MAX_START_FAILURES && Date.now() - failedAt >= FAILURE_COOLDOWN_MS;
}

function getHelper(): Helper | undefined {
  if (!enabled()) return undefined;
  if (helper) return helper;
  try {
    const state = new SharedArrayBuffer(12);
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(WORKER, {
      eval: true,
      workerData: { idleMs: IDLE_MS, state, syncPort: port2 },
      transferList: [port2],
    });
    const created: Helper = { worker, state: new Int32Array(state), syncPort: port1, pending: new Map(), started: [] };
    worker.on("message", (message: { type?: string; id?: number; failed?: boolean; results?: string[]; error?: string }) => {
      if (message.type === "connected") return settleStart(created, true);
      if (message.type === "disconnected") {
        // The host exits on EOF; a connection that never became ready is a start failure.
        // A failed connection leaves the host waiting for one: stop the host this module started.
        if (message.failed) { startFailed(); settleStart(created, false); created.host?.kill(); }
        return;
      }
      const resolve = created.pending.get(message.id!);
      if (resolve) { created.pending.delete(message.id!); resolve(message as { id: number }); }
    });
    worker.on("error", () => retire(created));
    worker.on("exit", () => retire(created));
    worker.unref();
    return helper = created;
  } catch {
    startFailed();
    return undefined;
  }
}

function settleStart(current: Helper, ready: boolean): void {
  for (const resolve of current.started.splice(0)) resolve(ready);
}

/** Start the host on THIS (the main) thread. Its readiness arrives asynchronously; callers do not wait for it. */
function startHost(current: Helper): void {
  if (current.host) return;
  const pipe = "\\\\.\\pipe\\agent-bridge-identity-" + process.pid + "-" + randomUUID();
  // Windows PowerShell 5.1 (.NET Framework): its System.dll NativeMethods and the legacy StartTime semantics.
  const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "$pipe = '" + pipe.slice("\\\\.\\pipe\\".length) + "'\n" + HOST;
  let host: ChildProcess;
  try {
    // The script is read from stdin and run as one script block; stdin is closed after it.
    host = spawn(bin, ["-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    startFailed(); settleStart(current, false); return;
  }
  current.host = host;
  host.stdin!.on("error", () => { /* a host that died early is reported through exit */ });
  host.stdin!.end(script);
  Atomics.store(current.state, 2, host.pid ?? 0);
  let ready = false;
  const startup = setTimeout(() => { if (!ready) host.kill(); }, STARTUP_TIMEOUT_MS);
  startup.unref();
  const stdout = host.stdout!;
  let buffer = "";
  stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    if (ready || !buffer.includes("ready")) return;
    ready = true; clearTimeout(startup);
    current.worker.postMessage({ type: "connect", path: pipe });
  });
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true; clearTimeout(startup);
    if (current.host === host) { current.host = undefined; Atomics.store(current.state, 2, 0); }
    current.worker.postMessage({ type: "close" });
    if (!ready) { startFailed(); settleStart(current, false); }
  };
  // A spawn failure (ENOENT) reports "error" without "exit".
  host.on("error", () => { if (host.pid === undefined || host.exitCode !== null) end(); });
  host.on("exit", end);
  // Never keep this process alive for the host: it exits on EOF of the pipe connection when this process ends.
  (stdout as unknown as { unref?: () => void }).unref?.();
  host.unref();
}

function retire(dead: Helper): void {
  if (helper === dead) helper = undefined;
  for (const resolve of dead.pending.values()) resolve({ id: -1, error: "identity worker exited" });
  dead.pending.clear();
  settleStart(dead, false);
}

function parse(pids: number[], results: string[] | undefined): Map<number, string> | undefined {
  if (!results) return undefined;
  const answers = new Map<number, string>();
  for (const entry of results) {
    const match = /^(\d+)=(\d+|-|\?)$/.exec(entry);
    if (match) answers.set(Number(match[1]), match[2]!);
  }
  const result = new Map<number, string>();
  for (const pid of pids) {
    const value = answers.get(pid);
    // A PID the host did not answer was not observed absent: the whole reading is not trustworthy.
    if (value === undefined) return undefined;
    if (value === "?") result.set(pid, "");
    else if (value !== "-") result.set(pid, value);
  }
  // Every PID unreadable means the native path itself is suspect (not one protected process): let the probe decide.
  if (pids.every(pid => answers.get(pid) === "?")) return undefined;
  return result;
}

function validPids(pids: number[]): number[] {
  return [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff))];
}

/** A ready helper, or undefined after starting the host when it is cold (the caller falls back meanwhile). */
function readyHelper(): Helper | undefined {
  const current = getHelper();
  if (!current) return undefined;
  if (Atomics.load(current.state, 1) === READY) return current;
  startHost(current);
  return undefined;
}

/** Whether the host is connected, so a query will be answered natively. */
export function nativeIdentityHostReady(): boolean {
  return !!helper && Atomics.load(helper.state, 1) === READY;
}

/** The PID of the host this process started, if one is running (diagnostics and tests). */
export function nativeIdentityHostPid(): number | undefined {
  return helper && Atomics.load(helper.state, 2) || undefined;
}

/** Start the host and wait (bounded) until it is connected: true when ready, false on failure or timeout. */
export function nativeIdentityHostStarted(timeoutMs = STARTUP_TIMEOUT_MS): Promise<boolean> {
  const current = getHelper();
  if (!current) return Promise.resolve(false);
  if (Atomics.load(current.state, 1) === READY) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => done(false), timeoutMs);
    function done(ready: boolean) {
      clearTimeout(timer);
      const index = current!.started.indexOf(done);
      if (index >= 0) current!.started.splice(index, 1);
      resolve(ready);
    }
    current.started.push(done);
    startHost(current);
  });
}

/**
 * Synchronous read. Returns undefined (the caller falls back) when native reads are disabled or cooling down,
 * when the host is not connected yet (it is then started; this call does not wait for it), or when no answer
 * arrives within timeoutMs.
 */
export function readNativeIdentitiesSync(pids: number[], timeoutMs: number): Map<number, string> | undefined {
  const valid = validPids(pids);
  if (!valid.length) return new Map();
  const current = readyHelper();
  if (!current) return undefined;
  const id = ++nextId;
  let seen = Atomics.load(current.state, 0);
  current.worker.postMessage({ type: "query", id, pids: valid, sync: true });
  const deadline = Date.now() + timeoutMs;
  // Bounded: each wait is at most the remaining budget, and only stale answers of earlier timed-out
  // requests can cause another round.
  for (let round = 0; round < 8; round++) {
    const outcome = Atomics.wait(current.state, 0, seen, Math.max(0, Math.min(timeoutMs, deadline - Date.now())));
    for (let received = receiveMessageOnPort(current.syncPort); received; received = receiveMessageOnPort(current.syncPort)) {
      const message = received.message as { id: number; results?: string[] };
      if (message.id === id) return parse(valid, message.results);
    }
    if (outcome === "timed-out") return undefined;
    seen = Atomics.load(current.state, 0);
  }
  return undefined;
}

/**
 * Asynchronous read with the same rules. Returns undefined at once (not a promise, so the caller's fallback starts
 * in the same tick) when native reads are disabled or the host is not connected yet (it is then started). The
 * promise resolves undefined when the host fails or does not answer in time. Either way the caller falls back.
 */
export function readNativeIdentities(pids: number[], timeoutMs: number, signal?: AbortSignal): Promise<Map<number, string> | undefined> | undefined {
  const valid = validPids(pids);
  if (!valid.length) return Promise.resolve(new Map());
  if (signal?.aborted) return undefined;
  const current = readyHelper();
  if (!current) return undefined;
  const id = ++nextId;
  return new Promise(resolve => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: Map<number, string> | undefined) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      current.pending.delete(id);
      if (!current.pending.size) current.worker.unref();
      resolve(value);
    };
    const onAbort = () => finish(undefined);
    current.pending.set(id, message => finish(parse(valid, message.results)));
    // An awaited query keeps this process alive as the PowerShell probe did; an idle host never does.
    current.worker.ref();
    timer = setTimeout(() => finish(undefined), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    current.worker.postMessage({ type: "query", id, pids: valid, sync: false });
  });
}

/** Stop the host this module started (by its ChildProcess, never by name) and the worker (tests). */
export async function stopNativeIdentityHost(): Promise<void> {
  const current = helper;
  if (!current) return;
  helper = undefined;
  const host = current.host;
  if (host && host.exitCode === null && host.signalCode === null) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 5_000);
      host.once("exit", () => { clearTimeout(timer); resolve(); });
      host.kill();
    });
  }
  await current.worker.terminate();
}

/** Reset the start-failure cooldown (tests); the per-process failure count is kept. */
export function resetNativeIdentityCooldown(): void {
  failedAt = 0;
}

/** Native answer parsing, exported for tests. */
export const parseNativeAnswer = parse;
