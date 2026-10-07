import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Entirely local Git remote and home; no network or owner plugin directories. */
export function marketplaceFixture(dir: string, home: string, client: "claude" | "codex" = "claude") {
  const remote = join(dir, `remote-${client}`), clone = join(home, "plugins", "marketplaces", "agent-bridge");
  mkdirSync(remote, { recursive: true }); mkdirSync(join(home, "plugins", "marketplaces"), { recursive: true });
  const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  git(remote, "init", "-b", "main");
  const release = (version: string) => {
    const manifest = client === "claude" ? ".claude-plugin" : ".agents/plugins", descriptor = client === "claude" ? ".claude-plugin" : ".codex-plugin";
    mkdirSync(join(remote, manifest), { recursive: true }); mkdirSync(join(remote, "plugins", client, descriptor), { recursive: true });
    writeFileSync(join(remote, manifest, "marketplace.json"), JSON.stringify({ name: "agent-bridge", plugins: [{ name: "agent-bridge", version, source: client === "claude" ? "./plugins/claude" : { source: "local", path: "./plugins/codex" } }] }));
    writeFileSync(join(remote, "plugins", client, descriptor, "plugin.json"), JSON.stringify({ name: "agent-bridge", version }));
    git(remote, "add", "."); git(remote, "-c", "user.name=rennerdo30", "-c", "user.email=9086097+rennerdo30@users.noreply.github.com", "commit", "-m", `Release ${version}`);
  };
  release("0.1.0"); git(dir, "clone", remote, clone); release("0.1.1");
  return { clone, remote, git, release };
}
