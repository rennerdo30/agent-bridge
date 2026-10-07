import { DelegateError, checkDepth, childEnv, runProcess, type DelegateRequest, type DelegateResult } from "./delegate.js";
import { object, parse } from "./transcripts/common.js";
import { PermissionRelay, type PermissionDecision, type PermissionRequest } from "./relay.js";
import { requireAntigravityPlugin } from "./antigravity-plugin.js";
import { progressEventHandler } from "./progress.js";

export const ANTIGRAVITY_ACCESS_ENV = "AGENT_BRIDGE_ANTIGRAVITY_ACCESS";
export const ANTIGRAVITY_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** agy stream-json has envelopes, unlike Gemini CLI's events. */
export function parseAntigravityJsonl(stdout: string): DelegateResult {
  let sessionId: string | null = null;
  let result: Record<string, any> | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const ev = parse(line);
    const id = ev.conversation_id ?? ev.step_update?.conversation_id ?? ev.result?.conversation_id;
    if (typeof id === "string" && id) sessionId = id;
    if (ev.event === "result") result = object(ev.result);
  }
  const denied = Array.isArray(result?.denied_actions) ? result.denied_actions : [];
  const isError = !result || result.status !== "SUCCESS" || (denied.length > 0 && !result.response);
  return { sessionId, text: typeof result?.response === "string" && result.response ? result.response : String(result?.error ?? (denied.length ? `Antigravity denied permissions: ${denied.map((action: any) => action.action ?? action.display_name ?? "tool").join(", ")}` : result ? `Antigravity ended with ${result.status ?? "unknown status"}` : "Antigravity emitted no result")), isError, details: { status: result?.status ?? null, usage: result?.usage ?? null, deniedActions: denied } };
}

export async function delegateToAntigravity(req: DelegateRequest & { bin: string; access: "read" | "ask" | "edit"; sandbox?: boolean; autoApprove?: boolean }): Promise<DelegateResult> {
  checkDepth(req.maxDelegateDepth);
  if (req.signal?.aborted) throw new DelegateError("delegate aborted", "aborted", "", "", req.sessionId ?? null);
  if (req.effort && !(ANTIGRAVITY_EFFORTS as readonly string[]).includes(req.effort)) throw new DelegateError("Antigravity effort must be low, medium, high, xhigh or max", "failed");
  requireAntigravityPlugin();
  const args = ["--output-format", "stream-json", "--input-format", "stream-json", "--print-timeout", `${req.timeoutSec}s`];
  if (req.sessionId) args.push("--conversation", req.sessionId);
  if (req.model) args.push("--model", req.model);
  if (req.effort) args.push("--effort", req.effort);
  if (req.sandbox) args.push("--sandbox");
  // v1.2.0 auto-denies headless native prompts even after a hook allows the call.
  // Restricted modes use the verified PreToolUse gate for EVERY tool; unknown tools deny.
  // Live smoke confirms this gate still blocks writes with the native skip flag present.
  if (req.access !== "edit" || req.autoApprove) args.push("--dangerously-skip-permissions");
  let sessionId = req.sessionId ?? null;
  const progress = progressEventHandler("antigravity", req.onProgress);
  // Use the common approval handler, including per-job allow rules and supervisor routing.
  const approvals = new AbortController();
  const approve = async (request: PermissionRequest): Promise<PermissionDecision> => {
    const ended: PermissionDecision = { allow: false, message: "Antigravity run ended" };
    if (approvals.signal.aborted) return ended;
    let stop!: () => void;
    const aborted = new Promise<PermissionDecision>((resolve) => { stop = () => resolve(ended); });
    approvals.signal.addEventListener("abort", stop, { once: true });
    try { return await Promise.race([req.approve!(request), aborted]); }
    finally { approvals.signal.removeEventListener("abort", stop); }
  };
  const relay = req.access === "ask" && req.approve ? new PermissionRelay(approve, req.log) : null;
  try {
    await relay?.start();
    const res = await runProcess({ bin: req.bin, args, cwd: req.cwd, stdin: JSON.stringify({ event: "user", message: { content: req.prompt } }) + "\n", timeoutMs: req.timeoutSec * 1000, signal: req.signal, env: childEnv({ ...req.extraEnv, ...relay?.childEnv(), [ANTIGRAVITY_ACCESS_ENV]: req.access }), log: req.log,
      onLine: (line) => {
        const ev = parse(line), id = ev.conversation_id ?? ev.step_update?.conversation_id ?? ev.result?.conversation_id;
        if (!sessionId && typeof id === "string" && id) { sessionId = id; req.onSession?.(id); }
        if (ev.event === "init") req.onInfo?.({ model: ev.init?.model ?? req.model, effort: req.effort, permission: req.access === "edit" && req.autoApprove !== undefined ? req.autoApprove ? "bypass" : "native" : req.access });
        progress?.(ev);
      } });
    const parsed = parseAntigravityJsonl(res.stdout);
    const isError = res.code !== 0 || parsed.isError;
    return { ...parsed, sessionId: parsed.sessionId ?? sessionId, isError, details: { ...parsed.details, exitCode: res.code, ...(isError ? { error: parsed.isError ? parsed.text : res.stderr.slice(-4000) || `Antigravity exited with code ${res.code}` } : {}), ...(res.code !== 0 ? { stderr: res.stderr.slice(-4000) } : {}) } };
  } catch (err) {
    if (err instanceof DelegateError) err.sessionId = sessionId ?? parseAntigravityJsonl(err.partialStdout).sessionId;
    throw err;
  } finally {
    approvals.abort();
    await relay?.stop();
  }
}
