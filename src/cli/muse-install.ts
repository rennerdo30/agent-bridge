import { spawn } from "node:child_process";
import { join } from "node:path";
import { resolveBinary, unwrapNpmShim } from "../core/delegate.js";
import { pluginSourceDir } from "./opencode-install.js";
import type { Action } from "./installer.js";

export const museSourceDir = (from?: string) => pluginSourceDir("muse", join(".muse-plugin", "plugin.json"), from);

/** The exact Muse plugin commands for each installer action. Approval trusts the bundle's capabilities. */
export function musePluginArgs(action: Action, source: string): string[][] {
  if (action === "install") return [["plugins", "install", source], ["plugins", "approve", "agent-bridge"]];
  if (action === "update") return [["plugins", "update", "agent-bridge"], ["plugins", "approve", "agent-bridge"]];
  return [["plugins", "remove", "agent-bridge"]];
}

function runInherited(bin: string, args: string[]): Promise<number> {
  const resolved = resolveBinary(bin);
  if (!resolved) return Promise.resolve(127);
  const shim = /\.(cmd|bat)$/i.test(resolved) ? unwrapNpmShim(resolved) : null;
  const command = shim?.command ?? resolved;
  const fullArgs = [...(shim?.prefix ?? []), ...args];
  return new Promise((resolve) => {
    const child = spawn(command, fullArgs, { stdio: "inherit", shell: false });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Install/update/remove the native Muse bundle through Muse's own plugin manager. */
export async function installMusePlugin(action: Action, run: (args: string[]) => Promise<number> = (args) => runInherited("muse", args)): Promise<string[]> {
  const source = museSourceDir();
  if (action !== "uninstall" && !source) throw new Error("Missing Muse plugin build");
  const done: string[] = [];
  for (const args of musePluginArgs(action, source ?? "")) {
    const code = await run(args);
    if (code !== 0) throw new Error(`muse ${args.join(" ")} failed with code ${code}`);
    done.push(`muse ${args.join(" ")}`);
  }
  return done;
}
