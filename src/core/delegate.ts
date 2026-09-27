import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";
import type { ClaudePermissionMode, CodexSandbox } from "./config.js";
import type { Logger } from "./logger.js";

/** Env var tracking nested delegation, so a delegated agent cannot delegate back forever. */
export const DELEGATE_DEPTH_ENV = "AGENT_BRIDGE_DELEGATE_DEPTH";
export const MAX_DELEGATE_DEPTH = 1;
const KILL_GRACE_MS = 3_000;
const MAX_CAPTURE_CHARS = 8 * 1024 * 1024;
const STDERR_TAIL_CHARS = 4_000;
const WINDOWS_SHIM_EXTS = new Set([".cmd", ".bat"]);
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export function currentDelegateDepth(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env[DELEGATE_DEPTH_ENV] ?? "0", 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export class DelegateError extends Error {
  constructor(
    message: string,
    readonly kind: "not_found" | "timeout" | "failed" | "depth" | "aborted",
    readonly stderrTail = "",
  ) {
    super(message);
    this.name = "DelegateError";
  }
}

/** Resolve a bare command name against PATH (and PATHEXT on Windows). */
export function resolveBinary(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const isWin = platform === "win32";
  const exts = isWin ? (env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter(Boolean) : [""];
  const candidates = (base: string) => (isWin && !extname(base) ? exts.map((e) => base + e.toLowerCase()) : [base]);
  if (isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    return candidates(bin).find((c) => existsSync(c)) ?? null;
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const c of candidates(join(dir, bin))) if (existsSync(c)) return c;
  }
  return null;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a CLI with the prompt on stdin. Arguments are fixed flags and ids, never user text,
 * which keeps the Windows .cmd shim path (which needs a shell) free of injection risk.
 */
export function runProcess(opts: {
  bin: string;
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  log: Logger;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const resolved = resolveBinary(opts.bin, opts.env);
  if (!resolved) return Promise.reject(new DelegateError(`executable not found: ${opts.bin}`, "not_found"));
  const needsShell = process.platform === "win32" && WINDOWS_SHIM_EXTS.has(extname(resolved).toLowerCase());
  for (const a of opts.args) {
    if (needsShell && /[&|<>^%"\r\n]/.test(a)) {
      return Promise.reject(new DelegateError(`unsafe argument for shell invocation: ${a}`, "failed"));
    }
  }
  opts.log.debug("spawning delegate", { bin: resolved, args: opts.args, cwd: opts.cwd, shell: needsShell });

  return new Promise((resolve, reject) => {
    const child = spawn(needsShell ? `"${resolved}"` : resolved, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: needsShell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = () => {
      child.kill();
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new DelegateError(`delegate timed out after ${Math.round(opts.timeoutMs / 1000)}s`, "timeout", stderr.slice(-STDERR_TAIL_CHARS))));
    }, opts.timeoutMs);
    const onAbort = () => {
      kill();
      finish(() => reject(new DelegateError("delegate aborted", "aborted")));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length < MAX_CAPTURE_CHARS) stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr = (stderr + d).slice(-MAX_CAPTURE_CHARS);
    });
    child.on("error", (err) => finish(() => reject(new DelegateError(`failed to start ${opts.bin}: ${err.message}`, "failed"))));
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
    child.stdin.on("error", () => {
      // The child may exit before reading stdin; the close handler reports the outcome.
    });
    child.stdin.end(opts.stdin);
  });
}

export interface DelegateRequest {
  prompt: string;
  cwd: string;
  sessionId?: string | null;
  timeoutSec: number;
  log: Logger;
  signal?: AbortSignal;
}

export interface DelegateResult {
  sessionId: string | null;
  text: string;
  isError: boolean;
  details: Record<string, unknown>;
}

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, [DELEGATE_DEPTH_ENV]: String(currentDelegateDepth() + 1) };
}

function checkDepth(): void {
  if (currentDelegateDepth() >= MAX_DELEGATE_DEPTH) {
    throw new DelegateError("delegation is disabled inside a delegated session (prevents recursive delegation)", "depth");
  }
}

/** Parse `codex exec --json` JSONL output. */
export function parseCodexJsonl(stdout: string): { threadId: string | null; text: string; error: string | null; usage: unknown } {
  let threadId: string | null = null;
  const messages: string[] = [];
  let error: string | null = null;
  let usage: unknown = null;
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    switch (ev.type) {
      case "thread.started":
        threadId = ev.thread_id ?? threadId;
        break;
      case "item.completed":
        if (ev.item?.type === "agent_message" && typeof ev.item.text === "string") messages.push(ev.item.text);
        break;
      case "turn.completed":
        usage = ev.usage ?? usage;
        break;
      case "turn.failed":
        error = ev.error?.message ?? "turn failed";
        break;
      case "error":
        error = ev.message ?? "error";
        break;
    }
  }
  return { threadId, text: messages.at(-1) ?? "", error, usage };
}

export async function delegateToCodex(
  req: DelegateRequest & { bin: string; sandbox: CodexSandbox },
): Promise<DelegateResult> {
  checkDepth();
  const common = ["--json", "--skip-git-repo-check"];
  const args = req.sessionId
    ? ["exec", "resume", ...common, "-c", `sandbox_mode="${req.sandbox}"`, req.sessionId, "-"]
    : ["exec", ...common, "-s", req.sandbox, "-C", req.cwd, "-"];
  const res = await runProcess({
    bin: req.bin,
    args,
    stdin: req.prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutSec * 1000,
    env: childEnv(),
    log: req.log,
    signal: req.signal,
  });
  const parsed = parseCodexJsonl(res.stdout);
  const isError = res.code !== 0 || parsed.error !== null;
  if (isError && !parsed.text) {
    throw new DelegateError(parsed.error ?? `codex exited with code ${res.code}`, "failed", res.stderr.slice(-STDERR_TAIL_CHARS));
  }
  req.log.info("codex delegate finished", { threadId: parsed.threadId, code: res.code, isError });
  return {
    sessionId: parsed.threadId ?? req.sessionId ?? null,
    text: parsed.text,
    isError,
    details: { exitCode: res.code, usage: parsed.usage, error: parsed.error },
  };
}

/** Parse `claude -p --output-format json` output (a single JSON object). */
export function parseClaudeJson(stdout: string): { sessionId: string | null; text: string; isError: boolean; cost: unknown } | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const o = JSON.parse(stdout.slice(start)) as Record<string, any>;
    return {
      sessionId: typeof o.session_id === "string" ? o.session_id : null,
      text: typeof o.result === "string" ? o.result : "",
      isError: Boolean(o.is_error) || o.subtype === "error",
      cost: o.total_cost_usd ?? null,
    };
  } catch {
    return null;
  }
}

export async function delegateToClaude(
  req: DelegateRequest & { bin: string; permissionMode: ClaudePermissionMode },
): Promise<DelegateResult> {
  checkDepth();
  const args = ["-p", "--output-format", "json", "--permission-mode", req.permissionMode];
  if (req.sessionId) args.push("--resume", req.sessionId);
  const res = await runProcess({
    bin: req.bin,
    args,
    stdin: req.prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutSec * 1000,
    env: childEnv(),
    log: req.log,
    signal: req.signal,
  });
  const parsed = parseClaudeJson(res.stdout);
  if (!parsed) {
    throw new DelegateError(`claude exited with code ${res.code} without a JSON result`, "failed", (res.stderr || res.stdout).slice(-STDERR_TAIL_CHARS));
  }
  req.log.info("claude delegate finished", { sessionId: parsed.sessionId, code: res.code, isError: parsed.isError });
  return {
    sessionId: parsed.sessionId ?? req.sessionId ?? null,
    text: parsed.text,
    isError: parsed.isError || res.code !== 0,
    details: { exitCode: res.code, costUsd: parsed.cost },
  };
}
