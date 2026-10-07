import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertUnlinked } from "../core/plugin-runtime.js";

export function claudeMarketplace(home: string): string {
  const known = join(home, "plugins", "known_marketplaces.json");
  assertUnlinked(known);
  const location = existsSync(known) ? JSON.parse(readFileSync(known, "utf8"))["agent-bridge"]?.installLocation : undefined;
  return typeof location === "string" ? location : join(home, "plugins", "marketplaces", "agent-bridge");
}

/** Fetch and validate before the fast-forward. Never reset, clean, prune or overwrite a dirty clone. */
export function syncMarketplace(root: string, client: "claude" | "codex", version: string): void {
  assertUnlinked(root);
  const manifest = client === "claude" ? ".claude-plugin/marketplace.json" : ".agents/plugins/marketplace.json";
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const fix = `agent-bridge update ${client} --yes`;
  if (!existsSync(join(root, ".git"))) throw new Error(`Missing Git marketplace clone: ${root}. Fix: ${client} plugin marketplace ${client === "claude" ? "update" : "upgrade"} agent-bridge, then ${fix}`);
  if (git("status", "--porcelain")) throw new Error(`Marketplace has local changes: ${root}; preserved unchanged. Commit or stash them, then ${fix}`);
  git("fetch", "origin", "HEAD");
  const market = JSON.parse(git("show", `FETCH_HEAD:${manifest}`));
  const plugin = market.plugins?.find((entry: any) => entry.name === "agent-bridge");
  const path = client === "claude" ? plugin?.source : plugin?.source?.path;
  if (typeof path !== "string" || !/^\.\/plugins\/(claude|codex)$/.test(path)) throw new Error(`Unsupported marketplace source in ${root}; preserved unchanged`);
  const descriptor = client === "claude" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json";
  const actual = JSON.parse(git("show", `FETCH_HEAD:${path.slice(2)}/${descriptor}`)).version;
  if (actual !== version || client === "claude" && plugin.version !== version) throw new Error(`Marketplace release ${actual} differs from packaged release ${version}; no selector changed. Use the CLI for v${actual}, then ${fix}`);
  git("merge", "--ff-only", "FETCH_HEAD");
}
