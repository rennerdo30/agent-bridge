import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DelegateError } from "./delegate.js";
import { assertUnlinked, selectedWorker } from "./plugin-runtime.js";

export const antigravityPluginDir = (home = homedir()) => join(home, ".gemini", "config", "plugins", "agent-bridge");
export const antigravityRuntimeHome = (dir = antigravityPluginDir()) => join(dirname(dir), ".agent-bridge-runtime");

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
