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
 * which can be Muse's own cached copy of the old version. A reinstall leaves the plugin disabled and its hooks and
 * MCP server unapproved (Muse 1.4.9), which made every Muse write fail closed after each update. An update of a
 * plugin the owner had enabled therefore enables and approves it again, as an install does; one the owner
 * disabled stays disabled and is only inspected.
 * The scope is always explicit: run inside a Git project, Muse 1.4.9 otherwise refuses a user-scope plugin with
 * "already installed from a different source".
 */
export function musePluginArgs(action: Action, source: string, wasEnabled = false): string[][] {
  const install = ["plugins", "install", source, "--scope", "user"];
  if (action === "install") return [install, ["plugins", "approve", "agent-bridge"]];
  if (action === "update") return wasEnabled ? [install, ["plugins", "enable", "agent-bridge"], ["plugins", "approve", "agent-bridge"]] : [install, ["plugins", "inspect", "agent-bridge"]];
  return [["plugins", "remove", "agent-bridge"]];
}

/** Whether Muse lists agent-bridge as enabled (`muse plugins list --json`); false when unknown. */
export async function museBridgeEnabled(bin = "muse"): Promise<boolean> {
  try {
    const target = resolveCommand(bin, ["plugins", "list", "--json"], process.env, nullLogger);
    if (target.needsShell) return false;
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(target.resolved, target.args, { stdio: ["ignore", "pipe", "ignore"], shell: false, windowsHide: true });
      let text = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("muse plugins list timed out")); }, 30_000);
      child.stdout.on("data", (chunk) => { text += chunk; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(text); else reject(new Error(`muse plugins list failed with code ${code}`)); });
    });
    const plugins = (JSON.parse(out) as { plugins?: { record?: { id?: unknown; enabled?: unknown } }[] }).plugins ?? [];
    return plugins.some((p) => p.record?.id === "agent-bridge" && p.record.enabled === true);
  } catch { return false; }
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
  publish: (source: string) => string = publishMuseBundle, enabled: () => Promise<boolean> = () => museBridgeEnabled()): Promise<string[]> {
  const source = museSourceDir();
  if (action !== "uninstall" && !source) throw new Error("Missing Muse plugin build");
  const bundle = action === "uninstall" ? "" : publish(source!);
  // Read before the reinstall, which resets it.
  const wasEnabled = action === "update" && await enabled();
  const done: string[] = action === "uninstall" ? [] : [`+ ${bundle}`];
  for (const args of musePluginArgs(action, bundle, wasEnabled)) {
    const code = await run(args);
    if (code !== 0) throw new Error(`muse ${args.join(" ")} failed with code ${code}`);
    done.push(`muse ${args.join(" ")}`);
  }
  if (action === "update") done.push(wasEnabled
    ? "agent-bridge was enabled, so it is enabled and approved again. New Muse sessions use it; running sessions keep their existing package until restarted."
    : "agent-bridge was not enabled, so it stays disabled. To use it, run muse plugins enable agent-bridge, then muse plugins approve agent-bridge. Activation is in the next new session.");
  return done;
}
