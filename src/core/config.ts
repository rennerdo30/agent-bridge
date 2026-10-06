import { unwatchFile, watchFile } from "node:fs";
import { basename, join } from "node:path";
import { CONFIG_FILE_NAME, DEFAULT_CLAUDE_BIN, DEFAULT_CODEX_BIN, DEFAULT_LINGER_SEC, DEFAULT_MAX_HOPS, DEFAULT_MAX_JOBS, DEFAULT_OPENCODE_BIN, DEFAULT_DASHBOARD_PORT, ENV, MAX_JOBS_LIMIT } from "./constants.js";
import type { Logger } from "./logger.js";
import { AGENT_KINDS, type AgentKind } from "./protocol.js";
import { isRecord, readJsonStore, writeJsonStore } from "./json-store.js";

/**
 * How incoming messages reach a Claude Code session.
 *  - channel: pushed live through Claude Code channels (session started with --channels / development flag)
 *  - hooks:   injected by UserPromptSubmit / PostToolUse / Stop hooks
 *  - auto:    channel when the parent Claude process was started with the channel flag, else hooks
 */
export type DeliveryMode = "auto" | "channel" | "hooks";
const DELIVERY_MODES: readonly DeliveryMode[] = ["auto", "channel", "hooks"];

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
const CODEX_SANDBOXES: readonly CodexSandbox[] = ["read-only", "workspace-write", "danger-full-access"];

/** "manual" is the newer name of "default" (Claude Code 2.1.28x); both are accepted. */
export type ClaudePermissionMode = "default" | "manual" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";
const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[] = ["default", "manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];

export interface BridgeConfig {
  /** Peer name; defaults to "<agent>-<cwd basename>". */
  name: string | null;
  autoWake: boolean;
  maxHops: number;
  /** Background subagents running at once per session. */
  maxJobs: number;
  /** MCP tools subagents may call without asking the parent (\server.tool\ patterns with *; see tool-allow.ts). */
  autoApproveTools: string[];
  delivery: DeliveryMode;
  claudeBin: string;
  codexBin: string;
  /** Default sandbox for delegated Codex runs. */
  codexSandbox: CodexSandbox;
  /** Default permission mode for delegated Claude runs. */
  claudePermissionMode: ClaudePermissionMode;
  /** Listen window after sending, in seconds (0 disables). */
  lingerSec: number;
  /** Default model for delegated Codex / Claude runs (null = the CLI's own default). */
  codexModel: string | null;
  claudeModel: string | null;
  opencodeBin: string;
  /** opencode model as provider/model, e.g. "anthropic/claude-sonnet-5". */
  opencodeModel: string | null;
  /** Default reasoning effort for subagents: one level for all, or per target agent ({ "codex": "high" }). */
  effort: Partial<Record<AgentKind, string>>;
  /** Pass --auto to headless opencode runs (auto-approve permission requests). */
  opencodeAutoApprove: boolean;
  /** Run the web dashboard inside whichever session hosts the bridge. */
  dashboard: boolean;
  dashboardPort: number;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  name: null,
  autoWake: false,
  maxHops: DEFAULT_MAX_HOPS,
  maxJobs: DEFAULT_MAX_JOBS,
  autoApproveTools: [],
  delivery: "auto",
  claudeBin: DEFAULT_CLAUDE_BIN,
  codexBin: DEFAULT_CODEX_BIN,
  codexSandbox: "read-only",
  claudePermissionMode: "default",
  lingerSec: DEFAULT_LINGER_SEC,
  codexModel: null,
  claudeModel: null,
  opencodeBin: DEFAULT_OPENCODE_BIN,
  opencodeModel: null,
  effort: {},
  opencodeAutoApprove: false,
  dashboard: true,
  dashboardPort: DEFAULT_DASHBOARD_PORT,
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function parseBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (TRUE_VALUES.has(s)) return true;
  if (FALSE_VALUES.has(s)) return false;
  return undefined;
}

function parseIntInRange(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

const MAX_HOPS_LIMIT = 100;
const MAX_LINGER_SEC = 3_600;

/**
 * Model ids are passed through verbatim to the CLI, so new models work without a plugin update.
 * Only reject what could break a command line: whitespace, quotes and shell metacharacters.
 */
export const MODEL_NAME_PATTERN = /^[^\s"'`&|<>^%$;()]{1,200}$/;
function modelName(v: unknown): string | undefined {
  return typeof v === "string" && MODEL_NAME_PATTERN.test(v.trim()) ? v.trim() : undefined;
}

/** A list of tool patterns: a JSON array, or a comma-separated string (env var). */
const EFFORT_NAME = /^[A-Za-z0-9_-]{1,20}$/;

/** "high" (every target) or { "codex": "xhigh", "claude": "high" }. */
function effortLevels(v: unknown): Partial<Record<AgentKind, string>> | undefined {
  if (typeof v === "string" && EFFORT_NAME.test(v)) return Object.fromEntries(AGENT_KINDS.map((k) => [k, v]));
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Partial<Record<AgentKind, string>> = {};
  for (const [k, x] of Object.entries(v)) if ((AGENT_KINDS as readonly string[]).includes(k) && typeof x === "string" && EFFORT_NAME.test(x)) out[k as AgentKind] = x;
  return out;
}

function toolPatterns(v: unknown): string[] | undefined {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!list || !list.every((x) => typeof x === "string")) return undefined;
  return (list as string[]).map((x) => x.trim()).filter(Boolean);
}

/** How often a running session checks config.json for changes. */
const CONFIG_POLL_MS = 2_000;

/**
 * Re-read config.json whenever it changes (polling: editors often replace the file, which breaks fs.watch).
 * Returns a function that stops watching.
 */
export function watchConfig(home: string, agent: AgentKind, log: Logger, onChange: (cfg: BridgeConfig) => void): () => void {
  const path = join(home, CONFIG_FILE_NAME);
  const listener = (cur: { mtimeMs: number }, prev: { mtimeMs: number }) => {
    if (cur.mtimeMs === prev.mtimeMs) return;
    log.info("config file changed; applying it", { path });
    onChange(loadConfig(home, agent, log));
  };
  watchFile(path, { interval: CONFIG_POLL_MS, persistent: false }, listener);
  return () => unwatchFile(path, listener);
}

/** Set one top-level value in config.json, keeping the rest of the file. */
export function saveConfigValue(home: string, key: string, value: unknown): void {
  const path = join(home, CONFIG_FILE_NAME);
  const previous = readJsonStore(path);
  const file = isRecord(previous) ? previous : {};
  writeJsonStore(path, { ...file, [key]: value }, previous);
}

/** Config file (~/.agent-bridge/config.json) with optional per-agent sections, overridden by env vars. */
export function loadConfig(home: string, agent: AgentKind, log: Logger, env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  let file: Record<string, unknown> = {};
  const path = join(home, CONFIG_FILE_NAME);
  try {
    file = (readJsonStore(path, log) ?? {}) as Record<string, unknown>;
    log.debug("config file loaded", { path });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn("ignoring unreadable config file", { path, err: (err as Error).message });
  }
  const section = isRecord(file[agent]) ? file[agent] : {};
  /** First valid value wins: env var, then the agent section, then the top level of the file. */
  const pick = <T>(key: keyof BridgeConfig, envKey: string | null, parse: (v: unknown) => T | undefined): T | undefined => {
    for (const v of [envKey ? env[envKey] : undefined, section[key], file[key]]) {
      if (v === undefined) continue;
      const parsed = parse(v);
      if (parsed !== undefined) return parsed;
      log.warn("ignoring invalid config value", { key, value: String(v) });
    }
    return undefined;
  };
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  const d = DEFAULT_CONFIG;
  const cfg: BridgeConfig = {
    name: pick("name", ENV.name, str) ?? d.name,
    autoWake: pick("autoWake", ENV.autoWake, parseBool) ?? d.autoWake,
    maxHops: pick("maxHops", ENV.maxHops, (v) => parseIntInRange(v, 0, MAX_HOPS_LIMIT)) ?? d.maxHops,
    maxJobs: pick("maxJobs", ENV.maxJobs, (v) => parseIntInRange(v, 1, MAX_JOBS_LIMIT)) ?? d.maxJobs,
    autoApproveTools: pick("autoApproveTools", ENV.autoApproveTools, toolPatterns) ?? d.autoApproveTools,
    delivery: pick("delivery", ENV.delivery, (v) => oneOf(v, DELIVERY_MODES)) ?? d.delivery,
    claudeBin: pick("claudeBin", ENV.claudeBin, str) ?? d.claudeBin,
    codexBin: pick("codexBin", ENV.codexBin, str) ?? d.codexBin,
    codexSandbox: pick("codexSandbox", null, (v) => oneOf(v, CODEX_SANDBOXES)) ?? d.codexSandbox,
    claudePermissionMode: pick("claudePermissionMode", null, (v) => oneOf(v, CLAUDE_PERMISSION_MODES)) ?? d.claudePermissionMode,
    lingerSec: pick("lingerSec", ENV.lingerSec, (v) => parseIntInRange(v, 0, MAX_LINGER_SEC)) ?? d.lingerSec,
    codexModel: pick("codexModel", null, modelName) ?? d.codexModel,
    claudeModel: pick("claudeModel", null, modelName) ?? d.claudeModel,
    opencodeBin: pick("opencodeBin", ENV.opencodeBin, str) ?? d.opencodeBin,
    opencodeModel: pick("opencodeModel", null, modelName) ?? d.opencodeModel,
    effort: pick("effort", null, effortLevels) ?? d.effort,
    opencodeAutoApprove: pick("opencodeAutoApprove", null, parseBool) ?? d.opencodeAutoApprove,
    dashboard: pick("dashboard", ENV.dashboard, parseBool) ?? d.dashboard,
    dashboardPort: pick("dashboardPort", null, (v) => parseIntInRange(v, 1, 65_535)) ?? d.dashboardPort,
  };
  log.debug("effective config", { ...cfg });
  return cfg;
}

export function parseAgentKind(v: string | undefined): AgentKind {
  return oneOf(v?.trim().toLowerCase(), AGENT_KINDS) ?? "other";
}

/**
 * Default peer name: agent kind plus the project folder name, sanitized to the peer-name alphabet. Never the bare
 * kind: "codex" as a target means "the codex peer", and a peer named so would shadow that.
 */
export function defaultPeerName(agent: AgentKind, cwd: string): string {
  const folder = basename(cwd).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+/, "").slice(0, 40);
  return `${agent}-${folder || "session"}`;
}

export { CODEX_SANDBOXES, CLAUDE_PERMISSION_MODES };
