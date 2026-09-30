import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexHome } from "./codex-trust.js";

/**
 * The reasoning effort a subagent runs at when the caller does not choose one: its CLI's own default, read from
 * the user's config. Only for display (the dashboard); the CLI applies its default itself. null when unknown.
 *  - Codex: model_reasoning_effort in config.toml (the app-server also reports it per thread, which wins)
 *  - Claude: effortLevel in settings.json, per model under modelSettings or for all models
 *  - opencode: a model's "variant"; its default is provider-specific, so unknown
 */
export function defaultEffort(agent: string, model: string | null, read: (p: string) => string = (p) => readFileSync(p, "utf8")): string | null {
  try {
    if (agent === "codex") return codexConfigEffort(read(join(codexHome(), "config.toml")));
    if (agent === "claude") return claudeSettingsEffort(read(join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "settings.json")), model);
  } catch {
    // no config: unknown
  }
  return null;
}

/** model_reasoning_effort from config.toml's top level (before the first [table]). */
export function codexConfigEffort(toml: string): string | null {
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

/** effortLevel for this model (modelSettings keys are model ids; "opus[1m]" style suffixes are ignored), else the global one. */
export function claudeSettingsEffort(json: string, model: string | null): string | null {
  const s = JSON.parse(json) as { effortLevel?: unknown; modelSettings?: Record<string, { effortLevel?: unknown }> };
  const id = model?.replace(/\[.*\]$/, "").toLowerCase() ?? "";
  if (id) {
    for (const [key, v] of Object.entries(s.modelSettings ?? {})) {
      const k = key.replace(/\[.*\]$/, "").toLowerCase();
      if ((id === k || id.startsWith(`${k}-`) || k.startsWith(`${id}-`)) && typeof v?.effortLevel === "string") return v.effortLevel;
    }
  }
  return typeof s.effortLevel === "string" ? s.effortLevel : null;
}
