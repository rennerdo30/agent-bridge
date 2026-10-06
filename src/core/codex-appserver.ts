import { spawn } from "node:child_process";
import { APP_VERSION } from "./constants.js";
import type { CodexSandbox } from "./config.js";
import { checkDepth, childEnv, DelegateError, exitDescription, killTree, realFolder, resolveCommand, trackChild, type DelegateRequest, type DelegateResult } from "./delegate.js";
import { progressEventHandler } from "./progress.js";
import { CODEX_ASK_HINT } from "./delegate.js";

/**
 * Codex subagents through `codex app-server` (JSON-RPC over stdio) instead of `codex exec`. The same
 * agent and session files, plus what exec cannot do: messages reach the running turn as real user input
 * (turn/steer), the way a native subagent receives messages, and the subagent's next message is its answer.
 */
const STEER_HEADER = (from: string) =>
  `[Message from ${from}, who gave you this task, sent while you work. Answer it briefly in your next message, then continue the task, adjusted to what it asks.]`;
/** Delta notifications we never use; opting out keeps the stream small. */
const OPT_OUT = [
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
];
const STDERR_TAIL_CHARS = 4_000;
/**
 * Longest wait for app-server to answer the handshake (initialize, thread start or resume, turn start).
 * Usually seconds, but with many Codex processes running it can take a minute or more.
 */
export const STARTUP_TIMEOUT_MS = 180_000;

/** `"…\pwsh.exe" -Command '…'` and friends: just the command, for approval questions. */
export function innerCommand(s: string): string {
  // The shell may be a quoted path with spaces ("C:\Program Files\...\pwsh.exe").
  const m = /^(?:"[^"]*[\\/]|[^\s"]*[\\/])?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?"?\s+(?:-NoProfile\s+|-NoLogo\s+)*(?:-Command|-lc|-c|\/c)\s+([\s\S]*)$/i.exec(s.trim());
  if (!m) return s;
  const c = m[1]!.trim();
  return /^'[\s\S]*'$|^"[\s\S]*"$/.test(c) ? c.slice(1, -1) : c;
}

/** Lets the caller talk to the running subagent. */
export interface Steering {
  /** Deliver a message into the running turn; false when no turn is running (it has finished). */
  send: (message: string) => Promise<boolean>;
  rename?: (title: string) => Promise<void>;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** app-server item types, as the exec-style events the progress describer knows. */
function asExecEvent(kind: "item.started" | "item.completed", item: any): unknown {
  const type =
    ({ agentMessage: "agent_message", commandExecution: "command_execution", fileChange: "file_change", mcpToolCall: "mcp_tool_call", webSearch: "web_search", reasoning: "reasoning" } as Record<string, string>)[item?.type] ??
    item?.type;
  return { type: kind, item: { ...item, type } };
}

export async function delegateToCodexAppServer(
  req: DelegateRequest & { bin: string; sandbox: CodexSandbox; askMode?: boolean; writableRoots?: string[]; startupTimeoutMs?: number },
): Promise<DelegateResult> {
  checkDepth();
  // See delegateToCodex: the Windows sandbox user does not see drive mappings.
  const cwd = realFolder(req.cwd);
  const env = childEnv(req.extraEnv);
  const { resolved, args, needsShell } = resolveCommand(req.bin, ["app-server"], env, req.log);
  req.log.debug("starting codex app-server", { bin: resolved, cwd });
  const child = spawn(resolved, args, { cwd, env: { ...env, PWD: cwd }, shell: needsShell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  trackChild(child);

  let nextId = 1;
  const pending = new Map<number, Pending>();
  let stderr = "";
  let threadId: string | null = req.sessionId ?? null;
  let turnId: string | null = null;
  let lastMessage = "";
  let usage: unknown = null;
  let retryableError: string | null = null;
  let finished: (v: { status: string; error: string | null }) => void = () => {};
  const turnDone = new Promise<{ status: string; error: string | null }>((r) => (finished = r));
  const completions = new Map<string, { status: string; error: string | null }>();
  // After a steered message, the subagent's next message is its answer to it.
  const answers: string[] = [];
  let awaitingAnswer = false;
  const onEvent = progressEventHandler("codex", req.onProgress);

  const write = (msg: unknown) => {
    if (!child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  const request = <T = any>(method: string, params: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      write({ id, method, params });
    });

  // Approval questions from Codex go to the session that started the subagent (see DelegateRequest.approve).
  const editPaths = new Map<string, string[]>();
  const decide = async (tool: string, detail: string): Promise<boolean> => {
    if (!req.approve) return false;
    try {
      const d = await req.approve({ agent: "codex", tool, detail, cwd });
      return d.allow;
    } catch {
      return false;
    }
  };
  const answerRequest = async (id: number | string, method: string, params: any) => {
    const reply = (result: unknown) => write({ id, result });
    switch (method) {
      case "mcpServer/elicitation/request": {
        const ok = await decide(`mcp:${params.serverName ?? "tool"}`, String(params.message ?? "an MCP tool call"));
        // Form elicitations get their defaults; tool-call approvals have no fields to fill.
        const props = params.requestedSchema?.properties ?? {};
        const content = Object.fromEntries(Object.entries(props).filter(([, v]: [string, any]) => v && "default" in v).map(([k, v]: [string, any]) => [k, v.default]));
        return reply(ok ? { action: "accept", content } : { action: "decline", content: null });
      }
      case "item/commandExecution/requestApproval":
        if (!req.askMode) return reply({ decision: "decline" });
        return reply({ decision: (await decide("command", innerCommand(String(params.command ?? params.reason ?? "a command")))) ? "accept" : "decline" });
      case "item/fileChange/requestApproval": {
        if (!req.askMode) return reply({ decision: "decline" });
        const paths = editPaths.get(params.itemId) ?? [];
        return reply({ decision: (await decide("edit", paths.length ? paths.join(", ") : String(params.reason ?? "file changes"))) ? "accept" : "decline" });
      }
      default:
        // Questions and permission-profile requests: not forwarded; refuse rather than let the turn hang.
        req.log.warn("codex app-server request refused", { method });
        return write({ id, error: { code: -32601, message: "not supported by agent-bridge" } });
    }
  };
  const handle = (msg: any) => {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "app-server error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      void answerRequest(msg.id, msg.method, msg.params ?? {});
      return;
    }
    const params = msg.params ?? {};
    switch (msg.method) {
      case "item/started":
        onEvent?.(asExecEvent("item.started", params.item));
        if (params.item?.type === "fileChange") editPaths.set(params.item.id, (params.item.changes ?? []).map((c: any) => c?.path).filter(Boolean));
        break;
      case "item/completed": {
        if (turnId && params.turnId && params.turnId !== turnId) break;
        const item = params.item ?? {};
        onEvent?.(asExecEvent("item.completed", item));
        if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
          lastMessage = item.text;
          if (awaitingAnswer) {
            awaitingAnswer = false;
            answers.push(item.text);
            req.live?.onAnswer(item.text);
          }
        }
        break;
      }
      case "thread/tokenUsage/updated":
        usage = params.tokenUsage?.total ?? params.total ?? usage;
        break;
      case "error":
        if (!params.willRetry) retryableError = params.error?.message ?? "error";
        break;
      case "turn/completed":
        // Only our turn counts: a resumed thread can report an earlier (interrupted) turn first.
        completions.set(String(params.turn?.id), { status: String(params.turn?.status ?? "completed"), error: params.turn?.error?.message ?? null });
        if (turnId && completions.has(turnId)) finished(completions.get(turnId)!);
        break;
    }
  };

  let buf = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      try {
        handle(JSON.parse(line));
      } catch (err) {
        req.log.debug("bad app-server line", { err: (err as Error).message });
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (d: string) => {
    stderr = (stderr + d).slice(-STDERR_TAIL_CHARS);
  });
  const exited = new Promise<never>((_, reject) => {
    child.on("error", (err) => reject(new DelegateError(`failed to start ${req.bin}: ${err.message}`, "failed", "", "", threadId)));
    child.on("exit", (code, signal) => reject(new DelegateError(`codex app-server ${exitDescription({ code, signal })}`, "failed", stderr, "", threadId)));
  });
  exited.catch(() => {});

  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DelegateError(`delegate timed out after ${req.timeoutSec}s (its time limit, timeout_sec)`, "timeout", stderr, "", threadId)), req.timeoutSec * 1000);
    req.signal?.addEventListener("abort", () => reject(new DelegateError("delegate aborted", "aborted", "", "", threadId)), { once: true });
  });
  stopped.catch(() => {});
  const race = <T>(p: Promise<T>) => Promise.race([p, exited, stopped]);
  // The handshake has its own, shorter limit: a stuck start must not wait for the whole run's timeout.
  let step = "initialize";
  let startupTimer: NodeJS.Timeout | undefined;
  const startup = new Promise<never>((_, reject) => {
    startupTimer = setTimeout(
      () => reject(DelegateError.startup(`codex app-server did not answer ${step} within ${Math.round((req.startupTimeoutMs ?? STARTUP_TIMEOUT_MS) / 1000)}s (startup timeout)`, stderr, threadId)),
      req.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
    );
  });
  startup.catch(() => {});
  const boot = <T>(p: Promise<T>) => Promise.race([p, exited, stopped, startup]);

  const steering: Steering = {
    rename: async (title) => {
      if (threadId) await race(request("thread/name/set", { threadId, name: title }));
    },
    send: async (message) => {
      if (!threadId || !turnId) return false;
      try {
        await request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: `${STEER_HEADER(req.live?.from ?? "the session that started you")}\n\n${message}`, text_elements: [] }] });
        awaitingAnswer = true;
        return true;
      } catch (err) {
        req.log.info("steering refused; the turn has ended", { err: (err as Error).message });
        return false;
      }
    },
  };

  try {
    await boot(request("initialize", { clientInfo: { name: "agent-bridge", title: "agent-bridge", version: APP_VERSION }, capabilities: { experimentalApi: false, optOutNotificationMethods: OPT_OUT } }));
    write({ method: "initialized", params: {} });
    // approvalsReviewer "user" + approvalPolicy "never": the sandbox holds (see CODEX_STRICT_APPROVALS).
    // Codex asks us (never a reviewer model): MCP tool approvals go to the parent session; sandbox escalations
    // only in "ask" mode, and are refused here without asking otherwise, so the sandbox holds.
    const approvalPolicy = "on-request";
    // Extra writable folders for workspace-write (a worktree's git admin dir lives in the main repo).
    const config: Record<string, unknown> = {};
    if (req.writableRoots?.length && req.sandbox === "workspace-write") config.sandbox_workspace_write = { writable_roots: req.writableRoots.map(realFolder) };
    if (req.effort) config.model_reasoning_effort = req.effort;
    const threadParams = { cwd, sandbox: req.sandbox, approvalPolicy, approvalsReviewer: "user", ...(Object.keys(config).length ? { config } : {}), ...(req.model ? { model: req.model } : {}) };
    step = req.sessionId ? "thread/resume" : "thread/start";
    const thread = req.sessionId
      ? await boot(request("thread/resume", { ...threadParams, threadId: req.sessionId, excludeTurns: true }))
      : await boot(request("thread/start", threadParams));
    threadId = thread?.thread?.id ?? threadId;
    if (threadId) req.onSession?.(threadId);
    if (threadId && req.title) {
      step = "thread/name/set";
      await boot(request("thread/name/set", { threadId, name: req.title })).catch((err) => req.log.warn("could not name the Codex thread", { err: (err as Error).message }));
    }
    // The model and effort this thread really uses (the user's config defaults included).
    if (typeof thread?.model === "string")
      req.onInfo?.({
        model: thread.model,
        effort: req.effort ?? (typeof thread.reasoningEffort === "string" ? thread.reasoningEffort : null),
        // The sandbox Codex really applies to this thread (its config can differ from what was asked).
        permission: typeof thread.sandbox?.type === "string" ? thread.sandbox.type : null,
      });
    const prompt = req.askMode ? `${req.prompt}\n\n${CODEX_ASK_HINT}` : req.prompt;
    step = "turn/start";
    const turn = await boot(request("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], ...(req.effort ? { effort: req.effort } : {}) }));
    turnId = turn?.turn?.id ?? null;
    clearTimeout(startupTimer);
    if (turnId && completions.has(turnId)) finished(completions.get(turnId)!);
    req.live?.onSteering(steering);
    const outcome = await race(turnDone);
    req.live?.onSteering(null);
    const error = outcome.error ?? (outcome.status === "failed" ? (retryableError ?? "turn failed") : null);
    req.log.info("codex turn ended", { threadId, turnId, status: outcome.status, error: outcome.error, retryableError });
    if (outcome.status === "interrupted") throw new DelegateError(`codex interrupted the turn${outcome.error ? `: ${outcome.error}` : ""}`, "failed", stderr, "", threadId);
    if (error && !lastMessage) throw new DelegateError(error, "failed", stderr, "", threadId);
    req.log.info("codex delegate finished", { threadId, status: outcome.status });
    return { sessionId: threadId, text: lastMessage, isError: Boolean(error), details: { usage, error, answers: answers.length } };
  } catch (err) {
    req.live?.onSteering(null);
    // Stop the turn properly before the process goes, so the session file stays consistent for a resume.
    if (threadId && turnId) await Promise.race([request("turn/interrupt", { threadId, turnId }).catch(() => {}), new Promise((r) => setTimeout(r, 2_000))]);
    if (err instanceof DelegateError) {
      err.sessionId = err.sessionId ?? threadId;
      throw err;
    }
    throw new DelegateError((err as Error).message, "failed", stderr, "", threadId);
  } finally {
    clearTimeout(timer);
    clearTimeout(startupTimer);
    for (const p of pending.values()) p.reject(new Error("closed"));
    child.stdin.end();
    await killTree(child);
  }
}
