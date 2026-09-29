import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Facts about the local Codex setup that the delegating agent should know before giving Codex work.
 *
 * Windows, `[windows] sandbox = "elevated"` in ~/.codex/config.toml: Codex runs commands as a separate
 * sandbox user that cannot read the user's profile, so tools installed there (Python under
 * AppData\Local\Programs, user-level pip or npm installs) are missing in Codex subagents. Plain Codex
 * behaves the same; it is not something agent-bridge can change without changing Windows permissions.
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
  if (codexWindowsSandbox(home, platform) !== "elevated") return "";
  return (
    " Note for this machine: Codex runs commands as a separate Windows sandbox user (elevated sandbox), which cannot read the " +
    "user's profile. Tools installed there, such as Python under AppData\\Local\\Programs or user-level pip/npm installs, are " +
    "missing in Codex subagents (\"python is not recognized\"). For work that needs them, point Codex to an interpreter inside the " +
    "repository (e.g. a .venv in the worktree), or use a claude/opencode subagent."
  );
}
