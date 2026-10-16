import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeMcpDenyRules, OWN_SERVER_RULE } from "../src/core/claude-mcp.js";
import { delegateToClaude } from "../src/core/delegate.js";
import { grantedPluginServers, startClaudeJobMcp } from "../src/core/claude-job-mcp.js";
import { nullLogger } from "../src/core/logger.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { until } from "./helpers.js";
import { readProcessIdentity } from "../src/core/process-identity.js";
import { OwnedMcpStdio } from "../src/core/owned-mcp-stdio.js";

// Lets a test force the job MCP cleanup to fail; every other test gets the real view unchanged.
const jobMcp = vi.hoisted(() => ({ failStop: false }));
vi.mock("../src/core/claude-job-mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/claude-job-mcp.js")>();
  return { ...actual, startClaudeJobMcp: async (...args: Parameters<typeof actual.startClaudeJobMcp>) => {
    const view = await actual.startClaudeJobMcp(...args);
    if (!jobMcp.failStop) return view;
    return { ...view, stop: async () => { await view.stop(); throw new Error("forced MCP cleanup failure"); } };
  } };
});

const dirs: string[] = [];
afterEach(() => {
  jobMcp.failStop = false;
  vi.restoreAllMocks();
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
        const names = m.params?.cursor ? ['inventory_get_issue', 'Get_issue', 'link_parent', 'set_status', 'set_build', 'set_handoff', 'update_handoff', 'delete_issue', 'merge_issues', 'unmerge', 'queue_command'] : ['get_issue', 'list_issues', 'comment', 'set_plan', 'update_step', 'create_issue'];
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

  it("does not alias a prefixed or differently cased raw inventory tool into an exact grant", async () => {
    const f = jobFixture();
    writeFileSync(join(f.plugin, ".mcp.json"), JSON.stringify({ inventory: { command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/upstream.cjs"], env: { CALLS: f.calls } } }));
    const view = await startClaudeJobMcp({ cwd: f.root, patterns: ["inventory.get_issue"], env: { ...process.env, CLAUDE_CONFIG_DIR: f.configDir }, log: nullLogger });
    const client = new Client({ name: "fixture", version: "1" });
    try {
      const cfg = Object.values(view.config)[0] as { url: string };
      await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: { Authorization: `Bearer ${view.env.AGENT_BRIDGE_CLAUDE_MCP_TOKEN}` } } }));
      expect(view.allowed).toEqual(["mcp__job_plugin_fixture_inventory__get_issue"]);
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(["get_issue"]);
      for (const name of ["inventory_get_issue", "Get_issue"]) await expect(client.callTool({ name, arguments: {} })).rejects.toThrow("not granted");
      await client.callTool({ name: "get_issue", arguments: {} });
      expect(readFileSync(f.calls, "utf8")).toBe("get_issue\n");
    } finally { await client.close(); await view.stop(); }
  });

  it.each(["completion", "cancellation"])("stops the recorded owned root, launcher and stubborn descendant on %s", async (reason) => {
    const f = jobFixture();
    const pidsFile = join(f.root, "pids.json");
    writeFileSync(join(f.plugin, "launcher.cjs"), `
      const { spawn } = require('node:child_process');
      const leaf = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000)"], { stdio: 'ignore', windowsHide: true });
      require('node:fs').writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify([process.pid, leaf.pid]));
      require('./upstream.cjs');
    `);
    writeFileSync(join(f.plugin, ".mcp.json"), JSON.stringify({ inventory: { command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/launcher.cjs"], env: { CALLS: f.calls } } }));
    const log = { ...nullLogger, info: vi.fn() };
    const controller = new AbortController();
    const view = await startClaudeJobMcp({ cwd: f.root, patterns: ["inventory.get_issue"], env: { ...process.env, CLAUDE_CONFIG_DIR: f.configDir }, log, signal: controller.signal });
    const root = log.info.mock.calls.find(([message]) => message === "owned plugin MCP root")![1] as { pid: number; identity: string };
    const pids: number[] = [root.pid, ...JSON.parse(readFileSync(pidsFile, "utf8"))];
    const identities = await Promise.all(pids.map(pid => readProcessIdentity(pid)));
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      expect(root.identity).toBe(identities[0]);
      expect(pids.every(alive)).toBe(true);
      if (reason === "cancellation") controller.abort();
      await view.stop();
      await until(() => pids.every(pid => !alive(pid)));
    } finally {
      await view.stop();
      // Failure cleanup is limited to these fixture-created PIDs with their recorded identities.
      for (const [index, pid] of pids.entries()) if (identities[index] && await readProcessIdentity(pid) === identities[index]) process.kill(pid, "SIGKILL");
    }
  });

  it.each(["deadline", "cancellation"])("bounds SSE startup without an endpoint event on %s", async (reason) => {
    const f = jobFixture();
    let connected!: () => void;
    let disconnected = false;
    const opened = new Promise<void>(done => { connected = done; });
    const server = createServer((_req, res) => { res.on("close", () => { disconnected = true; }); res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": waiting\n\n"); connected(); });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    writeFileSync(join(f.plugin, ".mcp.json"), JSON.stringify({ inventory: { type: "sse", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sse` } }));
    const controller = new AbortController();
    const started = Date.now();
    try {
      const result = startClaudeJobMcp({ cwd: f.root, patterns: ["inventory.get_issue"], env: { ...process.env, CLAUDE_CONFIG_DIR: f.configDir }, log: nullLogger, timeoutMs: reason === "deadline" ? 500 : 5000, signal: controller.signal });
      const rejected = expect(result).rejects.toThrow("refusing an unfiltered fallback");
      await opened;
      if (reason === "cancellation") controller.abort();
      await rejected;
      expect(Date.now() - started).toBeLessThan(3000);
      await until(() => disconnected);
    } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  });

  it("keeps the run's own result or error when the job MCP cleanup fails", async () => {
    const fixture = jobFixture();
    jobMcp.failStop = true;
    const warn = vi.fn();
    const log = { ...nullLogger, warn };
    const request = { cwd: fixture.root, prompt: "inspect tools", permissionMode: "manual" as const, timeoutSec: 15, log,
      extraEnv: { CLAUDE_CONFIG_DIR: fixture.configDir }, claudeAllowTools: ["pair-desk.create_issue"] };
    const result = await delegateToClaude({ ...request, bin: fixture.bin });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).servers).toEqual(["job_plugin_fixture_pair-desk"]);
    expect(warn).toHaveBeenCalledWith("claude job MCP cleanup failed", expect.objectContaining({ error: expect.stringContaining("forced MCP cleanup failure") }));
    warn.mockClear();
    const failed = delegateToClaude({ ...request, bin: join(fixture.root, "missing-claude-binary") });
    await expect(failed).rejects.toSatisfy((error: Error) => !String(error.message).includes("forced MCP cleanup failure"));
    expect(warn).toHaveBeenCalledWith("claude job MCP cleanup failed", expect.anything());
  });

  it("never proxies the bridge's own server, even for a broad grant", () => {
    const f = jobFixture();
    const bridge = join(f.root, "bridge-plugin");
    mkdirSync(bridge);
    writeFileSync(join(bridge, ".mcp.json"), JSON.stringify({ bridge: { command: "must-not-launch" } }));
    writeFileSync(join(f.configDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: {
      "fixture@market": [{ installPath: f.plugin, scope: "user" }],
      "agent-bridge@market": [{ installPath: bridge, scope: "user" }],
    } }));
    for (const grant of ["*", "b*", "plugin_agent-bridge_bridge"]) {
      expect(grantedPluginServers(f.root, [grant], f.configDir).map((s) => s.name)).not.toContain("plugin_agent-bridge_bridge");
    }
    expect(grantedPluginServers(f.root, ["*"], f.configDir).map((s) => s.name)).toContain("plugin_fixture_pair-desk");
  });

  it("releases stdio and IPC but kills nothing when the root identity cannot be verified", async () => {
    const f = jobFixture();
    const transport = new OwnedMcpStdio({ command: process.execPath, args: [join(f.plugin, "upstream.cjs")],
      env: { ...process.env, CALLS: f.calls }, cwd: f.root, log: nullLogger, signal: new AbortController().signal });
    await transport.start();
    const child = (transport as any).child as import("node:child_process").ChildProcess;
    const identity = await readProcessIdentity(child.pid!);
    (transport as any).identity = "forged-identity"; // simulate a PID whose creation identity no longer matches
    // Keep the root running through close: the job cleanup would otherwise end its only child and let it exit.
    (transport as any).scope?.detach();
    (transport as any).scope = undefined;
    try {
      await expect(transport.close()).rejects.toThrow("Cannot verify plugin MCP root identity");
      expect(child.stdin!.destroyed).toBe(true);
      expect(child.stdout!.destroyed).toBe(true);
      expect(child.connected).toBe(false);
      expect(child.killed).toBe(false);
      expect(child.signalCode).toBeNull();
    } finally {
      // Fixture cleanup only for this test-created root with its recorded identity.
      if (identity && await readProcessIdentity(child.pid!) === identity) process.kill(child.pid!, "SIGKILL");
    }
  });

  it("compares physical project paths without inventing drive aliases or folding case-sensitive folders", () => {
    const f = jobFixture();
    const physical = join(f.root, "Project");
    const different = join(f.root, "project");
    const alias = join(f.root, "alias");
    mkdirSync(physical); symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");
    const install = (projectPath: string) => writeFileSync(join(f.configDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "fixture@market": [{ installPath: f.plugin, projectPath }] } }));
    install(physical);
    expect(grantedPluginServers(alias, ["pair-desk.get_issue"], f.configDir)).toHaveLength(1);
    // Realpath proves aliases. Unrelated drive spellings must stay unrelated, even on Windows.
    install("E:/independent-project");
    const actual = realpathSync.native;
    vi.spyOn(realpathSync, "native").mockImplementation((path: any) => {
      if (/^[DE]:[\\/]independent-project$/i.test(String(path))) return String(path) as any;
      return actual(path);
    });
    expect(grantedPluginServers("D:/independent-project", ["pair-desk.get_issue"], f.configDir)).toHaveLength(0);
    vi.restoreAllMocks();
    if (process.platform !== "win32" && !existsSync(different)) {
      mkdirSync(different); install(physical);
      expect(grantedPluginServers(different, ["pair-desk.get_issue"], f.configDir)).toHaveLength(0);
    }
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
