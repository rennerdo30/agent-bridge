import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Every file agent-bridge installs outside of a plugin manager carries this marker. */
export const INSTALL_MARKER = "agent-bridge";

const PLUGIN_FILE = "agent-bridge.js";
const SERVER_DIR = "agent-bridge";
const SERVER_FILE = "server.mjs";
const SKILL_REL = join("skills", "agent-bridge", "SKILL.md");
const AGENTS_DIR = "agents";

/** opencode's global config dir: $XDG_CONFIG_HOME/opencode or ~/.config/opencode (also on Windows). */
export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "opencode");
}

/** Locate plugins/<name> next to the running CLI (plugins/<x>/dist/cli.mjs) or in a repo checkout. */
export function pluginSourceDir(name: "claude" | "codex" | "opencode", marker: string, fromFile: string = fileURLToPath(import.meta.url)): string | null {
  let dir = dirname(fromFile);
  for (let i = 0; i < 5; i++) {
    for (const candidate of [join(dir, "plugins", name), join(dir, "..", name)]) {
      if (existsSync(join(candidate, marker))) return resolve(candidate);
    }
    dir = dirname(dir);
  }
  return null;
}

export const opencodeSourceDir = (from?: string) => pluginSourceDir("opencode", join("dist", PLUGIN_FILE), from);

export interface InstallResult {
  configDir: string;
  files: string[];
  /** Existing files not written by agent-bridge that were left alone. */
  skipped: string[];
}

function ownedByUs(path: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(INSTALL_MARKER);
  } catch {
    return false;
  }
}

/** Copy files, refusing to overwrite files the user created themselves. */
function copyAll(copies: [string, string][], configDir: string): InstallResult {
  const res: InstallResult = { configDir, files: [], skipped: [] };
  for (const [from, to] of copies) {
    if (!existsSync(from)) throw new Error(`missing build output: ${from} (run npm run build)`);
    if (existsSync(to) && !ownedByUs(to)) {
      res.skipped.push(to);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    res.files.push(to);
  }
  return res;
}

/**
 * Agent sources are stored as `<name>.agent.md`: on case-insensitive file systems a plain `claude.md`
 * would be picked up by Claude Code as a CLAUDE.md memory file. They are installed as `<name>.md`.
 */
const AGENT_SOURCE_SUFFIX = ".agent.md";

function agentCopies(sourceDir: string, targetDir: string): [string, string][] {
  const dir = join(sourceDir, AGENTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(AGENT_SOURCE_SUFFIX))
    .map((f) => [join(dir, f), join(targetDir, AGENTS_DIR, f.slice(0, -AGENT_SOURCE_SUFFIX.length) + ".md")] as [string, string]);
}

export function installOpencode(sourceDir: string, configDir: string = opencodeConfigDir()): InstallResult {
  return copyAll(
    [
      [join(sourceDir, "dist", PLUGIN_FILE), join(configDir, "plugins", PLUGIN_FILE)],
      [join(sourceDir, "dist", SERVER_FILE), join(configDir, "plugins", SERVER_DIR, SERVER_FILE)],
      [join(sourceDir, SKILL_REL), join(configDir, SKILL_REL)],
      ...agentCopies(sourceDir, configDir),
    ],
    configDir,
  );
}

export function uninstallOpencode(configDir: string = opencodeConfigDir(), sourceDir: string | null = opencodeSourceDir()): InstallResult {
  const targets = [join(configDir, "plugins", PLUGIN_FILE), join(configDir, "plugins", SERVER_DIR), join(configDir, "skills", "agent-bridge")];
  if (sourceDir) targets.push(...agentCopies(sourceDir, configDir).map(([, to]) => to));
  return removeOwned(targets, configDir);
}

function removeOwned(targets: string[], configDir: string): InstallResult {
  const res: InstallResult = { configDir, files: [], skipped: [] };
  for (const p of targets) {
    if (!existsSync(p)) continue;
    // Directories (plugin server, skill) are ours by path; single files must carry the marker.
    const isOurFile = p.endsWith(".md") || p.endsWith(".toml") ? ownedByUs(p) : true;
    if (!isOurFile) {
      res.skipped.push(p);
      continue;
    }
    rmSync(p, { recursive: true, force: true });
    res.files.push(p);
  }
  return res;
}
