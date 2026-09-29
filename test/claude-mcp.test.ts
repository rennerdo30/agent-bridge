import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeMcpDenyRules, OWN_SERVER_RULE } from "../src/core/claude-mcp.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ab-cmcp-"));
  dirs.push(d);
  return d;
};

describe("MCP deny rules for read-only Claude subagents", () => {
  it("lists every configured server except agent-bridge's", () => {
    const home = tmp();
    const project = tmp();
    const plugin = (name: string, files: Record<string, unknown>) => {
      const root = join(home, "cache", name);
      mkdirSync(join(root, ".claude-plugin"), { recursive: true });
      for (const [f, v] of Object.entries(files)) writeFileSync(join(root, f), JSON.stringify(v));
      return root;
    };
    const desk = plugin("desk", { ".mcp.json": { mcpServers: { "pair-desk": {} } } });
    const bridge = plugin("bridge", { ".claude-plugin/plugin.json": { mcpServers: { bridge: {} } } });
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "agent-pair-programming@x": [{ installPath: desk }], "agent-bridge@y": [{ installPath: bridge }] } }),
    );
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { github: {} }, projects: { [project]: { mcpServers: { local: {} } } } }));
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { shared: {} } }));

    const rules = claudeMcpDenyRules(project, home);
    expect(rules).toEqual(expect.arrayContaining(["mcp__plugin_agent-pair-programming_pair-desk", "mcp__github", "mcp__local", "mcp__shared", "mcp__claude_ai_*"]));
    expect(rules).not.toContain(OWN_SERVER_RULE);
  });

  it("copes with no Claude configuration at all", () => {
    expect(claudeMcpDenyRules(tmp(), tmp())).toContain("mcp__claude_ai_*");
  });
});
