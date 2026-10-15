import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeMcpDenyRules, OWN_SERVER_RULE } from "../src/core/claude-mcp.js";
import { delegateToClaude } from "../src/core/delegate.js";
import { grantedPluginServers, startClaudeJobMcp } from "../src/core/claude-job-mcp.js";
import { nullLogger } from "../src/core/logger.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function jobFixture() {
  const root = tmp();
  const configDir = join(root, "config");
  const plugin = join(root, "plugin");
  mkdirSync(join(configDir, "plugins"), { recursive: true });
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ mcpServers: "./servers.json" }));
  // The fake upstream records calls: a denial must never reach it.
  const calls = join(root, "calls.jsonl");
  writeFileSync(join(plugin, "upstream.cjs"), `
    const { createInterface } = require('node:readline');
    const { appendFileSync } = require('node:fs');
    createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line); if (m.id === undefined) return;
      let result;
      if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      if (m.method === 'tools/list') {
        const names = m.params?.cursor ? ['link_parent', 'set_status', 'set_build', 'set_handoff', 'update_handoff', 'delete_issue', 'merge_issues', 'unmerge', 'queue_command'] : ['get_issue', 'list_issues', 'comment', 'set_plan', 'update_step', 'create_issue'];
        result = { tools: names.map(name => ({ name, inputSchema: { type: 'object' } })), ...(m.params?.cursor ? {} : { nextCursor: 'page2' }) };
      }
      if (m.method === 'tools/call') { appendFileSync(process.env.CALLS, m.params.name + '\\n'); result = { content: [{ type: 'text', text: m.params.name }] }; }
      console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  `);
  writeFileSync(join(plugin, "servers.json"), JSON.stringify({ mcpServers: {
    "pair-desk": { command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/upstream.cjs"], env: { CALLS: calls } },
    "ungranted": { command: "must-not-launch" },
  } }));
  writeFileSync(join(configDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "fixture@market": [{ installPath: plugin, scope: "user" }] } }));
  const script = join(root, "claude-fixture.cjs");
  writeFileSync(script, `
    (async () => {
      for await (const _ of process.stdin) {}
      const args = process.argv.slice(2);
      const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers;
      const servers = Object.keys(config);
      const cfg = Object.values(config)[0];
      const authorization = cfg.headers.Authorization.replace(/\\$\\{([^}]+)\\}/g, (_, key) => process.env[key]);
      let id = 0;
      const rpc = async (method, params = {}) => (await (await fetch(cfg.url, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json());
      await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
      const tools = (await rpc('tools/list')).result.tools.map(t => t.name);
      const allowed = (await rpc('tools/call', { name: 'create_issue', arguments: {} })).result;
      const denied = await Promise.all(['set_status', 'set_build', 'set_handoff', 'update_handoff', 'delete_issue', 'merge_issues', 'unmerge', 'queue_command'].map(name => rpc('tools/call', { name, arguments: {} })));
      const noAuth = (await fetch(cfg.url, { method: 'POST' })).status;
      console.log(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: servers.map(name => ({ name, status: 'connected' })), tools }));
      console.log(JSON.stringify({ type: 'result', session_id: args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'fresh', result: JSON.stringify({ args, servers, url: cfg.url, tools, allowed, denied, noAuth }) }));
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `);
  const bin = join(root, process.platform === "win32" ? "claude.cmd" : "claude");
  writeFileSync(bin, process.platform === "win32" ? '@"%dp0%\\claude-fixture.cjs" %*' : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return { root, configDir, plugin, calls, bin };
}

describe("granted plugin MCP exposure in headless Claude jobs", () => {
  it.each([null, "resumed-session"])("registers and filters the real fixture inventory, session %s", async (sessionId) => {
    const fixture = jobFixture();
    const result = await delegateToClaude({ bin: fixture.bin, cwd: fixture.root, prompt: "inspect tools", sessionId,
      permissionMode: "manual", timeoutSec: 15, log: nullLogger, extraEnv: { CLAUDE_CONFIG_DIR: fixture.configDir },
      claudeAllowTools: ["pair-desk:worker", "pair-desk.create_issue", "pair-desk.link_parent"] });
    expect(result.isError).toBe(false);
    const observed = JSON.parse(result.text);
    expect(result.sessionId).toBe(sessionId ?? "fresh");
    expect(observed.servers).toEqual(["job_plugin_fixture_pair-desk"]);
    expect(observed.tools.sort()).toEqual(["comment", "create_issue", "get_issue", "link_parent", "list_issues", "set_plan", "update_step"]);
    const args = observed.args as string[];
    const allowed = args[args.indexOf("--allowedTools") + 1]!.split(",");
    expect(allowed.sort()).toEqual(observed.tools.map((t: string) => `mcp__job_plugin_fixture_pair-desk__${t}`).sort());
    expect(allowed).not.toContain("mcp__job_plugin_fixture_pair-desk");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("mcp__plugin_fixture_pair-desk");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Write");
    expect(observed.denied.every((r: any) => r.error && !r.result)).toBe(true);
    expect(observed.noAuth).toBe(401);
    expect(readFileSync(fixture.calls, "utf8")).toBe("create_issue\n");
    await expect(fetch(observed.url)).rejects.toThrow(); // registration dies with this run
  });

  it("accepts a single exact tool grant and never exposes handoff writes even with an explicit grant", async () => {
    const f = jobFixture();
    const view = await startClaudeJobMcp({ cwd: f.root, patterns: ["pair-desk.link_parent", "pair-desk.set_handoff"], env: { ...process.env, CLAUDE_CONFIG_DIR: f.configDir }, log: nullLogger });
    try { expect(view.allowed).toEqual(["mcp__job_plugin_fixture_pair-desk__link_parent"]); }
    finally { await view.stop(); }
  });

  it("does not load an ungranted or foreign project plugin", () => {
    const f = jobFixture();
    expect(grantedPluginServers(f.root, [], f.configDir)).toEqual([]);
    expect(grantedPluginServers(f.root, ["other.read"], f.configDir)).toEqual([]);
    writeFileSync(join(f.configDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "fixture@market": [{ installPath: f.plugin, scope: "project", projectPath: join(f.root, "different-project") }] } }));
    expect(grantedPluginServers(f.root, ["pair-desk:worker"], f.configDir)).toEqual([]);
  });

  it("serves a generic plugin grant through the MCP SDK and closes on cancellation", async () => {
    const f = jobFixture();
    writeFileSync(join(f.plugin, ".mcp.json"), JSON.stringify({ inventory: { command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/upstream.cjs"], env: { CALLS: f.calls } } }));
    const controller = new AbortController();
    const view = await startClaudeJobMcp({ cwd: f.root, patterns: ["inventory.get_*"], env: { ...process.env, CLAUDE_CONFIG_DIR: f.configDir }, log: nullLogger, signal: controller.signal });
    const config = Object.values(view.config)[0] as { url: string };
    const client = new Client({ name: "fixture", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: `Bearer ${view.env.AGENT_BRIDGE_CLAUDE_MCP_TOKEN}` } } }), { timeout: 1000 });
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(["get_issue"]);
      expect(await client.callTool({ name: "get_issue", arguments: {} })).toMatchObject({ content: [{ text: "get_issue" }] });
      await expect(client.callTool({ name: "comment", arguments: {} })).rejects.toThrow("not granted");
      expect(readFileSync(f.calls, "utf8")).toBe("get_issue\n");
      controller.abort();
      await view.stop();
      await expect(fetch(config.url)).rejects.toThrow();
    } finally { await client.close(); await view.stop(); }
  });

  it("fails closed when a granted server cannot start", async () => {
    const f = jobFixture();
    await expect(startClaudeJobMcp({ cwd: f.root, patterns: ["ungranted.read"], env: { ...process.env, CLAUDE_CONFIG_DIR: f.configDir }, log: nullLogger, timeoutMs: 1000 })).rejects.toThrow("refusing an unfiltered fallback");
  });
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
