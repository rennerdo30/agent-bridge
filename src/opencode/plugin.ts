/**
 * agent-bridge for opencode.
 *
 * opencode has no hooks for MCP servers to push into a session, but plugins can. This plugin starts the
 * agent-bridge server (the same one the Claude Code and Codex plugins use) as a child process, talks
 * to it over MCP, exposes its tools as native opencode tools, and delivers peer messages:
 *  - while the session is working: appended to the system prompt of the next model step
 *  - when the session goes idle: the server's Stop logic decides (listen window / auto-wake), and the
 *    plugin starts a new turn with client.session.promptAsync
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z as bundledZod } from "zod";
import { APP_VERSION, ENV } from "../core/constants.js";
import { jsonSchemaToZodShape, type JsonSchema } from "./schema.js";

const OPENCODE_NOTIFICATION = "notifications/agent-bridge/message";
/** Tool names in opencode: bridge_peers, bridge_send, ... */
const TOOL_PREFIX = "bridge_";
/** The internal hook endpoint is called by this plugin, never by the model. */
const HIDDEN_TOOLS = new Set(["hook_event"]);
/** MCP requests may legitimately run long (delegation, wait_for_message, Stop listen window). */
const MCP_REQUEST_TIMEOUT_MS = 3_700_000;
const SERVER_DIR = "agent-bridge";
const SERVER_FILE = "server.mjs";
const LOG_FILE = "opencode-plugin.log";
/** Distinguishes plugin copies that opencode loads in separate JS contexts of one process. */
const INSTANCE = Math.random().toString(36).slice(2, 8);
/** Resolved at runtime from opencode's config dir (opencode installs it there); optional. */
const OPENCODE_PLUGIN_PACKAGE: string = "@opencode-ai/plugin";

type Json = Record<string, unknown>;

interface PluginInput {
  client: any;
  directory: string;
  worktree?: string;
}

interface OpencodeEvent {
  type: string;
  properties?: any;
}

interface ToolContext {
  sessionID: string;
  abort: AbortSignal;
}

function makeLog(): (level: string, msg: string, data?: Json) => void {
  const home = process.env[ENV.home]?.trim() || join(homedir(), ".agent-bridge");
  const file = join(home, "logs", LOG_FILE);
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    // logging is best effort
  }
  return (level, msg, data) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [opencode-plugin] pid=${process.pid} inst=${INSTANCE} ${msg}${data ? " " + JSON.stringify(data) : ""}\n`);
    } catch {
      // ignore
    }
  };
}

function textOf(result: any): string {
  return (result?.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

/** Works with both the v1 SDK ({path, body}) and the v2 SDK (flat) session APIs. */
async function promptAsync(client: any, sessionID: string, text: string, noReply: boolean): Promise<void> {
  const body = { parts: [{ type: "text", text }], ...(noReply ? { noReply: true } : {}) };
  await client.session.promptAsync({ path: { id: sessionID }, body, sessionID, ...body });
}

async function loadZod(): Promise<typeof bundledZod> {
  try {
    // Prefer opencode's own zod so tool schemas convert exactly as opencode expects.
    const mod: any = await import(OPENCODE_PLUGIN_PACKAGE);
    if (mod?.tool?.schema) return mod.tool.schema;
  } catch {
    // Not resolvable from this plugin's location; the bundled zod 4 is compatible.
  }
  return bundledZod;
}

type Hooks = Awaited<ReturnType<typeof createBridge>>;
interface SharedEntry {
  refs: number;
  hooks: Promise<Hooks>;
}
/** opencode can initialize a plugin more than once per process; share one bridge per directory. */
const REGISTRY_KEY = Symbol.for("agent-bridge.opencode.registry");
const registry: Map<string, SharedEntry> = ((globalThis as any)[REGISTRY_KEY] ??= new Map());

export const AgentBridgePlugin = async (input: PluginInput) => {
  const key = input.directory.toLowerCase();
  let entry = registry.get(key);
  if (!entry) {
    entry = { refs: 0, hooks: createBridge(input) };
    registry.set(key, entry);
    entry.hooks.catch(() => registry.delete(key));
  }
  entry.refs++;
  const hooks = await entry.hooks;
  let disposed = false;
  return {
    ...hooks,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      const current = registry.get(key);
      if (current && --current.refs <= 0) {
        registry.delete(key);
        await hooks.dispose();
      }
    },
  };
};

async function createBridge({ client, directory }: PluginInput) {
  const log = makeLog();
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = process.env.AGENT_BRIDGE_OPENCODE_SERVER || (existsSync(join(here, SERVER_FILE)) ? join(here, SERVER_FILE) : join(here, SERVER_DIR, SERVER_FILE));
  const nodeBin = process.env.AGENT_BRIDGE_NODE || "node";
  log("info", "starting", { version: APP_VERSION, directory, serverPath });

  const transport = new StdioClientTransport({
    command: nodeBin,
    args: [serverPath, "--agent=opencode"],
    cwd: directory,
    env: { ...(process.env as Record<string, string>) },
    stderr: "ignore",
  });
  const mcp = new Client({ name: "agent-bridge-opencode", version: APP_VERSION });

  // --- session tracking -----------------------------------------------------------------------
  let activeSession: string | null = null;
  const childSessions = new Set<string>();
  const busy = new Map<string, boolean>();
  let stopCheckRunning = false;
  let sessionStartSent = false;

  const hook = async (event: string, sessionID: string | null, signal?: AbortSignal): Promise<any> => {
    try {
      const res = await mcp.callTool(
        { name: "hook_event", arguments: { event, ...(sessionID ? { session_id: sessionID } : {}), cwd: directory } },
        undefined,
        { timeout: MCP_REQUEST_TIMEOUT_MS, signal },
      );
      const raw = textOf(res);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      log("warn", "hook call failed", { event, err: String((err as Error)?.message ?? err) });
      return {};
    }
  };

  const noteSession = (sessionID: string | undefined) => {
    if (!sessionID || childSessions.has(sessionID)) return;
    activeSession = sessionID;
    if (!sessionStartSent) {
      sessionStartSent = true;
      void hook("SessionStart", sessionID);
    }
  };

  /** Session went idle or mail arrived while idle: let the server decide whether to continue. */
  const stopCheck = async (sessionID: string) => {
    if (stopCheckRunning) return;
    stopCheckRunning = true;
    try {
      const out = await hook("Stop", sessionID);
      if (out?.decision === "block" && typeof out.reason === "string") {
        const stillIdle = !busy.get(sessionID);
        log("info", stillIdle ? "starting a turn for peer messages" : "adding peer messages to a busy session", { sessionID });
        await promptAsync(client, sessionID, out.reason, !stillIdle);
      }
    } catch (err) {
      log("warn", "stop check failed", { err: String((err as Error)?.message ?? err) });
    } finally {
      stopCheckRunning = false;
    }
  };

  mcp.setNotificationHandler(
    bundledZod.object({ method: bundledZod.literal(OPENCODE_NOTIFICATION), params: bundledZod.any().optional() }),
    async () => {
      if (activeSession && !busy.get(activeSession)) void stopCheck(activeSession);
    },
  );

  await mcp.connect(transport);
  const { tools: mcpTools } = await mcp.listTools();
  const z = await loadZod();

  const tool: Record<string, unknown> = {};
  for (const t of mcpTools) {
    if (HIDDEN_TOOLS.has(t.name)) continue;
    const name = t.name;
    tool[`${TOOL_PREFIX}${name}`] = {
      description: `[agent-bridge] ${t.description ?? name}`,
      args: jsonSchemaToZodShape(z as any, t.inputSchema as JsonSchema),
      execute: async (args: Json, ctx: ToolContext) => {
        log("debug", "tool", { name, sessionID: ctx?.sessionID });
        noteSession(ctx?.sessionID);
        const res: any = await mcp.callTool({ name, arguments: args }, undefined, { timeout: MCP_REQUEST_TIMEOUT_MS, signal: ctx?.abort });
        const out = textOf(res);
        if (res?.isError) throw new Error(out || `agent-bridge ${name} failed`);
        return out;
      },
    };
  }
  log("info", "ready", { tools: Object.keys(tool) });

  return {
    tool,

    "chat.message": async (input: { sessionID: string }) => {
      log("debug", "chat.message", { sessionID: input?.sessionID });
      noteSession(input?.sessionID);
    },

    /** After each tool call: mail that arrived meanwhile goes into that tool's result, where the model reads it. */
    "tool.execute.after": async (input: { sessionID?: string }, output: { output?: unknown }) => {
      const sessionID = input?.sessionID;
      if (!sessionID || childSessions.has(sessionID) || typeof output?.output !== "string") return;
      noteSession(sessionID);
      const out = await hook("PostToolUse", sessionID);
      const context = out?.reason ?? out?.hookSpecificOutput?.additionalContext;
      if (typeof context !== "string" || !context) return;
      // A real user message in the running session (models discount instructions inside tool results);
      // the tool result only as a fallback.
      try {
        await promptAsync(client, sessionID, context, true);
      } catch (err) {
        log("warn", "could not add the message to the session; appending it to the tool result", { err: String((err as Error)?.message ?? err) });
        output.output = `${output.output}\n\n${context}`;
      }
    },

    /**
     * Runs before every model step: deliver mail that arrived while the session is working. The hook marks
     * it read, but a system prompt is not stored: if this step fails (provider error, abort) the mail would
     * be gone. So it is also added to the session as a message (like after a tool call), which persists;
     * the system prompt still shows it to this very step.
     */
    "experimental.chat.system.transform": async (input: { sessionID?: string }, output: { system: string[] }) => {
      const sessionID = input?.sessionID;
      if (!sessionID || childSessions.has(sessionID)) return;
      noteSession(sessionID);
      const out = await hook("PostToolUse", sessionID);
      const context = out?.hookSpecificOutput?.additionalContext;
      if (typeof context !== "string" || !context) return;
      output.system.push(context);
      try {
        await promptAsync(client, sessionID, context, true);
      } catch (err) {
        log("warn", "could not store peer messages in the session; they reach only this step's system prompt", { err: String((err as Error)?.message ?? err) });
      }
    },

    event: async ({ event }: { event: OpencodeEvent }) => {
      if (event?.type?.startsWith("session.")) log("debug", "event", { type: event.type, sessionID: event.properties?.sessionID ?? event.properties?.info?.id });
      const p = event?.properties ?? {};
      switch (event?.type) {
        case "session.created":
          if (p.info?.parentID && p.info?.id) childSessions.add(p.info.id);
          break;
        case "session.status": {
          const id = p.sessionID;
          if (!id) break;
          const isBusy = p.status?.type !== "idle";
          busy.set(id, isBusy);
          if (!isBusy && id === activeSession) void stopCheck(id);
          break;
        }
        case "session.idle":
          if (p.sessionID) {
            busy.set(p.sessionID, false);
            if (p.sessionID === activeSession) void stopCheck(p.sessionID);
          }
          break;
      }
    },

    dispose: async () => {
      log("info", "disposing");
      await mcp.close().catch(() => {});
    },
  };
};
