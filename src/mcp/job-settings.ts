import type { TargetArgs } from "./targets.js";

/** Settings that can change between turns without replacing a job's session or worktree. */
export type JobSettings = Pick<TargetArgs, "access" | "sandbox" | "permission_mode" | "auto_approve"> & { model?: string; effort?: string };
export const JOB_SETTING_KEYS = ["model", "effort", "access", "sandbox", "permission_mode", "auto_approve"] as const;
const EXACT_PERMISSION_KEYS = ["sandbox", "permission_mode", "auto_approve"] as const;

/** An access change replaces an earlier exact override; an exact override replaces earlier access. */
export function changedJobArgs(args: Record<string, unknown> | undefined, settings: JobSettings): Record<string, unknown> {
  const next = { ...args };
  if (settings.access !== undefined) for (const key of EXACT_PERMISSION_KEYS) delete next[key];
  else if (EXACT_PERMISSION_KEYS.some((key) => settings[key] !== undefined)) delete next.access;
  for (const key of JOB_SETTING_KEYS) if (settings[key] !== undefined) next[key] = settings[key];
  return next;
}
