import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/process-identity.ts
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
var exec = promisify(execFile);
var parentIdentity;
var windowsIdentityCommand = (pid) => `try { [Console]::Write([Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks) } catch { exit 1 }; exit 0`;
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
    const { stdout } = process.platform === "win32" ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsIdentityCommand(pid)], { windowsHide: true, timeout: 5e3, signal }) : await exec("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5e3, env: { ...process.env, LC_ALL: "C" }, signal });
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
    let stdout;
    try {
      ({ stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id @(${valid.join(",")}) -ErrorAction SilentlyContinue | ForEach-Object { try { [string]$_.Id + '|' + [string]$_.StartTime.ToUniversalTime().Ticks } catch {} }; exit 0`], { windowsHide: true, timeout: BATCH_QUERY_TIMEOUT_MS }));
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
  let stdout;
  try {
    stdout = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id @(${valid.join(",")}) -ErrorAction SilentlyContinue | ForEach-Object { $p = $_; try { [string]$p.Id + '|' + [string]$p.StartTime.ToUniversalTime().Ticks } catch { [string]$p.Id + '|' } }; exit 0`], { windowsHide: true, timeout: BATCH_QUERY_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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
var ownIdentity;
var ownIdentityRead;
function ownProcessIdentity() {
  if (ownIdentity) return Promise.resolve(ownIdentity);
  return ownIdentityRead ??= readProcessIdentity(process.pid).then((identity) => {
    if (identity) ownIdentity ??= identity;
    else ownIdentityRead = void 0;
    return ownIdentity;
  });
}
function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return void 0;
  if (pid === process.pid && ownIdentity) return ownIdentity;
  try {
    let identity;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (start) identity = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
    } else {
      identity = (process.platform === "win32" ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsIdentityCommand(pid)], { windowsHide: true, timeout: 5e3, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) : execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5e3, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } })).trim() || void 0;
    }
    if (pid === process.pid) ownIdentity = identity;
    return identity;
  } catch {
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
      const ticks = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: 5e3, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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
