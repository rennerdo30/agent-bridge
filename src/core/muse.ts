import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegateError, checkDepth, childEnv, runProcess, withResumeHint, type DelegateRequest, type DelegateResult } from "./delegate.js";
import { progressEventHandler } from "./progress.js";
import { object, parse } from "./transcripts/common.js";

export const MUSE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

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
export function musePromptFile(prompt: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-muse-"));
  const file = join(dir, "prompt.txt");
  writeFileSync(file, prompt, "utf8");
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
  if (req.access === "read") args.push("--disable-write", "--disable-shell", "--approval-mode", "never");
  else args.push("--disable-approval");
  const progress = progressEventHandler("muse", req.onProgress);
  let sessionId = req.sessionId ?? null;
  let sessionReported = false;
  try {
    const res = await withResumeHint("muse", (o) => parseMuseJsonl(o).sessionId, () => runProcess({
      bin: req.bin,
      args,
      stdin: "",
      cwd: req.cwd,
      timeoutMs: req.timeoutSec * 1000,
      env: childEnv(req.extraEnv),
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
    rmSync(dir, { recursive: true, force: true });
  }
}
