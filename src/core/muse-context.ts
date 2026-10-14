import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "./procinfo.js";
import { processIdentity } from "./process-identity.js";

export const MUSE_ACCESS_ENV = "AGENT_BRIDGE_MUSE_ACCESS";
const EXTRA_KEYS = new Set(["CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "ANTIGRAVITY_CLI_HOME"]);
const allowed = (key: string) => key.startsWith("AGENT_BRIDGE_") || EXTRA_KEYS.has(key);

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
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Muse context");
  return value;
}

export function registerMuseContext(pid: number, env: NodeJS.ProcessEnv): () => void {
  const identity = processIdentity(pid);
  if (!identity || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Muse host identity unavailable");
  const path = join(museContextDirectory({ ...process.env, ...env }), `host-${pid}.json`);
  const nonce = randomUUID();
  const context = Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed(key) && typeof value === "string"));
  writeFileSync(path, JSON.stringify({ version: 1, pid, identity, nonce, env: context }), { mode: 0o600, flag: "wx" });
  return () => {
    try { const record = readMusePrivateJson(path); if (record.identity === identity && record.nonce === nonce) unlinkSync(path); } catch { /* Retain an unknown replacement. */ }
  };
}

export function museHostCommand(command: string): boolean {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map(t => t.replace(/^["']|["']$/g, "")) ?? [];
  const name = (token: string | undefined) => token?.replace(/\\/g, "/").split("/").at(-1) ?? "";
  return /^muse(?:\.exe|\.cmd|\.bat)?$/i.test(name(tokens[0])) || (/^node(?:\.exe)?$/i.test(name(tokens[0])) && /^muse(?:\.[cm]?js)?$/i.test(name(tokens[1])));
}

export async function museHostPid(start = process.ppid): Promise<number | null> {
  let pid = start;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const info = await lookup(pid);
    if (!info) break;
    try {
      const record = readMusePrivateJson(join(museContextDirectory(), `host-${pid}.json`));
      if (record.version === 1 && record.pid === pid && record.identity === processIdentity(pid)) return pid;
    } catch { /* A custom/SDK host must have an owned registration. */ }
    if (museHostCommand(info.cmdline)) return pid;
    pid = info.ppid;
  }
  // Host-injected session identity also supports embedding Muse in an SDK host/shim.
  return process.env.MUSE_SESSION_ID ? start : null;
}

export async function restoreMuseContext(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A stale, corrupt, or replaced host record must never create a top-level peer.
        env.AGENT_BRIDGE_INTERNAL = "1";
        return false;
      }
    }
    if (museHostCommand(info.cmdline) && /(?:^|\s)(?:exec|serve)(?:\s|$)/.test(info.cmdline)) env.AGENT_BRIDGE_INTERNAL = "1";
    pid = info.ppid;
  }
  return false;
}
