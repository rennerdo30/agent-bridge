import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { hasServerGrant, isAutoApproved, isHandoffToolCall } from "./tool-allow.js";
import { readBodyText } from "./http-body.js";
import { tokensEqual } from "./token.js";
import type { Logger } from "./logger.js";

const TOKEN_ENV = "AGENT_BRIDGE_CLAUDE_MCP_TOKEN";
const TIMEOUT_MS = 30_000;
type PluginServer = { name: string; root: string; config: Record<string, any> };
function json(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
const norm = (p: string) => resolve(p).replace(/\\/g, "/").replace(/^d:/i, "e:").toLowerCase();

/** Resolve installed plugin declarations without relying on the job's ambient plugin discovery. */
export function grantedPluginServers(cwd: string, patterns: readonly string[], configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")): PluginServer[] {
  const installed = json(join(configDir, "plugins", "installed_plugins.json"));
  const selected = new Map<string, PluginServer>();
  if (!patterns.length) return [];
  for (const [key, entries] of Object.entries<any>(installed?.plugins ?? {})) {
    const plugin = key.split("@")[0]!;
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      const root = entry?.installPath;
      if (typeof root !== "string") continue;
      if (entry.projectPath && norm(cwd) !== norm(entry.projectPath) && !norm(cwd).startsWith(norm(entry.projectPath) + "/")) continue;
      const manifest = json(join(root, ".claude-plugin", "plugin.json"));
      const servers: Record<string, any> = {};
      const merge = (value: any): void => {
        if (Array.isArray(value)) { value.forEach(merge); return; }
        if (typeof value === "string") {
          if (!value.endsWith(".json")) return;
          merge(json(resolve(root, value))); return;
        }
        if (value && typeof value === "object") Object.assign(servers, value.mcpServers ?? value);
      };
      merge(json(join(root, ".mcp.json")));
      merge(manifest?.mcpServers);
      for (const [server, config] of Object.entries<any>(servers)) {
        const name = `plugin_${plugin}_${server}`;
        if (hasServerGrant(name, patterns)) selected.set(name, { name, root, config });
      }
    }
  }
  return [...selected.values()];
}

function expand(value: string, root: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
    if (key === "CLAUDE_PLUGIN_ROOT") return root;
    const [name, fallback] = key.split(":-");
    const result = env[name!] ?? fallback;
    if (result === undefined) throw new Error(`Missing plugin MCP variable ${name}`);
    return result;
  });
}

/** A run-local MCP view: only granted tools are listed AND callable, even in bypass mode.
 * The upstream configuration never goes into CLI args, logs or temporary files.
 */
export async function startClaudeJobMcp(options: {
  cwd: string; patterns: readonly string[]; env: NodeJS.ProcessEnv; log: Logger; signal?: AbortSignal; timeoutMs?: number;
}) {
  const plugins = grantedPluginServers(options.cwd, options.patterns, options.env.CLAUDE_CONFIG_DIR);
  const clients: Client[] = [];
  let http: Server | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    options.signal?.removeEventListener("abort", abort);
    http?.closeAllConnections();
    if (http?.listening) await new Promise<void>((done) => http!.close(() => done()));
    await Promise.allSettled(clients.map((client) => client.close()));
  })();
  const abort = () => { void stop(); };
  const timeout = options.timeoutMs ?? TIMEOUT_MS;
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(timeout)]);
  const views: { name: string; client: Client; tools: Tool[] }[] = [];
  try {
    for (const plugin of plugins) {
      signal.throwIfAborted();
      const cfg = plugin.config;
      if (!/^[\w-]+$/.test(plugin.name)) throw new Error("Unsupported plugin MCP server name");
      const expandValue = (s: string) => expand(s, plugin.root, options.env);
      const record = (values: Record<string, string> = {}) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, expandValue(v)]));
      let transport: Transport;
      if (!cfg.type || cfg.type === "stdio") {
        if (typeof cfg.command !== "string") throw new Error(`Missing command for granted MCP server ${plugin.name}`);
        let command = expandValue(cfg.command);
        // Plugins commonly ship an extensionless shell launcher beside a Windows launcher.
        if (process.platform === "win32" && existsSync(`${command}.cmd`)) command += ".cmd";
        transport = new StdioClientTransport({ command, args: (cfg.args ?? []).map(expandValue),
          env: { ...options.env, ...record(cfg.env), CLAUDE_PLUGIN_ROOT: plugin.root } as Record<string, string>, cwd: options.cwd, stderr: "ignore" });
      } else if (cfg.type === "http" || cfg.type === "sse") {
        const url = new URL(expandValue(cfg.url));
        const requestInit = { headers: record(cfg.headers) };
        transport = cfg.type === "http" ? new StreamableHTTPClientTransport(url, { requestInit }) : new SSEClientTransport(url, { requestInit });
      } else throw new Error(`Unsupported granted MCP transport for ${plugin.name}`);
      const client = new Client({ name: "agent-bridge-job", version: "1" });
      clients.push(client);
      try { await client.connect(transport, { timeout, signal }); }
      finally {
        if (transport instanceof StdioClientTransport) options.log.info("started granted plugin MCP", { server: plugin.name, pid: transport.pid });
      }
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout, signal });
        tools.push(...page.tools.filter((tool) => {
          if (!/^[\w.-]+$/.test(tool.name)) return false;
          const call = { tool: `mcp:${plugin.name}`, detail: `${tool.name}: {}` };
          return isAutoApproved(call, options.patterns) && !isHandoffToolCall(call);
        }));
        cursor = page.nextCursor;
      } while (cursor);
      views.push({ name: `job_${plugin.name}`, client, tools });
    }
    const token = randomBytes(24).toString("hex");
    const config: Record<string, unknown> = {};
    if (views.length) {
      http = createServer(async (req, res) => {
        if (!tokensEqual(req.headers.authorization ?? "", `Bearer ${token}`)) { res.writeHead(401).end(); return; }
        const view = views.find((v) => req.url === `/${v.name}`);
        if (!view) { res.writeHead(404).end(); return; }
        if (req.method !== "POST") { res.writeHead(405).end(); return; }
        let message: any;
        try {
          message = JSON.parse(await readBodyText(req, 1024 * 1024));
          if (message.id === undefined) { res.writeHead(202).end(); return; }
          let result: unknown;
          if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: view.name, version: "1" } };
          else if (message.method === "ping") result = {};
          else if (message.method === "tools/list") result = { tools: view.tools };
          else if (message.method === "tools/call" && view.tools.some((t) => t.name === message.params?.name)) {
            result = await view.client.callTool(message.params, undefined, { timeout, signal: options.signal });
          } else throw new Error("Tool or method not granted to this job");
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        } catch {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32601, message: "Tool or method not granted, or upstream unavailable" } }));
        }
      });
      http.requestTimeout = timeout;
      await new Promise<void>((done, reject) => { http!.once("error", reject); http!.listen(0, "127.0.0.1", done); });
      const port = (http.address() as AddressInfo).port;
      for (const view of views) config[view.name] = { type: "http", url: `http://127.0.0.1:${port}/${view.name}`, headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } };
    }
    const env: Record<string, string> = views.length ? { [TOKEN_ENV]: token } : {};
    options.signal?.throwIfAborted();
    options.signal?.addEventListener("abort", abort, { once: true });
    return { config, env,
      allowed: views.flatMap((v) => v.tools.map((t) => `mcp__${v.name}__${t.name}`)),
      denied: plugins.map((p) => `mcp__${p.name}`), stop };
  } catch {
    await stop();
    throw new Error("Could not load granted Claude plugin MCP servers; refusing an unfiltered fallback");
  }
}
