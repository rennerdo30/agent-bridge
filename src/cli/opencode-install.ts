import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Files making up the opencode integration, relative to plugins/opencode in this repo. */
const PLUGIN_FILE = "agent-bridge.js";
const SERVER_DIR = "agent-bridge";
const SERVER_FILE = "server.mjs";
const SKILL_REL = join("skills", "agent-bridge", "SKILL.md");

/** opencode's global config dir: $XDG_CONFIG_HOME/opencode or ~/.config/opencode (also on Windows). */
export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "opencode");
}

/** Locate plugins/opencode next to the running CLI (plugins/<x>/dist/cli.mjs). */
export function opencodeSourceDir(fromFile: string = fileURLToPath(import.meta.url)): string | null {
  let dir = dirname(fromFile);
  for (let i = 0; i < 5; i++) {
    for (const candidate of [join(dir, "plugins", "opencode"), join(dir, "..", "opencode")]) {
      if (existsSync(join(candidate, "dist", PLUGIN_FILE))) return resolve(candidate);
    }
    dir = dirname(dir);
  }
  return null;
}

export interface InstallResult {
  configDir: string;
  files: string[];
}

export function installOpencode(sourceDir: string, configDir: string = opencodeConfigDir()): InstallResult {
  const copies: [string, string][] = [
    [join(sourceDir, "dist", PLUGIN_FILE), join(configDir, "plugins", PLUGIN_FILE)],
    [join(sourceDir, "dist", SERVER_FILE), join(configDir, "plugins", SERVER_DIR, SERVER_FILE)],
    [join(sourceDir, SKILL_REL), join(configDir, SKILL_REL)],
  ];
  for (const [from, to] of copies) {
    if (!existsSync(from)) throw new Error(`missing build output: ${from} (run npm run build)`);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  return { configDir, files: copies.map(([, to]) => to) };
}

export function uninstallOpencode(configDir: string = opencodeConfigDir()): InstallResult {
  const targets = [join(configDir, "plugins", PLUGIN_FILE), join(configDir, "plugins", SERVER_DIR), join(configDir, "skills", "agent-bridge")];
  const removed = targets.filter((p) => existsSync(p));
  for (const p of removed) rmSync(p, { recursive: true, force: true });
  return { configDir, files: removed };
}
