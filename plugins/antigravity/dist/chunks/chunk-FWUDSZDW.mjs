import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  processIdentity
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
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
var MUSE_ACCESS_ENV = "AGENT_BRIDGE_MUSE_ACCESS";
var EXTRA_KEYS = /* @__PURE__ */ new Set(["CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "ANTIGRAVITY_CLI_HOME"]);
var allowed = (key) => key.startsWith("AGENT_BRIDGE_") || EXTRA_KEYS.has(key);
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
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Muse context");
  return value;
}
function registerMuseContext(pid, env) {
  const identity = processIdentity(pid);
  if (!identity || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Muse host identity unavailable");
  const path = join(museContextDirectory({ ...process.env, ...env }), `host-${pid}.json`);
  const nonce = randomUUID();
  const context = Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed(key) && typeof value === "string"));
  writeFileSync(path, JSON.stringify({ version: 1, pid, identity, nonce, env: context }), { mode: 384, flag: "wx" });
  return () => {
    try {
      const record = readMusePrivateJson(path);
      if (record.identity === identity && record.nonce === nonce) unlinkSync(path);
    } catch {
    }
  };
}
function museHostCommand(command) {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
  const name = (token) => token?.replace(/\\/g, "/").split("/").at(-1) ?? "";
  return /^muse(?:\.exe|\.cmd|\.bat)?$/i.test(name(tokens[0])) || /^node(?:\.exe)?$/i.test(name(tokens[0])) && /^muse(?:\.[cm]?js)?$/i.test(name(tokens[1]));
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
  return process.env.MUSE_SESSION_ID ? start : null;
}
async function restoreMuseContext(env = process.env) {
  let pid = process.ppid;
  const directory = museContextDirectory();
  for (let i = 0; i < 8 && pid > 1; i++) {
    const info = await lookup(pid);
    if (!info) break;
    try {
      const record = readMusePrivateJson(join(directory, `host-${pid}.json`));
      if (record.version !== 1 || record.pid !== pid || record.identity !== processIdentity(pid) || !record.env || typeof record.env !== "object" || Array.isArray(record.env)) throw new Error("Invalid Muse host binding");
      for (const [key, value] of Object.entries(record.env)) if (allowed(key) && typeof value === "string") env[key] = value;
      return true;
    } catch (error) {
      if (error.code !== "ENOENT") {
        env.AGENT_BRIDGE_INTERNAL = "1";
        return false;
      }
    }
    if (museHostCommand(info.cmdline) && /(?:^|\s)(?:exec|serve)(?:\s|$)/.test(info.cmdline)) env.AGENT_BRIDGE_INTERNAL = "1";
    pid = info.ppid;
  }
  return false;
}

export {
  lookup,
  antigravityAncestor,
  inspectClaudeLaunch,
  MUSE_ACCESS_ENV,
  museHookFile,
  readMusePrivateJson,
  registerMuseContext,
  museHostPid,
  restoreMuseContext
};
