import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { APP_VERSION } from "./constants.js";
import { t3BindingSchema, type T3Binding } from "./t3-identity.js";

const id = z.string().min(1).max(512);
export const t3RequestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
export const t3Mode = z.enum(["auto", "queue", "steer", "restart"]);
const runtimeMode = z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const option = z.discriminatedUnion("type", [
  z.object({ id, label: id, type: z.literal("boolean"), currentValue: z.boolean().nullable().optional() }),
  z.object({ id, label: id, type: z.literal("select"), currentValue: id.nullable().optional(),
    options: z.array(z.object({ id, label: id, isDefault: z.boolean().nullable().optional() })).max(256),
    promptInjectedValues: z.array(id).max(256).nullable().optional() }),
]);
const capabilitiesSchema = z.object({
  parentThreadId: id, inheritedProviderInstanceId: id, inheritedModel: id.nullable(),
  runtimeMode, interactionMode: z.enum(["default", "plan"]),
  features: z.object({ appOwnedSubagents: z.boolean(), cancellation: z.boolean(), threadManagement: z.boolean() }),
  providers: z.array(z.object({ providerInstanceId: id, driverKind: id, displayName: id.nullable(),
    canRunChildTask: z.boolean(), canRunCrossProviderChildTask: z.boolean(), constraints: z.array(z.string().max(4096)).max(64),
    runtimeModes: z.array(runtimeMode).max(4).nullable().optional(),
    models: z.array(z.object({ id, label: id.nullable(), options: z.array(option).max(64).nullable().optional() })).max(1024),
  })).max(128),
});
export type T3Capabilities = z.infer<typeof capabilitiesSchema>;
const taskStatus = z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled", "interrupted"]);
const taskSchema = z.object({
  taskId: id, childNodeId: id, childThreadId: id, childRunId: id.nullable(),
  status: taskStatus, workState: z.enum(["working", "waiting_for_children", "result_available"]),
  hasPendingChildRuns: z.boolean(), hasPendingQuestion: z.boolean(), waitTimedOut: z.boolean(),
  summary: z.string().max(256_000).nullable(), providerInstanceId: id, model: id.nullable(),
  resultContextTransferId: id.nullable(), latestTerminalResultContextTransferId: id.nullable(),
  latestTerminalRunId: id.nullable(), latestTerminalStatus: taskStatus.exclude(["queued", "running", "waiting"]).nullable(),
  latestTerminalSummary: z.string().max(256_000).nullable(),
});
const sendSchema = z.object({
  threadId: id, delivery: z.enum(["started", "queued", "steered", "restarted"]),
  messageId: id, runId: id, taskId: id.nullable().optional(),
  status: z.enum(["preparing", "queued", "starting", "running", "waiting", "completed", "interrupted", "failed", "cancelled", "rolled_back"]),
});
export const t3DelegateInput = z.object({
  task: z.string().min(1).max(64_000), clientRequestId: t3RequestId,
  title: z.string().min(1).max(80).optional(),
  role: z.enum(["implementation", "research", "review", "design", "test", "general"]).optional(),
  isolation: z.enum(["shared", "worktree"]).default("worktree"),
  interactionMode: z.enum(["inherit", "default", "plan"]).optional(),
  // This adapter never raises permission modes. T3 also enforces the caller's native policy.
  target: z.object({ providerInstanceId: id, model: id,
    options: z.array(z.object({ id, value: z.union([z.string().max(512), z.boolean()]) })).max(64).optional(),
  }).optional(),
}).strict();
export type T3DelegateInput = z.input<typeof t3DelegateInput>;

export const T3_TOOL_NAMES = ["orchestrator_capabilities", "t3_thread_list", "t3_thread_send", "delegate_task", "task_status", "task_cancel"] as const;
type T3Tool = typeof T3_TOOL_NAMES[number];
const allowedTools = new Set<string>(T3_TOOL_NAMES);
const DEADLINE_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** No raw SDK, response-body, URL or authorization errors leave this module. */
export class T3HostError extends Error {
  constructor(readonly stage: "unavailable" | "refused" | "unknown", readonly operation: string) {
    super(stage === "unknown"
      ? `T3 ${operation} outcome unknown; retain its clientRequestId and inspect T3 before any retry. No native fallback was attempted.`
      : `T3 ${operation} ${stage}; requires explicit AGENT_BRIDGE_HOST=t3, valid scoped ACP transport and matching parent capabilities. No native fallback was attempted.`);
  }
}
export interface T3TransportConfig { endpoint: URL; authorization: string; scope: string }
export function t3TransportFromEnv(env: NodeJS.ProcessEnv = process.env): T3TransportConfig | undefined {
  if (env.AGENT_BRIDGE_HOST !== "t3") return undefined;
  const fail = () => new T3HostError("unavailable", "transport");
  const endpoint = env.T3_ACP_MCP_ENDPOINT, authorization = env.T3_ACP_MCP_AUTHORIZATION;
  if (!endpoint || endpoint.length > 2048 || !authorization?.trim() || authorization.length > 8192 || /[\x00-\x20\x7f]/.test(endpoint) || /[^\x20-\x7e]/.test(authorization)) throw fail();
  let url: URL;
  try { url = new URL(endpoint); } catch { throw fail(); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" &&
    !(url.protocol === "http:" && /^http:\/\/(127\.0\.0\.1|\[::1\])(:\d+)?\//.test(endpoint)))) throw fail();
  return { endpoint: url, authorization, scope: createHash("sha256").update(url.href).digest("hex") };
}

/** Injectable, bounded MCP connection for fixture replay; no generic RPC surface is exposed as a tool. */
export interface T3Connection {
  listTools(cursor?: string): Promise<{ tools: { name: string }[]; nextCursor?: string }>;
  callTool(name: T3Tool, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export type T3Connect = (config: T3TransportConfig, signal: AbortSignal) => Promise<T3Connection>;

async function closeConnection(connection: T3Connection | undefined): Promise<void> {
  if (!connection) return;
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([connection.close().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); timer.unref(); })]); }
  finally { if (timer) clearTimeout(timer); }
}

const connectMcp: T3Connect = async (config, signal) => {
  const client = new Client({ name: "agent-bridge-t3", version: APP_VERSION }, { capabilities: {} });
  // MCP's optional notification GET must not become a watcher or reconnect loop.
  const transport = new StreamableHTTPClientTransport(config.endpoint, {
    requestInit: { headers: { authorization: config.authorization }, redirect: "error" },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
    fetch: async (input, init) => {
      if (String(input) !== config.endpoint.href) throw new Error("T3 transport target refused");
      if (init?.method === "GET") return new Response(null, { status: 405 });
      const response = await fetch(input, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
      if (!response.body) return response;
      let bytes = 0;
      return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error("T3 response limit");
        controller.enqueue(chunk);
      } })), { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
  const opts = { signal, timeout: DEADLINE_MS, maxTotalTimeout: DEADLINE_MS };
  try { await client.connect(transport, opts); }
  catch { await client.close().catch(() => {}); throw new T3HostError("unavailable", "connect"); }
  return {
    listTools: cursor => client.listTools(cursor ? { cursor } : {}, opts),
    callTool: (name, args) => client.callTool({ name, arguments: args }, undefined, opts),
    close: () => client.close(),
  };
};

function decode<S extends z.ZodType>(schema: S, result: unknown): z.output<S> {
  const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().max(MAX_RESPONSE_BYTES).optional() })).max(16) }).parse(result);
  if (envelope.isError) throw new Error("T3 rejected tool");
  if (envelope.structuredContent !== undefined) return schema.parse(envelope.structuredContent);
  if (envelope.content.length !== 1 || envelope.content[0]?.type !== "text") throw new Error("T3 result shape");
  return schema.parse(JSON.parse(envelope.content[0].text ?? ""));
}

export class T3Host {
  private bindingValue?: T3Binding;
  private readonly active = new Set<AbortController>();
  private stopped = false;
  constructor(private readonly config: T3TransportConfig, private readonly connect: T3Connect = connectMcp) {}
  get binding(): T3Binding { if (!this.bindingValue) throw new T3HostError("unavailable", "binding"); return { ...this.bindingValue }; }

  private async session<T>(operation: string, fn: (call: <S extends z.ZodType>(name: T3Tool, args: Record<string, unknown>, schema: S, effect?: boolean) => Promise<z.output<S>>, caps: T3Capabilities, names: Set<string>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.stopped || signal?.aborted) throw new T3HostError("unavailable", operation);
    const controller = new AbortController(); this.active.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS); timer.unref();
    let connection: T3Connection | undefined, submitted = false;
    try {
      // Also bound injected transports that ignore AbortSignal.
      const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("T3 deadline")), { once: true }));
      const opening = this.connect(this.config, controller.signal);
      void opening.then(late => { if (controller.signal.aborted) void late.close().catch(() => {}); }, () => {});
      connection = await Promise.race([opening, aborted]);
      const request = <R>(promise: Promise<R>) => Promise.race([promise, aborted]);
      const names = new Set<string>(); let cursor: string | undefined;
      for (let page = 0; page < 8; page++) {
        const listed = await request(connection.listTools(cursor));
        if (listed.tools.length > 1024) throw new Error("T3 tool limit");
        for (const tool of listed.tools) names.add(tool.name);
        cursor = listed.nextCursor;
        if (!cursor) break;
      }
      if (cursor || !names.has("orchestrator_capabilities") || !names.has("t3_thread_list")) throw new Error("T3 capabilities missing");
      const call = async <S extends z.ZodType>(name: T3Tool, args: Record<string, unknown>, schema: S, effect = false): Promise<z.output<S>> => {
        if (!allowedTools.has(name) || !names.has(name) || controller.signal.aborted) throw new Error("T3 tool unavailable");
        if (effect) submitted = true;
        return decode(schema, await request(connection!.callTool(name, args)));
      };
      const caps = await call("orchestrator_capabilities", {}, capabilitiesSchema);
      const listed = await call("t3_thread_list", { limit: 1, includeSubagents: true }, z.object({ currentThreadId: id, projectId: id }));
      if (caps.parentThreadId !== listed.currentThreadId) throw new Error("T3 wrong parent");
      const binding = t3BindingSchema.parse({ kind: "t3", scope: this.config.scope, threadId: caps.parentThreadId, providerInstanceId: caps.inheritedProviderInstanceId });
      if (this.bindingValue && JSON.stringify(this.bindingValue) !== JSON.stringify(binding)) throw new Error("T3 binding changed");
      this.bindingValue = binding;
      return await fn(call, caps, names);
    } catch {
      throw new T3HostError(submitted ? "unknown" : "refused", operation);
    } finally {
      controller.abort(); clearTimeout(timer); this.active.delete(controller);
      signal?.removeEventListener("abort", abort);
      // Client.close aborts HTTP/SSE locally; it does not cancel app-owned tasks.
      await closeConnection(connection);
    }
  }

  capabilities(signal?: AbortSignal) {
    return this.session("capabilities", async (_call, capabilities, names) => ({ binding: this.binding, capabilities,
      tools: T3_TOOL_NAMES.filter(name => names.has(name)), ownership: "t3" as const }), signal);
  }
  send(input: { message: string; clientRequestId: string; mode?: z.infer<typeof t3Mode>; taskId?: string }, signal?: AbortSignal) {
    const args = z.object({ message: z.string().min(1).max(64_000), clientRequestId: t3RequestId, mode: t3Mode.default("queue"), taskId: id.optional() }).strict().parse(input);
    return this.session("send", async (call, caps) => {
      if (!caps.features.threadManagement) throw new Error("T3 messaging unavailable");
      // A child target is resolved only from this caller's T3-owned task, never an arbitrary thread ID.
      const task = args.taskId ? await call("task_status", { taskId: args.taskId }, taskSchema) : undefined;
      if (task && task.taskId !== args.taskId) throw new Error("T3 wrong task");
      const threadId = task?.childThreadId ?? this.binding.threadId;
      const receipt = await call("t3_thread_send", { threadId, message: args.message, mode: args.mode, clientRequestId: args.clientRequestId }, sendSchema, true);
      if (receipt.threadId !== threadId) throw new Error("T3 wrong receipt");
      return { ownership: "t3" as const, clientRequestId: args.clientRequestId, receipt, consumption: "unconfirmed" as const };
    }, signal);
  }
  delegate(input: T3DelegateInput, signal?: AbortSignal) {
    const args = t3DelegateInput.parse(input);
    return this.session("delegate", async (call, caps) => {
      if (!caps.features.appOwnedSubagents) throw new Error("T3 delegation unavailable");
      const selected = args.target?.providerInstanceId ?? caps.inheritedProviderInstanceId;
      const provider = caps.providers.find(p => p.providerInstanceId === selected);
      if (!provider?.canRunChildTask || selected !== caps.inheritedProviderInstanceId && !provider.canRunCrossProviderChildTask) throw new Error("T3 provider unavailable");
      const model = provider.models.find(m => m.id === (args.target?.model ?? caps.inheritedModel));
      if (!model) throw new Error("T3 model unavailable");
      for (const value of args.target?.options ?? []) {
        const spec = model.options?.find(o => o.id === value.id);
        if (!spec || (spec.type === "boolean" ? typeof value.value !== "boolean" : typeof value.value !== "string" || !spec.options.some(o => o.id === value.value))) throw new Error("T3 option unavailable");
      }
      const task = await call("delegate_task", { ...args, mode: "async" }, taskSchema, true);
      if (task.providerInstanceId !== selected || task.model !== model.id) throw new Error("T3 wrong delegated target");
      return { ownership: "t3" as const, clientRequestId: args.clientRequestId, task };
    }, signal);
  }
  status(taskId: string, signal?: AbortSignal) {
    id.parse(taskId);
    return this.session("status", async call => {
      const task = await call("task_status", { taskId }, taskSchema);
      if (task.taskId !== taskId) throw new Error("T3 wrong task");
      return { ownership: "t3" as const, task };
    }, signal);
  }
  cancel(taskId: string, clientRequestId: string, reason?: string, signal?: AbortSignal) {
    id.parse(taskId); t3RequestId.parse(clientRequestId); z.string().max(1000).optional().parse(reason);
    return this.session("cancel", async (call, caps) => {
      if (!caps.features.cancellation) throw new Error("T3 cancellation unavailable");
      const receipt = await call("task_cancel", { taskId, clientRequestId, ...(reason ? { reason } : {}) },
        z.object({ taskId: id, status: z.enum(["cancel_requested", "completed", "failed", "cancelled", "interrupted"]) }), true);
      if (receipt.taskId !== taskId) throw new Error("T3 wrong task");
      return { ownership: "t3" as const, clientRequestId, receipt };
    }, signal);
  }
  async close(): Promise<void> { this.stopped = true; for (const controller of this.active) controller.abort(); }
}
