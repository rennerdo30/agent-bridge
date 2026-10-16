import { spawn } from "node:child_process";
import { join } from "node:path";
import { APP_VERSION } from "../core/constants.js";
import { resolveCommand } from "../core/delegate.js";
import { nullLogger } from "../core/logger.js";
import { resolveHome } from "../core/paths.js";
import { publishPlugin, runtimeRoot } from "../core/plugin-runtime.js";
import { pluginSourceDir } from "./opencode-install.js";
import type { Action } from "./installer.js";

export const museSourceDir = (from?: string) => pluginSourceDir("muse", join(".muse-plugin", "plugin.json"), from);

/** Copy the bundle to the durable, immutable version folder all clients use. Muse records the path it installs
 * from as the plugin's source, so it must outlive this CLI package (npx removes its own copy). */
export const publishMuseBundle = (source: string): string => publishPlugin(source, runtimeRoot(resolveHome(), "muse"), APP_VERSION);

/**
 * The exact Muse plugin commands for each installer action. Approval trusts the bundle's capabilities.
 * An update installs the new bundle over the old one: `muse plugins update` only re-reads the recorded source,
 * which can be Muse's own cached copy of the old version. A reinstall keeps the plugin's enabled state.
 */
export function musePluginArgs(action: Action, source: string): string[][] {
  if (action === "install") return [["plugins", "install", source], ["plugins", "approve", "agent-bridge"]];
  if (action === "update") return [["plugins", "install", source], ["plugins", "inspect", "agent-bridge"]];
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
export async function installMusePlugin(action: Action, run: (args: string[]) => Promise<number> = (args) => runMusePluginCommand("muse", args),
  publish: (source: string) => string = publishMuseBundle): Promise<string[]> {
  const source = museSourceDir();
  if (action !== "uninstall" && !source) throw new Error("Missing Muse plugin build");
  const bundle = action === "uninstall" ? "" : publish(source!);
  const done: string[] = action === "uninstall" ? [] : [`+ ${bundle}`];
  for (const args of musePluginArgs(action, bundle)) {
    const code = await run(args);
    if (code !== 0) throw new Error(`muse ${args.join(" ")} failed with code ${code}`);
    done.push(`muse ${args.join(" ")}`);
  }
  if (action === "update") done.push("Changed capabilities remain modified/review_needed. Read the inspected package, then explicitly run muse plugins approve agent-bridge. A disabled plugin stays disabled (muse plugins enable agent-bridge turns it on). Activation is in the next new session; running sessions keep their existing package.");
  return done;
}
