import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/process-identity.ts
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { isMainThread as isMainThread2, workerData } from "node:worker_threads";

// src/core/windows-process-identity.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isMainThread, MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

// src/core/job-environment.ts
function withoutT3Context(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "AGENT_BRIDGE_HOST" && key.toUpperCase() !== "AGENT_BRIDGE_MCP_PROFILE" && !key.toUpperCase().startsWith("T3_ACP_MCP_") && // AB-483: a Bridge job started from a T3 Code chat is no T3 chat itself.
  key.toUpperCase() !== "T3CODE_CLI_PATH"));
}
function jobEnvironment(env = process.env, platform = process.platform) {
  const result = withoutT3Context(env);
  const defaults = { DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: "0", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1" };
  for (const [key, value] of Object.entries(defaults)) {
    const present = Object.hasOwn(env, key) || platform === "win32" && Object.keys(env).some((existing) => existing.toUpperCase() === key);
    if (!present) result[key] = value;
  }
  return result;
}

// src/core/windows-process-identity.ts
var READY = 1;
var IDLE_MS = 5 * 6e4;
var FAILURE_COOLDOWN_MS = 6e4;
var STARTUP_TIMEOUT_MS = 15e3;
var MAX_START_FAILURES = 3;
var HOST = String.raw`
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
var WORKER = String.raw`
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
var helper;
var closingHost;
var failedAt = 0;
var startFailures = 0;
var nextId = 0;
function startFailed() {
  failedAt = Date.now();
  startFailures++;
}
function enabled() {
  return process.platform === "win32" && isMainThread && process.env.AGENT_BRIDGE_NATIVE_PROCESS_IDENTITY !== "0" && startFailures < MAX_START_FAILURES && Date.now() - failedAt >= FAILURE_COOLDOWN_MS;
}
function getHelper() {
  if (!enabled() || closingHost) return void 0;
  if (helper) return helper;
  let channel;
  try {
    const { port1, port2 } = channel = new MessageChannel();
    const state = new SharedArrayBuffer(12);
    const worker = new Worker(WORKER, {
      eval: true,
      env: jobEnvironment(),
      workerData: { idleMs: IDLE_MS, state, syncPort: port2 },
      transferList: [port2]
    });
    const created = { worker, state: new Int32Array(state), syncPort: port1, pending: /* @__PURE__ */ new Map(), started: [] };
    worker.on("message", (message) => {
      if (created.retired) return;
      if (message.type === "connected") {
        clearTimeout(created.startup);
        return settleStart(created, true);
      }
      if (message.type === "disconnected") {
        if (message.failed) startFailed();
        retire(created);
        return;
      }
      const resolve = created.pending.get(message.id);
      if (resolve) {
        created.pending.delete(message.id);
        resolve(message);
      }
    });
    const workerEnded = () => {
      if (created.retired) return;
      if (Atomics.load(created.state, 1) !== READY) startFailed();
      retire(created);
    };
    worker.on("error", workerEnded);
    worker.on("exit", workerEnded);
    port1.unref();
    worker.unref();
    return helper = created;
  } catch {
    channel?.port1.close();
    channel?.port2.close();
    startFailed();
    return void 0;
  }
}
function settleStart(current, ready) {
  for (const resolve of current.started.splice(0)) resolve(ready);
}
function startHost(current) {
  try {
    launchHost(current);
  } catch {
    startFailed();
    retire(current);
  }
}
function launchHost(current) {
  if (current.retired || current.host) return;
  const pipe = "\\\\.\\pipe\\agent-bridge-identity-" + process.pid + "-" + randomUUID();
  const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "$pipe = '" + pipe.slice("\\\\.\\pipe\\".length) + "'\n" + HOST;
  let host;
  try {
    host = spawn(
      bin,
      ["-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: jobEnvironment() }
    );
  } catch {
    startFailed();
    retire(current);
    return;
  }
  current.host = host;
  host.stdin.on("error", () => {
  });
  host.stdin.end(script);
  Atomics.store(current.state, 2, host.pid ?? 0);
  let ready = false;
  const startup = current.startup = setTimeout(() => {
    if (current.retired || current.host !== host) return;
    startFailed();
    retire(current);
  }, STARTUP_TIMEOUT_MS);
  startup.unref();
  const stdout = host.stdout;
  let buffer = "";
  stdout.setEncoding("utf8").on("data", (chunk) => {
    if (current.retired || current.host !== host) return;
    buffer += chunk;
    if (ready || buffer !== "ready\n" && buffer !== "ready\r\n") return;
    ready = true;
    current.worker.postMessage({ type: "connect", path: pipe });
  });
  let ended = false;
  const end = () => {
    if (ended || current.retired || current.host !== host) return;
    ended = true;
    clearTimeout(startup);
    if (Atomics.load(current.state, 1) !== READY) startFailed();
    retire(current);
  };
  host.on("error", () => {
    if (host.pid === void 0 || host.exitCode !== null) end();
  });
  host.on("exit", end);
  stdout.unref?.();
  host.unref();
}
function retire(dead) {
  if (dead.retired) return;
  dead.retired = true;
  if (helper === dead) helper = void 0;
  clearTimeout(dead.startup);
  Atomics.store(dead.state, 1, 0);
  Atomics.store(dead.state, 2, 0);
  const host = dead.host;
  dead.host = void 0;
  if (host && host.pid !== void 0 && host.exitCode === null && host.signalCode === null) {
    closingHost = host;
    host.once("exit", () => {
      if (closingHost === host) closingHost = void 0;
    });
    host.kill?.();
  }
  host?.stdin?.destroy?.();
  host?.stdout?.destroy?.();
  dead.syncPort.close();
  dead.stopped = dead.worker.terminate().catch(() => -1);
  for (const resolve of dead.pending.values()) resolve({ id: -1, error: "identity worker exited" });
  dead.pending.clear();
  settleStart(dead, false);
}
function parse(pids, results) {
  if (!results) return void 0;
  const answers = /* @__PURE__ */ new Map();
  for (const entry of results) {
    const match = /^(\d+)=(\d+|-|\?)$/.exec(entry);
    if (!match) return void 0;
    const pid = Number(match[1]);
    if (!pids.includes(pid) || answers.has(pid)) return void 0;
    answers.set(pid, match[2]);
  }
  const result = /* @__PURE__ */ new Map();
  for (const pid of pids) {
    const value = answers.get(pid);
    if (value === void 0) return void 0;
    if (value === "?") result.set(pid, "");
    else if (value !== "-") result.set(pid, value);
  }
  if (pids.every((pid) => answers.get(pid) === "?")) return void 0;
  return result;
}
function validPids(pids) {
  return [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 4294967295))];
}
function readyHelper() {
  const current = getHelper();
  if (!current) return void 0;
  if (Atomics.load(current.state, 1) === READY) return current;
  startHost(current);
  return void 0;
}
function readNativeIdentitiesSync(pids, timeoutMs) {
  const valid = validPids(pids);
  if (!valid.length) return /* @__PURE__ */ new Map();
  const current = readyHelper();
  if (!current) return void 0;
  const id = ++nextId;
  const budget = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(1e3, timeoutMs)) : 0;
  const deadline = performance.now() + budget;
  let result;
  try {
    current.worker.postMessage({ type: "query", id, pids: valid, sync: true });
    for (let round = 0; round < 8 && performance.now() < deadline; round++) {
      const seen = Atomics.load(current.state, 0);
      for (let received = receiveMessageOnPort(current.syncPort); received; received = receiveMessageOnPort(current.syncPort)) {
        if (performance.now() >= deadline) return void 0;
        const message = received.message;
        if (message.id === id) return result = parse(valid, message.results);
      }
      const remaining2 = deadline - performance.now();
      if (remaining2 <= 0) return void 0;
      Atomics.wait(current.state, 0, seen, remaining2);
    }
  } catch {
  } finally {
    if (!result) retire(current);
  }
  return void 0;
}
function readNativeIdentities(pids, timeoutMs, signal) {
  const valid = validPids(pids);
  if (!valid.length) return Promise.resolve(/* @__PURE__ */ new Map());
  if (signal?.aborted) return void 0;
  const current = readyHelper();
  if (!current) return void 0;
  const id = ++nextId;
  const budget = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(1e3, timeoutMs)) : 0;
  const deadline = performance.now() + budget;
  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (performance.now() >= deadline || signal?.aborted) value = void 0;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      current.pending.delete(id);
      if (!current.pending.size) current.worker.unref();
      if (!value) retire(current);
      resolve(value);
    };
    const onAbort = () => finish(void 0);
    current.pending.set(id, (message) => finish(parse(valid, message.results)));
    current.worker.ref();
    timer = setTimeout(() => finish(void 0), budget);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      current.worker.postMessage({ type: "query", id, pids: valid, sync: false });
    } catch {
      finish(void 0);
    }
  });
}

// src/core/process-identity.ts
var exec = promisify(execFile);
var parentIdentity;
var windowsIdentityCommand = (pid) => `try { [Console]::Write([Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks) } catch { exit 1 }; exit 0`;
var SINGLE_QUERY_TIMEOUT_MS = 5e3;
var NATIVE_QUERY_TIMEOUT_MS = 1e3;
function remaining(budget, started) {
  const left = budget - (performance.now() - started);
  if (left <= 0) throw new Error("process identity query budget exhausted");
  return Math.max(1, Math.ceil(left));
}
function parentProcessIdentity() {
  return parentIdentity ??= readProcessIdentity(process.ppid);
}
async function readProcessIdentity(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || signal?.aborted) return null;
  try {
    if (process.platform === "linux") {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal }), readFile("/proc/sys/kernel/random/boot_id", { encoding: "utf8", signal })]);
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return start ? `${boot.trim()}:${start}` : null;
    }
    const started = performance.now();
    if (process.platform === "win32") {
      const pending = readNativeIdentities([pid], NATIVE_QUERY_TIMEOUT_MS, signal);
      const native = pending && await pending;
      if (native) return native.get(pid) || null;
      if (signal?.aborted) return null;
    }
    const { stdout } = process.platform === "win32" ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsIdentityCommand(pid)], { windowsHide: true, timeout: remaining(SINGLE_QUERY_TIMEOUT_MS, started), signal }) : await exec("ps", ["-p", String(pid), "-o", "lstart="], { timeout: SINGLE_QUERY_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" }, signal });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
var IDENTITY_QUERY_FAILED = "EIDENTITYQUERY";
var BATCH_QUERY_TIMEOUT_MS = 15e3;
async function readProcessIdentities(pids) {
  const valid = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  const result = /* @__PURE__ */ new Map();
  if (!valid.length) return result;
  if (process.platform === "win32") {
    const started = performance.now();
    const pending = readNativeIdentities(valid, NATIVE_QUERY_TIMEOUT_MS);
    const native = pending && await pending;
    if (native) {
      for (const [pid, identity] of native) if (identity) result.set(pid, identity);
      return result;
    }
    let stdout;
    try {
      ({ stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id @(${valid.join(",")}) -ErrorAction SilentlyContinue | ForEach-Object { try { [string]$_.Id + '|' + [string]$_.StartTime.ToUniversalTime().Ticks } catch {} }; exit 0`], { windowsHide: true, timeout: remaining(BATCH_QUERY_TIMEOUT_MS, started) }));
    } catch (error) {
      throw Object.assign(new Error(`process identity query failed: ${error.message}`), { code: IDENTITY_QUERY_FAILED, cause: error });
    }
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^(\d+)\|(\d+)$/.exec(line.trim());
      if (match && valid.includes(Number(match[1]))) result.set(Number(match[1]), match[2]);
    }
  } else {
    await Promise.all(valid.map(async (pid) => {
      const identity = await readProcessIdentity(pid);
      if (identity) result.set(pid, identity);
    }));
  }
  return result;
}
function readProcessIdentitiesSync(pids) {
  const valid = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  const result = /* @__PURE__ */ new Map();
  if (!valid.length) return result;
  if (process.platform !== "win32") {
    for (const pid of valid) {
      const identity = processIdentity(pid);
      if (identity) result.set(pid, identity);
    }
    return result;
  }
  const started = performance.now();
  const native = readNativeIdentitiesSync(valid, NATIVE_QUERY_TIMEOUT_MS);
  if (native) return native;
  let stdout;
  try {
    stdout = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id @(${valid.join(",")}) -ErrorAction SilentlyContinue | ForEach-Object { $p = $_; try { [string]$p.Id + '|' + [string]$p.StartTime.ToUniversalTime().Ticks } catch { [string]$p.Id + '|' } }; exit 0`], { windowsHide: true, timeout: remaining(BATCH_QUERY_TIMEOUT_MS, started), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return void 0;
  }
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+)\|(\d*)$/.exec(line.trim());
    if (match && valid.includes(Number(match[1]))) result.set(Number(match[1]), match[2]);
  }
  return result;
}
function readProcessNamesSync(pids) {
  const valid = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  const result = /* @__PURE__ */ new Map();
  if (!valid.length) return result;
  try {
    const stdout = process.platform === "win32" ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(${valid.join(",")}) | ForEach-Object { try { $p = [System.Diagnostics.Process]::GetProcessById($_); [string]$p.Id + '|' + [string]$p.ProcessName } catch {} }; exit 0`], { windowsHide: true, timeout: BATCH_QUERY_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) : execFileSync("ps", ["-p", valid.join(","), "-o", "pid=,comm="], { timeout: BATCH_QUERY_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } });
    for (const line of stdout.split(/\r?\n/)) {
      const match = (process.platform === "win32" ? /^(\d+)\|(.+)$/ : /^(\d+)\s+(.+)$/).exec(line.trim());
      if (match && valid.includes(Number(match[1])) && match[2].trim()) result.set(Number(match[1]), match[2].trim());
    }
    return result;
  } catch {
    return void 0;
  }
}
var ownSeed = !isMainThread2 ? workerData?.ownProcessIdentity : void 0;
var validSeedIdentity = (identity) => typeof identity === "string" && identity.length > 0 && identity === identity.trim() && (process.platform === "win32" ? /^\d+$/.test(identity) : process.platform === "linux" ? /^[0-9a-f-]{36}:\d+$/i.test(identity) : Number.isFinite(Date.parse(identity + " UTC")));
var ownIdentity = ownSeed?.pid === process.pid && validSeedIdentity(ownSeed.identity) ? ownSeed.identity : void 0;
var OWN_IDENTITY_COOLDOWN_MS = 1e3;
var ownProbeFailed = false;
var ownRetryAt = 0;
var ownRefresh;
function startOwnRefresh() {
  return ownRefresh ??= readProcessIdentity(process.pid).then((identity) => {
    if (identity) ownIdentity ??= identity;
    return ownIdentity;
  }).finally(() => {
    ownRetryAt = Date.now() + OWN_IDENTITY_COOLDOWN_MS;
    ownRefresh = void 0;
  });
}
function refreshOwnIdentity(immediate = false) {
  if (ownRefresh || !immediate && Date.now() < ownRetryAt) return;
  void startOwnRefresh();
}
function ownIdentityUnavailable() {
  ownProbeFailed = true;
  ownRetryAt = Date.now() + OWN_IDENTITY_COOLDOWN_MS;
  refreshOwnIdentity(true);
}
function ownProcessIdentity() {
  if (ownIdentity) return Promise.resolve(ownIdentity);
  return startOwnRefresh();
}
function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return void 0;
  if (pid === process.pid && ownIdentity) return ownIdentity;
  if (pid === process.pid && ownProbeFailed) {
    refreshOwnIdentity();
    return void 0;
  }
  try {
    let identity;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (start) identity = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
    } else {
      const started = performance.now();
      const native = process.platform === "win32" ? readNativeIdentitiesSync([pid], NATIVE_QUERY_TIMEOUT_MS) : void 0;
      if (native) identity = native.get(pid) || void 0;
      else identity = (process.platform === "win32" ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsIdentityCommand(pid)], { windowsHide: true, timeout: remaining(SINGLE_QUERY_TIMEOUT_MS, started), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) : execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: SINGLE_QUERY_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } })).trim() || void 0;
    }
    if (pid === process.pid) {
      ownIdentity = identity;
      if (!identity) ownIdentityUnavailable();
    }
    return identity;
  } catch {
    if (pid === process.pid) ownIdentityUnavailable();
    return void 0;
  }
}
function isProcessIdentityAlive(pid, identity) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !identity) return void 0;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "ESRCH" ? false : void 0;
  }
  const current = processIdentity(pid);
  return current === void 0 ? void 0 : current === identity;
}
function processStartMs(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return void 0;
  try {
    if (process.platform === "win32") {
      const started2 = performance.now();
      const native = readNativeIdentitiesSync([pid], NATIVE_QUERY_TIMEOUT_MS);
      const ticks = native ? native.get(pid) ?? "" : execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: remaining(SINGLE_QUERY_TIMEOUT_MS, started2), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (!/^\d+$/.test(ticks)) return void 0;
      return Number(BigInt(ticks) / 10000n - 62135596800000n);
    }
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5e3, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).trim();
    const ms = Date.parse(started);
    return Number.isFinite(ms) ? ms : void 0;
  } catch {
    return void 0;
  }
}
function identityStartedAfter(identity, recordedAt) {
  if (process.platform === "win32" && /^\d+$/.test(identity)) {
    const startedAt2 = Number((BigInt(identity) - 621355968000000000n) / 10000n);
    return startedAt2 > recordedAt;
  }
  if (process.platform === "linux") {
    const match = /^(.+):(\d+)$/.exec(identity);
    if (!match) return false;
    try {
      if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== match[1]) return false;
      const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
      return Number.isFinite(btime) && btime * 1e3 + Number(match[2]) * 10 > recordedAt;
    } catch {
      return false;
    }
  }
  const startedAt = Date.parse(identity + " UTC");
  return Number.isFinite(startedAt) && startedAt > recordedAt;
}
function recordedOwnerAlive(pid, identity, recordedAt) {
  return recordedOwnerLiveness(pid, identity, recordedAt) !== false;
}
function recordedOwnerLiveness(pid, identity, recordedAt) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return void 0;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "ESRCH" ? false : void 0;
  }
  const current = processIdentity(pid);
  if (current === void 0) return void 0;
  if (identity) return current === identity;
  return !identityStartedAfter(current, recordedAt + 1e3);
}

export {
  withoutT3Context,
  jobEnvironment,
  parentProcessIdentity,
  readProcessIdentity,
  readProcessIdentities,
  readProcessIdentitiesSync,
  readProcessNamesSync,
  ownProcessIdentity,
  processIdentity,
  isProcessIdentityAlive,
  processStartMs,
  identityStartedAfter,
  recordedOwnerAlive,
  recordedOwnerLiveness
};
