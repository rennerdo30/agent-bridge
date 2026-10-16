import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { OwnedMcpStdio } from "./owned-mcp-stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { hasServerGrant, isInventoryToolGranted } from "./tool-allow.js";
import { readBodyText } from "./http-body.js";
import { tokensEqual } from "./token.js";
import type { Logger } from "./logger.js";
import { projectKey } from "./project-identity.js";
import { realFolder } from "./delegate.js";
import { OWN_SERVER_RULE } from "./claude-mcp.js";

const TOKEN_ENV = "AGENT_BRIDGE_CLAUDE_MCP_TOKEN";
const TIMEOUT_MS = 30_000;
type PluginServer = { name: string; root: string; config: Record<string, any> };
function json(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
function inProject(cwd: string, project: string): boolean {
  const path = relative(projectKey(realFolder(resolve(project))), projectKey(realFolder(resolve(cwd))));
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
}

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
      if (entry.projectPath && !inProject(cwd, entry.projectPath)) continue;
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
        // The bridge's own server stays ambient: proxying it would deny the parent's send/report_progress.
        if (`mcp__${name}` === OWN_SERVER_RULE) continue;
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
 *
 * requiredPatterns (default: all of patterns) are the grants the caller asked for explicitly; a server they
 * select must load or the job fails. A server selected only by the other patterns (the configured default
 * allowance of jobs, AB-403) is optional: when it cannot start in time it is skipped with a warning.
 */
export async function startClaudeJobMcp(options: {
  cwd: string; patterns: readonly string[]; requiredPatterns?: readonly string[]; env: NodeJS.ProcessEnv; log: Logger; signal?: AbortSignal; timeoutMs?: number;
}) {
  const required = (name: string) => !options.requiredPatterns || hasServerGrant(name, options.requiredPatterns);
  // Required servers first, so an optional server that uses up the time limit cannot fail a required one.
  const plugins = grantedPluginServers(options.cwd, options.patterns, options.env.CLAUDE_CONFIG_DIR)
    .sort((a, b) => Number(required(b.name)) - Number(required(a.name)));
  const clients: Client[] = [];
  const transports: Transport[] = [];
  let http: Server | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    options.signal?.removeEventListener("abort", abort);
    http?.closeAllConnections();
    if (http?.listening) await new Promise<void>((done) => http!.close(() => done()));
    // Kill owned trees before closing protocol streams: a launcher exiting on EOF can orphan children.
    const closed = await Promise.allSettled(transports.map((transport) => transport.close()));
    await Promise.allSettled(clients.map((client) => client.close()));
    const failed = closed.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw new Error("Plugin MCP process cleanup failed", { cause: failed.reason });
  })();
  const abort = () => { void stop().catch(() => options.log.warn("Plugin MCP cancellation cleanup failed")); };
  const timeout = options.timeoutMs ?? TIMEOUT_MS;
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(timeout)]);
  const views: { name: string; client: Client; tools: Tool[] }[] = [];
  const connect = async (plugin: PluginServer): Promise<void> => {
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
        transport = new OwnedMcpStdio({ command, args: (cfg.args ?? []).map(expandValue),
          env: { ...options.env, ...record(cfg.env), CLAUDE_PLUGIN_ROOT: plugin.root }, cwd: options.cwd, log: options.log, signal });
      } else if (cfg.type === "http" || cfg.type === "sse") {
        const url = new URL(expandValue(cfg.url));
        const requestInit = { headers: record(cfg.headers) };
        transport = cfg.type === "http" ? new StreamableHTTPClientTransport(url, { requestInit }) : new SSEClientTransport(url, { requestInit });
      } else throw new Error(`Unsupported granted MCP transport for ${plugin.name}`);
      const client = new Client({ name: "agent-bridge-job", version: "1" });
      clients.push(client);
      transports.push(transport);
      // SDK connect awaits transport.start before its request deadline applies (notably SSE endpoint).
      let cancel: () => void;
      await new Promise<void>((done, reject) => {
        cancel = () => { void transport.close().catch(() => {}); reject(signal.reason); };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        else void client.connect(transport, { timeout, signal }).then(done, reject);
      }).finally(() => signal.removeEventListener("abort", cancel));
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout, signal });
        tools.push(...page.tools.filter((tool) => {
          if (!/^[\w.-]+$/.test(tool.name)) return false;
          return isInventoryToolGranted(plugin.name, tool.name, options.patterns) && !/(set|update)_handoff$/i.test(tool.name);
        }));
        cursor = page.nextCursor;
      } while (cursor);
      views.push({ name: `job_${plugin.name}`, client, tools });
  };
  try {
    for (const plugin of plugins) {
      const before = { clients: clients.length, transports: transports.length };
      try {
        await connect(plugin);
      } catch (error) {
        // A cancelled job and an explicitly granted server keep failing the job (no unfiltered fallback).
        if (required(plugin.name) || options.signal?.aborted) throw error;
        // Default-only grant (AB-403): the job runs without this server instead of failing.
        const failedTransports = transports.splice(before.transports);
        const failedClients = clients.splice(before.clients);
        const closed = await Promise.allSettled(failedTransports.map((transport) => transport.close()));
        await Promise.allSettled(failedClients.map((client) => client.close()));
        // A server whose process tree cannot be verified as closed must not be left behind silently.
        const leaked = closed.find((result) => result.status === "rejected");
        if (leaked?.status === "rejected") throw leaked.reason;
        options.log.warn("default-granted plugin MCP server did not start; the job runs without it", {
          // Never the error text: it may carry upstream configuration (URLs, headers).
          server: plugin.name, reason: signal.aborted ? "timeout" : "launch failed",
        });
      }
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
