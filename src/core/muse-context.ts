import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lookup } from "./procinfo.js";
import { processIdentity, readProcessIdentity } from "./process-identity.js";

export const MUSE_ACCESS_ENV = "AGENT_BRIDGE_MUSE_ACCESS";
// Only the adapter's explicit Bridge contract crosses the host boundary. In
// particular, provider keys, arbitrary Bridge extensions and executable injection
// settings must never be restored from an ambient environment.
const CONTEXT_KEYS = new Set(["AGENT_BRIDGE_HOME", "AGENT_BRIDGE_PIPE", "AGENT_BRIDGE_INTERNAL",
  "AGENT_BRIDGE_DELEGATE_DEPTH", "AGENT_BRIDGE_MAX_DELEGATE_DEPTH", "AGENT_BRIDGE_PARENT_URL",
  "AGENT_BRIDGE_PARENT_TOKEN", "AGENT_BRIDGE_PARENT_NAME", "AGENT_BRIDGE_PARENT_JOB", "AGENT_BRIDGE_JOB_ID",
  "AGENT_BRIDGE_ROOT_SESSION", "AGENT_BRIDGE_ROOT_NAME", "AGENT_BRIDGE_MUSE_ACCESS",
  "AGENT_BRIDGE_DASHBOARD", "AGENT_BRIDGE_AUTO_WAKE", "AGENT_BRIDGE_WAKE_ON_DIRECT",
  "CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "ANTIGRAVITY_CLI_HOME"]);
const allowed = (key: string) => CONTEXT_KEYS.has(key);

/** DPAPI authenticates/encrypts the entire record for this Windows account.
 * Plaintext goes over stdin only. Other accounts cannot forge or read a handoff
 * even if a temp directory has inherited broad ACLs. PID creation identity still
 * refuses replay; an unknown or damaged protected record fails closed. */
function windowsProtect(value: string, decrypt: boolean): string {
  const operation = decrypt ? "Unprotect" : "Protect";
  // Reflection avoids Add-Type's Utility module autoload, which can stall in
  // Muse's stripped Windows environment. DPAPI scope and ciphertext stay identical.
  const script = `$null=[Reflection.Assembly]::LoadWithPartialName('System.Security'); [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $s=[Console]::In.ReadToEnd(); $b=${decrypt ? "[Convert]::FromBase64String($s)" : "[Text.Encoding]::UTF8.GetBytes($s)"}; $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write(${decrypt ? "[Text.Encoding]::UTF8.GetString($r)" : "[Convert]::ToBase64String($r)"}); exit 0`;
  return execFileSync(join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], { input: value, encoding: "utf8", timeout: 15_000, windowsHide: true, maxBuffer: 128 * 1024, stdio: ["pipe", "pipe", "ignore"] });
}

export function writeMusePrivateJson(path: string, value: Record<string, unknown>, flag = "wx"): void {
  const text = JSON.stringify(value);
  writeFileSync(path, process.platform === "win32" ? JSON.stringify({ protected: windowsProtect(text, false) }) : text, { mode: 0o600, flag });
}

/** Muse deliberately sanitizes plugin environments; recover only this owned host's Bridge context. */
export function museContextDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const temp = process.platform === "win32" ? env.TEMP || env.TMP : env.TMPDIR || env.TMP || env.TEMP;
  const dir = join(temp || tmpdir(), `agent-bridge-muse-${process.getuid?.() ?? "user"}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error("Unsafe Muse context directory");
  return dir;
}

export function museHookFile(host: number, session: string): string {
  return join(museContextDirectory(), `hook-${host}-${createHash("sha256").update(session).digest("hex").slice(0, 24)}.json`);
}

export function readMusePrivateJson(path: string): Record<string, any> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error("Unsafe Muse context file");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const value = process.platform === "win32" ? JSON.parse(windowsProtect(raw.protected, true)) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Muse context");
  return value;
}

export function registerMuseContext(pid: number, env: NodeJS.ProcessEnv, identity = processIdentity(pid)): () => void {
  if (!identity || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Muse host identity unavailable");
  const path = join(museContextDirectory({ ...process.env, ...env }), `host-${pid}.json`);
  const nonce = randomUUID();
  const context = Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed(key) && typeof value === "string"));
  writeMusePrivateJson(path, { version: 1, pid, identity, nonce, env: context });
  return () => {
    try { const record = readMusePrivateJson(path); if (record.identity === identity && record.nonce === nonce) unlinkSync(path); } catch { /* Retain an unknown replacement. */ }
  };
}

export async function registerMuseContextAsync(pid: number, env: NodeJS.ProcessEnv): Promise<() => void> {
  const identity = await readProcessIdentity(pid);
  if (!identity) throw new Error("Muse host identity unavailable");
  return registerMuseContext(pid, env, identity);
}

export function museHostCommand(command: string): boolean {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map(t => t.replace(/^["']|["']$/g, "")) ?? [];
  const name = (token: string | undefined) => token?.replace(/\\/g, "/").split("/").at(-1) ?? "";
  return /^(?:muse(?:\.exe|\.cmd|\.bat)?|muse-bin-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\.exe)$/i.test(name(tokens[0])) || (/^node(?:\.exe)?$/i.test(name(tokens[0])) && /^muse(?:\.[cm]?js)?$/i.test(name(tokens[1])));
}

export async function museHostPid(start = process.ppid): Promise<number | null> {
  let pid = start;
  const owned = (host: number): boolean => {
    const record = readMusePrivateJson(join(museContextDirectory(), `host-${host}.json`));
    return record.version === 1 && record.pid === host && record.identity === processIdentity(host) && typeof record.nonce === "string" && !!record.nonce;
  };
  for (let i = 0; i < 8 && pid > 1; i++) {
    try { if (owned(pid)) return pid; } catch { /* An unknown ancestor needs an OS lookup. */ }
    const info = await lookup(pid);
    if (!info) { try { if (owned(pid)) return pid; } catch { /* No authenticated late handoff. */ } break; }
    if (museHostCommand(info.cmdline)) return pid;
    pid = info.ppid;
  }
  return null;
}

export async function restoreMuseContext(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  let pid = process.ppid;
  const directory = museContextDirectory();
  const pending: number[] = [];
  const handoffDeadline = Date.now() + 5_000;
  const refuse = (): false => { for (const key of CONTEXT_KEYS) delete env[key]; env.AGENT_BRIDGE_INTERNAL = "1"; return false; };
  const restore = (host: number): boolean => {
    const record = readMusePrivateJson(join(directory, `host-${host}.json`));
    if (record.version !== 1 || record.pid !== host || record.identity !== processIdentity(host) || typeof record.nonce !== "string" || !record.nonce || !record.env || typeof record.env !== "object" || Array.isArray(record.env)) throw new Error("Invalid Muse host binding");
    const scope = record.env;
    if (scope.AGENT_BRIDGE_INTERNAL !== "1") throw new Error("Missing internal Muse scope");
    const delegated = scope.AGENT_BRIDGE_DELEGATE_DEPTH !== undefined;
    if (delegated || ["AGENT_BRIDGE_PARENT_URL", "AGENT_BRIDGE_PARENT_TOKEN", "AGENT_BRIDGE_PARENT_NAME", "AGENT_BRIDGE_PARENT_JOB"].some(key => scope[key] !== undefined)) {
      const depth = scope.AGENT_BRIDGE_DELEGATE_DEPTH;
      const parent = new URL(scope.AGENT_BRIDGE_PARENT_URL);
      if (typeof depth !== "string" || !/^\d+$/.test(depth) || !Number.isSafeInteger(Number(depth)) || Number(depth) < 1 ||
        parent.protocol !== "http:" || parent.hostname !== "127.0.0.1" || parent.username || parent.password ||
        typeof scope.AGENT_BRIDGE_PARENT_TOKEN !== "string" || !scope.AGENT_BRIDGE_PARENT_TOKEN ||
        typeof scope.AGENT_BRIDGE_PARENT_NAME !== "string" || !scope.AGENT_BRIDGE_PARENT_NAME ||
        !["read", "ask", "edit"].includes(scope.AGENT_BRIDGE_MUSE_ACCESS)) throw new Error("Incomplete delegated Muse scope");
      if (scope.AGENT_BRIDGE_PARENT_JOB && (!scope.AGENT_BRIDGE_ROOT_SESSION || !scope.AGENT_BRIDGE_ROOT_NAME)) throw new Error("Incomplete Muse job scope");
    }
    // The authenticated record replaces the contract; omitted fields cannot be
    // recovered from inherited ambient values (including stale parent tokens).
    for (const key of CONTEXT_KEYS) delete env[key];
    for (const [key, value] of Object.entries(record.env)) if (allowed(key) && typeof value === "string") env[key] = value;
    return true;
  };
  for (let i = 0; i < 8 && pid > 1; i++) {
    try {
      return restore(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A stale, corrupt, or replaced host record must never create a top-level peer.
        return refuse();
      }
      pending.push(pid);
    }
    // The private handoff and creation identity authenticate an observed parent
    // without a command-line query. CIM is only needed to discover ancestors.
    if (Date.now() >= handoffDeadline) break;
    const info = await lookup(pid);
    if (!info) {
      // Registration may have completed while the bounded OS lookup was pending.
      try { return restore(pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse(); }
      break;
    }
    // Only positively identified interactive native hosts may start a main peer
    // without an adapter-owned handoff. SDK/shim/exec/serve ancestry is untrusted.
    if (museHostCommand(info.cmdline)) {
      if (!/(?:^|\s)(?:exec|serve)(?:\s|$)/.test(info.cmdline) && env.MUSE_SESSION_ID) {
        return env.AGENT_BRIDGE_INTERNAL || env.AGENT_BRIDGE_DELEGATE_DEPTH || env.AGENT_BRIDGE_PARENT_URL ? refuse() : false;
      }
      env.AGENT_BRIDGE_INTERNAL = "1";
      // Its handoff must win; walking farther could restore another job's
      // authenticated ancestor while this host's registration is still pending.
      break;
    }
    pid = info.ppid;
  }
  // Registration may lag plugin startup even when CIM cannot identify the host.
  // Retry only observed ancestors within the existing bound. A private record
  // and matching creation identity remain mandatory; ambient values grant nothing.
  for (; Date.now() < handoffDeadline;) {
    for (const host of pending) try { return restore(host); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse(); }
    await delay(100);
  }
  return refuse();
}
