import { DEFAULT_CODEX_SUBAGENTS, MAX_CODEX_SUBAGENTS } from "./constants.js";

/** CLI -c and app-server thread config use the same dotted TOML override keys. */
export function codexSubagentConfig(count = DEFAULT_CODEX_SUBAGENTS): Record<string, boolean | number> {
  if (!Number.isInteger(count) || count < 0 || count > MAX_CODEX_SUBAGENTS) throw new Error(`native_subagents must be an integer from 0 to ${MAX_CODEX_SUBAGENTS}`);
  return {
    "features.multi_agent": count > 0,
    // V2 takes precedence over agents.enabled. Clear an inherited V2 table (including its cap).
    // If the model selects V2, it derives its cap from agents.max_threads plus the coordinator.
    "features.multi_agent_v2": false,
    "agents.enabled": count > 0,
    // Codex rejects zero here even when the feature is disabled.
    "agents.max_threads": Math.max(1, count),
  };
}
