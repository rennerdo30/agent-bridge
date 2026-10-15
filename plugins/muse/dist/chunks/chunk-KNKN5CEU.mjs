import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  codexHome
} from "./chunk-IOGZQ3DT.mjs";

// src/core/effort.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function defaultEffort(agent, model, read = (p) => readFileSync(p, "utf8")) {
  try {
    if (agent === "codex") return codexConfigEffort(read(join(codexHome(), "config.toml")));
    if (agent === "claude") return claudeSettingsEffort(read(join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "settings.json")), model);
  } catch {
  }
  return null;
}
function codexConfigEffort(toml) {
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/.exec(line);
    if (m) return m[1];
  }
  return null;
}
function claudeSettingsEffort(json, model) {
  const s = JSON.parse(json);
  const id = model?.replace(/\[.*\]$/, "").toLowerCase() ?? "";
  if (id) {
    for (const [key, v] of Object.entries(s.modelSettings ?? {})) {
      const k = key.replace(/\[.*\]$/, "").toLowerCase();
      if ((id === k || id.startsWith(`${k}-`) || k.startsWith(`${id}-`)) && typeof v?.effortLevel === "string") return v.effortLevel;
    }
  }
  return typeof s.effortLevel === "string" ? s.effortLevel : null;
}

export {
  defaultEffort
};
