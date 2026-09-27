import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, win32 } from "node:path";
import type { ClaudePermissionMode, CodexSandbox } from "./config.js";
import type { Logger } from "./logger.js";
import { progressLineHandler } from "./progress.js";

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

/**
 * npm installs CLIs on Windows as .cmd shims. Spawning those needs a shell, so find what the shim
 * runs instead: either a native executable (`"%dp0%\...\x.exe" %*`) or a JS entry run by node.
 */
export function unwrapNpmShim(shimPath: string, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): { command: string; prefix: string[] } | null {
  let text: string;
  try {
    text = readFile(shimPath);
  } catch {
    return null;
  }
  // .cmd shims only exist on Windows; parse their paths with Windows semantics everywhere.
  const dir = win32.dirname(shimPath);
  const exe = /"%~?dp0%?\\([^"]+?\.exe)"\s+%\*/i.exec(text);
  if (exe) return { command: win32.join(dir, exe[1]!), prefix: [] };
  const js = /"%~?dp0%?\\([^"]+?\.(?:c|m)?js)"\s+%\*/i.exec(text);
  if (js) return { command: process.execPath, prefix: [win32.join(dir, js[1]!)] };
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
  /** Called with every complete stdout line as it arrives (for progress reporting). */
  onLine?: (line: string) => void;
}): Promise<RunResult> {
  let resolved = resolveBinary(opts.bin, opts.env);
  if (!resolved) return Promise.reject(new DelegateError(`executable not found: ${opts.bin}`, "not_found"));
  let args = opts.args;
  let needsShell = process.platform === "win32" && WINDOWS_SHIM_EXTS.has(extname(resolved).toLowerCase());
  if (needsShell) {
    const target = unwrapNpmShim(resolved);
    if (target && existsSync(target.command) && target.prefix.every((p) => existsSync(p))) {
      opts.log.debug("unwrapped npm shim", { shim: resolved, command: target.command, prefix: target.prefix });
      resolved = target.command;
      args = [...target.prefix, ...args];
      needsShell = false;
    }
  }
  if (needsShell) {
    // Last resort: cmd.exe re-parses the command line, so refuse anything it could interpret.
    for (const a of args) {
      if (/[&|<>^%"\s]/.test(a)) return Promise.reject(new DelegateError(`unsafe argument for shell invocation: ${a}`, "failed"));
    }
  }
  opts.log.debug("spawning delegate", { bin: resolved, args, cwd: opts.cwd, shell: needsShell });

  return new Promise((resolve, reject) => {
    const child = spawn(needsShell ? `"${resolved}"` : resolved, args, {
      cwd: opts.cwd,
      // Some CLIs (opencode) take their project folder from PWD rather than the real cwd; keep them in sync.
      env: { ...opts.env, PWD: opts.cwd },
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

    let pending = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length < MAX_CAPTURE_CHARS) stdout += d;
      if (!opts.onLine) return;
      pending += d;
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (line) {
          try {
            opts.onLine(line);
          } catch {
            // progress reporting must never break the run
          }
        }
      }
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
  /** Model override; null uses the CLI default. */
  model?: string | null;
  /** Receives short human-readable status lines while the delegate works. */
  onProgress?: (message: string) => void;
  /** Extra environment for the child (e.g. the permission relay address). */
  extraEnv?: Record<string, string>;
  log: Logger;
  signal?: AbortSignal;
}

export interface DelegateResult {
  sessionId: string | null;
  text: string;
  isError: boolean;
  details: Record<string, unknown>;
}

/** opencode reads an extra JSON config layer from this variable (merged over the user's config). */
export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";
/** Keep delegated Codex runs inside their sandbox regardless of the user's approvals reviewer. */
export const CODEX_STRICT_APPROVALS = 'approvals_reviewer="user"';
/** Makes codex exec request approvals (answered by the agent-bridge PermissionRequest hook first). */
export const CODEX_RELAY_APPROVALS = 'approvals_reviewer="auto_review"';
/** Read-only for opencode: no file changes, no shell commands. Reading and searching stay allowed. */
// "ask" rather than "deny": the tools stay listed (some providers reject a reduced tool set), and headless
// `opencode run` rejects every ask without --auto, so nothing is changed.
export const OPENCODE_READ_ONLY_PERMISSIONS = { edit: "ask", bash: "ask" } as const;

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, [DELEGATE_DEPTH_ENV]: String(currentDelegateDepth() + 1) };
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
  req: DelegateRequest & { bin: string; sandbox: CodexSandbox; relayApprovals?: boolean },
): Promise<DelegateResult> {
  checkDepth();
  const common = ["--json", "--skip-git-repo-check", ...(req.model ? ["-m", req.model] : [])];
  // With approvals_reviewer="auto_review" in the user's config, codex exec lets a reviewer model approve
  // escalations, so a read-only sandbox would not hold. Route approvals to "user": exec then never
  // escalates and the sandbox is enforced (verified: read-only then refuses to create files).
  // relayApprovals: exec then asks for approvals, and the (trusted) agent-bridge PermissionRequest hook
  // answers them with the user's decision. Only used when that hook's trust entry exists.
  const strict = ["-c", req.relayApprovals ? CODEX_RELAY_APPROVALS : CODEX_STRICT_APPROVALS];
  const args = req.sessionId
    ? ["exec", "resume", ...common, ...strict, "-c", `sandbox_mode="${req.sandbox}"`, req.sessionId, "-"]
    : ["exec", ...common, ...strict, "-s", req.sandbox, "-C", req.cwd, "-"];
  const res = await runProcess({
    bin: req.bin,
    args,
    stdin: req.prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutSec * 1000,
    env: childEnv(req.extraEnv),
    log: req.log,
    signal: req.signal,
    onLine: progressLineHandler("codex", req.onProgress),
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

/** Parse `claude -p` output: the final "result" line of stream-json, or a single json object. */
export function parseClaudeJson(stdout: string): { sessionId: string | null; text: string; isError: boolean; cost: unknown } | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  const resultLine = [...lines].reverse().find((l) => l.includes('"type":"result"'));
  const candidate = resultLine ?? (stdout.indexOf("{") >= 0 ? stdout.slice(stdout.indexOf("{")) : null);
  if (!candidate) return null;
  try {
    const o = JSON.parse(candidate) as Record<string, any>;
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

/**
 * Tools removed from a read-only Claude subagent. A deny list is used because permission modes alone
 * did not hold in headless runs: allow rules / auto mode approved writes and commands even in "manual".
 */
export const CLAUDE_READ_ONLY_DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"];
/** Permission modes that mean "look only". */
const CLAUDE_READ_ONLY_MODES = new Set<ClaudePermissionMode>(["default", "manual", "plan"]);

export async function delegateToClaude(
  req: DelegateRequest & { bin: string; permissionMode: ClaudePermissionMode },
): Promise<DelegateResult> {
  checkDepth();
  // stream-json lets us report progress; the final "result" line matches --output-format json.
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", req.permissionMode];
  if (CLAUDE_READ_ONLY_MODES.has(req.permissionMode)) args.push("--disallowedTools", CLAUDE_READ_ONLY_DENIED_TOOLS.join(","));
  if (req.model) args.push("--model", req.model);
  if (req.sessionId) args.push("--resume", req.sessionId);
  const res = await runProcess({
    bin: req.bin,
    args,
    stdin: req.prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutSec * 1000,
    env: childEnv(req.extraEnv),
    log: req.log,
    signal: req.signal,
    onLine: progressLineHandler("claude", req.onProgress),
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

/** Parse `opencode run --format json` output: one event per line, each carrying the sessionID. */
export function parseOpencodeJsonl(stdout: string): {
  sessionId: string | null;
  text: string;
  error: string | null;
  usage?: { input: number; output: number };
  cost?: number;
} {
  let sessionId: string | null = null;
  const textByMessage = new Map<string, string[]>();
  let lastMessage = "";
  let error: string | null = null;
  let input = 0;
  let output = 0;
  let cost = 0;
  let sawUsage = false;
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (typeof ev.sessionID === "string") sessionId ??= ev.sessionID;
    if (ev.type === "step_finish" && ev.part?.tokens) {
      sawUsage = true;
      input += Number(ev.part.tokens.input) || 0;
      output += Number(ev.part.tokens.output) || 0;
      cost += Number(ev.part.cost) || 0;
    }
    if (ev.type === "text" && typeof ev.part?.text === "string") {
      const mid = String(ev.part.messageID ?? "");
      if (!textByMessage.has(mid)) textByMessage.set(mid, []);
      textByMessage.get(mid)!.push(ev.part.text);
      lastMessage = mid;
    } else if (ev.type === "error") {
      error = ev.error?.data?.message ?? ev.error?.message ?? ev.message ?? "opencode reported an error";
    }
  }
  const text = (textByMessage.get(lastMessage) ?? []).join("");
  return sawUsage ? { sessionId, text, error, usage: { input, output }, cost } : { sessionId, text, error };
}

export async function delegateToOpencode(req: DelegateRequest & { bin: string; autoApprove: boolean }): Promise<DelegateResult> {
  checkDepth();
  // --dir as well: opencode must not fall back to an inherited PWD (it then works in the wrong folder).
  const args = ["run", "--format", "json", "--dir", req.cwd];
  if (req.model) args.push("-m", req.model);
  if (req.sessionId) args.push("-s", req.sessionId);
  // opencode's default rules allow edits and commands without asking, so read access must be enforced
  // explicitly: an extra config layer (merged over the user's) denies them. --auto approves the rest.
  if (req.autoApprove) args.push("--auto");
  const env = childEnv(req.extraEnv);
  if (!req.autoApprove) env[OPENCODE_CONFIG_CONTENT_ENV] = JSON.stringify({ permission: OPENCODE_READ_ONLY_PERMISSIONS });
  const res = await runProcess({
    bin: req.bin,
    args,
    stdin: req.prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutSec * 1000,
    env,
    log: req.log,
    signal: req.signal,
    onLine: progressLineHandler("opencode", req.onProgress),
  });
  const parsed = parseOpencodeJsonl(res.stdout);
  const isError = res.code !== 0 || parsed.error !== null;
  if (isError && !parsed.text) {
    throw new DelegateError(parsed.error ?? `opencode exited with code ${res.code}`, "failed", res.stderr.slice(-STDERR_TAIL_CHARS));
  }
  req.log.info("opencode delegate finished", { sessionId: parsed.sessionId, code: res.code, isError });
  return { sessionId: parsed.sessionId ?? req.sessionId ?? null, text: parsed.text, isError, details: { exitCode: res.code, error: parsed.error, usage: parsed.usage ?? null, costUsd: parsed.cost || null } };
}

/** Shared with the opencode server-mode delegate. */
export const checkDepthPublic = checkDepth;
export const childEnvPublic = (extra: Record<string, string> = {}) => childEnv(extra);
