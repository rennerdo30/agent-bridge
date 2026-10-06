import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexSandbox } from "./config.js";

/**
 * Facts about the local Codex setup that the delegating agent should know before giving Codex work.
 *
 * The elevated backend uses a separate user for sandboxed commands. Full-access commands bypass
 * that backend and inherit the bridge process identity (Codex 0.160.1). See docs/codex-windows-devices.md.
 */
export function codexWindowsSandbox(home = homedir(), platform = process.platform): string | null {
  if (platform !== "win32") return null;
  let toml: string;
  try {
    toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  } catch {
    return null;
  }
  // The [windows] table up to the next table header.
  const table = /^\[windows\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? "";
  return /^\s*sandbox\s*=\s*"([^"]+)"/m.exec(table)?.[1] ?? null;
}

export function codexEnvironmentNote(home = homedir(), platform = process.platform): string {
  if (platform !== "win32") return "";
  const elevated = codexWindowsSandbox(home, platform) === "elevated";
  return " On Windows, danger-full-access executes as the bridge process user, normally the logged-in user, even when " +
    "windows.sandbox is elevated. Sandboxed jobs may lack USB/adb or user-profile access; use danger-full-access when authorized, " +
    "or a claude/opencode subagent for device work. An empty adb list does not prove no device is connected: verify whoami and " +
    "the adb executable/server first. If running as the sandbox user, report \"can't see devices from the sandbox\"." + (elevated ? (
    " This machine uses a separate Windows sandbox user for sandboxed commands (elevated sandbox), which cannot read the " +
    "user's profile. Tools installed there, such as Python under AppData\\Local\\Programs or user-level pip/npm installs, are " +
    "unavailable to that user (\"python is not recognized\"). For sandboxed work that needs them, point Codex to an interpreter inside the " +
    "repository (e.g. a .venv in the worktree), or use a claude/opencode subagent."
  ) : "");
}

/** Give the executing job the same device-reporting guidance as its supervisor, including resumes. */
export function codexExecutionPrompt(prompt: string, sandbox: CodexSandbox, platform = process.platform): string {
  if (platform !== "win32") return prompt;
  return `${prompt}\n\n(Windows device probes: ${sandbox === "danger-full-access"
    ? "Full-access commands should run as the bridge process user; verify with whoami before device work."
    : "Sandboxed commands may run as a separate user without USB/adb or user-profile access; verify with whoami."} ` +
    "An empty adb devices result is not proof that no device is connected. Check the adb executable and server context. " +
    "If the command runs as the sandbox user, report \"can't see devices from the sandbox\" and ask the supervisor to use an " +
    "authorized full-access job or a claude/opencode subagent for device work. Do not change permissions or switch users yourself.)";
}
