import { spawn } from "node:child_process";
import { APP_VERSION } from "./constants.js";
import type { CodexSandbox } from "./config.js";
import { checkDepth, childEnv, DelegateError, killTree, realFolder, resolveCommand, trackChild, type DelegateRequest, type DelegateResult } from "./delegate.js";
import { progressEventHandler } from "./progress.js";

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

/** Lets the caller talk to the running subagent. */
export interface Steering {
  /** Deliver a message into the running turn; false when no turn is running (it has finished). */
  send: (message: string) => Promise<boolean>;
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
  req: DelegateRequest & { bin: string; sandbox: CodexSandbox },
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
      // A request from Codex (an approval, a question). Runs use approvalPolicy "never", so none are expected;
      // refuse anything that comes anyway rather than letting the turn hang.
      req.log.warn("codex app-server request refused", { method: msg.method });
      write({ id: msg.id, error: { code: -32601, message: "not supported by agent-bridge" } });
      return;
    }
    const params = msg.params ?? {};
    switch (msg.method) {
      case "item/started":
        onEvent?.(asExecEvent("item.started", params.item));
        break;
      case "item/completed": {
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
        if (!turnId || params.turn?.id === turnId) {
          finished({ status: String(params.turn?.status ?? "completed"), error: params.turn?.error?.message ?? null });
        }
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
    child.on("exit", (code) => reject(new DelegateError(`codex app-server exited with code ${code}`, "failed", stderr, "", threadId)));
  });
  exited.catch(() => {});

  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DelegateError(`delegate timed out after ${req.timeoutSec}s`, "timeout", stderr, "", threadId)), req.timeoutSec * 1000);
    req.signal?.addEventListener("abort", () => reject(new DelegateError("delegate aborted", "aborted", "", "", threadId)), { once: true });
  });
  stopped.catch(() => {});
  const race = <T>(p: Promise<T>) => Promise.race([p, exited, stopped]);

  const steering: Steering = {
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
    await race(request("initialize", { clientInfo: { name: "agent-bridge", title: "agent-bridge", version: APP_VERSION }, capabilities: { experimentalApi: false, optOutNotificationMethods: OPT_OUT } }));
    write({ method: "initialized", params: {} });
    // approvalsReviewer "user" + approvalPolicy "never": the sandbox holds (see CODEX_STRICT_APPROVALS).
    const threadParams = { cwd, sandbox: req.sandbox, approvalPolicy: "never", approvalsReviewer: "user", ...(req.model ? { model: req.model } : {}) };
    const thread = req.sessionId
      ? await race(request("thread/resume", { ...threadParams, threadId: req.sessionId, excludeTurns: true }))
      : await race(request("thread/start", threadParams));
    threadId = thread?.thread?.id ?? threadId;
    const turn = await race(request("turn/start", { threadId, input: [{ type: "text", text: req.prompt, text_elements: [] }] }));
    turnId = turn?.turn?.id ?? null;
    req.live?.onSteering(steering);
    const outcome = await race(turnDone);
    req.live?.onSteering(null);
    const error = outcome.error ?? (outcome.status === "failed" ? (retryableError ?? "turn failed") : null);
    if (outcome.status === "interrupted") throw new DelegateError("delegate aborted", "aborted", "", "", threadId);
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
    for (const p of pending.values()) p.reject(new Error("closed"));
    child.stdin.end();
    await killTree(child);
  }
}
