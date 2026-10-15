import { spawn } from "node:child_process";
import { join } from "node:path";
import { resolveCommand } from "../core/delegate.js";
import { nullLogger } from "../core/logger.js";
import { pluginSourceDir } from "./opencode-install.js";
import type { Action } from "./installer.js";

export const museSourceDir = (from?: string) => pluginSourceDir("muse", join(".muse-plugin", "plugin.json"), from);

/** The exact Muse plugin commands for each installer action. Approval trusts the bundle's capabilities. */
export function musePluginArgs(action: Action, source: string): string[][] {
  if (action === "install") return [["plugins", "install", source], ["plugins", "approve", "agent-bridge"]];
  if (action === "update") return [["plugins", "update", "agent-bridge"], ["plugins", "inspect", "agent-bridge"]];
  return [["plugins", "remove", "agent-bridge"]];
}

export function runMusePluginCommand(bin: string, args: string[]): Promise<number> {
  const target = resolveCommand(bin, args, process.env, nullLogger);
  // An unknown CMD launcher remains unsupported here; do not weaken the
  // shared guard or invoke a shell for plugin-manager trust operations.
  if (target.needsShell) throw new Error("Unsupported Muse CMD launcher; use a validated executable launcher");
  return new Promise((resolve) => {
    const child = spawn(target.resolved, target.args, { stdio: "inherit", shell: false, windowsHide: true });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Install/update/remove the native Muse bundle through Muse's own plugin manager. */
export async function installMusePlugin(action: Action, run: (args: string[]) => Promise<number> = (args) => runMusePluginCommand("muse", args)): Promise<string[]> {
  const source = museSourceDir();
  if (action !== "uninstall" && !source) throw new Error("Missing Muse plugin build");
  const done: string[] = [];
  for (const args of musePluginArgs(action, source ?? "")) {
    const code = await run(args);
    if (code !== 0) throw new Error(`muse ${args.join(" ")} failed with code ${code}`);
    done.push(`muse ${args.join(" ")}`);
  }
  if (action === "update") done.push("Changed capabilities remain modified/review_needed. Read the inspected package, then explicitly run muse plugins approve agent-bridge. Activation is in the next new session; running sessions keep their existing package.");
  return done;
}
