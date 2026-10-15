import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  defaultEffort
} from "./chunk-KNKN5CEU.mjs";
import {
  childEnv,
  killTree,
  listOpencodeModels,
  museMspQuery,
  opencodeV2,
  resolveCommand
} from "./chunk-V3DX43NZ.mjs";
import {
  APP_VERSION
} from "./chunk-NT6Y2SKY.mjs";

// src/core/usage.ts
import { spawn } from "node:child_process";
var USAGE_TIMEOUT_MS = 45e3;
var MINUTES_PER_HOUR = 60;
var MINUTES_PER_DAY = 1440;
var PLAN_LIMIT_REACHED = "rate_limit_reached";
var BLOCKING_LIMIT_TYPES = /* @__PURE__ */ new Set([
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached"
]);
var FULL_USAGE_PERCENT = 100;
var CREDIT_SIGNIFICANT_DIGITS = 3;
var DEFAULT_MAX_CAPTURE_BYTES = 1024 * 1024;
var ANTIGRAVITY_VERSION_TIMEOUT_MS = 1e4;
var ANTIGRAVITY_USAGE_TIMEOUT_MS = 15e3;
var ANTIGRAVITY_MAX_USAGE_BYTES = 256 * 1024;
function capture(bin, args, cwd, log, stdin, options) {
  return new Promise((resolve, reject) => {
    const env = childEnv();
    let cmd;
    try {
      cmd = resolveCommand(bin, args, env, log);
    } catch (err2) {
      return reject(err2);
    }
    const timeoutMs = options?.timeoutMs ?? USAGE_TIMEOUT_MS;
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
    const child = spawn(cmd.resolved, cmd.args, { cwd, env, shell: cmd.needsShell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let out = "";
    let err = "";
    let totalBytes = 0;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void killTree(child);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`${bin} did not answer within ${timeoutMs / 1e3}s`))), timeoutMs);
    const append = (chunk, target) => {
      totalBytes += Buffer.byteLength(chunk, "utf8");
      if (totalBytes > maxBytes) {
        finish(() => reject(new Error(`${bin} output exceeded ${maxBytes} bytes`)));
        return;
      }
      if (target === "out") out += chunk;
      else err += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", (d) => append(d, "out"));
    child.stderr.setEncoding("utf8").on("data", (d) => append(d, "err"));
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => finish(() => {
      if (code === 0 || !options?.requireZeroExit && out) return resolve(out);
      const detail = options?.requireZeroExit ? err.trim().slice(-300) || `exit code ${code}` : err.trim().slice(-300) || out.trim().slice(-300) || `exit code ${code}`;
      return reject(new Error(detail));
    }));
    if (stdin) stdin((s) => child.stdin.write(s), () => out, () => finish(() => resolve(out)));
    else child.stdin.end();
  });
}
function windowName(mins) {
  if (!mins) return "window";
  if (mins === 5 * MINUTES_PER_HOUR) return "5-hour window";
  if (mins === 7 * MINUTES_PER_DAY) return "weekly";
  return mins % MINUTES_PER_DAY === 0 ? `${mins / MINUTES_PER_DAY}-day window` : `${Math.round(mins / MINUTES_PER_HOUR)}-hour window`;
}
function resetTime(epoch) {
  if (!epoch) return null;
  const d = new Date(epoch < 1e12 ? epoch * 1e3 : epoch);
  return d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}
function resetText(epoch) {
  const r = resetTime(epoch);
  return r ? ` (resets ${r})` : "";
}
function formatCredits(balance) {
  const n = Number(balance);
  if (!Number.isFinite(n)) return balance;
  if (n > 0 && n < 1) return n.toLocaleString("en-US", { maximumSignificantDigits: CREDIT_SIGNIFICANT_DIGITS });
  return Math.floor(n).toLocaleString("en-US");
}
function formatCodexLimits(res) {
  const lines = [];
  const limits = [];
  let credits = null;
  let max = null;
  const byId = res?.rateLimitsByLimitId ? Object.values(res.rateLimitsByLimitId) : [];
  const snapshots = byId.length ? byId : res?.rateLimits ? [res.rateLimits] : [];
  let creditFallback = false;
  let blocked = false;
  for (const s of snapshots) {
    const parts = [];
    for (const w of [s?.primary, s?.secondary]) {
      if (!w || typeof w.usedPercent !== "number") continue;
      max = Math.max(max ?? 0, w.usedPercent);
      parts.push(`${windowName(w.windowDurationMins)} ${w.usedPercent}% used${resetText(w.resetsAt)}`);
      const window = windowName(w.windowDurationMins);
      limits.push({ name: snapshots.length > 1 ? `${s?.limitName ?? s?.limitId ?? "codex"}: ${window}` : window, usedPercent: w.usedPercent, resets: resetTime(w.resetsAt) });
    }
    const blockingLimit = BLOCKING_LIMIT_TYPES.has(s?.rateLimitReachedType) || s?.spendControlReached === true;
    const planReached = s?.rateLimitReachedType === PLAN_LIMIT_REACHED || [s?.primary, s?.secondary].some((w) => w?.usedPercent >= FULL_USAGE_PERCENT) || res?.ordinaryUsageAllowed === false;
    const hasCredits = s?.credits?.hasCredits && (s.credits.unlimited || Number.isFinite(Number(s.credits.balance)) && Number(s.credits.balance) > 0);
    if (hasCredits) {
      const balance = s.credits.unlimited ? "unlimited" : formatCredits(s.credits.balance);
      const inUse = planReached && !blockingLimit;
      const currentCredits = { balance, unlimited: Boolean(s.credits.unlimited), inUse };
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
    const noCredits = snapshots.some((s) => s?.credits?.hasCredits === false || s?.credits?.balance != null && Number.isFinite(Number(s.credits.balance)) && Number(s.credits.balance) <= 0);
    lines.push(noCredits ? "Unusable: included usage is unavailable and credits are exhausted." : "Included usage is unavailable; credit-backed usage availability is unknown.");
  }
  return { agent: "codex", lines: lines.length ? lines : ["No limits reported (API key or no plan limits)."], limits, credits, maxUsedPercent: max };
}
function parseClaudeUsage(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /\d+%\s*used/i.test(l) || /api key/i.test(l));
  const percents = lines.map((l) => Number(/(\d+)%\s*used/i.exec(l)?.[1])).filter((n) => Number.isFinite(n));
  const limits = [];
  for (const l of lines) {
    const m = /^(.+?):\s*(\d+)%\s*used(?:\s*[·•-]\s*resets\s+(.+))?$/i.exec(l);
    if (m) limits.push({ name: m[1].replace(/^current\s+/i, ""), usedPercent: Number(m[2]), resets: m[3]?.trim() ?? null });
  }
  return { agent: "claude", lines: lines.length ? lines : ["No limits reported."], limits, maxUsedPercent: percents.length ? Math.max(...percents) : null };
}
function parseOpencodeStats(text) {
  try {
    const stats = JSON.parse(text);
    if (typeof stats.cost === "number" && Number.isFinite(stats.cost) && typeof stats.tokens?.input === "number" && typeof stats.tokens?.output === "number") {
      return { agent: "opencode", lines: [
        "No account limits: opencode uses the providers' keys and plans.",
        `Today: cost $${stats.cost}, ${stats.tokens.input} input tokens, ${stats.tokens.output} output tokens`
      ], limits: [], maxUsedPercent: null };
    }
  } catch {
  }
  const pick = (label) => new RegExp(`${label}\\s+([^\\s\u2502|]+)`, "i").exec(text)?.[1];
  const cost = pick("Total Cost");
  const input = pick("Input");
  const output = pick("Output");
  const lines = ["No account limits: opencode uses the providers' keys and plans."];
  if (cost || input) lines.push(`Last 24 hours: ${[cost && `cost ${cost}`, input && `${input} input tokens`, output && `${output} output tokens`].filter(Boolean).join(", ")}`);
  return { agent: "opencode", lines, limits: [], maxUsedPercent: null };
}
function parseOpencodeModelCosts(text) {
  const out = [];
  try {
    const models = JSON.parse(text).data;
    if (Array.isArray(models)) return models.flatMap((m) => {
      if (!Array.isArray(m.cost) || !m.cost.length || m.cost.some((c) => typeof c.input !== "number" || typeof c.output !== "number")) return [];
      return [{ id: `${m.providerID}/${m.id}`, input: Math.max(...m.cost.map((c) => c.input)), output: Math.max(...m.cost.map((c) => c.output)) }];
    });
  } catch {
  }
  const parts = text.split(/^([\w.-]+\/[\w.:@-]+)\r?\n(?=\{)/m);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    try {
      const cost = JSON.parse(parts[i + 1].trim()).cost;
      if (cost && typeof cost.input === "number" && typeof cost.output === "number") out.push({ id: parts[i], input: cost.input, output: cost.output });
    } catch {
    }
  }
  return out;
}
async function readOpencodeModelCosts(bin, cwd, log) {
  const v2 = await opencodeV2(bin, cwd, log);
  return parseOpencodeModelCosts(await capture(bin, v2 ? ["api", "--standalone", "GET", `/api/model?${new URLSearchParams({ "location[directory]": cwd })}`] : ["models", "--verbose"], cwd, log));
}
var MAX_FREE_LISTED = 12;
function describeOpencodeCosts(costs, model) {
  const lines = [];
  const free = costs.filter((c) => c.input === 0 && c.output === 0).map((c) => c.id);
  if (model) {
    const m = costs.find((c) => c.id === model) ?? costs.find((c) => c.id.endsWith(`/${model}`) || c.id.includes(model));
    if (m) lines.push(m.input === 0 && m.output === 0 ? `Model ${m.id} has no per-token price (free, or covered by a plan).` : `Model ${m.id} costs $${m.input} input / $${m.output} output per million tokens.`);
  }
  if (free.length) lines.push(`Models without a per-token price (free, or covered by a plan) (${free.length}): ${free.slice(0, MAX_FREE_LISTED).join(", ")}${free.length > MAX_FREE_LISTED ? ", \u2026" : ""}`);
  return lines;
}
async function codexAppServerCall(bin, cwd, log, method, params) {
  const out = await capture(bin, ["app-server"], cwd, log, (write, read, done) => {
    write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-bridge", version: APP_VERSION }, capabilities: { experimentalApi: false } } })}
`);
    write(`${JSON.stringify({ method: "initialized", params: {} })}
`);
    write(`${JSON.stringify({ id: 2, method, params })}
`);
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
function captureOutput(bin, args, cwd, log) {
  return capture(bin, args, cwd, log);
}
function antigravityWindowName(window, fallbackName) {
  const w = typeof window === "string" ? window.trim() : "";
  if (w === "5h") return "5-hour window";
  if (w === "weekly") return "weekly";
  if (w === "daily") return "1-day window";
  if (w) return w;
  const name = typeof fallbackName === "string" ? fallbackName.trim().replace(/\s+limit\s+remaining$/i, "").replace(/\s+remaining$/i, "") : "";
  return name ? name.toLowerCase() : "window";
}
function supportsAntigravityUsage(versionText) {
  const m = /\b(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\b/.exec(versionText);
  if (!m || m[4]) return false;
  const major = Number(m[1]), minor = Number(m[2]), patch = Number(m[3]);
  return major > 1 || major === 1 && (minor > 1 || minor === 1 && patch >= 11);
}
function parseAntigravityUsage(text) {
  const unknown = (reason) => ({
    agent: "antigravity",
    lines: [`Account limit availability is unknown: ${reason}`],
    limits: [],
    maxUsedPercent: null
  });
  const records = [];
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
  const groups = [];
  let creditSource = null;
  for (const parsed of records) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unknown("Antigravity did not return a JSON object.");
    if (parsed.status !== void 0 && parsed.status !== "SUCCESS") {
      const detail = typeof parsed.error === "string" && parsed.error.trim() ? parsed.error.trim() : `status ${String(parsed.status)}`;
      return unknown(`Antigravity usage report failed (${detail}).`);
    }
    if (typeof parsed.num_turns === "number" && parsed.num_turns > 0 || typeof parsed.conversation_id === "string" && parsed.conversation_id.trim().length > 0) {
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
    } else if (data.remaining_credits !== void 0) {
      creditSource = { balance: data.remaining_credits };
    }
  }
  const validGroups = groups.filter((g) => g && typeof g === "object" && !Array.isArray(g) && typeof g.name === "string" && g.name.trim() && Array.isArray(g.buckets));
  const lines = [];
  const limits = [];
  let max = null;
  let hasUsableGroup = false;
  for (const group of validGroups) {
    const groupName = group.name.trim();
    const parts = [];
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
      let usedPercent = null;
      const clampUsed = (rawUsedPercent, exhausted) => {
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
  let credits = void 0;
  if (creditSource) {
    const rawBalance = creditSource.balance ?? creditSource.remaining_credits;
    const explicitInUse = creditSource.in_use === true || creditSource.inUse === true;
    if (creditSource.unlimited === true) {
      credits = { balance: "unlimited", unlimited: true, inUse: explicitInUse };
      lines.push(explicitInUse ? "Credits: usable, running on credits (unlimited left)" : "Credits: unlimited available");
    } else if ((typeof rawBalance === "number" || typeof rawBalance === "string" && rawBalance.trim() !== "") && Number.isFinite(Number(rawBalance))) {
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
  return { agent: "antigravity", lines, limits, ...credits !== void 0 ? { credits } : {}, maxUsedPercent: max };
}
async function antigravityUsage(bin, cwd, log, prefixArgs = []) {
  let versionOut = "";
  try {
    versionOut = await capture(bin, [...prefixArgs, "--version"], cwd, log, void 0, { timeoutMs: ANTIGRAVITY_VERSION_TIMEOUT_MS, maxBytes: 16 * 1024, requireZeroExit: true });
  } catch (err) {
    return {
      agent: "antigravity",
      lines: [`Account limit availability is unknown: could not verify agy version (${err.message}).`],
      limits: [],
      maxUsedPercent: null
    };
  }
  if (!supportsAntigravityUsage(versionOut)) {
    return {
      agent: "antigravity",
      lines: ["Account limit availability is unknown: installed agy version does not support standalone structured /usage reports (requires agy 1.1.11+)."],
      limits: [],
      maxUsedPercent: null
    };
  }
  try {
    const [usageOut, creditsOut] = await Promise.all([
      capture(bin, [...prefixArgs, "-p", "/usage", "--output-format", "json"], cwd, log, void 0, { timeoutMs: ANTIGRAVITY_USAGE_TIMEOUT_MS, maxBytes: ANTIGRAVITY_MAX_USAGE_BYTES, requireZeroExit: true }),
      capture(bin, [...prefixArgs, "-p", "/credits", "--output-format", "json"], cwd, log, void 0, { timeoutMs: ANTIGRAVITY_USAGE_TIMEOUT_MS, maxBytes: ANTIGRAVITY_MAX_USAGE_BYTES, requireZeroExit: true }).catch(() => "")
    ]);
    const combined = creditsOut.trim() ? `${usageOut.trim()}
${creditsOut.trim()}` : usageOut;
    const parsed = parseAntigravityUsage(combined);
    return parsed.maxUsedPercent !== null || !creditsOut.trim() ? parsed : parseAntigravityUsage(usageOut);
  } catch (err) {
    return {
      agent: "antigravity",
      lines: [`Account limit availability is unknown: ${err.message}`],
      limits: [],
      maxUsedPercent: null
    };
  }
}
async function codexUsage(bin, cwd, log) {
  return formatCodexLimits(await codexAppServerCall(bin, cwd, log, "account/rateLimits/read", null));
}
async function readUsage(agent, bin, cwd, log, model = null) {
  try {
    if (agent === "antigravity") return await antigravityUsage(bin, cwd, log);
    if (agent === "muse") return { agent, lines: ["Account limit availability is unknown: Muse MSP reports session usage, which does not establish account quotas. Delegated results include the run outcome."], limits: [], maxUsedPercent: null };
    if (agent === "codex") return await codexUsage(bin, cwd, log);
    if (agent === "claude") return parseClaudeUsage(await capture(bin, ["-p", "/usage"], cwd, log));
    const v2 = await opencodeV2(bin, cwd, log);
    const [stats, models] = await Promise.all([
      capture(bin, v2 ? ["stats", "--standalone", "--days", "1", "--json"] : ["stats", "--days", "1"], cwd, log).catch(() => ""),
      readOpencodeModelCosts(bin, cwd, log).catch(() => [])
    ]);
    const report = parseOpencodeStats(stats);
    report.lines.push(...describeOpencodeCosts(models, model));
    return report;
  } catch (err) {
    return { agent, lines: [`Could not read usage: ${err.message}`], limits: [], maxUsedPercent: null };
  }
}

// src/core/models.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var MAX_LISTED = 80;
var MODEL_CACHE_MS = 10 * 60 * 1e3;
var SHORT_MODEL_LIST = 6;
var modelReads = /* @__PURE__ */ new Map();
var modelBin = (agent, cfg) => cfg[`${agent}Bin`];
var modelDefault = (agent, cfg) => cfg[`${agent}Model`];
var modelCachePath = (home, agent) => join(home, `models-${agent}.json`);
function cachedModels(home, agent, cfg) {
  try {
    const cache = JSON.parse(readFileSync(modelCachePath(home, agent), "utf8"));
    const validStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
    if (cache.bin !== modelBin(agent, cfg) || cache.effort !== (cfg.effort[agent] ?? null) || typeof cache.at !== "number" || Date.now() - cache.at >= MODEL_CACHE_MS) return null;
    if (cache.report?.agent !== agent || !validStrings(cache.report.models) || !validStrings(cache.report.lines)) return null;
    return { ...cache.report, defaultModel: modelDefault(agent, cfg) ?? cache.report.defaultModel };
  } catch {
    return null;
  }
}
function modelParameterDescription(agent, cfg, home, example) {
  const cached = cachedModels(home, agent, cfg);
  const models = cached?.models ?? (agent === "claude" ? ["opus", "sonnet"] : []);
  return `Any model id or alias ${agent} accepts, passed through verbatim (e.g. ${example}). Default: ${modelDefault(agent, cfg) ?? cached?.defaultModel ?? `${agent}'s own default`}. ` + (models.length ? `Available${models.length > SHORT_MODEL_LIST ? " (short list)" : ""}: ${models.slice(0, SHORT_MODEL_LIST).join(", ")}. ` : "") + (agent === "opencode" ? `Use list_models(agent="opencode") for catalog hints; explicit provider/model IDs are resolved by opencode, even when the catalog is empty.` : `Use list_models(agent="${agent}") for the full list and effort levels.`);
}
async function readModels(agent, cfg, cwd, log, home) {
  const cached = cachedModels(home, agent, cfg);
  if (cached) return cached;
  const key = JSON.stringify([home, agent, modelBin(agent, cfg), modelDefault(agent, cfg), cfg.effort[agent], cwd]);
  let reading = modelReads.get(key);
  if (!reading) {
    reading = (async () => {
      const lines = await describeModels(agent, cfg, cwd, log);
      const models = agent === "claude" ? /Aliases for the latest of each family: ([^;]+)/.exec(lines[0] ?? "")?.[1]?.split(", ") ?? [] : lines.flatMap((l) => {
        const id = /^- (\S+)/.exec(l)?.[1];
        return id ? [agent === "codex" || agent === "antigravity" || agent === "muse" ? id.replace(/:$/, "") : id] : [];
      });
      const defaultModel = lines.flatMap((l) => /^- (\S+) \(default\)/.exec(l)?.[1] ?? [])[0] ?? null;
      const report = { agent, defaultModel, models, lines };
      if (!lines[0]?.startsWith("Could not list") && (!["opencode", "muse"].includes(agent) || models.length > 0)) {
        try {
          mkdirSync(home, { recursive: true });
          writeFileSync(modelCachePath(home, agent), JSON.stringify({ at: Date.now(), bin: modelBin(agent, cfg), effort: cfg.effort[agent] ?? null, report }), { mode: 384 });
        } catch (err) {
          log.debug("could not cache models", { err: err.message });
        }
      }
      return { ...report, defaultModel: modelDefault(agent, cfg) ?? defaultModel };
    })().finally(() => modelReads.delete(key));
    modelReads.set(key, reading);
  }
  return reading;
}
async function describeModels(agent, cfg, cwd, log, query = "") {
  const q = query.trim().toLowerCase();
  const match = (...s) => !q || s.some((x) => x?.toLowerCase().includes(q));
  const effortDefault = cfg.effort[agent] ?? defaultEffort(agent, null);
  const tail = [`Default effort: ${effortDefault ?? `${agent}'s own default`} (pass effort=... per call, or set "effort" in ~/.agent-bridge/config.json).`];
  try {
    if (agent === "codex") {
      const res = await codexAppServerCall(cfg.codexBin, cwd, log, "model/list", { includeHidden: false });
      const models2 = (res?.data ?? []).filter((m) => match(m?.id, m?.displayName, m?.description));
      const lines = models2.slice(0, MAX_LISTED).map((m) => {
        const efforts = (m.supportedReasoningEfforts ?? []).map((e) => typeof e === "string" ? e : e?.reasoningEffort ?? e?.effort).filter(Boolean);
        return `- ${m.id}${m.isDefault ? " (default)" : ""}: ${m.displayName ?? m.id}${m.description ? `, ${String(m.description).replace(/\.+$/, "")}` : ""}${efforts.length ? `. Efforts: ${efforts.join(", ")} (default ${m.defaultReasoningEffort})` : ""}`;
      });
      return [`Codex models (${models2.length}):`, ...lines, ...tail];
    }
    if (agent === "claude") {
      const help = (await captureOutput(cfg.claudeBin, ["--help"], cwd, log)).replace(/\s+/g, " ");
      const aliases = /--model <model>.*?\(e\.g\. (.*?)\)/.exec(help)?.[1]?.match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
      const efforts = /--effort <level>.*?\(([^)]+)\)/.exec(help)?.[1];
      return [
        `Claude Code cannot list its models. Aliases for the latest of each family: ${aliases.length ? aliases.join(", ") : "opus, sonnet"}; or a full model id (e.g. "claude-opus-5-5").`,
        ...efforts ? [`Efforts: ${efforts}.`] : [],
        ...tail
      ];
    }
    if (agent === "muse") {
      const catalog2 = await museMspQuery({ bin: cfg.museBin, cwd, log, method: "model/list" });
      const rows = Array.isArray(catalog2.models) ? catalog2.models.filter((m) => typeof m?.modelId === "string" && m.modelId && match(m.modelId, m.displayLabel, m.description)) : [];
      const lines = rows.slice(0, MAX_LISTED).map((m) => `- ${m.modelId}${m.isDefault ? " (default)" : ""}: ${m.displayLabel ?? m.modelId}${m.description ? `, ${m.description}` : ""}${Array.isArray(m.variants) ? `. Efforts: ${m.variants.join(", ")}${m.defaultReasoningEffort ? ` (default ${m.defaultReasoningEffort})` : ""}` : ". Efforts: unknown"}`);
      return [`Muse models (${rows.length}; source ${typeof catalog2.source === "string" ? catalog2.source : "unknown"}):`, ...lines, ...rows.length ? [] : ["Catalog is empty or unavailable; explicit model IDs are still passed to Muse for resolution."], ...tail];
    }
    if (agent === "antigravity") {
      const rows = (await captureOutput(cfg.antigravityBin, ["models"], cwd, log)).split(/\r?\n/).map((line) => /^([A-Za-z0-9][\w.-]*)\t+(.+)$/.exec(line.trim())).filter((row) => row && match(row[1], row[2]));
      return [`Antigravity CLI models (${rows.length}):`, ...rows.slice(0, MAX_LISTED).map((row) => `- ${row[1]}: ${row[2]}`), "Efforts: low, medium, high, xhigh, max (model-dependent).", ...tail];
    }
    const catalog = await listOpencodeModels(cfg.opencodeBin, cwd, log);
    const models = catalog.filter((m) => match(m));
    return [
      catalog.length ? `opencode catalog (${models.length}${q ? ` matching "${query}"` : ""}), as provider/model (not exhaustive):` : "opencode returned an empty catalog; available models are unknown, not necessarily unavailable.",
      "An explicit provider/model ID may still run; opencode resolves it at startup. Catalog absence does not reject an explicit ID.",
      ...cfg.opencodeModel ? [`Configured model: ${cfg.opencodeModel} (configuration, not availability verification).`] : [],
      ...models.slice(0, MAX_LISTED).map((m) => `- ${m}`),
      ...models.length > MAX_LISTED ? [`\u2026 ${models.length - MAX_LISTED} more; narrow it down with query.`] : [],
      `Effort is the model's "variant" (provider-specific, e.g. low, high, max).`,
      ...tail
    ];
  } catch (err) {
    return [`Could not list ${agent} models: ${err.message}`];
  }
}

export {
  readOpencodeModelCosts,
  codexAppServerCall,
  readUsage,
  modelParameterDescription,
  readModels,
  describeModels
};
