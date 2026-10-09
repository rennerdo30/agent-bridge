import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  defaultEffort
} from "./chunk-KNKN5CEU.mjs";
import {
  childEnv,
  killTree,
  listOpencodeModels,
  opencodeV2,
  resolveCommand
} from "./chunk-7KRAJNI6.mjs";
import {
  APP_VERSION
} from "./chunk-GWP4RZPO.mjs";

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
function capture(bin, args, cwd, log, stdin) {
  return new Promise((resolve, reject) => {
    const env = childEnv();
    let cmd;
    try {
      cmd = resolveCommand(bin, args, env, log);
    } catch (err2) {
      return reject(err2);
    }
    const child = spawn(cmd.resolved, cmd.args, { cwd, env, shell: cmd.needsShell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void killTree(child);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`${bin} did not answer within ${USAGE_TIMEOUT_MS / 1e3}s`))), USAGE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (d) => out += d);
    child.stderr.setEncoding("utf8").on("data", (d) => err += d);
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => finish(() => code === 0 || out ? resolve(out) : reject(new Error(err.trim().slice(-300) || `exit code ${code}`))));
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
  return parseOpencodeModelCosts(await capture(bin, v2 ? ["api", "--standalone", "GET", "/api/model"] : ["models", "--verbose"], cwd, log));
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
async function codexUsage(bin, cwd, log) {
  return formatCodexLimits(await codexAppServerCall(bin, cwd, log, "account/rateLimits/read", null));
}
async function readUsage(agent, bin, cwd, log, model = null) {
  try {
    if (agent === "antigravity") return { agent, lines: ["Account limit availability is unknown: agy exposes quotas in interactive /usage (or /quota), without a documented machine-readable quota command. Delegated results include token usage."], limits: [], maxUsedPercent: null };
    if (agent === "codex") return await codexUsage(bin, cwd, log);
    if (agent === "claude") return parseClaudeUsage(await capture(bin, ["-p", "/usage"], cwd, log));
    const [stats, models] = await Promise.all([
      capture(bin, ["stats", "--days", "1"], cwd, log).catch(() => ""),
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
  return `Any model id or alias ${agent} accepts, passed through verbatim (e.g. ${example}). Default: ${modelDefault(agent, cfg) ?? cached?.defaultModel ?? `${agent}'s own default`}. ` + (models.length ? `Available${models.length > SHORT_MODEL_LIST ? " (short list)" : ""}: ${models.slice(0, SHORT_MODEL_LIST).join(", ")}. ` : "") + `Use list_models(agent="${agent}") for the full list and effort levels.`;
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
        return id ? [agent === "codex" || agent === "antigravity" ? id.replace(/:$/, "") : id] : [];
      });
      const defaultModel = lines.flatMap((l) => /^- (\S+) \(default\)/.exec(l)?.[1] ?? [])[0] ?? null;
      const report = { agent, defaultModel, models, lines };
      if (!lines[0]?.startsWith("Could not list")) {
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
    if (agent === "antigravity") {
      const rows = (await captureOutput(cfg.antigravityBin, ["models"], cwd, log)).split(/\r?\n/).map((line) => /^([A-Za-z0-9][\w.-]*)\t+(.+)$/.exec(line.trim())).filter((row) => row && match(row[1], row[2]));
      return [`Antigravity CLI models (${rows.length}):`, ...rows.slice(0, MAX_LISTED).map((row) => `- ${row[1]}: ${row[2]}`), "Efforts: low, medium, high, xhigh, max (model-dependent).", ...tail];
    }
    const models = (await listOpencodeModels(cfg.opencodeBin, cwd, log)).filter((m) => match(m));
    return [
      `opencode models (${models.length}${q ? ` matching "${query}"` : ""}), as provider/model:`,
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
