import { codexSubagentConfig } from "./codex-subagents.js";
import { codexExecutionPrompt } from "./codex-env.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ClaudePermissionMode, CodexSandbox } from "./config.js";
import type { Logger } from "./logger.js";
import { claudeMcpDenyRules } from "./claude-mcp.js";
import { PARENT_URL_ENV } from "./parent-link.js";
import { FinalAnswers } from "./final-answers.js";
import { progressLineHandler } from "./progress.js";
import { PermissionRelay, type PermissionDecision } from "./relay.js";
import { codexDriveMappings, codexPathPrompt } from "./codex-paths.js";
import { DEFAULT_MAX_DELEGATE_DEPTH, ENV, MAX_DELEGATE_DEPTH_LIMIT } from "./constants.js";

/** Env var tracking nested delegation, so a delegated agent cannot delegate back forever. */
export const DELEGATE_DEPTH_ENV = "AGENT_BRIDGE_DELEGATE_DEPTH";
export const MAX_DELEGATE_DEPTH = MAX_DELEGATE_DEPTH_LIMIT;
export const PARENT_JOB_ENV = "AGENT_BRIDGE_PARENT_JOB";
export const ROOT_SESSION_ENV = "AGENT_BRIDGE_ROOT_SESSION";
export const ROOT_NAME_ENV = "AGENT_BRIDGE_ROOT_NAME";
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
    /** stdout captured before the failure (lets callers recover the session id after a timeout). */
    readonly partialStdout = "",
    /** The agent's session, when it was known before the failure (for resuming it). */
    public sessionId: string | null = null,
  ) {
    super(message);
    this.name = "DelegateError";
  }

  /** The agent never got going (its startup timed out): trying again is safe. */
  startupFailed = false;

  static startup(message: string, stderrTail: string, sessionId: string | null): DelegateError {
    const err = new DelegateError(message, "failed", stderrTail, "", sessionId);
    err.startupFailed = true;
    return err;
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

/** Every process tree started by a delegate, so shutdown can stop them all. */
const liveChildren = new Map<ChildProcess, Logger | undefined>();

/**
 * Stop a delegate and everything it started (the agent's own tool processes, the native binary behind
 * a node launcher). child.kill() alone only stops the direct child on Windows.
 */
export function killTree(child: ChildProcess, reason = "delegate cleanup"): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  liveChildren.get(child)?.info("stopping delegate process tree", { pid, reason, method: process.platform === "win32" ? "taskkill /PID /T /F" : "process group signals" });
  // taskkill finishing is not the child closing. In particular, Windows can still hold its cwd
  // while the caller tears down the run. Subscribe before sending any signal so a fast exit is kept.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return new Promise<void>((resolve) => {
    if (process.platform === "win32") {
      const tk = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      tk.on("error", () => (child.kill(), resolve()));
      tk.on("close", (code) => {
        if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill();
        resolve();
      });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const force = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, KILL_GRACE_MS);
      child.once("exit", () => (clearTimeout(force), resolve()));
    }
  }).then(() => closed);
}

/**
 * Stop a process this one did not start (a detached job runner) and everything it started. On POSIX it gets
 * SIGTERM first (the runner then stops its subagent's own process group), SIGKILL after the grace period.
 */
export function killPid(pid: number, log?: Logger): void {
  log?.info("stopping job runner process tree", { pid, reason: "job cancellation fallback", method: process.platform === "win32" ? "taskkill /PID /T /F" : "runner signals" });
  if (process.platform === "win32") {
    const tk = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    tk.on("error", () => {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, KILL_GRACE_MS).unref();
}

/** Whether a process with this pid exists (it may be another one after pid reuse; callers check more). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just is not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kill every running delegate's process tree (on shutdown); resolves when they are gone or after a cap. */
export async function killAllDelegates(capMs = KILL_GRACE_MS): Promise<void> {
  const all = [...liveChildren.keys()].map((c) => killTree(c, "server shutdown"));
  await Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, capMs))]);
}

export function trackChild(child: ChildProcess, log?: Logger): void {
  liveChildren.set(child, log);
  log?.info("delegate process started", { pid: child.pid });
  child.once("exit", () => {
    // Every POSIX delegate above owns a fresh process group. Its leader exiting does not
    // mean its tools exited, and killTree deliberately skips a dead ChildProcess PID.
    // Clean the original group at the exit event, never retain a stale PID for a later sweep.
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
        log?.info("stopped surviving delegate process group", { pgid: child.pid, reason: "delegate root exited" });
      } catch {
        // No members remain in the original group.
      }
    }
    liveChildren.delete(child);
  });
}

/** What to spawn for a CLI: its real executable (npm .cmd shims unwrapped), or the shim through a shell. */
export function resolveCommand(bin: string, argsIn: string[], env: NodeJS.ProcessEnv, log: Logger): { resolved: string; args: string[]; needsShell: boolean } {
  let resolved = resolveBinary(bin, env);
  if (!resolved) throw new DelegateError(`executable not found: ${bin}`, "not_found");
  let args = argsIn;
  let needsShell = process.platform === "win32" && WINDOWS_SHIM_EXTS.has(extname(resolved).toLowerCase());
  if (needsShell) {
    const target = unwrapNpmShim(resolved);
    if (target && existsSync(target.command) && target.prefix.every((p) => existsSync(p))) {
      log.debug("unwrapped npm shim", { shim: resolved, command: target.command, prefix: target.prefix });
      resolved = target.command;
      args = [...target.prefix, ...args];
      needsShell = false;
    }
  }
  if (needsShell) {
    // Last resort: cmd.exe re-parses the command line, so refuse anything it could interpret.
    for (const a of args) {
      if (/[&|<>^%"\s]/.test(a)) throw new DelegateError(`unsafe argument for shell invocation: ${a}`, "failed");
    }
  }
  return { resolved: needsShell ? `"${resolved}"` : resolved, args, needsShell };
}

export interface RunResult {
  code: number | null;
  /** The signal that ended the process, if one did (then code is null). */
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** How a process ended, for error messages: "exited with code 1" or "was killed by signal SIGKILL". */
export function exitDescription(res: Pick<RunResult, "code" | "signal">): string {
  return res.code === null && res.signal ? `was killed by signal ${res.signal}` : `exited with code ${res.code}`;
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
  /** What runs, for the timeout message (e.g. "git worktree add"); default: a delegated agent run. */
  what?: string;
}): Promise<RunResult> {
  let command: { resolved: string; args: string[]; needsShell: boolean };
  try {
    command = resolveCommand(opts.bin, opts.args, opts.env, opts.log);
  } catch (err) {
    return Promise.reject(err);
  }
  const { resolved, args, needsShell } = command;
  opts.log.debug("spawning delegate", { bin: resolved, args, cwd: opts.cwd, shell: needsShell });

  return new Promise((resolve, reject) => {
    const child = spawn(resolved, args, {
      cwd: opts.cwd,
      // Some CLIs (opencode) take their project folder from PWD rather than the real cwd; keep them in sync.
      env: { ...opts.env, PWD: opts.cwd },
      shell: needsShell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group on POSIX, so the whole tree can be killed (see killTree).
      detached: process.platform !== "win32",
    });
    trackChild(child, opts.log);
    // Long runs can print more than the cap: keep the start (session id) and the end (final answer).
    let head = "";
    let tail = "";
    const captured = () => (tail ? `${head}\n${tail.slice(tail.indexOf("\n") + 1)}` : head);
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = (reason: string) => void killTree(child, reason);
    const timer = setTimeout(() => {
      kill("delegate time limit");
      const seconds = Math.round(opts.timeoutMs / 1000);
      const message = opts.what ? `${opts.what} timed out after ${seconds}s` : `delegate timed out after ${seconds}s (its time limit, timeout_sec)`;
      finish(() => reject(new DelegateError(message, "timeout", stderr.slice(-STDERR_TAIL_CHARS), captured())));
    }, opts.timeoutMs);
    const onAbort = () => {
      kill("delegate aborted");
      finish(() => reject(new DelegateError("delegate aborted", "aborted", "", captured())));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let pending = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      if (head.length < MAX_CAPTURE_CHARS / 2) head += d;
      else tail = (tail + d).slice(-MAX_CAPTURE_CHARS / 2);
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
    child.on("close", (code, signal) => finish(() => resolve({ code, signal, stdout: captured(), stderr })));
    child.stdin.on("error", () => {
      // The child may exit before reading stdin; the close handler reports the outcome.
    });
    child.stdin.end(opts.stdin);
  });
}

export interface DelegateRequest {
  maxDelegateDepth?: number;
  /** Maximum open native Codex child threads, excluding this job. */
  nativeSubagents?: number;
  prompt: string;
  /** The job's title, used as its Codex thread name. */
  title?: string;
  cwd: string;
  sessionId?: string | null;
  timeoutSec: number;
  /** Model override; null uses the CLI default. */
  model?: string | null;
  /** Reasoning effort override (Claude --effort, Codex model_reasoning_effort, opencode --variant); null uses the CLI default. */
  effort?: string | null;
  /** The model and effort the subagent really uses, where its CLI reports them (Codex threads, Claude's init). */
  onInfo?: (info: { model?: string | null; effort?: string | null; permission?: string | null }) => void;
  /** Receives short human-readable status lines while the delegate works. */
  onProgress?: (message: string, full?: string) => void;
  /** Extra folders the subagent may write (workspace-write), e.g. a worktree's git data in the main repo. */
  writableRoots?: string[];
  /** Called once with the subagent's own session id, as soon as it is known (not only at the end). */
  onSession?: (sessionId: string) => void;
  /**
   * Answers the subagent's approval questions: the parent agent (background subagents) or the user decides.
   * Used by Codex app-server, opencode served mode and the Claude PermissionRequest hook.
   */
  approve?: (r: { agent: string; tool: string; detail: string; cwd?: string; automaticReview?: boolean }) => Promise<PermissionDecision>;
  /** Deliver denial context through hooks if native live input cannot reach the running turn. */
  onDenied?: (message: string) => void;
  /**
   * Whether someone can really answer approve's questions in this run (the parent agent of a background
   * subagent, or a user who can see permission dialogs). Where a target would otherwise approve blindly or
   * deny, it only routes questions to approve when this is true, so nothing becomes more permissive.
   */
  canApprove?: boolean;
  /** Talking to the running subagent, where the target supports it natively (Codex app-server). */
  live?: {
    from: string;
    onSteering: (s: { send: (message: string, sibling?: boolean) => Promise<boolean>; rename?: (title: string) => Promise<void> } | null) => void;
    /** Its reply to a message delivered this way. */
    onAnswer: (text: string) => void;
  };
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
/** With it, Codex requests approval for anything beyond the sandbox instead of just failing. */
export const CODEX_ASK_POLICY = 'approval_policy="on-request"';
export const CODEX_NO_APPROVALS = 'approval_policy="never"';
export const CODEX_ASK_HINT =
  "(The workspace is read-only on purpose: when you need to change files or run a command the sandbox blocks, request escalated permissions for it. The user is asked and decides; if denied, stop and report.)";
/** Read-only for opencode: no file changes, no shell commands. Reading and searching stay allowed. */
// "ask" rather than "deny": the tools stay listed (some providers reject a reduced tool set), and headless
// `opencode run` rejects every ask without --auto, so nothing is changed.
export const OPENCODE_READ_ONLY_PERMISSIONS = { edit: "ask", bash: "ask" } as const;
/** MCP tools (named <server>_<tool>) can change things too: read-only runs keep only agent-bridge's send (to answer the parent). */
export const OPENCODE_READ_ONLY_TOOLS = {
  "*_*": false, bridge_send: true, bridge_report_progress: true, bridge_peers: true, bridge_search_history: true, bridge_get_conversation: true,
  bridge_spawn_codex: true, bridge_spawn_claude: true, bridge_ask_codex: true, bridge_ask_claude: true,
  bridge_message_subagent: true, bridge_cancel_subagent: true, bridge_inbox: true, bridge_wait_for_message: true,
} as const;

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // The parent's project dir would point a delegated Claude (it may work in a worktree) at the wrong folder.
  const { CLAUDE_PROJECT_DIR: _parentProject, ...env } = process.env;
  return { ...env, ...extra, [DELEGATE_DEPTH_ENV]: String(currentDelegateDepth() + 1) };
}

export function checkDepth(max = Number(process.env[ENV.maxDelegateDepth] ?? DEFAULT_MAX_DELEGATE_DEPTH), env: NodeJS.ProcessEnv = process.env): void {
  const limit = Number.isInteger(max) && max >= 1 ? Math.min(max, MAX_DELEGATE_DEPTH_LIMIT) : DEFAULT_MAX_DELEGATE_DEPTH;
  if (currentDelegateDepth(env) >= limit) {
    throw new DelegateError(`delegation depth limit ${limit} reached`, "depth");
  }
}

/** The session id in one JSON event line of a CLI, if it carries one. */
export function sessionInLine(agent: "codex" | "claude" | "opencode", line: string): string | null {
  if (!line.startsWith("{")) return null;
  try {
    const ev = JSON.parse(line) as Record<string, any>;
    const id = agent === "codex" ? (ev.type === "thread.started" ? ev.thread_id : null) : agent === "claude" ? ev.session_id : (ev.sessionID ?? ev.part?.sessionID);
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/** Wraps a line handler: reports the session id the first time it shows up in the stream. */
function withSessionSniffer(agent: "codex" | "claude" | "opencode", next: ((line: string) => void) | undefined, onSession: ((id: string) => void) | undefined): ((line: string) => void) | undefined {
  if (!onSession) return next;
  let seen = false;
  return (line) => {
    if (!seen) {
      const id = sessionInLine(agent, line);
      if (id) {
        seen = true;
        onSession(id);
      }
    }
    next?.(line);
  };
}

/** Parse `codex exec --json` JSONL output. */
export function parseCodexJsonl(stdout: string): { threadId: string | null; text: string; error: string | null; usage: unknown } {
  let threadId: string | null = null;
  const messages = new FinalAnswers();
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
        if (ev.item?.type === "agent_message" && typeof ev.item.text === "string") messages.add(ev.item);
        break;
      case "turn.completed":
        usage = ev.usage ?? usage;
        // "error" events before a completed turn were transient (e.g. a reconnect); the run succeeded.
        error = null;
        break;
      case "turn.failed":
        error = ev.error?.message ?? "turn failed";
        break;
      case "error":
        error = ev.message ?? "error";
        break;
    }
  }
  return { threadId, text: messages.text(), error, usage };
}

/** The canonical path of a folder (drive mappings and junctions resolved); the input on any error. */
export function realFolder(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

export async function delegateToCodex(
  req: DelegateRequest & { bin: string; sandbox: CodexSandbox; relayApprovals?: boolean; networkAccess?: boolean },
): Promise<DelegateResult> {
  checkDepth(req.maxDelegateDepth);
  // Codex's Windows sandbox runs as a separate user that does not see per-user drive mappings (a mapped
  // or subst'ed E: drive): commands fail with "no E: drive". Hand it the real path instead.
  req = { ...req, cwd: realFolder(req.cwd), prompt: codexExecutionPrompt(codexPathPrompt(req.prompt, codexDriveMappings(`${req.cwd}\n${req.prompt}`)), req.sandbox) };
  // In ask mode the sandbox is read-only and every change goes through an approval the user answers;
  // without this hint Codex gives up at the sandbox instead of requesting the approval.
  if (req.relayApprovals && req.sandbox !== "danger-full-access") req = { ...req, prompt: `${req.prompt}\n\n${CODEX_ASK_HINT}` };
  const common = ["--json", "--skip-git-repo-check", ...(req.model ? ["-m", req.model] : []), ...(req.effort ? ["-c", `model_reasoning_effort="${req.effort}"`] : [])];
  for (const [key, value] of Object.entries(codexSubagentConfig(req.nativeSubagents))) common.push("-c", `${key}=${value}`);
  if (req.writableRoots?.length && req.sandbox === "workspace-write") {
    common.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(req.writableRoots.map(realFolder))}`);
  }
  if (req.sandbox === "workspace-write" && req.networkAccess !== undefined) common.push("-c", `sandbox_workspace_write.network_access=${req.networkAccess}`);
  // With approvals_reviewer="auto_review" in the user's config, codex exec lets a reviewer model approve
  // escalations, so a read-only sandbox would not hold. Route approvals to "user": exec then never
  // escalates and the sandbox is enforced (verified: read-only then refuses to create files).
  // relayApprovals: exec then asks for approvals, and the (trusted) agent-bridge PermissionRequest hook
  // answers them with the user's decision. Only used when that hook's trust entry exists.
  const strict = req.sandbox === "danger-full-access" ? ["-c", CODEX_STRICT_APPROVALS, "-c", CODEX_NO_APPROVALS] : req.relayApprovals ? ["-c", CODEX_RELAY_APPROVALS, "-c", CODEX_ASK_POLICY] : ["-c", CODEX_STRICT_APPROVALS];
  const args = req.sessionId
    ? ["exec", "resume", ...common, ...strict, "-c", `sandbox_mode="${req.sandbox}"`, req.sessionId, "-"]
    : ["exec", ...common, ...strict, "-s", req.sandbox, "-C", req.cwd, "-"];
  const res = await withResumeHint("codex", (o) => parseCodexJsonl(o).threadId, () => runProcess({
    bin: req.bin,
    args,
    stdin: req.prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutSec * 1000,
    env: childEnv(req.extraEnv),
    log: req.log,
    signal: req.signal,
    onLine: withSessionSniffer("codex", progressLineHandler("codex", req.onProgress), req.onSession),
  }));
  const parsed = parseCodexJsonl(res.stdout);
  const isError = res.code !== 0 || parsed.error !== null;
  if (isError && !parsed.text) {
    throw new DelegateError(parsed.error ?? `codex ${exitDescription(res)}`, "failed", res.stderr.slice(-STDERR_TAIL_CHARS), "", parsed.threadId ?? req.sessionId ?? null);
  }
  req.log.info("codex delegate finished", { threadId: parsed.threadId, code: res.code, isError });
  return {
    sessionId: parsed.threadId ?? req.sessionId ?? null,
    text: parsed.text,
    isError,
    details: { exitCode: res.code, signal: res.signal ?? null, usage: parsed.usage, error: parsed.error },
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
/** The agent-bridge plugin's "send" tool as Claude Code names it. */
const CLAUDE_PARENT_SEND_TOOL = "mcp__plugin_agent-bridge_bridge__send";
const CLAUDE_PARENT_PROGRESS_TOOL = "mcp__plugin_agent-bridge_bridge__report_progress";
export const CLAUDE_READ_ONLY_DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"];
/** Whether a Claude subagent in this mode may only look (no edits, commands or MCP tools). */
export function isClaudeReadOnly(mode: ClaudePermissionMode): boolean {
  return CLAUDE_READ_ONLY_MODES.has(mode);
}

/** Permission modes that mean "look only". */
const CLAUDE_READ_ONLY_MODES = new Set<ClaudePermissionMode>(["default", "manual", "plan"]);

/** The CLI bundled next to this module (plugins/<x>/dist/cli.mjs next to server.mjs); null when run from source. */
export function bundledCli(): string | null {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.mjs");
  return existsSync(cli) ? cli : null;
}

/** Whether a CLI starts without a shell (a shell would refuse the JSON settings argument). */
function spawnsWithoutShell(bin: string, log: Logger): boolean {
  try {
    return !resolveCommand(bin, [], process.env, log).needsShell;
  } catch {
    return false;
  }
}

/**
 * `--settings` for a Claude subagent: a PermissionRequest command hook (it fires in headless `claude -p` too,
 * whenever a tool would show a permission dialog) that asks agent-bridge's relay (see cli/permission-hook.ts).
 * Deny rules and allow rules are applied before it, so it never widens a read-only run's deny list.
 */
export function claudePermissionHookSettings(cli: string, node = process.execPath): string {
  const hook = { type: "command", command: node, args: [cli, "permission-hook", "claude"], timeout: CLAUDE_HOOK_TIMEOUT_SEC };
  return JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [hook] }] } });
}

/** Whether a Claude subagent's permission prompts go to approve: never read-only, only with someone to answer. */
export function claudeForwardsPrompts(mode: ClaudePermissionMode, req: Pick<DelegateRequest, "approve" | "canApprove">): boolean {
  return !isClaudeReadOnly(mode) && Boolean(req.canApprove && req.approve);
}

/** Longer than the parent's (and the user's) 10 minutes to answer: on a hook timeout Claude would just deny. */
const CLAUDE_HOOK_TIMEOUT_SEC = 900;

/** Claude's first stream line (system init) names the model it really runs, e.g. for an alias like "opus". */
function claudeInitSniffer(next: ((line: string) => void) | undefined, onInfo: DelegateRequest["onInfo"]): ((line: string) => void) | undefined {
  if (!onInfo) return next;
  let seen = false;
  return (line) => {
    if (!seen && line.includes('"subtype":"init"')) {
      seen = true;
      try {
        const model = (JSON.parse(line) as { model?: unknown }).model;
        if (typeof model === "string" && model) onInfo({ model });
      } catch {
        // not the line we are after
      }
    }
    next?.(line);
  };
}

export async function delegateToClaude(
  req: DelegateRequest & { bin: string; permissionMode: ClaudePermissionMode; hookCli?: string },
): Promise<DelegateResult> {
  checkDepth(req.maxDelegateDepth);
  // stream-json lets us report progress; the final "result" line matches --output-format json.
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", req.permissionMode];
  // Read-only also means no MCP tools: those of the user's plugins can change things. Each server is denied by
  // name except agent-bridge's (a blanket mcp__* deny would beat the allow for send, which answers the parent).
  const readOnly = isClaudeReadOnly(req.permissionMode);
  if (readOnly) args.push("--disallowedTools", [...CLAUDE_READ_ONLY_DENIED_TOOLS, ...claudeMcpDenyRules(req.cwd)].join(","));
  if (req.model) args.push("--model", req.model);
  if (req.effort) args.push("--effort", req.effort);
  if (req.sessionId) args.push("--resume", req.sessionId);
  // Headless Claude denies MCP tools it would ask about: let it answer its parent (see parent-link.ts).
  if (req.extraEnv?.[PARENT_URL_ENV]) args.push("--allowedTools", `${CLAUDE_PARENT_SEND_TOOL},${CLAUDE_PARENT_PROGRESS_TOOL}`);
  // Permission prompts (a command or MCP tool that needs approval) go to approve through a PermissionRequest
  // hook; without it headless Claude settles them on its own, unseen. Never for read-only runs: there the deny
  // list decides alone. The hook fires in `claude -p` since Claude Code 2.1.268; older versions skip it.
  const hookCli = claudeForwardsPrompts(req.permissionMode, req) ? (req.hookCli ?? bundledCli()) : null;
  let relay: PermissionRelay | null = null;
  const extraEnv = { ...req.extraEnv };
  if (hookCli && spawnsWithoutShell(req.bin, req.log)) {
    const approve = req.approve!;
    relay = new PermissionRelay(async (r) => {
      const d = await approve(r);
      return d.allow ? { allow: true } : { allow: false, message: d.message || "Denied by the parent session." };
    }, req.log);
    await relay.start();
    Object.assign(extraEnv, relay.childEnv());
    args.push("--settings", claudePermissionHookSettings(hookCli));
  } else if (hookCli) {
    req.log.warn("claude runs through a shell; its permission prompts are not forwarded", { bin: req.bin });
  }
  let res: RunResult;
  try {
    res = await withResumeHint("claude", (o) => claudeSessionFromStream(o), () => runProcess({
      bin: req.bin,
      args,
      stdin: req.prompt,
      cwd: req.cwd,
      timeoutMs: req.timeoutSec * 1000,
      env: childEnv(extraEnv),
      log: req.log,
      signal: req.signal,
      onLine: claudeInitSniffer(withSessionSniffer("claude", progressLineHandler("claude", req.onProgress), req.onSession), req.onInfo),
    }));
  } finally {
    await relay?.stop();
  }
  const parsed = parseClaudeJson(res.stdout);
  if (!parsed) {
    throw new DelegateError(`claude ${exitDescription(res)} without a JSON result`, "failed", (res.stderr || res.stdout).slice(-STDERR_TAIL_CHARS), "", claudeSessionFromStream(res.stdout) ?? req.sessionId ?? null);
  }
  req.log.info("claude delegate finished", { sessionId: parsed.sessionId, code: res.code, isError: parsed.isError });
  return {
    sessionId: parsed.sessionId ?? req.sessionId ?? null,
    text: parsed.text,
    isError: parsed.isError || res.code !== 0,
    details: { exitCode: res.code, signal: res.signal ?? null, costUsd: parsed.cost },
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
  checkDepth(req.maxDelegateDepth);
  // --dir as well: opencode must not fall back to an inherited PWD (it then works in the wrong folder).
  const args = ["run", "--format", "json", "--dir", req.cwd];
  if (req.model) args.push("-m", req.model);
  if (req.effort) args.push("--variant", req.effort);
  if (req.sessionId) args.push("-s", req.sessionId);
  // opencode's default rules allow edits and commands without asking, so read access must be enforced
  // explicitly: an extra config layer (merged over the user's) denies them. --auto approves the rest.
  if (req.autoApprove) args.push("--auto");
  const env = childEnv(req.extraEnv);
  if (!req.autoApprove) env[OPENCODE_CONFIG_CONTENT_ENV] = JSON.stringify({ permission: OPENCODE_READ_ONLY_PERMISSIONS, tools: OPENCODE_READ_ONLY_TOOLS });
  const res = await withResumeHint("opencode", (o) => parseOpencodeJsonl(o).sessionId, () => runProcess({
    bin: req.bin,
    args,
    stdin: req.prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutSec * 1000,
    env,
    log: req.log,
    signal: req.signal,
    onLine: withSessionSniffer("opencode", progressLineHandler("opencode", req.onProgress), req.onSession),
  }));
  const parsed = parseOpencodeJsonl(res.stdout);
  const isError = res.code !== 0 || parsed.error !== null;
  if (isError && !parsed.text) {
    throw new DelegateError(parsed.error ?? `opencode ${exitDescription(res)}`, "failed", res.stderr.slice(-STDERR_TAIL_CHARS), "", parsed.sessionId ?? req.sessionId ?? null);
  }
  req.log.info("opencode delegate finished", { sessionId: parsed.sessionId, code: res.code, isError });
  return { sessionId: parsed.sessionId ?? req.sessionId ?? null, text: parsed.text, isError, details: { exitCode: res.code, signal: res.signal ?? null, error: parsed.error, usage: parsed.usage ?? null, costUsd: parsed.cost || null } };
}

/** Shared with the opencode server-mode delegate. */
export const checkDepthPublic = checkDepth;
export const childEnvPublic = (extra: Record<string, string> = {}) => childEnv(extra);

/** Session id from a partial `claude -p --output-format stream-json` stream (every event carries it). */
export function claudeSessionFromStream(stdout: string): string | null {
  const m = /"session_id":"([^"]+)"/.exec(stdout);
  return m ? m[1]! : null;
}

/**
 * A timed-out run is not wasted: the agent's session keeps its progress. Tell the caller which session
 * to continue, so it resumes instead of starting the same task from scratch.
 */
export async function withResumeHint<T>(agent: string, sessionOf: (stdout: string) => string | null, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof DelegateError && !err.sessionId) err.sessionId = sessionOf(err.partialStdout);
    if (err instanceof DelegateError && err.kind === "timeout") {
      const id = err.sessionId;
      if (id) {
        throw new DelegateError(
          `${err.message}. The ${agent} session ${id} keeps its progress: call again with session_id="${id}" (and a longer timeout_sec, or use spawn_${agent}) to continue instead of starting over.`,
          "timeout",
          err.stderrTail,
          err.partialStdout,
          id,
        );
      }
    }
    throw err;
  }
}

/** Provider hiccups worth retrying: the session is fine, the provider's answer was not. */
const TRANSIENT_ERROR_RE =
  /(?:model|selected model) is at capacity|not valid JSON|upstream|overloaded|bad gateway|service unavailable|gateway time-?out|internal server error|\b50[0-4]\b|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|connection (?:reset|closed|error|refused)|stream (?:error|closed|disconnected|ended)|network error|fetch failed|temporarily unavailable|routing discovery timed out/i;
const CAPACITY_ERROR_RE = /model is at capacity/i;
export const CAPACITY_RETRY_DELAYS_MS = [15_000, 30_000, 60_000] as const;
const TRANSIENT_RETRY_LIMIT = 1;
const MS_PER_SECOND = 1_000;
/** Usage and rate limits: retrying at once only fails again, so these are reported, not retried. */
const LIMIT_ERROR_RE = /usage limit|rate.?limit|quota|too many requests|\b429\b|insufficient (?:credits|balance)|billing/i;

export function isTransientProviderError(message: string): boolean {
  return TRANSIENT_ERROR_RE.test(message) && !LIMIT_ERROR_RE.test(message);
}

/** Sent to the same session after a transient provider error, to carry on with the task. */
export const TRANSIENT_RETRY_MESSAGE =
  "Your previous turn was cut off by a temporary provider error. Continue where you stopped and finish the task. Then give your final answer.";

/**
 * Resume after provider hiccups. Capacity errors back off on the selected model, within the original
 * deadline; other transient errors get one immediate retry. Existing session state is preserved.
 */
export async function retryTransient(req: DelegateRequest, run: (req: DelegateRequest) => Promise<DelegateResult>): Promise<DelegateResult> {
  const deadline = Date.now() + req.timeoutSec * MS_PER_SECOND;
  let sessionId = req.sessionId ?? null;
  let model = req.model;
  let firstCause: string | null = null;
  let retries = 0;
  for (;;) {
    if (req.signal?.aborted) throw new DelegateError("delegate aborted", "aborted", "", "", sessionId);
    const remainingSec = (deadline - Date.now()) / MS_PER_SECOND;
    if (remainingSec <= 0) throw new DelegateError("delegate timed out during provider retry backoff", "timeout", "", "", sessionId);
    let res: DelegateResult | undefined;
    let failure: unknown;
    let failed = false;
    let cause = "";
    try {
      res = await run({
        ...req, model, sessionId, timeoutSec: remainingSec, prompt: retries && sessionId ? TRANSIENT_RETRY_MESSAGE : req.prompt,
        onSession: (id) => {
          sessionId = id;
          req.onSession?.(id);
        },
        onInfo: (info) => {
          model ??= info.model;
          req.onInfo?.(info);
        },
      });
      sessionId = res.sessionId ?? sessionId;
      cause = res.isError && typeof res.details?.error === "string" ? res.details.error : "";
    } catch (err) {
      failure = err;
      failed = true;
      if (err instanceof DelegateError) {
        sessionId = err.sessionId ?? sessionId;
        cause = err.kind === "failed" ? err.message : "";
      }
    }
    const capacity = CAPACITY_ERROR_RE.test(cause);
    const limit = capacity ? CAPACITY_RETRY_DELAYS_MS.length : TRANSIENT_RETRY_LIMIT;
    if (!isTransientProviderError(cause) || (!sessionId && !capacity) || retries >= limit) {
      if (failed) {
        if (failure instanceof DelegateError && firstCause) {
          failure.message += ` (after ${retries === 1 ? "one automatic retry" : `${retries} automatic retries`}: the first attempt had failed with "${firstCause}")`;
          failure.sessionId ??= sessionId;
        }
        throw failure;
      }
      if (!firstCause) return res!;
      const count = retries === 1 ? "once" : `${retries} times`;
      const note = `(A temporary provider error interrupted the run ("${firstCause}"); agent-bridge ${sessionId ? "resumed the same session" : "retried"} ${count} on the selected model.)`;
      return { ...res!, text: `${note}\n\n${res!.text}`, details: { ...res!.details, retriedAfter: firstCause, retries } };
    }
    firstCause ??= cause;
    const waitMs = capacity ? CAPACITY_RETRY_DELAYS_MS[retries]! : 0;
    if (Date.now() + waitMs >= deadline) throw new DelegateError("delegate timed out during provider retry backoff", "timeout", "", "", sessionId);
    retries++;
    req.log.warn("transient provider error; retrying on the selected model", { sessionId, model, cause, retries, waitMs });
    req.onProgress?.(`temporary provider error: ${cause}; retry ${retries}/${limit} in ${waitMs / MS_PER_SECOND}s on the same model, ${sessionId ? "preserving session progress" : "before session start"}`);
    try {
      await delay(waitMs, undefined, { signal: req.signal });
    } catch {
      throw new DelegateError("delegate aborted", "aborted", "", "", sessionId);
    }
  }
}

/** The last lines of a process's error output, short enough for a report. */
function stderrSummary(stderr: string): string {
  const lines = stderr.trim().split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-5).join("\n").slice(-800);
}

function labelError(message: string): string {
  return LIMIT_ERROR_RE.test(message) ? `usage or rate limit reached: ${message}` : `error: ${message}`;
}

/**
 * Why a delegated run failed, for the report to whoever started it: the exit code or signal, which timeout,
 * the provider's error text, a usage limit, or a cancellation. Never just "failed".
 */
export function failureCause(outcome: { result?: DelegateResult; error?: unknown }): string {
  if (outcome.result) {
    const d = outcome.result.details ?? {};
    const parts: string[] = [];
    if (typeof d.error === "string" && d.error) parts.push(labelError(d.error));
    if (typeof d.exitCode === "number" && d.exitCode !== 0) parts.push(`the agent exited with code ${d.exitCode}`);
    else if (typeof d.signal === "string" && d.signal) parts.push(`the agent was killed by signal ${d.signal}`);
    return parts.join("; ") || "the agent ended its turn with an error but gave no details";
  }
  const err = outcome.error;
  if (!(err instanceof DelegateError)) return `error: ${String((err as Error)?.message ?? err)}`;
  switch (err.kind) {
    case "aborted":
      return "cancelled: it was stopped (cancel_subagent, or the session that started it ended)";
    case "timeout":
      return `timeout: ${err.message}`;
    case "not_found":
      return `could not start: ${err.message}`;
    default: {
      const tail = err.stderrTail ? stderrSummary(err.stderrTail) : "";
      return `${labelError(err.message)}${tail && !err.message.includes(tail) ? `\nLast error output:\n${tail}` : ""}`;
    }
  }
}
