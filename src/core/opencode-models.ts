import { runProcess } from "./delegate.js";
import type { Logger } from "./logger.js";

/**
 * opencode needs exact "provider/model" ids. Agents (and people) often write a short or partial name
 * ("muse-spark", "opencode/muse-spark", "sonnet"). Resolve those against `opencode models` up front,
 * so a run never starts with an unknown model.
 */
const LIST_TIMEOUT_MS = 60_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MODEL_LINE = /^[A-Za-z0-9._-]+\/\S+$/;
const MAX_SUGGESTIONS = 8;

let cache: { at: number; models: string[] } | null = null;

export async function listOpencodeModels(bin: string, cwd: string, log: Logger): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;
  const res = await runProcess({ bin, args: ["models"], stdin: "", cwd, timeoutMs: LIST_TIMEOUT_MS, env: process.env, log });
  const models = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => MODEL_LINE.test(l));
  if (models.length) cache = { at: Date.now(), models };
  return models;
}

export type ModelResolution = { model: string; note: string | null } | { error: string };

/** Pick the one model the input means, or explain why it cannot be decided. */
export function resolveOpencodeModel(input: string, models: string[]): ModelResolution {
  const want = input.trim();
  if (models.length === 0) return { model: want, note: null }; // cannot check; let opencode decide
  if (models.includes(want)) return { model: want, note: null };
  const lower = want.toLowerCase();
  const exactCi = models.filter((m) => m.toLowerCase() === lower);
  if (exactCi.length === 1) return { model: exactCi[0]!, note: null };

  const [provider, ...rest] = lower.includes("/") ? lower.split("/") : ["", lower];
  const name = rest.join("/");
  const matches = models.filter((m) => {
    const [mp, ...mr] = m.toLowerCase().split("/");
    const mn = mr.join("/");
    if (provider && mp !== provider) return false;
    return mn === name || mn.startsWith(name) || mn.includes(name);
  });
  // Prefer names that start with the input over ones that merely contain it.
  const prefixed = matches.filter((m) => m.toLowerCase().split("/").slice(1).join("/").startsWith(name));
  const best = prefixed.length ? prefixed : matches;
  if (best.length === 1) return { model: best[0]!, note: `model "${want}" resolved to "${best[0]}"` };

  const suggest = (list: string[]) => list.slice(0, MAX_SUGGESTIONS).join(", ");
  if (best.length > 1) return { error: `The opencode model "${want}" is ambiguous. Pass one of: ${suggest(best)}${best.length > MAX_SUGGESTIONS ? ", …" : ""}` };
  const near = models.filter((m) => name.split(/[-._]/).some((part) => part.length > 2 && m.toLowerCase().includes(part)));
  return {
    error: `Unknown opencode model "${want}". Use "provider/model" from \`opencode models\`${near.length ? `, e.g. ${suggest(near)}` : ""}.`,
  };
}
