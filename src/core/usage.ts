import { spawn } from "node:child_process";
import { APP_VERSION } from "./constants.js";
import { childEnv, killTree, resolveCommand } from "./delegate.js";
import type { Logger } from "./logger.js";
import type { CodingAgent } from "./protocol.js";

/**
 * How much of each agent's account limits is left, so a driving agent can decide whom to give work to
 * (and when to stop). Every source is local and costs no model call:
 *  - Codex: `account/rateLimits/read` of `codex app-server`
 *  - Claude Code: `claude -p /usage` (runs locally in print mode)
 *  - opencode: no account limits (it uses provider keys); `opencode stats` shows today's spend and tokens
 */
const USAGE_TIMEOUT_MS = 45_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const PLAN_LIMIT_REACHED = "rate_limit_reached";
const BLOCKING_LIMIT_TYPES = new Set([
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);
const FULL_USAGE_PERCENT = 100;
const CREDIT_SIGNIFICANT_DIGITS = 3;

/** One account limit, for display as a bar (the dashboard). */
export interface UsageLimit {
  name: string;
  usedPercent: number;
  /** When it resets, as the CLI words it (or a local time); null when unknown. */
  resets: string | null;
}

export interface UsageReport {
  agent: CodingAgent;
  lines: string[];
  /** The same limits, structured. Empty when the agent has none (opencode, API keys). */
  limits: UsageLimit[];
  /** Prepaid credits (Codex): what runs once a limit is reached. */
  credits?: { balance: string; unlimited: boolean; inUse: boolean } | null;
  /** Highest plan "% used", when known; credits may still allow usage. */
  maxUsedPercent: number | null;
}

/** Run a CLI briefly and return its stdout (or throw). */
function capture(bin: string, args: string[], cwd: string, log: Logger, stdin?: (write: (s: string) => void, out: () => string, done: () => void) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = childEnv();
    let cmd: ReturnType<typeof resolveCommand>;
    try {
      cmd = resolveCommand(bin, args, env, log);
    } catch (err) {
      return reject(err);
    }
    const child = spawn(cmd.resolved, cmd.args, { cwd, env, shell: cmd.needsShell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void killTree(child);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`${bin} did not answer within ${USAGE_TIMEOUT_MS / 1000}s`))), USAGE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => finish(() => (code === 0 || out ? resolve(out) : reject(new Error(err.trim().slice(-300) || `exit code ${code}`)))));
    if (stdin) stdin((s) => child.stdin.write(s), () => out, () => finish(() => resolve(out)));
    else child.stdin.end();
  });
}

function windowName(mins: number | null | undefined): string {
  if (!mins) return "window";
  if (mins === 5 * MINUTES_PER_HOUR) return "5-hour window";
  if (mins === 7 * MINUTES_PER_DAY) return "weekly";
  return mins % MINUTES_PER_DAY === 0 ? `${mins / MINUTES_PER_DAY}-day window` : `${Math.round(mins / MINUTES_PER_HOUR)}-hour window`;
}

function resetTime(epoch: number | null | undefined): string | null {
  if (!epoch) return null;
  const d = new Date(epoch < 1e12 ? epoch * 1000 : epoch);
  return d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function resetText(epoch: number | null | undefined): string {
  const r = resetTime(epoch);
  return r ? ` (resets ${r})` : "";
}

/** "62082.3000850000" -> "62,082". */
function formatCredits(balance: string): string {
  const n = Number(balance);
  if (!Number.isFinite(n)) return balance;
  if (n > 0 && n < 1) return n.toLocaleString("en-US", { maximumSignificantDigits: CREDIT_SIGNIFICANT_DIGITS });
  return Math.floor(n).toLocaleString("en-US");
}

/** Format Codex's GetAccountRateLimitsResponse. */
export function formatCodexLimits(res: any): UsageReport {
  const lines: string[] = [];
  const limits: UsageLimit[] = [];
  let credits: UsageReport["credits"] = null;
  let max: number | null = null;
  const byId: any[] = res?.rateLimitsByLimitId ? Object.values(res.rateLimitsByLimitId) : [];
  const snapshots: any[] = byId.length ? byId : res?.rateLimits ? [res.rateLimits] : [];
  let creditFallback = false;
  let blocked = false;
  for (const s of snapshots) {
    const parts: string[] = [];
    for (const w of [s?.primary, s?.secondary]) {
      if (!w || typeof w.usedPercent !== "number") continue;
      max = Math.max(max ?? 0, w.usedPercent);
      parts.push(`${windowName(w.windowDurationMins)} ${w.usedPercent}% used${resetText(w.resetsAt)}`);
      const window = windowName(w.windowDurationMins);
      limits.push({ name: snapshots.length > 1 ? `${s?.limitName ?? s?.limitId ?? "codex"}: ${window}` : window, usedPercent: w.usedPercent, resets: resetTime(w.resetsAt) });
    }
    const blockingLimit = BLOCKING_LIMIT_TYPES.has(s?.rateLimitReachedType) || s?.spendControlReached === true;
    const planReached = s?.rateLimitReachedType === PLAN_LIMIT_REACHED || [s?.primary, s?.secondary].some((w) => w?.usedPercent >= FULL_USAGE_PERCENT) || res?.ordinaryUsageAllowed === false;
    const hasCredits = s?.credits?.hasCredits && (s.credits.unlimited || (Number.isFinite(Number(s.credits.balance)) && Number(s.credits.balance) > 0));
    if (hasCredits) {
      const balance = s.credits.unlimited ? "unlimited" : formatCredits(s.credits.balance);
      // With a limit reached, work continues on credits.
      const inUse = planReached && !blockingLimit;
      const currentCredits = { balance, unlimited: Boolean(s.credits.unlimited), inUse };
      // The dashboard has one credit card; do not let a later idle bucket hide active credit usage.
      if (!credits?.inUse || inUse) credits = currentCredits;
      creditFallback ||= inUse;
      parts.push(inUse ? `usable, plan limit reached, running on credits (${balance} left)` : `credits ${balance} available`);
    }
    if (blockingLimit) {
      blocked = true;
      parts.push(`unusable: ${s?.rateLimitReachedType ?? "spend control limit reached"}`);
    } else if (s?.rateLimitReachedType && !hasCredits) parts.push(`Plan limit reached (${s.rateLimitReachedType})`);
    if (parts.length) lines.push(`${s?.limitName ?? s?.limitId ?? "codex"}${s?.planType ? ` [${s.planType}]` : ""}: ${parts.join(", ")}`);
  }
  if (res?.ordinaryUsageAllowed === false && !creditFallback && !blocked) {
    const noCredits = snapshots.some((s) => s?.credits?.hasCredits === false || (s?.credits?.balance != null && Number.isFinite(Number(s.credits.balance)) && Number(s.credits.balance) <= 0));
    lines.push(noCredits ? "Unusable: included usage is unavailable and credits are exhausted." : "Included usage is unavailable; credit-backed usage availability is unknown.");
  }
  return { agent: "codex", lines: lines.length ? lines : ["No limits reported (API key or no plan limits)."], limits, credits, maxUsedPercent: max };
}

/** Pick the limit lines out of `claude -p /usage`. */
export function parseClaudeUsage(text: string): UsageReport {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\d+%\s*used/i.test(l) || /api key/i.test(l));
  const percents = lines.map((l) => Number(/(\d+)%\s*used/i.exec(l)?.[1])).filter((n) => Number.isFinite(n));
  // "Current week (all models): 88% used · resets Oct 6, 1:59pm (Asia/Tokyo)"
  const limits: UsageLimit[] = [];
  for (const l of lines) {
    const m = /^(.+?):\s*(\d+)%\s*used(?:\s*[·•-]\s*resets\s+(.+))?$/i.exec(l);
    if (m) limits.push({ name: m[1]!.replace(/^current\s+/i, ""), usedPercent: Number(m[2]), resets: m[3]?.trim() ?? null });
  }
  return { agent: "claude", lines: lines.length ? lines : ["No limits reported."], limits, maxUsedPercent: percents.length ? Math.max(...percents) : null };
}

/** Today's spend and tokens from `opencode stats`. */
export function parseOpencodeStats(text: string): UsageReport {
  const pick = (label: string) => new RegExp(`${label}\\s+([^\\s│|]+)`, "i").exec(text)?.[1];
  const cost = pick("Total Cost");
  const input = pick("Input");
  const output = pick("Output");
  const lines = ["No account limits: opencode uses the providers' keys and plans."];
  if (cost || input) lines.push(`Last 24 hours: ${[cost && `cost ${cost}`, input && `${input} input tokens`, output && `${output} output tokens`].filter(Boolean).join(", ")}`);
  return { agent: "opencode", lines, limits: [], maxUsedPercent: null };
}

export interface ModelCost {
  id: string;
  /** USD per million tokens, as opencode's model catalog reports it. */
  input: number;
  output: number;
}

/** Prices from `opencode models --verbose` ("provider/model" lines, each followed by its JSON). */
export function parseOpencodeModelCosts(text: string): ModelCost[] {
  const out: ModelCost[] = [];
  const parts = text.split(/^([\w.-]+\/[\w.:@-]+)\r?\n(?=\{)/m);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    try {
      const cost = JSON.parse(parts[i + 1]!.trim()).cost;
      if (cost && typeof cost.input === "number" && typeof cost.output === "number") out.push({ id: parts[i]!, input: cost.input, output: cost.output });
    } catch {
      // not a model block
    }
  }
  return out;
}

const MAX_FREE_LISTED = 12;

export function describeOpencodeCosts(costs: ModelCost[], model: string | null): string[] {
  const lines: string[] = [];
  const free = costs.filter((c) => c.input === 0 && c.output === 0).map((c) => c.id);
  if (model) {
    const m = costs.find((c) => c.id === model) ?? costs.find((c) => c.id.endsWith(`/${model}`) || c.id.includes(model));
    if (m) lines.push(m.input === 0 && m.output === 0 ? `Model ${m.id} has no per-token price (free, or covered by a plan).` : `Model ${m.id} costs $${m.input} input / $${m.output} output per million tokens.`);
  }
  if (free.length) lines.push(`Models without a per-token price (free, or covered by a plan) (${free.length}): ${free.slice(0, MAX_FREE_LISTED).join(", ")}${free.length > MAX_FREE_LISTED ? ", …" : ""}`);
  return lines;
}

/** One request to a short-lived `codex app-server` (initialize, then the call); returns its result. */
export async function codexAppServerCall(bin: string, cwd: string, log: Logger, method: string, params: unknown): Promise<any> {
  const out = await capture(bin, ["app-server"], cwd, log, (write, read, done) => {
    write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-bridge", version: APP_VERSION }, capabilities: { experimentalApi: false } } })}\n`);
    write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    write(`${JSON.stringify({ id: 2, method, params })}\n`);
    const poll = setInterval(() => {
      if (/"id":2[,}]/.test(read())) {
        clearInterval(poll);
        done();
      }
    }, 100);
  });
  const line = out.split("\n").find((l) => /"id":2[,}]/.test(l));
  const msg = line ? JSON.parse(line) : null;
  if (!msg || msg.error) throw new Error(msg?.error?.message ?? "no answer from codex app-server");
  return msg.result;
}

/** Run a CLI briefly and return its output (for model lists and help texts). */
export function captureOutput(bin: string, args: string[], cwd: string, log: Logger): Promise<string> {
  return capture(bin, args, cwd, log);
}

async function codexUsage(bin: string, cwd: string, log: Logger): Promise<UsageReport> {
  return formatCodexLimits(await codexAppServerCall(bin, cwd, log, "account/rateLimits/read", null));
}

/** `model`: the model the caller would use (opencode: shows whether it is free). */
export async function readUsage(agent: CodingAgent, bin: string, cwd: string, log: Logger, model: string | null = null): Promise<UsageReport> {
  try {
    if (agent === "codex") return await codexUsage(bin, cwd, log);
    if (agent === "claude") return parseClaudeUsage(await capture(bin, ["-p", "/usage"], cwd, log));
    const [stats, models] = await Promise.all([
      capture(bin, ["stats", "--days", "1"], cwd, log).catch(() => ""),
      capture(bin, ["models", "--verbose"], cwd, log).catch(() => ""),
    ]);
    const report = parseOpencodeStats(stats);
    report.lines.push(...describeOpencodeCosts(parseOpencodeModelCosts(models), model));
    return report;
  } catch (err) {
    return { agent, lines: [`Could not read usage: ${(err as Error).message}`], limits: [], maxUsedPercent: null };
  }
}
