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

export interface UsageReport {
  agent: CodingAgent;
  lines: string[];
  /** Highest "% used" among the limits, when known: the one that blocks first. */
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

function resetText(epoch: number | null | undefined): string {
  if (!epoch) return "";
  const d = new Date(epoch < 1e12 ? epoch * 1000 : epoch);
  return ` (resets ${d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })})`;
}

/** Format Codex's GetAccountRateLimitsResponse. */
export function formatCodexLimits(res: any): UsageReport {
  const lines: string[] = [];
  let max: number | null = null;
  const snapshots: any[] = res?.rateLimitsByLimitId ? Object.values(res.rateLimitsByLimitId) : res?.rateLimits ? [res.rateLimits] : [];
  for (const s of snapshots) {
    const parts: string[] = [];
    for (const w of [s?.primary, s?.secondary]) {
      if (!w || typeof w.usedPercent !== "number") continue;
      max = Math.max(max ?? 0, w.usedPercent);
      parts.push(`${windowName(w.windowDurationMins)} ${w.usedPercent}% used${resetText(w.resetsAt)}`);
    }
    if (s?.credits?.hasCredits && !s.credits.unlimited && s.credits.balance) parts.push(`credits ${s.credits.balance}`);
    if (s?.rateLimitReachedType) parts.push(`LIMIT REACHED (${s.rateLimitReachedType})`);
    if (parts.length) lines.push(`${s?.limitName ?? s?.limitId ?? "codex"}${s?.planType ? ` [${s.planType}]` : ""}: ${parts.join(", ")}`);
  }
  if (res?.ordinaryUsageAllowed === false) lines.push("The account currently does not allow ordinary usage.");
  return { agent: "codex", lines: lines.length ? lines : ["No limits reported (API key or no plan limits)."], maxUsedPercent: max };
}

/** Pick the limit lines out of `claude -p /usage`. */
export function parseClaudeUsage(text: string): UsageReport {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\d+%\s*used/i.test(l) || /api key/i.test(l));
  const percents = lines.map((l) => Number(/(\d+)%\s*used/i.exec(l)?.[1])).filter((n) => Number.isFinite(n));
  return { agent: "claude", lines: lines.length ? lines : ["No limits reported."], maxUsedPercent: percents.length ? Math.max(...percents) : null };
}

/** Today's spend and tokens from `opencode stats`. */
export function parseOpencodeStats(text: string): UsageReport {
  const pick = (label: string) => new RegExp(`${label}\\s+([^\\s│|]+)`, "i").exec(text)?.[1];
  const cost = pick("Total Cost");
  const input = pick("Input");
  const output = pick("Output");
  const lines = ["No account limits: opencode uses the providers' keys and plans."];
  if (cost || input) lines.push(`Last 24 hours: ${[cost && `cost ${cost}`, input && `${input} input tokens`, output && `${output} output tokens`].filter(Boolean).join(", ")}`);
  return { agent: "opencode", lines, maxUsedPercent: null };
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

async function codexUsage(bin: string, cwd: string, log: Logger): Promise<UsageReport> {
  const out = await capture(bin, ["app-server"], cwd, log, (write, read, done) => {
    write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-bridge", version: APP_VERSION }, capabilities: { experimentalApi: false } } })}\n`);
    write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    write(`${JSON.stringify({ id: 2, method: "account/rateLimits/read", params: null })}\n`);
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
  return formatCodexLimits(msg.result);
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
    return { agent, lines: [`Could not read usage: ${(err as Error).message}`], maxUsedPercent: null };
  }
}
