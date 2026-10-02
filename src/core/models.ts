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
