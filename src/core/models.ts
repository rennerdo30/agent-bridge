import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "./config.js";
import { defaultEffort } from "./effort.js";
import type { Logger } from "./logger.js";
import { listOpencodeModels } from "./opencode-models.js";
import type { CodingAgent } from "./protocol.js";
import { captureOutput, codexAppServerCall } from "./usage.js";

/**
 * Which models (and reasoning efforts) a subagent target accepts, so the driving agent can pick one:
 *  - Codex: `model/list` of `codex app-server` (each model with its effort levels)
 *  - Claude Code: cannot list models; its --help names the aliases and the effort levels
 *  - opencode: `opencode models` (every provider/model it is logged in to); efforts are per-model "variants"
 */
const MAX_LISTED = 80;
const MODEL_CACHE_MS = 10 * 60 * 1000;
const SHORT_MODEL_LIST = 6;
const modelReads = new Map<string, Promise<ModelReport>>();

export interface ModelReport {
  agent: CodingAgent;
  defaultModel: string | null;
  models: string[];
  lines: string[];
}

const modelBin = (agent: CodingAgent, cfg: BridgeConfig): string => cfg[`${agent}Bin`];
const modelDefault = (agent: CodingAgent, cfg: BridgeConfig): string | null => cfg[`${agent}Model`];
const modelCachePath = (home: string, agent: CodingAgent): string => join(home, `models-${agent}.json`);

/** Startup reads only this small file; listing models never holds up MCP registration. */
function cachedModels(home: string, agent: CodingAgent, cfg: BridgeConfig): ModelReport | null {
  try {
    const cache = JSON.parse(readFileSync(modelCachePath(home, agent), "utf8"));
    const validStrings = (v: unknown): boolean => Array.isArray(v) && v.every((s: unknown) => typeof s === "string");
    if (cache.bin !== modelBin(agent, cfg) || cache.effort !== (cfg.effort[agent] ?? null) || typeof cache.at !== "number" || Date.now() - cache.at >= MODEL_CACHE_MS) return null;
    if (cache.report?.agent !== agent || !validStrings(cache.report.models) || !validStrings(cache.report.lines)) return null;
    return { ...cache.report, defaultModel: modelDefault(agent, cfg) ?? cache.report.defaultModel };
  } catch {
    return null;
  }
}

export function modelParameterDescription(agent: CodingAgent, cfg: BridgeConfig, home: string, example: string): string {
  const cached = cachedModels(home, agent, cfg);
  const models = cached?.models ?? (agent === "claude" ? ["opus", "sonnet"] : []);
  return (
    `Any model id or alias ${agent} accepts, passed through verbatim (e.g. ${example}). ` +
    `Default: ${modelDefault(agent, cfg) ?? cached?.defaultModel ?? `${agent}'s own default`}. ` +
    (models.length ? `Available${models.length > SHORT_MODEL_LIST ? " (short list)" : ""}: ${models.slice(0, SHORT_MODEL_LIST).join(", ")}. ` : "") +
    `Use list_models(agent="${agent}") for the full list and effort levels.`
  );
}

/** Shared by list_models and the dashboard; concurrent reads start each CLI only once. */
export async function readModels(agent: CodingAgent, cfg: BridgeConfig, cwd: string, log: Logger, home: string): Promise<ModelReport> {
  const cached = cachedModels(home, agent, cfg);
  if (cached) return cached;
  const key = JSON.stringify([home, agent, modelBin(agent, cfg), modelDefault(agent, cfg), cfg.effort[agent], cwd]);
  let reading = modelReads.get(key);
  if (!reading) {
    reading = (async () => {
      const lines = await describeModels(agent, cfg, cwd, log);
      const models = agent === "claude"
        ? /Aliases for the latest of each family: ([^;]+)/.exec(lines[0] ?? "")?.[1]?.split(", ") ?? []
        : lines.flatMap((l) => {
            const id = /^- (\S+)/.exec(l)?.[1];
            return id ? [agent === "codex" || agent === "antigravity" ? id.replace(/:$/, "") : id] : [];
          });
      const defaultModel = lines.flatMap((l) => /^- (\S+) \(default\)/.exec(l)?.[1] ?? [])[0] ?? null;
      const report: ModelReport = { agent, defaultModel, models, lines };
      if (!lines[0]?.startsWith("Could not list")) {
        try {
          mkdirSync(home, { recursive: true });
          writeFileSync(modelCachePath(home, agent), JSON.stringify({ at: Date.now(), bin: modelBin(agent, cfg), effort: cfg.effort[agent] ?? null, report }), { mode: 0o600 });
        } catch (err) {
          log.debug("could not cache models", { err: (err as Error).message });
        }
      }
      return { ...report, defaultModel: modelDefault(agent, cfg) ?? defaultModel };
    })().finally(() => modelReads.delete(key));
    modelReads.set(key, reading);
  }
  return reading;
}

export async function describeModels(agent: CodingAgent, cfg: BridgeConfig, cwd: string, log: Logger, query = ""): Promise<string[]> {
  const q = query.trim().toLowerCase();
  const match = (...s: (string | null | undefined)[]) => !q || s.some((x) => x?.toLowerCase().includes(q));
  const effortDefault = cfg.effort[agent] ?? defaultEffort(agent, null);
  const tail = [`Default effort: ${effortDefault ?? `${agent}'s own default`} (pass effort=... per call, or set "effort" in ~/.agent-bridge/config.json).`];
  try {
    if (agent === "codex") {
      const res = await codexAppServerCall(cfg.codexBin, cwd, log, "model/list", { includeHidden: false });
      const models: any[] = (res?.data ?? []).filter((m: any) => match(m?.id, m?.displayName, m?.description));
      const lines = models.slice(0, MAX_LISTED).map((m) => {
        const efforts = (m.supportedReasoningEfforts ?? []).map((e: any) => (typeof e === "string" ? e : e?.reasoningEffort ?? e?.effort)).filter(Boolean);
        return `- ${m.id}${m.isDefault ? " (default)" : ""}: ${m.displayName ?? m.id}${m.description ? `, ${String(m.description).replace(/\.+$/, "")}` : ""}${efforts.length ? `. Efforts: ${efforts.join(", ")} (default ${m.defaultReasoningEffort})` : ""}`;
      });
      return [`Codex models (${models.length}):`, ...lines, ...tail];
    }
    if (agent === "claude") {
      const help = (await captureOutput(cfg.claudeBin, ["--help"], cwd, log)).replace(/\s+/g, " ");
      const aliases = /--model <model>.*?\(e\.g\. (.*?)\)/.exec(help)?.[1]?.match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
      const efforts = /--effort <level>.*?\(([^)]+)\)/.exec(help)?.[1];
      return [
        `Claude Code cannot list its models. Aliases for the latest of each family: ${aliases.length ? aliases.join(", ") : "opus, sonnet"}; or a full model id (e.g. "claude-opus-5-5").`,
        ...(efforts ? [`Efforts: ${efforts}.`] : []),
        ...tail,
      ];
    }
    if (agent === "antigravity") {
      const rows = (await captureOutput(cfg.antigravityBin, ["models"], cwd, log)).split(/\r?\n/).map((line) => /^([A-Za-z0-9][\w.-]*)\t+(.+)$/.exec(line.trim())).filter((row) => row && match(row[1], row[2]));
      return [`Antigravity CLI models (${rows.length}):`, ...rows.slice(0, MAX_LISTED).map((row) => `- ${row![1]}: ${row![2]}`), "Efforts: low, medium, high, xhigh, max (model-dependent).", ...tail];
    }
    const models = (await listOpencodeModels(cfg.opencodeBin, cwd, log)).filter((m) => match(m));
    return [
      `opencode models (${models.length}${q ? ` matching "${query}"` : ""}), as provider/model:`,
      ...models.slice(0, MAX_LISTED).map((m) => `- ${m}`),
      ...(models.length > MAX_LISTED ? [`… ${models.length - MAX_LISTED} more; narrow it down with query.`] : []),
      `Effort is the model's "variant" (provider-specific, e.g. low, high, max).`,
      ...tail,
    ];
  } catch (err) {
    return [`Could not list ${agent} models: ${(err as Error).message}`];
  }
}
