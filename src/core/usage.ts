import { spawn } from "node:child_process";
import { APP_VERSION } from "./constants.js";
import { childEnv, killTree, resolveCommand, opencodeV2 } from "./delegate.js";
import type { Logger } from "./logger.js";
import type { CodingAgent } from "./protocol.js";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolveHome } from "./paths.js";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { decideProviderUsage, PROVIDER_USAGE_TTL_MS, type ProviderUsageDecision, type ProviderUsageFact, type ProviderUsageScope } from "./provider-usage-policy.js";

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

export interface CaptureOptions {
  timeoutMs?: number;
  maxBytes?: number;
  requireZeroExit?: boolean;
}

const DEFAULT_MAX_CAPTURE_BYTES = 1024 * 1024;
const ANTIGRAVITY_VERSION_TIMEOUT_MS = 10_000;
const ANTIGRAVITY_USAGE_TIMEOUT_MS = 15_000;
const ANTIGRAVITY_MAX_USAGE_BYTES = 256 * 1024;

/** Run a CLI briefly and return its stdout (or throw). */
function capture(
  bin: string,
  args: string[],
  cwd: string,
  log: Logger,
  stdin?: (write: (s: string) => void, out: () => string, done: () => void) => void | (() => void),
  options?: CaptureOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = childEnv();
    let cmd: ReturnType<typeof resolveCommand>;
    try {
      cmd = resolveCommand(bin, args, env, log);
    } catch (err) {
      return reject(err);
    }
    const timeoutMs = options?.timeoutMs ?? USAGE_TIMEOUT_MS;
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
    const child = spawn(cmd.resolved, cmd.args, { cwd, env, shell: cmd.needsShell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let out = "";
    let err = "";
    let totalBytes = 0;
    let settled = false;
    let cleanup: (() => void) | void;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup?.();
      void killTree(child);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`${bin} did not answer within ${timeoutMs / 1000}s`))), timeoutMs);
    const append = (chunk: string, target: "out" | "err") => {
      totalBytes += Buffer.byteLength(chunk, "utf8");
      if (totalBytes > maxBytes) {
        finish(() => reject(new Error(`${bin} output exceeded ${maxBytes} bytes`)));
        return;
      }
      if (target === "out") out += chunk;
      else err += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", (d: string) => append(d, "out"));
    child.stderr.setEncoding("utf8").on("data", (d: string) => append(d, "err"));
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => finish(() => {
      if (code === 0 || (!options?.requireZeroExit && out)) return resolve(out);
      const detail = options?.requireZeroExit
        ? err.trim().slice(-300) || `exit code ${code}`
        : err.trim().slice(-300) || out.trim().slice(-300) || `exit code ${code}`;
      return reject(new Error(detail));
    }));
    if (stdin) { cleanup = stdin((s) => child.stdin.write(s), () => out, () => finish(() => resolve(out))); if (settled) cleanup?.(); }
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
  try {
    const stats = JSON.parse(text);
    if (typeof stats.cost === "number" && Number.isFinite(stats.cost) &&
        typeof stats.tokens?.input === "number" && typeof stats.tokens?.output === "number") {
      return { agent: "opencode", lines: ["No account limits: opencode uses the providers' keys and plans.",
        `Today: cost $${stats.cost}, ${stats.tokens.input} input tokens, ${stats.tokens.output} output tokens`], limits: [], maxUsedPercent: null };
    }
  } catch { /* V1 prints a table. */ }
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
  try {
    const models = JSON.parse(text).data;
    if (Array.isArray(models)) return models.flatMap((m) => {
      // v2 prices are context tiers. A model is free only when every tier has zero prices.
      if (!Array.isArray(m.cost) || !m.cost.length || m.cost.some((c: any) => typeof c.input !== "number" || typeof c.output !== "number")) return [];
      return [{ id: `${m.providerID}/${m.id}`, input: Math.max(...m.cost.map((c: any) => c.input)), output: Math.max(...m.cost.map((c: any) => c.output)) }];
    });
  } catch { /* v1 prints a model id followed by a JSON block. */ }
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

export async function readOpencodeModelCosts(bin: string, cwd: string, log: Logger): Promise<ModelCost[]> {
  const v2 = await opencodeV2(bin, cwd, log);
  return parseOpencodeModelCosts(await capture(bin, v2 ? ["api", "--standalone", "GET", `/api/model?${new URLSearchParams({ "location[directory]": cwd })}`] : ["models", "--verbose"], cwd, log));
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

function antigravityWindowName(window: unknown, fallbackName: unknown): string {
  const w = typeof window === "string" ? window.trim() : "";
  if (w === "5h") return "5-hour window";
  if (w === "weekly") return "weekly";
  if (w === "daily") return "1-day window";
  if (w) return w;
  const name = typeof fallbackName === "string" ? fallbackName.trim().replace(/\s+limit\s+remaining$/i, "").replace(/\s+remaining$/i, "") : "";
  return name ? name.toLowerCase() : "window";
}

/** Standalone `-p /usage --output-format json` without a model turn was introduced in agy 1.1.11. */
export function supportsAntigravityUsage(versionText: string): boolean {
  const m = /\b(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\b/.exec(versionText);
  if (!m || m[4]) return false;
  const major = Number(m[1]), minor = Number(m[2]), patch = Number(m[3]);
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11)));
}

/** Parse structured output from `agy -p /usage --output-format json` (and/or `/quota`, `/credits`). */
export function parseAntigravityUsage(text: string): UsageReport {
  const unknown = (reason: string): UsageReport => ({
    agent: "antigravity",
    lines: [`Account limit availability is unknown: ${reason}`],
    limits: [],
    maxUsedPercent: null,
  });
  const records: any[] = [];
  const trimmed = text.trim();
  if (!trimmed) return unknown("Antigravity did not return structured JSON usage output.");
  try {
    records.push(JSON.parse(trimmed));
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try {
        records.push(JSON.parse(s));
      } catch {
        return unknown("Antigravity did not return structured JSON usage output.");
      }
    }
  }
  if (!records.length) return unknown("Antigravity did not return structured JSON usage output.");
  const groups: any[] = [];
  let creditSource: any = null;
  for (const parsed of records) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unknown("Antigravity did not return a JSON object.");
    if (parsed.status !== undefined && parsed.status !== "SUCCESS") {
      const detail = typeof parsed.error === "string" && parsed.error.trim() ? parsed.error.trim() : `status ${String(parsed.status)}`;
      return unknown(`Antigravity usage report failed (${detail}).`);
    }
    if ((typeof parsed.num_turns === "number" && parsed.num_turns > 0) || (typeof parsed.conversation_id === "string" && parsed.conversation_id.trim().length > 0)) {
      return unknown("Antigravity returned a conversation turn instead of a standalone usage report.");
    }
    const cmd = parsed.command;
    if (!cmd || typeof cmd !== "object" || Array.isArray(cmd) || !["usage", "quota", "credits"].includes(cmd.name) || !cmd.data || typeof cmd.data !== "object" || Array.isArray(cmd.data)) {
      return unknown("Antigravity usage report has an unrecognized schema.");
    }
    const data = cmd.data;
    if (Array.isArray(data.groups)) groups.push(...data.groups);
    if (data.credits && typeof data.credits === "object" && !Array.isArray(data.credits)) {
      creditSource = data.credits;
    } else if (data.remaining_credits !== undefined) {
      creditSource = { balance: data.remaining_credits };
    }
  }
  const validGroups = groups.filter((g) => g && typeof g === "object" && !Array.isArray(g) && typeof g.name === "string" && g.name.trim() && Array.isArray(g.buckets));
  const lines: string[] = [];
  const limits: UsageLimit[] = [];
  let max: number | null = null;
  let hasUsableGroup = false;
  for (const group of validGroups) {
    const groupName = group.name.trim();
    const parts: string[] = [];
    let groupNumericBuckets = 0;
    let groupAllWindowsUsable = group.buckets.length > 0;
    for (const b of group.buckets) {
      if (!b || typeof b !== "object" || Array.isArray(b)) {
        groupAllWindowsUsable = false;
        continue;
      }
      const windowLabel = antigravityWindowName(b.window, b.name);
      if (b.disabled === true || b.enabled === false) {
        groupAllWindowsUsable = false;
        parts.push(`${windowLabel} disabled`);
        continue;
      }
      let usedPercent: number | null = null;
      const clampUsed = (rawUsedPercent: number, exhausted: boolean): number => {
        if (exhausted) return FULL_USAGE_PERCENT;
        return Math.min(FULL_USAGE_PERCENT - 1, Math.max(0, Math.round(rawUsedPercent)));
      };
      if (typeof b.remaining_fraction === "number" && Number.isFinite(b.remaining_fraction) && b.remaining_fraction >= 0 && b.remaining_fraction <= 1) {
        usedPercent = clampUsed((1 - b.remaining_fraction) * FULL_USAGE_PERCENT, b.remaining_fraction === 0);
      } else if (typeof b.used_fraction === "number" && Number.isFinite(b.used_fraction) && b.used_fraction >= 0 && b.used_fraction <= 1) {
        usedPercent = clampUsed(b.used_fraction * FULL_USAGE_PERCENT, b.used_fraction === 1);
      } else if (typeof b.used_percent === "number" && Number.isFinite(b.used_percent) && b.used_percent >= 0 && b.used_percent <= FULL_USAGE_PERCENT) {
        usedPercent = clampUsed(b.used_percent, b.used_percent === FULL_USAGE_PERCENT);
      } else if (typeof b.remaining_percent === "number" && Number.isFinite(b.remaining_percent) && b.remaining_percent >= 0 && b.remaining_percent <= FULL_USAGE_PERCENT) {
        usedPercent = clampUsed(FULL_USAGE_PERCENT - b.remaining_percent, b.remaining_percent === 0);
      }
      if (usedPercent === null) {
        groupAllWindowsUsable = false;
        continue;
      }
      groupNumericBuckets++;
      if (usedPercent >= FULL_USAGE_PERCENT) groupAllWindowsUsable = false;
      const resetEpoch = typeof b.reset_time === "string" && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(b.reset_time.trim()) ? Date.parse(b.reset_time) : NaN;
      const resets = Number.isFinite(resetEpoch) ? resetTime(resetEpoch) : null;
      max = Math.max(max ?? 0, usedPercent);
      parts.push(`${windowLabel} ${usedPercent}% used${resets ? ` (resets ${resets})` : ""}`);
      limits.push({ name: validGroups.length > 1 ? `${groupName}: ${windowLabel}` : windowLabel, usedPercent, resets });
    }
    if (groupAllWindowsUsable && groupNumericBuckets > 0) hasUsableGroup = true;
    if (parts.length) lines.push(`${groupName}: ${parts.join(", ")}`);
  }
  let credits: UsageReport["credits"] = undefined;
  if (creditSource) {
    const rawBalance = creditSource.balance ?? creditSource.remaining_credits;
    const explicitInUse = creditSource.in_use === true || creditSource.inUse === true;
    if (creditSource.unlimited === true) {
      credits = { balance: "unlimited", unlimited: true, inUse: explicitInUse };
      lines.push(explicitInUse ? "Credits: usable, running on credits (unlimited left)" : "Credits: unlimited available");
    } else if ((typeof rawBalance === "number" || (typeof rawBalance === "string" && rawBalance.trim() !== "")) && Number.isFinite(Number(rawBalance))) {
      const n = Number(rawBalance);
      if (n > 0) {
        const balance = formatCredits(String(n));
        credits = { balance, unlimited: false, inUse: explicitInUse };
        lines.push(explicitInUse ? `Credits: usable, running on credits (${balance} left)` : `Credits: ${balance} available`);
      } else if (n === 0) {
        credits = null;
        lines.push(hasUsableGroup ? "Credits: 0 available (plan quota remains usable)" : "Credits: 0 available");
      }
    }
  }
  if (!lines.length) return unknown("Antigravity usage report contained no recognized quota buckets.");
  return { agent: "antigravity", lines, limits, ...(credits !== undefined ? { credits } : {}), maxUsedPercent: max };
}

export async function antigravityUsage(bin: string, cwd: string, log: Logger, prefixArgs: string[] = []): Promise<UsageReport> {
  let versionOut = "";
  try {
    versionOut = await capture(bin, [...prefixArgs, "--version"], cwd, log, undefined, { timeoutMs: ANTIGRAVITY_VERSION_TIMEOUT_MS, maxBytes: 16 * 1024, requireZeroExit: true });
  } catch (err) {
    return {
      agent: "antigravity",
      lines: [`Account limit availability is unknown: could not verify agy version (${(err as Error).message}).`],
      limits: [],
      maxUsedPercent: null,
    };
  }
  if (!supportsAntigravityUsage(versionOut)) {
    return {
      agent: "antigravity",
      lines: ["Account limit availability is unknown: installed agy version does not support standalone structured /usage reports (requires agy 1.1.11+)."],
      limits: [],
      maxUsedPercent: null,
    };
  }
  try {
    const [usageOut, creditsOut] = await Promise.all([
      capture(bin, [...prefixArgs, "-p", "/usage", "--output-format", "json"], cwd, log, undefined, { timeoutMs: ANTIGRAVITY_USAGE_TIMEOUT_MS, maxBytes: ANTIGRAVITY_MAX_USAGE_BYTES, requireZeroExit: true }),
      capture(bin, [...prefixArgs, "-p", "/credits", "--output-format", "json"], cwd, log, undefined, { timeoutMs: ANTIGRAVITY_USAGE_TIMEOUT_MS, maxBytes: ANTIGRAVITY_MAX_USAGE_BYTES, requireZeroExit: true }).catch(() => ""),
    ]);
    const combined = creditsOut.trim() ? `${usageOut.trim()}\n${creditsOut.trim()}` : usageOut;
    const parsed = parseAntigravityUsage(combined);
    return parsed.maxUsedPercent !== null || !creditsOut.trim() ? parsed : parseAntigravityUsage(usageOut);
  } catch (err) {
    return {
      agent: "antigravity",
      lines: [`Account limit availability is unknown: ${(err as Error).message}`],
      limits: [],
      maxUsedPercent: null,
    };
  }
}

/** Muse knows its plan usage only inside a `muse serve` that made a model call (`usage/changed`); a fresh host
 * answers `usage/read` with nothing. Muse jobs therefore keep the last observation here (no secrets, numbers only). */
export const MUSE_USAGE_FILE = "muse-usage.json";
const MUSE_USAGE_STALE_MS = 6 * 60 * 60 * 1000;
type MuseUsage = { observedAtMs: number; tier: string; window: { usedPercent: number; resetsAtMs: number; windowDurationMins: number }; weekly: { usedPercent: number; resetsAtMs: number } };
function museUsageValue(value: unknown): MuseUsage | null {
  const v = value as MuseUsage | null;
  const int = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  return v && int(v.observedAtMs) && typeof v.tier === "string" && int(v.window?.usedPercent) && int(v.window?.resetsAtMs) &&
    int(v.window?.windowDurationMins) && v.window.windowDurationMins > 0 && int(v.weekly?.usedPercent) && int(v.weekly?.resetsAtMs)
    ? { observedAtMs: v.observedAtMs, tier: v.tier, window: { usedPercent: v.window.usedPercent, resetsAtMs: v.window.resetsAtMs, windowDurationMins: v.window.windowDurationMins },
      weekly: { usedPercent: v.weekly.usedPercent, resetsAtMs: v.weekly.resetsAtMs } } : null;
}
/** Keep the newest observation; an older one from a concurrent job never replaces it. */
export function recordMuseUsage(home: string, value: unknown): void {
  const usage = museUsageValue(value);
  if (!usage) return;
  const file = join(home, MUSE_USAGE_FILE);
  try { if ((museUsageValue(JSON.parse(readFileSync(file, "utf8")))?.observedAtMs ?? -1) >= usage.observedAtMs) return; } catch { /* none yet */ }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(usage), { mode: 0o600 });
  renameSync(temp, file);
}
export function museUsage(home: string, now = Date.now()): UsageReport {
  let usage: MuseUsage | null = null;
  try { usage = museUsageValue(JSON.parse(readFileSync(join(home, MUSE_USAGE_FILE), "utf8"))); } catch { /* none yet */ }
  if (!usage) return { agent: "muse", lines: ["No plan usage reported yet. Muse reports it while it works; it shows here after the next Muse job."], limits: [], maxUsedPercent: null };
  const window = windowName(usage.window.windowDurationMins);
  const asOf = new Date(usage.observedAtMs).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const stale = now - usage.observedAtMs > MUSE_USAGE_STALE_MS;
  return {
    agent: "muse",
    lines: [`muse${usage.tier ? ` [${usage.tier}]` : ""}: ${window} ${usage.window.usedPercent}% used${resetText(usage.window.resetsAtMs)}, weekly ${usage.weekly.usedPercent}% used${resetText(usage.weekly.resetsAtMs)}`,
      `As of ${asOf}, the last Muse job${stale ? "; may be out of date" : ""}.`],
    limits: [{ name: window, usedPercent: usage.window.usedPercent, resets: resetTime(usage.window.resetsAtMs) }, { name: "weekly", usedPercent: usage.weekly.usedPercent, resets: resetTime(usage.weekly.resetsAtMs) }],
    // A past window has reset since; only the weekly figure can still hold.
    maxUsedPercent: usage.window.resetsAtMs > now ? Math.max(usage.window.usedPercent, usage.weekly.usedPercent) : usage.weekly.resetsAtMs > now ? usage.weekly.usedPercent : null,
  };
}

async function codexUsage(bin: string, cwd: string, log: Logger): Promise<UsageReport> {
  return formatCodexLimits(await codexAppServerCall(bin, cwd, log, "account/rateLimits/read", null));
}

/** `model`: the model the caller would use (opencode: shows whether it is free). */
export async function readUsage(agent: CodingAgent, bin: string, cwd: string, log: Logger, model: string | null = null): Promise<UsageReport> {
  try {
    if (agent === "antigravity") return await antigravityUsage(bin, cwd, log);
    if (agent === "muse") return museUsage(resolveHome());
    if (agent === "codex") return await codexUsage(bin, cwd, log);
    if (agent === "claude") return parseClaudeUsage(await capture(bin, ["-p", "/usage"], cwd, log));
    const v2 = await opencodeV2(bin, cwd, log);
    const [stats, models] = await Promise.all([
      capture(bin, v2 ? ["stats", "--standalone", "--days", "1", "--json"] : ["stats", "--days", "1"], cwd, log).catch(() => ""),
      readOpencodeModelCosts(bin, cwd, log).catch(() => []),
    ]);
    const report = parseOpencodeStats(stats);
    report.lines.push(...describeOpencodeCosts(models, model));
    return report;
  } catch (err) {
    return { agent, lines: [`Could not read usage: ${(err as Error).message}`], limits: [], maxUsedPercent: null };
  }
}

/** Admission facts never come from the display DTO above. */
export const PROVIDER_USAGE_CACHE_LIMIT = 64;
export const PROVIDER_USAGE_PROBE_TIMEOUT_MS = 3_000;
export interface UsageProbe {
  agent: CodingAgent; bin: string; cwd: string; home: string; model: string | null; log: Logger;
}
export interface UsageAdmission extends ProviderUsageDecision { resetAt?: number }
/** Persist decisions, not cached account readings. A later accepted turn has its own warning. */
export interface ProviderUsageState {
  /** Stable admitted execution; detached internal turns share this identity. */
  runId?: string;
  turnStartedAt: number;
  decision: UsageAdmission;
  warningReported: boolean;
  /** Pending accepted controls; receipt ACKs are not evidence of native consumption. */
  retainedControls?: { cid: string; body: string }[];
  /** Cumulative CIDs whose submitted prompts reached native admission in this run. */
  admittedControls?: string[];
}
type UsageControl = { cid: string; body: string };
export interface UsageSubmissionReceipt {
  runId?: string;
  turnStartedAt: number;
  pending: UsageControl[];
  queued: UsageControl[];
  admitted: string[];
}
type UsageSubmission = { startedAt: number; usageRunId?: string; providerUsage?: ProviderUsageState; usagePendingControls?: UsageControl[];
  usageQueuedControls?: UsageControl[]; usageAdmittedControls?: string[]; usagePendingHeld?: boolean; queue: string[] };
/** The only consumption boundary for a submitted batch, shared by local and remote executors. */
export function confirmUsageAdmission(job: UsageSubmission, admitted: readonly string[]): void {
  const ids = new Set(admitted);
  job.usageAdmittedControls = [...new Set([...(job.usageAdmittedControls ?? []), ...ids])];
  if (job.providerUsage) job.providerUsage.admittedControls = [...new Set([...(job.providerUsage.admittedControls ?? []), ...ids])];
  if (job.usagePendingHeld) {
    const count = job.usagePendingControls?.length ?? 0;
    job.queue = [...job.queue.slice(0, count).filter((_body, index) => !ids.has(job.usagePendingControls![index]!.cid)), ...job.queue.slice(count)];
  }
  job.usagePendingControls = job.usagePendingControls?.filter(control => !ids.has(control.cid));
  if (!job.usagePendingControls?.length) { job.usagePendingControls = undefined; job.usagePendingHeld = undefined; }
}
/** Every checkpoint carries unacknowledged data, even before a usage decision exists. */
export function usageSubmissionReceipt(job: UsageSubmission): UsageSubmissionReceipt {
  return { runId: job.usageRunId, turnStartedAt: job.startedAt, pending: [...job.usagePendingControls ?? []],
    queued: [...job.usageQueuedControls ?? []], admitted: [...job.usageAdmittedControls ?? []] };
}
/** One attempt settlement: success/explicit ACK may consume; every other exit preserves. */
export function settleUsageAttempt(job: UsageSubmission, completed: boolean): void {
  if (completed) confirmUsageAdmission(job, (job.usagePendingControls ?? []).map(control => control.cid));
  const receipt = usageSubmissionReceipt(job);
  if (job.providerUsage) job.providerUsage.retainedControls = [...receipt.pending, ...receipt.queued];
}
/** Holding a refused batch changes its queue representation, never its submitted provenance. */
export function holdUsageSubmission(job: UsageSubmission): void {
  if (job.usagePendingControls?.length && !job.usagePendingHeld) {
    job.queue.unshift(...job.usagePendingControls.map(control => control.body));
    job.usagePendingHeld = true;
  }
}
/** Reconstruct an unacknowledged submitted batch even after a pre-settlement reload. */
export function usageContinuationMessage(job: UsageSubmission): string {
  holdUsageSubmission(job);
  return job.queue.join("\n\n");
}
export function currentUsage(job: { startedAt: number; usageRunId?: string }, state: Pick<ProviderUsageState, "runId" | "turnStartedAt"> | undefined): boolean {
  return Boolean(state && (state.runId ? state.runId === job.usageRunId : state.turnStartedAt === job.startedAt));
}
export function usageRefused(job: { startedAt: number; usageRunId?: string; providerUsage?: ProviderUsageState }): boolean {
  return currentUsage(job, job.providerUsage) && job.providerUsage?.decision?.type === "block";
}
export function usageAdmissionText(result: UsageAdmission): string {
  const reset = result.resetAt === undefined ? "" : ` Resets ${new Date(result.resetAt).toISOString()}.`;
  return result.type === "block"
    ? `Provider usage exhausted; no native work started (${result.reason}).${reset} Continue explicitly after allowance is available.`
    : result.type === "warn" ? "Warning: provider allowance is low; continuing on the selected model." : "";
}

type ProducedUsage = { scope: ProviderUsageScope; facts: ProviderUsageFact[] } | null;
/** Decode only account-wide Codex buckets. Other model-specific buckets cannot refuse this model. */
export function codexAdmissionFacts(input: { accountBefore: unknown; accountAfter: unknown; models: unknown; limits: unknown; config: unknown },
  probe: Pick<UsageProbe, "model">, executorId: string, observedAt: number): ProducedUsage {
  const before = input.accountBefore as any, after = input.accountAfter as any, models = input.models as any, limits = input.limits as any;
  const account = before?.account;
  const routing = before?.workspaceRouting;
  const config = (input.config as any)?.config;
  if (account?.type !== "chatgpt" || typeof account.email !== "string" || !account.email.trim()
    || before?.requiresOpenaiAuth !== true || config?.model_provider !== "openai" || config?.model_providers?.openai
    || typeof routing?.chatgptAccountId !== "string" || !routing.chatgptAccountId.trim()
    || routing.backendOrigin !== "https://chatgpt.com"
    || JSON.stringify(before) !== JSON.stringify(after)) return null;
  const entries = Array.isArray(models?.data) ? models.data : [];
  const selected = probe.model ?? config.model;
  const matches = entries.filter((m: any) => selected == null ? m?.isDefault === true : m?.id === selected || m?.model === selected);
  if (matches.length !== 1 || typeof matches[0]?.model !== "string" || !matches[0].model.trim()) return null;
  const scope: ProviderUsageScope = { executorId, agent: "codex", accountId: createHash("sha256").update(JSON.stringify([account, routing])).digest("hex"),
    providerId: "openai", modelId: matches[0].model };
  const facts: ProviderUsageFact[] = [];
  const buckets = limits?.rateLimitsByLimitId;
  const snapshot = buckets && typeof buckets === "object" ? buckets.codex : limits?.rateLimits;
  if (!snapshot || snapshot.limitId && snapshot.limitId !== "codex") return { scope, facts };
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (typeof window?.usedPercent !== "number") continue;
    const reset = window.resetsAt;
    // Protocol resetsAt is epoch seconds. No string/date guessing.
    const resetAt = typeof reset === "number" && Number.isSafeInteger(reset) && reset >= 0 && Number.isSafeInteger(reset * 1000) ? reset * 1000 : undefined;
    facts.push({ state: "known", scope, observedAt, reading: { kind: "percent_used", value: window.usedPercent, unit: "percent" }, ...(resetAt === undefined ? {} : { resetAt }) });
  }
  const credit = snapshot.credits;
  // The app-server protocol reports a decimal string; reject blank/coercible malformed data.
  const balance = typeof credit?.balance === "number" ? credit.balance : typeof credit?.balance === "string" && /^\d+(?:\.\d+)?$/.test(credit.balance) ? Number(credit.balance) : NaN;
  if (credit?.unlimited !== true && Number.isFinite(balance)) facts.push({ state: "known", scope, observedAt,
    reading: { kind: "credits_remaining", value: balance, unit: "credits" } });
  return { scope, facts };
}

/** One initialized local app-server context; never starts a model turn. */
async function produceAdmissionUsage(probe: UsageProbe, observedAt: number, readLimits = true, deadline = observedAt + PROVIDER_USAGE_PROBE_TIMEOUT_MS): Promise<ProducedUsage> {
  if (probe.agent !== "codex") return null; // Other adapters currently lack authenticated account/model quota facts.
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error("Usage admission deadline elapsed");
  const methods = ["initialize", "account/read", "model/list", "config/read", ...(readLimits ? ["account/rateLimits/read"] : []), "account/read"];
  const results: any[] = [];
  let protocolError: Error | undefined;
  const out = await capture(probe.bin, ["app-server"], probe.cwd, probe.log, (write, read, done) => {
    let next = 0;
    const send = () => write(`${JSON.stringify({ id: next + 1, method: methods[next], params: next === 0
      ? { clientInfo: { name: "agent-bridge", version: APP_VERSION }, capabilities: { experimentalApi: true, explicitGatewayOauth: true } }
      : next === 2 ? { limit: 100 } : methods[next] === "config/read" ? { includeLayers: false, cwd: probe.cwd }
      : methods[next] === "account/read" ? { refreshToken: false } : null })}\n`);
    send();
    const poll = setInterval(() => {
      try {
        const messages = read().split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        const reply = messages.find(m => m.id === next + 1);
        if (!reply) return;
        if (reply.error) { protocolError = new Error("Usage probe RPC failed"); clearInterval(poll); done(); return; }
        results.push(reply.result);
        if (next === 0) write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        if (++next === methods.length) { clearInterval(poll); done(); } else send();
      } catch { protocolError = new Error("Invalid usage response"); clearInterval(poll); done(); }
    }, 10);
    return () => clearInterval(poll);
  }, { timeoutMs, maxBytes: DEFAULT_MAX_CAPTURE_BYTES, requireZeroExit: true });
  void out;
  if (protocolError || results.length !== methods.length) throw protocolError ?? new Error("Incomplete usage probe");
  if (results[2]?.nextCursor) return null; // Incomplete model catalog cannot resolve an alias/default.
  return codexAdmissionFacts({ accountBefore: results[1], models: results[2], config: results[3], limits: readLimits ? results[4] : {}, accountAfter: results.at(-1) }, probe,
    createHash("sha256").update(`${hostname()}\0${resolve(probe.home)}\0${homedir()}`).digest("hex"), observedAt);
}

/** Cache identity includes local auth/config bytes; never log or persist their hashes or contents. */
function admissionCacheKey(probe: UsageProbe): string {
  const root = process.env.CODEX_HOME || join(homedir(), ".codex");
  const hash = createHash("sha256").update(JSON.stringify([probe.agent, probe.bin, resolve(probe.cwd), resolve(probe.home), probe.model,
    root, process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY, process.env.OPENAI_BASE_URL]));
  for (const path of [join(root, "auth.json"), join(root, "config.toml"), join(probe.cwd, ".codex", "config.toml")]) {
    try { hash.update(path).update(readFileSync(path)); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; hash.update(`${path}:absent`); }
  }
  return hash.digest("hex");
}

export function createUsagePreflight(deps: { now: () => number; key: (probe: UsageProbe) => string;
  read: (probe: UsageProbe, observedAt: number, deadline: number) => Promise<ProducedUsage>;
  authenticate?: (probe: UsageProbe, value: NonNullable<ProducedUsage>, deadline: number) => Promise<boolean> }) {
  const cache = new Map<string, { observedAt: number; value: ProducedUsage }>();
  const pending = new Map<string, Promise<ProducedUsage>>();
  return async (probe: UsageProbe, warningAlreadyReported = false): Promise<UsageAdmission> => {
    const deadline = deps.now() + PROVIDER_USAGE_PROBE_TIMEOUT_MS;
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
      const remaining = deadline - deps.now();
      if (remaining <= 0) throw new Error("Usage admission deadline elapsed");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Usage admission deadline elapsed")), remaining);
        })]);
        if (deps.now() >= deadline) throw new Error("Usage admission deadline elapsed");
        return value;
      } finally { clearTimeout(timer); }
    };
    let key: string;
    let value: ProducedUsage;
    try {
      key = deps.key(probe);
      const now = deps.now(), hit = cache.get(key);
      if (hit && now >= hit.observedAt && now - hit.observedAt < PROVIDER_USAGE_TTL_MS
        && hit.value && (!deps.authenticate || await bounded(() => deps.authenticate!(probe, hit.value!, deadline)))) value = hit.value;
      else {
        let read = pending.get(key);
        if (!read) {
          if (pending.size >= PROVIDER_USAGE_CACHE_LIMIT) return { type: "allow", reason: "read_failed" };
          read = Promise.resolve().then(() => deps.read(probe, now, deadline));
          pending.set(key, read);
          try {
            value = await bounded(() => read!);
            if (deps.key(probe) !== key) return { type: "allow", reason: "scope_mismatch" };
            // Unknowns/failures do not hide a later valid reading.
            if (value) { if (cache.size >= PROVIDER_USAGE_CACHE_LIMIT) cache.delete(cache.keys().next().value!); cache.set(key, { observedAt: now, value }); }
          } finally { pending.delete(key); }
        } else value = await bounded(() => read!);
      }
      if (deps.key(probe) !== key) return { type: "allow", reason: "scope_mismatch" };
      if (!value) return { type: "allow", reason: "unknown" };
      let warning: UsageAdmission | undefined;
      for (const fact of value.facts) {
        const decision = decideProviderUsage(fact, { target: value.scope, now: deps.now(), warningAlreadyReported });
        const result = { ...decision, ...(fact.state === "known" && fact.resetAt !== undefined ? { resetAt: fact.resetAt } : {}) };
        if (result.type === "block") return result;
        if (result.type === "warn") warning ??= result;
      }
      return warning ?? { type: "allow", reason: "allowance_available" };
    } catch { return { type: "allow", reason: "read_failed" }; }
  };
}
export const checkUsagePreflight = createUsagePreflight({ now: () => Date.now(), key: admissionCacheKey,
  read: (probe, observedAt, deadline) => produceAdmissionUsage(probe, observedAt, true, deadline),
  authenticate: async (probe, cached, deadline) => {
    const current = await produceAdmissionUsage(probe, Date.now(), false, deadline);
    return current !== null && JSON.stringify(current.scope) === JSON.stringify(cached.scope);
  } });
