import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  processIdentity,
  readProcessIdentity
} from "./chunk-6KVDLO53.mjs";

// src/core/procinfo.ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
var LOOKUP_TIMEOUT_MS = 5e3;
var MAX_ANCESTORS = 4;
function exec(file, args) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => err ? reject(err) : resolve(stdout)
    );
  });
}
async function lookup(pid) {
  try {
    if (process.platform === "linux") {
      const [cmd, stat] = await Promise.all([readFile(`/proc/${pid}/cmdline`, "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      return { pid, ppid, cmdline: cmd.split("\0").join(" ") };
    }
    if (process.platform === "win32") {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.ParentProcessId)"; $p.CommandLine }`;
      const out2 = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      const [ppidLine, ...rest] = out2.split(/\r?\n/);
      if (!ppidLine?.trim()) return null;
      return { pid, ppid: Number(ppidLine.trim()), cmdline: rest.join(" ").trim() };
    }
    const out = await exec("ps", ["-o", "ppid=,args=", "-p", String(pid)]);
    const m = /^\s*(\d+)\s+(.*)$/s.exec(out.trim());
    return m ? { pid, ppid: Number(m[1]), cmdline: m[2].trim() } : null;
  } catch {
    return null;
  }
}
var CHANNEL_FLAGS = ["--channels", "--dangerously-load-development-channels"];
async function antigravityAncestor(start = process.ppid) {
  let pid = start;
  for (let i = 0; i < 6 && pid > 1; i++) {
    const info = await lookup(pid);
    if (!info) return null;
    if (/^(?:"[^"\r\n]*[\\/]|[^\s"\r\n]*[\\/])?agy(?:\.exe)?(?:"|\s|$)/i.test(info.cmdline)) return pid;
    pid = info.ppid;
  }
  return null;
}
function cmdlineEnablesChannel(cmdline, pluginName) {
  const tokens = cmdline.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
  const values = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const eq = CHANNEL_FLAGS.find((f) => tok.startsWith(`${f}=`));
    if (eq) {
      values.push(tok.slice(eq.length + 1));
    } else if (CHANNEL_FLAGS.includes(tok)) {
      for (let j = i + 1; j < tokens.length && !tokens[j].startsWith("-"); j++) values.push(tokens[j]);
    }
  }
  return values.some((v) => v.split(",").some((entry) => entry.includes(pluginName)));
}
function cmdlineIsPrintMode(cmdline) {
  return cmdline.split(/\s+/).some((t) => /^["']?(-p|--print)(=.*)?["']?$/.test(t));
}
function cmdlineIsClaude(cmdline) {
  const tokens = cmdline.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^["']|["']$/g, "")) ?? [];
  const executable = tokens[0]?.replace(/\\/g, "/").split("/").at(-1) ?? "";
  if (/^claude(?:\.exe|\.cmd)?$/i.test(executable)) return true;
  if (!/^node(?:\.exe)?$/i.test(executable)) return false;
  return /(?:^|\/)node_modules\/@anthropic-ai\/claude-code\/cli\.js$/i.test((tokens[1] ?? "").replace(/\\/g, "/"));
}
async function inspectClaudeLaunch(pluginName, log) {
  let pid = process.ppid;
  let channel = false;
  for (let i = 0; i < MAX_ANCESTORS && pid > 1; i++) {
    const info = await lookup(pid);
    if (!info) break;
    log.debug("inspected ancestor process", { pid, cmdline: info.cmdline.slice(0, 300) });
    if (cmdlineEnablesChannel(info.cmdline, pluginName)) channel = true;
    if (cmdlineIsClaude(info.cmdline)) {
      const print = cmdlineIsPrintMode(info.cmdline);
      return { channel, print, interactive: !print };
    }
    pid = info.ppid;
  }
  return { channel, print: false, interactive: false };
}

// src/core/muse-context.ts
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
var MUSE_ACCESS_ENV = "AGENT_BRIDGE_MUSE_ACCESS";
var CONTEXT_KEYS = /* @__PURE__ */ new Set([
  "AGENT_BRIDGE_HOME",
  "AGENT_BRIDGE_PIPE",
  "AGENT_BRIDGE_INTERNAL",
  "AGENT_BRIDGE_DELEGATE_DEPTH",
  "AGENT_BRIDGE_MAX_DELEGATE_DEPTH",
  "AGENT_BRIDGE_PARENT_URL",
  "AGENT_BRIDGE_PARENT_TOKEN",
  "AGENT_BRIDGE_PARENT_NAME",
  "AGENT_BRIDGE_PARENT_JOB",
  "AGENT_BRIDGE_JOB_ID",
  "AGENT_BRIDGE_ROOT_SESSION",
  "AGENT_BRIDGE_ROOT_NAME",
  "AGENT_BRIDGE_MUSE_ACCESS",
  "AGENT_BRIDGE_DASHBOARD",
  "AGENT_BRIDGE_AUTO_WAKE",
  "AGENT_BRIDGE_WAKE_ON_DIRECT",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "XDG_DATA_HOME",
  "ANTIGRAVITY_CLI_HOME"
]);
var allowed = (key) => CONTEXT_KEYS.has(key);
function windowsProtect(value, decrypt) {
  const operation = decrypt ? "Unprotect" : "Protect";
  const script = `Add-Type -AssemblyName System.Security; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $s=[Console]::In.ReadToEnd(); $b=${decrypt ? "[Convert]::FromBase64String($s)" : "[Text.Encoding]::UTF8.GetBytes($s)"}; $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write(${decrypt ? "[Text.Encoding]::UTF8.GetString($r)" : "[Convert]::ToBase64String($r)"})`;
  return execFileSync(
    join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input: value, encoding: "utf8", timeout: 15e3, windowsHide: true, maxBuffer: 128 * 1024, stdio: ["pipe", "pipe", "ignore"] }
  );
}
function writeMusePrivateJson(path, value, flag = "wx") {
  const text = JSON.stringify(value);
  writeFileSync(path, process.platform === "win32" ? JSON.stringify({ protected: windowsProtect(text, false) }) : text, { mode: 384, flag });
}
function museContextDirectory(env = process.env) {
  const temp = process.platform === "win32" ? env.TEMP || env.TMP : env.TMPDIR || env.TMP || env.TEMP;
  const dir = join(temp || tmpdir(), `agent-bridge-muse-${process.getuid?.() ?? "user"}`);
  mkdirSync(dir, { recursive: true, mode: 448 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && (stat.uid !== process.getuid() || (stat.mode & 63) !== 0)) throw new Error("Unsafe Muse context directory");
  return dir;
}
function museHookFile(host, session) {
  return join(museContextDirectory(), `hook-${host}-${createHash("sha256").update(session).digest("hex").slice(0, 24)}.json`);
}
function readMusePrivateJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 || process.getuid && (stat.uid !== process.getuid() || (stat.mode & 63) !== 0)) throw new Error("Unsafe Muse context file");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const value = process.platform === "win32" ? JSON.parse(windowsProtect(raw.protected, true)) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Muse context");
  return value;
}
function registerMuseContext(pid, env, identity = processIdentity(pid)) {
  if (!identity || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Muse host identity unavailable");
  const path = join(museContextDirectory({ ...process.env, ...env }), `host-${pid}.json`);
  const nonce = randomUUID();
  const context = Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed(key) && typeof value === "string"));
  writeMusePrivateJson(path, { version: 1, pid, identity, nonce, env: context });
  return () => {
    try {
      const record = readMusePrivateJson(path);
      if (record.identity === identity && record.nonce === nonce) unlinkSync(path);
    } catch {
    }
  };
}
async function registerMuseContextAsync(pid, env) {
  const identity = await readProcessIdentity(pid);
  if (!identity) throw new Error("Muse host identity unavailable");
  return registerMuseContext(pid, env, identity);
}
function museHostCommand(command) {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
  const name = (token) => token?.replace(/\\/g, "/").split("/").at(-1) ?? "";
  return /^(?:muse(?:\.exe|\.cmd|\.bat)?|muse-bin-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\.exe)$/i.test(name(tokens[0])) || /^node(?:\.exe)?$/i.test(name(tokens[0])) && /^muse(?:\.[cm]?js)?$/i.test(name(tokens[1]));
}
async function museHostPid(start = process.ppid) {
  let pid = start;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const info = await lookup(pid);
    if (!info) break;
    try {
      const record = readMusePrivateJson(join(museContextDirectory(), `host-${pid}.json`));
      if (record.version === 1 && record.pid === pid && record.identity === processIdentity(pid)) return pid;
    } catch {
    }
    if (museHostCommand(info.cmdline)) return pid;
    pid = info.ppid;
  }
  return null;
}
async function restoreMuseContext(env = process.env) {
  let pid = process.ppid;
  const directory = museContextDirectory();
  const pending = [];
  let headless = false;
  const refuse = () => {
    for (const key of CONTEXT_KEYS) delete env[key];
    env.AGENT_BRIDGE_INTERNAL = "1";
    return false;
  };
  const restore = (host) => {
    const record = readMusePrivateJson(join(directory, `host-${host}.json`));
    if (record.version !== 1 || record.pid !== host || record.identity !== processIdentity(host) || typeof record.nonce !== "string" || !record.nonce || !record.env || typeof record.env !== "object" || Array.isArray(record.env)) throw new Error("Invalid Muse host binding");
    const scope = record.env;
    if (scope.AGENT_BRIDGE_INTERNAL !== "1") throw new Error("Missing internal Muse scope");
    const delegated = scope.AGENT_BRIDGE_DELEGATE_DEPTH !== void 0;
    if (delegated || ["AGENT_BRIDGE_PARENT_URL", "AGENT_BRIDGE_PARENT_TOKEN", "AGENT_BRIDGE_PARENT_NAME", "AGENT_BRIDGE_PARENT_JOB"].some((key) => scope[key] !== void 0)) {
      const depth = scope.AGENT_BRIDGE_DELEGATE_DEPTH;
      const parent = new URL(scope.AGENT_BRIDGE_PARENT_URL);
      if (typeof depth !== "string" || !/^\d+$/.test(depth) || !Number.isSafeInteger(Number(depth)) || Number(depth) < 1 || parent.protocol !== "http:" || parent.hostname !== "127.0.0.1" || parent.username || parent.password || typeof scope.AGENT_BRIDGE_PARENT_TOKEN !== "string" || !scope.AGENT_BRIDGE_PARENT_TOKEN || typeof scope.AGENT_BRIDGE_PARENT_NAME !== "string" || !scope.AGENT_BRIDGE_PARENT_NAME || !["read", "ask", "edit"].includes(scope.AGENT_BRIDGE_MUSE_ACCESS)) throw new Error("Incomplete delegated Muse scope");
      if (scope.AGENT_BRIDGE_PARENT_JOB && (!scope.AGENT_BRIDGE_ROOT_SESSION || !scope.AGENT_BRIDGE_ROOT_NAME)) throw new Error("Incomplete Muse job scope");
    }
    for (const key of CONTEXT_KEYS) delete env[key];
    for (const [key, value] of Object.entries(record.env)) if (allowed(key) && typeof value === "string") env[key] = value;
    return true;
  };
  for (let i = 0; i < 8 && pid > 1; i++) {
    const info = await lookup(pid);
    if (!info) break;
    try {
      return restore(pid);
    } catch (error) {
      if (error.code !== "ENOENT") {
        return refuse();
      }
      pending.push(pid);
    }
    if (museHostCommand(info.cmdline)) {
      if (!/(?:^|\s)(?:exec|serve)(?:\s|$)/.test(info.cmdline) && env.MUSE_SESSION_ID) {
        return env.AGENT_BRIDGE_INTERNAL || env.AGENT_BRIDGE_DELEGATE_DEPTH || env.AGENT_BRIDGE_PARENT_URL ? refuse() : false;
      }
      headless = true;
      env.AGENT_BRIDGE_INTERNAL = "1";
    }
    pid = info.ppid;
  }
  if (headless) for (const deadline = Date.now() + 5e3; Date.now() < deadline; ) {
    for (const host of pending) try {
      return restore(host);
    } catch (error) {
      if (error.code !== "ENOENT") return refuse();
    }
    await delay(100);
  }
  return refuse();
}

export {
  lookup,
  antigravityAncestor,
  inspectClaudeLaunch,
  MUSE_ACCESS_ENV,
  writeMusePrivateJson,
  museHookFile,
  readMusePrivateJson,
  registerMuseContextAsync,
  museHostPid,
  restoreMuseContext
};
