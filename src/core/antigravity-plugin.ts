import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DelegateError } from "./delegate.js";
import { assertUnlinked, selectedWorker } from "./plugin-runtime.js";
import { processIdentity } from "./process-identity.js";
import { TRANSCRIPT_ID } from "./transcripts/common.js";

export const antigravityPluginDir = (home = homedir()) => join(home, ".gemini", "config", "plugins", "agent-bridge");
export const antigravityRuntimeHome = (dir = antigravityPluginDir()) => join(dirname(dir), ".agent-bridge-runtime");

/** Hook capabilities and root identity may be read only from private regular files. */
export function readAntigravityPrivateJson(path: string): Record<string, any> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error("Unsafe Antigravity hook file");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Antigravity hook file");
  return value;
}

export function antigravityRootSession(home: string, pid: number, hostIdentity: string): string | null {
  try {
    const record = readAntigravityPrivateJson(join(home, "antigravity-hooks", `${pid}.session.json`));
    return record.hostIdentity === hostIdentity && record.hostPid === pid && typeof record.conversationId === "string" && TRANSCRIPT_ID.test(record.conversationId) ? record.conversationId : null;
  } catch { return null; }
}

/** Only the adapter's top-level init can identify a newly created delegated root. */
export function registerAntigravityRoot(home: string, pid: number, conversationId: string): () => void {
  const hostIdentity = processIdentity(pid);
  if (!hostIdentity || !TRANSCRIPT_ID.test(conversationId)) throw new Error("Antigravity root identity unavailable");
  const directory = join(home, "antigravity-hooks");
  assertUnlinked(directory); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${pid}.session.json`), generation = randomBytes(24).toString("hex");
  const value = JSON.stringify({ hostPid: pid, hostIdentity, conversationId, generation });
  try { writeFileSync(file, value, { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = readAntigravityPrivateJson(file);
    // A crashed adapter can leave a file whose PID is later reused. It is safe
    // to replace that dead host binding, never another publisher for this host.
    if (previous.hostPid !== pid || typeof previous.hostIdentity !== "string" || previous.hostIdentity === hostIdentity) throw error;
    const temporary = `${file}.${generation}.tmp`;
    try { writeFileSync(temporary, value, { mode: 0o600, flag: "wx" }); renameSync(temporary, file); }
    finally { try { unlinkSync(temporary); } catch { /* Renamed or removed. */ } }
  }
  return () => { try { if (readAntigravityPrivateJson(file).generation === generation) unlinkSync(file); } catch { /* Preserve unknown replacements. */ } };
}

/** Runtime storage is separate from both the native plugin descriptor and shared broker data. */
export function antigravityRuntimeDir(dir = antigravityPluginDir()): string {
  const selected = selectedWorker(antigravityRuntimeHome(dir), "antigravity", join(dir, "dist", "server.mjs"));
  return dirname(dirname(selected.worker));
}

/** agy 1.2.0 Windows hooks mishandle quoted executable paths. Encoded PowerShell keeps paths out of its shell parser. */
export function antigravityHookCommand(cli: string, event: string, node = process.execPath, platform = process.platform): string {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  if (platform === "win32") {
    const script = `$ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $hookInput = [Console]::In.ReadToEnd(); $hookInput | & ${quote(node)} ${quote(cli)} antigravity-hook ${quote(event)}; exit $LASTEXITCODE`;
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  return `${shellQuote(node)} ${shellQuote(cli)} antigravity-hook ${event}`;
}

/** Restricted tools need the installed native PreToolUse gate, even for direct CLI smoke runs. */
export function requireAntigravityPlugin(dir = antigravityPluginDir()): void {
  try {
    assertUnlinked(dir);
    const runtime = antigravityRuntimeDir(dir);
    assertUnlinked(runtime);
    const hooks = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8"))["agent-bridge"];
    if (readFileSync(join(dir, ".agent-bridge-owned"), "utf8").trim() !== "agent-bridge" || hooks?.enabled === false || !hooks?.PreToolUse?.some((group: any) => group.matcher === "*" && group.hooks?.some((hook: any) => hook.command === antigravityHookCommand(join(runtime, "dist", "cli.mjs"), "PreToolUse"))) || !existsSync(join(runtime, "dist", "server.mjs")) || !existsSync(join(runtime, "dist", "cli.mjs"))) throw new Error("incomplete plugin");
  } catch {
    throw new DelegateError("Antigravity needs its enabled agent-bridge plugin: run agent-bridge install antigravity --yes, then restart agy", "failed");
  }
}
