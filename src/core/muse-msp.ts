import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { APP_VERSION } from "./constants.js";
import { checkDepth, childEnv, DelegateError, exitDescription, killTree, realFolder, resolveCommand, trackChild, type DelegateRequest, type DelegateResult } from "./delegate.js";
import { boundedDetail, unreviewable, type PermissionDecision } from "./relay.js";

/** Stable MSP v1, pinned to the @muse-code/sdk 1.4.7 schema. No experimental traffic. */
export type MuseApprovalMode = "allowAll" | "promptUnmatched" | "onRequest" | "denyUnmatched";
export type MuseMcpServer = { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; framing?: "auto" | "lineDelimitedJson" | "contentLength"; mode?: "required" | "optional" } | { transport: "streamableHttp"; url: string; headers?: Record<string, string>; mode?: "required" | "optional" };
export interface MuseSteering {
  send: (message: string, sibling?: boolean) => Promise<boolean>;
  rename?: (title: string) => Promise<void>;
}
export interface MuseMspRequest extends DelegateRequest {
  bin: string;
  access: "read" | "ask" | "edit" | "full";
  /** Complete CLI arguments, including serve and the caller's native filesystem/tool policy. */
  serveArgs?: string[];
  approvalMode?: MuseApprovalMode;
  /** Select on start; verify the committed additive permissionState on start/resume. */
  permissionProfile?: string;
  /** Require the installed native plugin to gate implicitly permitted tool calls. */
  requirePermissionHooks?: boolean;
  sessionConfig?: { mcpServers?: Record<string, MuseMcpServer> };
  onSpawn?: (pid: number) => void;
  startupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}
export interface MuseMspQueryRequest extends Pick<MuseMspRequest, "bin" | "cwd" | "log" | "serveArgs" | "extraEnv" | "onSpawn" | "startupTimeoutMs" | "cleanupTimeoutMs" | "signal"> {
  method: "model/list" | "usage/read";
  params?: Record<string, unknown>;
  timeoutSec?: number;
}

/** Read-only MSP queries reuse the transport without constructing a session or submitting a turn. */
export async function museMspQuery(req: MuseMspQueryRequest): Promise<Record<string, unknown>> {
  if (!["model/list", "usage/read"].includes(req.method)) throw new DelegateError(`Muse no-turn query does not support ${req.method}`, "failed");
  const result = await runMuseMsp({ ...req, access: "read", prompt: "", timeoutSec: req.timeoutSec ?? 15, query: { method: req.method, params: req.params ?? {} } });
  return result.details.response as Record<string, unknown>;
}

export function delegateToMuseMsp(req: MuseMspRequest): Promise<DelegateResult> { return runMuseMsp(req); }

type RecordValue = Record<string, any>;
type Pending = { resolve: (value: RecordValue) => void; reject: (error: Error) => void; commandId?: string; requireEcho: boolean; expectedSessionId?: string };
class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

/** UUIDv7 commands, not UUIDv4: MSP validates the version at admission. */
function commandMinter(): () => string {
  let last = -1, sequence = 0;
  return () => {
    let now = Date.now();
    if (now <= last) { now = last; if (++sequence > 0xfff) { now++; sequence = 0; } }
    else sequence = 0;
    last = now;
    const bytes = randomBytes(16);
    bytes.writeUIntBE(now, 0, 6);
    bytes[6] = 0x70 | (sequence >> 8);
    bytes[7] = sequence & 0xff;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const h = bytes.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
}

function inside(path: string, roots: string[]): boolean {
  if (!isAbsolute(path)) return false;
  // Resolve existing parents too: a newly created file under a symlink is
  // outside the workspace when that symlink points outside it.
  let parent = resolve(path);
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  try { path = resolve(realpathSync.native(parent), relative(parent, resolve(path))); }
  catch { return false; }
  return isAbsolute(path) && roots.some((root) => {
    const suffix = relative(root, resolve(path));
    return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
  });
}

/** Native CLI policy must gate implicitly permitted actions too; this guards every surfaced approval. */
async function decideApproval(req: MuseMspRequest, params: RecordValue, cwd: string): Promise<PermissionDecision> {
  const subject = params.subject ?? {};
  const known = ["shell", "fileAccess", "network", "unixSocket", "process", "tool"].includes(subject.kind);
  const tool = subject.kind === "tool" ? String(subject.toolName ?? params.toolName ?? "tool") : String(subject.kind ?? "approval");
  const detail = JSON.stringify({ subject, toolName: params.toolName, rawArgs: params.rawArgs, protectedWrite: params.protectedWrite });
  if (req.access === "read") {
    if (subject.kind === "fileAccess" && subject.access === "read" && !params.protectedWrite) return { allow: true };
    return { allow: false, message: "Denied by agent-bridge: read-only jobs cannot approve commands, writes or external tool actions." };
  }
  if (known && req.access === "full") return { allow: true };
  if (known && req.access === "edit" && subject.kind === "fileAccess" && !params.protectedWrite && typeof subject.path === "string" && inside(subject.path, [cwd, ...(req.writableRoots ?? []).map(realFolder)])) return { allow: true };
  if (!req.canApprove || !req.approve) return { allow: false, message: "Denied by agent-bridge: no supervisor can answer this approval." };
  const request = { agent: "muse", tool, ...boundedDetail(detail), cwd };
  const refused = unreviewable(request);
  if (refused) return refused;
  try { return await req.approve(request); }
  catch (error) { return { allow: false, message: `Approval forwarding failed: ${String((error as Error).message ?? error)}` }; }
}

/** Own one Muse serve process and one submitted turn. Acknowledgements never count as completion. */
async function runMuseMsp(req: MuseMspRequest & { query?: { method: "model/list" | "usage/read"; params: Record<string, unknown> } }): Promise<DelegateResult> {
  if (!req.query) checkDepth(req.maxDelegateDepth);
  if (req.signal?.aborted) throw new DelegateError("delegate aborted", "aborted", "", "", req.sessionId ?? null);
  const cwd = realFolder(req.cwd);
  const env = childEnv(req.extraEnv);
  const { resolved, args, needsShell } = resolveCommand(req.bin, req.serveArgs ?? ["serve"], env, req.log);
  const child = spawn(resolved, args, { cwd, env: { ...env, PWD: cwd }, shell: needsShell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  trackChild(child, req.log);
  const mint = commandMinter();
  let nextId = 1, sessionId = req.sessionId ?? null, turnId: string | null = null;
  let stderr = "", step = "initialize", submitted = false, closing = false, awaitingAnswer = false;
  let effectiveModel: string | null | undefined, effectiveEffort: string | null | undefined;
  let policyVerified = false;
  const permissionName = (native: string) => policyVerified && req.requirePermissionHooks
    ? `${req.permissionProfile ? `${req.permissionProfile}; ` : ""}Bridge ${req.access} (native ${native})` : native;
  const pending = new Map<number, Pending>();
  const completions = new Map<string, RecordValue>();
  const messages = new Map<string, RecordValue>();
  const approvalTasks = new Map<string, Promise<void>>();
  const earlyApprovals: { id: number; params: RecordValue }[] = [];
  let finish!: (value: RecordValue) => void, fail!: (error: Error) => void;
  const done = new Promise<RecordValue>((r, j) => { finish = r; fail = j; });
  done.catch(() => {});
  const error = (message: string, kind: "failed" | "aborted" | "timeout" = "failed") => new DelegateError(message, kind, stderr, [...messages.values()].map((m) => m.text ?? "").join("\n\n"), sessionId);
  const write = (value: unknown) => {
    if (child.stdin.destroyed || !child.stdin.writable) throw error("Muse MSP input closed");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...(value as object) })}\n`);
  };
  const request = (method: string, params: RecordValue): Promise<RecordValue> => new Promise((r, j) => {
    const id = nextId++;
    pending.set(id, { resolve: r, reject: j, commandId: params.commandId, requireEcho: !!params.commandId && !["session/start", "session/resume"].includes(method), ...(typeof params.sessionId === "string" ? { expectedSessionId: params.sessionId } : {}) });
    try { write({ id, method, params }); } catch (err) { pending.delete(id); j(err); }
  });
  const command = (method: string, params: RecordValue) => request(method, { commandId: mint(), ...params });
  const report = (info: { model?: string | null; effort?: string | null; permission?: string | null }) => {
    if ("model" in info) effectiveModel = info.model;
    if ("effort" in info) effectiveEffort = info.effort;
    req.onInfo?.(info);
  };
  const answerApproval = async (id: number, params: RecordValue, received = false) => {
    if (params.sessionId !== sessionId) { write({ id, error: { code: -32602, message: "approval belongs to another session" } }); return; }
    // This is only a presentation receipt; it does not decide an approval.
    if (!received) write({ id, result: { received: true } });
    // Resume can reissue pending requests, and turn events can precede admission.
    // Never approve until policy preflight succeeds and the owned turn is known.
    if (!turnId) { earlyApprovals.push({ id, params }); return; }
    if (params.turnId !== turnId) { fail(error("Muse approval belongs to another turn; refusing to decide it")); return; }
    const key = `${params.approvalId}:${params.currentRequirementId?.sourceIndex}`;
    if (approvalTasks.has(key)) return;
    const task = (async () => {
      const decision = await decideApproval(req, params, cwd);
      if (closing) return;
      const choices: RecordValue[] = Array.isArray(params.availableChoices) ? params.availableChoices : [];
      const choice = decision.allow ? choices.find((c) => c.decision === "approved" && c.scope === "once") : choices.find((c) => c.decision === "denied" && c.scope === "once") ?? choices.find((c) => c.decision === "abort" && c.scope === "once");
      if (!choice || !params.currentRequirementId) throw error("Muse approval has no safe one-time decision choice");
      const feedback = (!decision.allow && decision.message) || "Denied by agent-bridge.";
      await command("approval/decide", { sessionId, approvalId: params.approvalId, requirementId: params.currentRequirementId, choiceId: choice.choiceId, ...(!decision.allow && choice.acceptsFeedback ? { feedback } : {}) });
      if (!decision.allow) { req.onDenied?.(feedback); req.onProgress?.(`Approval denied: ${feedback}`); }
    })();
    approvalTasks.set(key, task);
    task.catch((err) => fail(error(`Muse approval failed: ${(err as Error).message}`)));
  };
  const handle = (msg: RecordValue) => {
    if (msg.jsonrpc !== "2.0") throw error("Invalid Muse MSP JSON-RPC envelope");
    if (msg.id !== undefined && !msg.method) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message ?? "MSP request failed"));
      else if (p.commandId && (p.requireEcho || msg.result?.commandId !== undefined) && msg.result?.commandId !== p.commandId) p.reject(error("Muse MSP command acknowledgement identity mismatch"));
      else if (p.requireEcho && msg.result?.status !== "accepted") p.reject(error("Muse MSP command was not accepted"));
      else if (p.expectedSessionId && msg.result?.session?.sessionId !== undefined && msg.result.session.sessionId !== p.expectedSessionId) p.reject(error("Muse MSP response belongs to another session"));
      else {
        // A subscribe's view frames can follow its response before await resumes.
        if (typeof msg.result?.session?.sessionId === "string") sessionId = msg.result.session.sessionId;
        p.resolve(msg.result ?? {});
      }
      return;
    }
    const p = msg.params ?? {};
    if (msg.id !== undefined && msg.method) {
      if (msg.method === "approval/request") void answerApproval(msg.id, p).catch((err) => fail(err));
      else { write({ id: msg.id, error: { code: -32601, message: "not supported by agent-bridge" } }); fail(error(`Muse requested unsupported interaction ${msg.method}`)); }
      return;
    }
    if (p.sessionId !== sessionId) return;
    switch (msg.method) {
      case "session/modelChanged": report({ model: p.modelId }); break;
      case "session/reasoningEffortChanged": report({ effort: p.reasoningEffort }); break;
      case "session/approvalModeChanged": report({ permission: permissionName(p.mode) }); break;
      case "session/tokenUsage": if (typeof p.modelId === "string") report({ model: p.modelId }); break;
      case "view/gap": case "session/viewHealthChanged": fail(error(`Muse view stream unavailable (${msg.method}); turn outcome cannot be verified`)); break;
      case "item/started": case "item/updated": case "item/completed": {
        const item = p.item ?? {};
        if (turnId && item.turnId !== turnId) break;
        if (item.kind === "agentMessage" && msg.method === "item/completed" && typeof item.itemId === "string") {
          const old = messages.get(item.itemId);
          if (old && old.revision >= item.revision) break;
          messages.set(item.itemId, item);
          if (awaitingAnswer && item.text?.trim()) { awaitingAnswer = false; req.live?.onAnswer(item.text); }
        } else if (item.kind !== "userMessage" && item.kind !== "reasoning" && item.kind !== "agentMessage") {
          const summary = item.statusLine ?? item.fallbackText ?? item.tool ?? item.kind;
          req.onProgress?.(`${summary}: ${item.status}${item.failureReason ? ` — ${item.failureReason}` : ""}`, JSON.stringify(item));
        }
        break;
      }
      case "turn/completed":
        completions.set(p.turnId, p);
        if (p.turnId === turnId) finish(p);
        break;
    }
  };
  let buffer = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) { fail(error("Muse MSP frame exceeds capture limit")); return; }
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch (err) { fail(error(`Invalid Muse MSP frame: ${(err as Error).message}`)); }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  child.stdin.on("error", (err) => { if (!closing) fail(error(`Muse MSP input failed: ${err.message}`)); });
  const closed = new Promise<void>((r) => child.once("close", () => r()));
  child.once("error", (err) => fail(error(`failed to start ${req.bin}: ${err.message}`)));
  child.once("exit", (code, signal) => { if (!closing) fail(error(`Muse serve exited unexpectedly (${exitDescription({ code, signal })})`)); });
  let timeout: NodeJS.Timeout | undefined, startup: NodeJS.Timeout | undefined;
  const stop = new Promise<never>((_, j) => {
    timeout = setTimeout(() => j(error(`delegate timed out after ${req.timeoutSec}s (timeout_sec)`, "timeout")), req.timeoutSec * 1000);
  });
  stop.catch(() => {});
  let abortReject!: (error: Error) => void;
  const aborted = new Promise<never>((_, j) => { abortReject = j; });
  aborted.catch(() => {});
  const abort = () => abortReject(error("delegate aborted", "aborted"));
  req.signal?.addEventListener("abort", abort, { once: true });
  if (req.signal?.aborted) abort();
  const startupFailure = new Promise<never>((_, j) => {
    startup = setTimeout(() => j(DelegateError.startup(`Muse serve did not answer ${step} within startup timeout`, stderr, sessionId)), req.startupTimeoutMs ?? 180_000);
  });
  startupFailure.catch(() => {});
  const race = <T>(p: Promise<T>, boot = false) => Promise.race([p, done.then(() => new Promise<never>(() => {})), stop, aborted, ...(boot ? [startupFailure] : [])]);
  const steering: MuseSteering = {
    send: async (message, sibling = false) => {
      if (!turnId || closing || completions.has(turnId)) return false;
      awaitingAnswer = true;
      try {
        await race(command("turn/steer", { sessionId, expectedTurnId: turnId, input: [{ type: "text", text: `[Message from ${sibling ? "a sibling job" : req.live?.from ?? "your supervisor"} while you work. Apply it and continue.]\n${message}` }] }));
        return true;
      } catch (err) {
        awaitingAnswer = false;
        req.log.warn("Muse steering refused", { error: (err as Error).message });
        return false;
      }
    },
    rename: async (title) => { await race(command("session/rename", { sessionId, name: title })); },
  };
  try {
    if (child.pid) req.onSpawn?.(child.pid);
    const init = await race(request("initialize", { clientInfo: { name: "agent_bridge", title: "Agent Bridge", version: APP_VERSION }, capabilities: { experimentalApi: false, userInputDialogs: false, requestedCapabilities: req.sessionConfig?.mcpServers ? ["sessionMcp"] : [] } }), true);
    if (init.schema?.version !== 1) throw error("Muse serve returned an unsupported MSP schema version");
    if (req.sessionConfig?.mcpServers && !init.grantedCapabilities?.includes("sessionMcp")) throw error("Muse serve did not grant the sessionMcp capability required by this job");
    write({ method: "initialized" });
    if (req.query) {
      step = req.query.method;
      const response = await race(request(step, req.query.params), true);
      return { sessionId: null, text: "", isError: false, details: { transport: "msp", response } };
    }
    // An exact named profile owns its native approval policy; access is enforced independently by the Bridge hook.
    const mode = req.approvalMode ?? (req.permissionProfile ? undefined : req.access === "full" ? "allowAll" : "promptUnmatched");
    step = req.sessionId ? "session/resume" : "session/start";
    const session = await race(command(step, req.sessionId ? { sessionId: req.sessionId, excludeItems: true, ...(req.sessionConfig ? { config: req.sessionConfig } : {}) } : { workspaceRoot: cwd, ...(mode ? { approvalMode: mode } : {}), ...(req.permissionProfile ? { permissionProfile: req.permissionProfile } : {}), ...(req.model ? { modelId: req.model } : {}), ...(req.sessionConfig ? { config: req.sessionConfig } : {}) }), true);
    if (typeof session.session?.sessionId !== "string") throw error("Muse serve returned no session identity");
    sessionId = session.session.sessionId;
    req.onSession?.(sessionId!);
    report({ ...(session.session.modelId !== undefined ? { model: session.session.modelId } : {}), ...(session.session.approvalMode?.mode ? { permission: session.session.approvalMode.mode } : {}) });
    const state = session.history?.snapshot?.state;
    if (state?.effectiveModel?.modelId) report({ model: state.effectiveModel.modelId });
    if (state?.reasoningEffort?.reasoningEffort) report({ effort: state.reasoningEffort.reasoningEffort });
    if (req.permissionProfile) {
      // 1.4.7's SDK proves this additive field even though older stable Session
      // declarations omit it. Unknown/absent never means selection succeeded.
      let profile = session.session.permissionState?.profileId;
      if (typeof profile !== "string") {
        step = "session/read";
        const read = await race(request(step, { sessionId, excludeItems: true }), true);
        profile = read.session?.permissionState?.profileId;
      }
      if (profile !== req.permissionProfile) throw error(`Muse permission profile was not applied: requested ${req.permissionProfile}, served ${typeof profile === "string" ? profile : "unknown"}`);
    }
    if (req.requirePermissionHooks) {
      step = "hook/list";
      const catalog = await race(request(step, { sessionId }), true);
      const hooks: RecordValue[] = Array.isArray(catalog.hooks) ? catalog.hooks : [];
      if (!hooks.some((h) => h.enabled === true && h.event === "preToolUse" && h.handlerKind === "plugin" && typeof h.key === "string" && /^(?:plugin:)?agent-bridge:/.test(h.key))) throw error("Muse is missing the enabled agent-bridge PreToolUse permission hook; refusing to submit this job");
    }
    if (mode && !req.sessionId && session.session.approvalMode?.mode !== undefined && session.session.approvalMode.mode !== mode) throw error(`Muse did not apply the requested approval mode ${mode}`);
    if (mode && (req.sessionId || session.session.approvalMode?.mode === undefined)) {
      step = "session/setApprovalMode";
      const changed = await race(command(step, { sessionId, mode }), true);
      if (changed.effectiveMode?.mode !== mode) throw error(`Muse did not confirm the requested approval mode ${mode}`);
    }
    policyVerified = true;
    report({ permission: permissionName(mode ?? session.session.approvalMode?.mode ?? "unknown") });
    if (req.sessionId && req.model) { step = "session/setModel"; await race(command(step, { sessionId, model: { modelId: req.model } }), true); }
    step = "turn/start";
    submitted = true; // Never fall back once input may have reached admission.
    const turn = await race(command(step, { sessionId, input: [{ type: "text", text: req.prompt }], ifBusy: "queue", ...(req.effort ? { reasoningEffort: req.effort } : {}) }), true);
    if (turn.status !== "accepted" || typeof turn.turnId !== "string") throw error("Muse serve returned an invalid turn admission");
    turnId = turn.turnId;
    for (const approval of earlyApprovals.splice(0)) void answerApproval(approval.id, approval.params, true).catch(err => fail(err));
    if (req.effort) report({ effort: req.effort });
    clearTimeout(startup);
    // Events may precede the acknowledgement in the same stdout chunk.
    for (const [id, item] of messages) if (item.turnId !== turnId) messages.delete(id);
    req.live?.onSteering(steering);
    if (completions.has(turnId!)) finish(completions.get(turnId!)!);
    const terminal = await Promise.race([done, stop, aborted]);
    const text = [...messages.values()].map((m) => m.text ?? "").filter(Boolean).join("\n\n");
    if (terminal.terminal !== "completed") throw error(terminal.error?.message ?? terminal.reason ?? `Muse turn ${terminal.terminal}`, terminal.terminal === "cancelled" ? "aborted" : "failed");
    return { sessionId, text, isError: false, details: { transport: "msp", turnId, terminal: terminal.terminal, ...(terminal.usage ? { usage: terminal.usage } : {}), ...(effectiveModel !== undefined ? { model: effectiveModel } : {}), ...(effectiveEffort !== undefined ? { effort: effectiveEffort } : {}) } };
  } catch (err) {
    const failure = err instanceof DelegateError ? err : error(`Muse MSP ${step} failed: ${(err as Error).message}`);
    if (err instanceof RpcError) Object.assign(failure, { rpcCode: err.code, rpcMethod: step });
    if (failure.kind === "failed") failure.startupFailed = !submitted;
    throw failure;
  } finally {
    clearTimeout(timeout); clearTimeout(startup);
    req.signal?.removeEventListener("abort", abort);
    closing = true;
    try { req.live?.onSteering(null); } catch (err) { req.log.warn("Muse steering cleanup callback failed", { error: (err as Error).message }); }
    const budget = Math.max(0, Math.min(req.cleanupTimeoutMs ?? 750, 3000));
    const bounded = async (p: Promise<unknown>) => {
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([p.catch(() => {}), new Promise<void>((r) => { timer = setTimeout(r, budget); })]); }
      finally { clearTimeout(timer); }
    };
    if (sessionId && submitted && (!turnId || !completions.has(turnId))) {
      await bounded(command("turn/cancel", { sessionId, ...(turnId ? { turnId } : {}) }));
      await bounded(Promise.race([done, closed]));
    }
    child.stdin.end();
    await bounded(closed);
    await killTree(child, "Muse MSP cleanup");
    // The host can exit on EOF while a native tool still holds its process
    // group. killTree intentionally returns early for an exited leader.
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* owned group already gone */ }
    }
    for (const p of pending.values()) p.reject(error("Muse MSP connection closed"));
    pending.clear();
  }
}
