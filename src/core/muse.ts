import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegateError, checkDepth, childEnv, runProcess, withResumeHint, type DelegateRequest, type DelegateResult } from "./delegate.js";
import { delegateToMuseMsp } from "./muse-msp.js";
import { MUSE_ACCESS_ENV, registerMuseContextAsync } from "./muse-context.js";
import { progressEventHandler } from "./progress.js";
import { object, parse, TRANSCRIPT_ID } from "./transcripts/common.js";

export const MUSE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** Muse injects its session identity into child processes; the bridge binds it so transcripts and the dashboard can find the live session. */
export function museEnvSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env.MUSE_SESSION_ID?.trim();
  return id && TRANSCRIPT_ID.test(id) ? id : null;
}

/**
 * Parse `muse exec --json` output: the session-log record stream.
 * The session id is `stream.id` on every record; the final answer is the
 * `run.terminal.completed` record's payload text. A run can exit 0 while a
 * task failed internally, so the terminal record decides, not the exit code.
 */
export function parseMuseJsonl(stdout: string): DelegateResult {
  let sessionId: string | null = null;
  let text = "";
  let deltas = "";
  let terminal: string | null = null;
  let failure: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const ev = parse(line);
    const stream = object(ev.stream);
    if (stream.kind === "session" && typeof stream.id === "string" && stream.id) sessionId = stream.id;
    const payload = object(ev.payload);
    if (ev.payload_type === "run.output.delta" && typeof payload.text === "string") deltas += payload.text;
    if (ev.payload_type === "task.lifecycle.failed") {
      const event = object(payload.event);
      if (typeof event.reason === "string" && event.reason) failure = event.reason;
    }
    if (payload.kind === "run_terminal") {
      terminal = typeof payload.terminal === "string" ? payload.terminal : null;
      if (typeof payload.text === "string" && payload.text) text = payload.text;
      if (typeof payload.reason === "string" && payload.reason) failure = payload.reason;
    }
  }
  const isError = terminal !== "completed";
  return {
    sessionId,
    text: text || (isError ? "" : deltas),
    isError,
    details: { terminal, ...(failure ? { error: failure } : {}) },
  };
}

/** Prompt text goes through a file: muse takes it as an argument otherwise, and user text never belongs in argv. */
export function musePromptFile(prompt: string, write = writeFileSync): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-muse-"));
  const file = join(dir, "prompt.txt");
  try { write(file, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  catch (error) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Preserve the original allocation failure. */ } throw error; }
  return { dir, file };
}

export async function delegateToMuse(req: DelegateRequest & { bin: string; access: "read" | "edit"; permissionProfile?: string | null }): Promise<DelegateResult> {
  checkDepth(req.maxDelegateDepth);
  if (req.signal?.aborted) throw new DelegateError("delegate aborted", "aborted", "", "", req.sessionId ?? null);
  if (req.effort && !(MUSE_EFFORTS as readonly string[]).includes(req.effort)) {
    throw new DelegateError(`Muse effort must be one of ${MUSE_EFFORTS.join(", ")}`, "failed");
  }
  const { dir, file } = musePromptFile(req.prompt);
  const args = ["exec", "--json", "--prompt-file", file, "--workspace", req.cwd, "--trust-workspace"];
  if (req.sessionId) args.push("--session-id", req.sessionId);
  if (req.model) args.push("--model", req.model);
  if (req.effort) args.push("--reasoning-effort", req.effort);
  if (req.permissionProfile) args.push("--permission-profile", req.permissionProfile);
  // A named permission profile selects Muse's approval behaviour itself:
  // muse exec refuses --permission-profile together with --approval-mode / --disable-approval.
  if (req.access === "read") args.push("--disable-write", "--disable-shell", ...(req.permissionProfile ? [] : ["--approval-mode", "never"]));
  else if (!req.permissionProfile) args.push("--disable-approval");
  const progress = progressEventHandler("muse", req.onProgress);
  const env = childEnv({ ...req.extraEnv, CLAUDE_PROJECT_DIR: req.cwd, [MUSE_ACCESS_ENV]: req.access });
  let releaseContext: (() => void) | undefined;
  let finished = false;
  let sessionId = req.sessionId ?? null;
  let sessionReported = false;
  try {
    const res = await withResumeHint("muse", (o) => parseMuseJsonl(o).sessionId, () => runProcess({
      bin: req.bin,
      args,
      stdin: "",
      cwd: req.cwd,
      timeoutMs: req.timeoutSec * 1000,
      env,
      onSpawn: async pid => { const release = await registerMuseContextAsync(pid, env); if (finished) release(); else releaseContext = release; },
      log: req.log,
      signal: req.signal,
      onLine: (line) => {
        const ev = parse(line);
        const stream = object(ev.stream);
        if (!sessionReported && stream.kind === "session" && typeof stream.id === "string" && stream.id) {
          sessionReported = true;
          sessionId = stream.id;
          req.onSession?.(sessionId);
        }
        if (ev.payload_type === "run.model.configured") {
          const model = object(object(ev.payload).record).model_id;
          if (typeof model === "string" && model) req.onInfo?.({ model, effort: req.effort ?? null });
        }
        progress?.(ev);
      },
    }));
    const parsed = parseMuseJsonl(res.stdout);
    const isError = res.code !== 0 || parsed.isError;
    if (isError && !parsed.text) {
      const error = (typeof parsed.details.error === "string" && parsed.details.error) || `Muse ended with ${parsed.details.terminal ?? "no terminal record"}`;
      throw new DelegateError(error, "failed", res.stderr.slice(-4000), "", parsed.sessionId ?? sessionId);
    }
    req.log.info("muse delegate finished", { sessionId: parsed.sessionId, code: res.code, isError });
    return { ...parsed, sessionId: parsed.sessionId ?? sessionId, isError, details: { ...parsed.details, exitCode: res.code, signal: res.signal ?? null } };
  } catch (err) {
    if (err instanceof DelegateError && !err.sessionId) err.sessionId = sessionId;
    throw err;
  } finally {
    finished = true;
    releaseContext?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Explicit compatibility mode; never replay a possibly started MSP turn through exec. */
export const MUSE_EXEC_ENV = "AGENT_BRIDGE_MUSE_EXEC";
export async function runMuse(req: DelegateRequest & { bin: string; access: "read" | "ask" | "edit"; permissionProfile?: string | null }): Promise<DelegateResult> {
  if (req.effort && !(MUSE_EFFORTS as readonly string[]).includes(req.effort)) throw new DelegateError(`Muse effort must be one of ${MUSE_EFFORTS.join(", ")}`, "failed");
  if (process.env[MUSE_EXEC_ENV] === "1") return delegateToMuse({ ...req, access: req.access === "edit" ? "edit" : "read" });
  const extraEnv = { ...req.extraEnv, CLAUDE_PROJECT_DIR: req.cwd, [MUSE_ACCESS_ENV]: req.access };
  const env = childEnv(extraEnv);
  let releaseContext: (() => void) | undefined;
  let finished = false;
  try {
    return await delegateToMuseMsp({ ...req, extraEnv, permissionProfile: req.permissionProfile ?? undefined, requirePermissionHooks: true, onSpawn: async pid => { const release = await registerMuseContextAsync(pid, env); if (finished) release(); else releaseContext = release; } });
  } finally { finished = true; releaseContext?.(); }
}
