import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  APP_VERSION,
  PROTOCOL_VERSION
} from "./chunk-7EOIPV3B.mjs";

// src/core/plugin-runtime.ts
import { randomUUID, createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync as readFileSync2, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// src/core/process-identity.ts
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
var exec = promisify(execFile);
var parentIdentity;
function parentProcessIdentity() {
  return parentIdentity ??= readProcessIdentity(process.ppid);
}
async function readProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return start ? `${boot.trim()}:${start}` : null;
    }
    const { stdout } = process.platform === "win32" ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: 5e3 }) : await exec("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5e3, env: { ...process.env, LC_ALL: "C" } });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
async function readProcessIdentities(pids) {
  const valid = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  const result = /* @__PURE__ */ new Map();
  if (!valid.length) return result;
  if (process.platform === "win32") {
    try {
      const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id @(${valid.join(",")}) -ErrorAction SilentlyContinue | ForEach-Object { try { [string]$_.Id + '|' + [string]$_.StartTime.ToUniversalTime().Ticks } catch {} }; exit 0`], { windowsHide: true, timeout: 5e3 });
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^(\d+)\|(\d+)$/.exec(line.trim());
        if (match && valid.includes(Number(match[1]))) result.set(Number(match[1]), match[2]);
      }
    } catch {
    }
  } else {
    await Promise.all(valid.map(async (pid) => {
      const identity = await readProcessIdentity(pid);
      if (identity) result.set(pid, identity);
    }));
  }
  return result;
}
var ownIdentity;
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
      identity = (process.platform === "win32" ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: 5e3, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) : execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5e3, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } })).trim() || void 0;
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
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code !== "ESRCH";
  }
  const current = processIdentity(pid);
  if (current === void 0) return true;
  if (identity) return current === identity;
  return !identityStartedAfter(current, recordedAt + 1e3);
}

// src/core/plugin-runtime.ts
var RUNTIME_SCHEMA = 1;
var runtimeRoot = (home, client) => join(home, "plugin-versions", client);
function assertUnlinked(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Plugin links are not supported: ${current}`);
    if (dirname(current) === current) break;
  }
}
function pluginFiles(root, rel = "") {
  assertUnlinked(root);
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const path = join(rel, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Plugin links are not supported: ${path}`);
    if (entry.isDirectory()) return pluginFiles(root, path);
    if (!entry.isFile()) throw new Error(`Unsupported plugin file: ${path}`);
    return [path];
  }).sort();
}
function digest(root) {
  const hash = createHash("sha256");
  for (const rel of pluginFiles(root)) hash.update(rel.replaceAll("\\", "/")).update("\0").update(readFileSync2(join(root, rel))).update("\0");
  return hash.digest("hex");
}
function validatePluginPublication(source, base, version) {
  releaseVersion(version);
  assertUnlinked(source);
  assertUnlinked(base);
  const target = join(base, version);
  assertUnlinked(target);
  if (existsSync(target) && digest(source) !== digest(target)) throw new Error(`Immutable plugin version differs: ${target}. Release a new patch; existing files were preserved.`);
}
function releaseVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Expected a patch release version, got ${version}`);
}
function publishPlugin(source, base, version = APP_VERSION) {
  releaseVersion(version);
  assertUnlinked(source);
  assertUnlinked(base);
  const target = join(base, version);
  assertUnlinked(target);
  if (existsSync(target)) {
    if (digest(source) !== digest(target)) throw new Error(`Immutable plugin version differs: ${target}. Release a new patch; existing files were preserved.`);
    return target;
  }
  const files = pluginFiles(source);
  const staging = join(dirname(base), `.agent-bridge-stage-${randomUUID()}`);
  assertUnlinked(staging);
  mkdirSync(staging, { recursive: true });
  for (const rel of files) {
    mkdirSync(dirname(join(staging, rel)), { recursive: true });
    copyFileSync(join(source, rel), join(staging, rel));
  }
  mkdirSync(base, { recursive: true });
  if (existsSync(target)) {
    if (digest(staging) !== digest(target)) throw new Error(`Concurrent immutable version differs: ${target}`);
    return target;
  }
  renameSync(staging, target);
  return target;
}
function atomicPluginWrite(path, text) {
  assertUnlinked(path);
  mkdirSync(dirname(path), { recursive: true });
  const previous = existsSync(path) ? readFileSync2(path) : null;
  const content = Buffer.from(text);
  if (previous?.equals(content)) return;
  const tmp = `${path}.${randomUUID()}.tmp`, backup = `${path}.backup-${Date.now()}-${randomUUID()}`;
  assertUnlinked(tmp);
  assertUnlinked(backup);
  if (previous) copyFileSync(path, backup);
  writeFileSync(tmp, content, { flag: "wx", mode: 384 });
  const current = existsSync(path) ? readFileSync2(path) : null;
  if (previous === null !== (current === null) || previous && !previous.equals(current)) throw new Error(`Plugin metadata changed concurrently; preserved both copies: ${path}`);
  renameSync(tmp, path);
}
function selectRuntime(home, client, source, version = APP_VERSION) {
  releaseVersion(version);
  const base = runtimeRoot(home, client);
  const path = join(base, "active.json");
  assertUnlinked(path);
  if (existsSync(path)) {
    const old = JSON.parse(readFileSync2(path, "utf8"));
    if (old.schemaVersion !== RUNTIME_SCHEMA) throw new Error("Unknown runtime selector format; preserved unchanged");
    releaseVersion(old.version);
    const a = old.version.split(".").map(Number), b = version.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (a[i] > b[i]) throw new Error("A newer plugin runtime is already selected; preserved unchanged");
      if (a[i] < b[i]) break;
    }
  }
  const root = publishPlugin(source, base, version);
  atomicPluginWrite(path, JSON.stringify({ schemaVersion: RUNTIME_SCHEMA, version, protocol: PROTOCOL_VERSION }, null, 2) + "\n");
  return root;
}
function selectedWorker(home, client, fallback) {
  const base = runtimeRoot(home, client), path = join(base, "active.json");
  try {
    assertUnlinked(path);
    const active = JSON.parse(readFileSync2(path, "utf8"));
    releaseVersion(active.version);
    if (active.schemaVersion !== RUNTIME_SCHEMA || active.protocol !== PROTOCOL_VERSION) throw new Error("Incompatible runtime selector");
    const worker = join(base, active.version, "dist", "worker.mjs");
    assertUnlinked(worker);
    if (!existsSync(worker)) throw new Error("Missing selected worker");
    return { worker, version: active.version };
  } catch {
    return { worker: fallback, version: APP_VERSION };
  }
}
var SESSION_RECORD = /^\d+\.json$/;
function archiveSessionRecord(dir, file) {
  const archive = join(dir, "archive");
  mkdirSync(archive, { recursive: true });
  assertUnlinked(archive);
  renameSync(join(dir, file), join(archive, `${file.slice(0, -5)}-${Date.now()}-${randomUUID()}.json`));
}
var pidGone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
};
function recordRuntimeSession(home, session) {
  const dir = join(home, "plugin-sessions");
  if (existsSync(dir)) {
    assertUnlinked(dir);
    for (const file of readdirSync(dir).filter((name) => SESSION_RECORD.test(name))) {
      const pid = Number(file.slice(0, -5));
      if (pid === session.pid || pidGone(pid)) try {
        archiveSessionRecord(dir, file);
      } catch {
      }
    }
  }
  atomicPluginWrite(join(dir, `${session.pid}.json`), JSON.stringify({ schemaVersion: RUNTIME_SCHEMA, ...session }) + "\n");
}
function liveRuntimeSessions(home, client) {
  const dir = join(home, "plugin-sessions");
  if (!existsSync(dir)) return [];
  assertUnlinked(dir);
  return readdirSync(dir).filter((file) => SESSION_RECORD.test(file)).flatMap((file) => {
    try {
      const path = join(dir, file);
      assertUnlinked(path);
      const session = JSON.parse(readFileSync2(path, "utf8"));
      if (session.schemaVersion !== RUNTIME_SCHEMA || session.client !== client || !Number.isSafeInteger(session.pid) || session.pid <= 0) return [];
      process.kill(session.pid, 0);
      const startedAt = Date.parse(session.startedAt);
      if (Number.isFinite(startedAt) && !recordedOwnerAlive(session.pid, void 0, startedAt)) return [];
      return [session];
    } catch {
      return [];
    }
  });
}

export {
  parentProcessIdentity,
  readProcessIdentity,
  readProcessIdentities,
  processIdentity,
  isProcessIdentityAlive,
  processStartMs,
  identityStartedAfter,
  recordedOwnerAlive,
  assertUnlinked,
  pluginFiles,
  validatePluginPublication,
  releaseVersion,
  publishPlugin,
  atomicPluginWrite,
  selectRuntime,
  selectedWorker,
  recordRuntimeSession,
  liveRuntimeSessions
};
