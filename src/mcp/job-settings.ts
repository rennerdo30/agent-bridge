import { MAX_CODEX_SUBAGENTS } from "../core/constants.js";
import { CLAUDE_PERMISSION_MODES, CODEX_APPROVALS_REVIEWERS, CODEX_SANDBOXES, MODEL_NAME_PATTERN } from "../core/config.js";
import type { AgentKind } from "../core/protocol.js";
import { ACCESS_LEVELS, type TargetArgs } from "./targets.js";

/** Settings that can change between turns without replacing a job's session or worktree. */
export type JobSettings = Pick<TargetArgs, "access" | "sandbox" | "native_subagents" | "approvals_reviewer" | "permission_mode" | "auto_approve"> & { model?: string; effort?: string };
export const JOB_SETTING_KEYS = ["native_subagents", "model", "effort", "access", "sandbox", "approvals_reviewer", "permission_mode", "auto_approve"] as const;
const EXACT_PERMISSION_KEYS = ["sandbox", "permission_mode", "auto_approve"] as const;
/** Each exact permission key belongs to one agent's CLI. */
export const PERMISSION_KEY_AGENT = { native_subagents: "codex", sandbox: "codex", approvals_reviewer: "codex", permission_mode: "claude", auto_approve: "opencode" } as const;
export const EFFORT_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;

/** An access change replaces an earlier exact override; an exact override replaces earlier access. */
export function changedJobArgs(args: Record<string, unknown> | undefined, settings: JobSettings): Record<string, unknown> {
  const next = { ...args };
  if (settings.access !== undefined) for (const key of EXACT_PERMISSION_KEYS) delete next[key];
  else if (EXACT_PERMISSION_KEYS.some((key) => settings[key] !== undefined)) delete next.access;
  for (const key of JOB_SETTING_KEYS) if (settings[key] !== undefined) next[key] = settings[key];
  return next;
}

/**
 * Settings from outside the MCP schema (the dashboard): the same rules as message_subagent's parameters.
 * Returns the settings, or an error message.
 */
export function parseJobSettings(input: unknown, agent: AgentKind): JobSettings | string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "settings must be an object";
  const raw = input as Record<string, unknown>;
  const unknownKey = Object.keys(raw).find((key) => !(JOB_SETTING_KEYS as readonly string[]).includes(key));
  if (unknownKey) return `unknown setting: ${unknownKey}`;
  const settings: JobSettings = {};
  if (raw.native_subagents !== undefined) {
    if (typeof raw.native_subagents !== "number" || !Number.isInteger(raw.native_subagents) || raw.native_subagents < 0 || raw.native_subagents > MAX_CODEX_SUBAGENTS) return "invalid native_subagents";
    settings.native_subagents = raw.native_subagents;
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || !MODEL_NAME_PATTERN.test(raw.model)) return "invalid model";
    settings.model = raw.model;
  }
  if (raw.effort !== undefined) {
    if (typeof raw.effort !== "string" || !EFFORT_PATTERN.test(raw.effort)) return "invalid effort";
    settings.effort = raw.effort;
  }
  if (raw.access !== undefined) {
    if (!(ACCESS_LEVELS as readonly unknown[]).includes(raw.access)) return "invalid access";
    settings.access = raw.access as JobSettings["access"];
  }
  if (raw.sandbox !== undefined) {
    if (!(CODEX_SANDBOXES as readonly unknown[]).includes(raw.sandbox)) return "invalid sandbox";
    settings.sandbox = raw.sandbox as JobSettings["sandbox"];
  }
  if (raw.approvals_reviewer !== undefined) {
    if (!(CODEX_APPROVALS_REVIEWERS as readonly unknown[]).includes(raw.approvals_reviewer)) return "invalid approvals_reviewer";
    settings.approvals_reviewer = raw.approvals_reviewer as JobSettings["approvals_reviewer"];
  }
  if (raw.permission_mode !== undefined) {
    if (!(CLAUDE_PERMISSION_MODES as readonly unknown[]).includes(raw.permission_mode)) return "invalid permission_mode";
    settings.permission_mode = raw.permission_mode as JobSettings["permission_mode"];
  }
  if (raw.auto_approve !== undefined) {
    if (typeof raw.auto_approve !== "boolean") return "invalid auto_approve";
    settings.auto_approve = raw.auto_approve;
  }
  for (const [key, owner] of Object.entries(PERMISSION_KEY_AGENT)) {
    if (settings[key as keyof typeof PERMISSION_KEY_AGENT] !== undefined && agent !== owner) return `${key} applies only to ${owner} jobs.`;
  }
  if (!Object.keys(settings).length) return "no settings given";
  return settings;
}
