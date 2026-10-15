import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  defaultEffort
} from "./chunk-KNKN5CEU.mjs";
import {
  captureOutput,
  codexAppServerCall,
  listOpencodeModels,
  museMspQuery
} from "./chunk-NRRZXVAU.mjs";

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
  modelParameterDescription,
  readModels,
  describeModels
};
