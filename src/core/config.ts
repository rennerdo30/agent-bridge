import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_CODEX_SUBAGENTS, MAX_CODEX_SUBAGENTS, CONFIG_FILE_NAME, DEFAULT_CLAUDE_BIN, DEFAULT_CODEX_BIN, DEFAULT_LINGER_SEC, DEFAULT_MAX_HOPS, DEFAULT_MAX_JOBS, DEFAULT_MAX_DELEGATE_DEPTH, DEFAULT_OPENCODE_BIN, DEFAULT_DASHBOARD_PORT, ENV, MAX_DELEGATE_DEPTH_LIMIT, MAX_JOBS_LIMIT } from "./constants.js";
import type { Logger } from "./logger.js";
import { AGENT_KINDS, type AgentKind } from "./protocol.js";
import { isRecord, readJsonStore, writeJsonStore } from "./json-store.js";
import { DEFAULT_NETWORK_CONFIG, parseNetworkConfig, type NetworkConfig } from "../network/config.js";

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
export type CodexApprovalsReviewer = "user" | "auto_review";
export const CODEX_APPROVALS_REVIEWERS: readonly CodexApprovalsReviewer[] = ["user", "auto_review"];
export const DEFAULT_CODEX_APPROVALS_REVIEWER: CodexApprovalsReviewer = "auto_review";

/** "manual" is the newer name of "default" (Claude Code 2.1.28x); both are accepted. */
export type ClaudePermissionMode = "default" | "manual" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";
const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[] = ["default", "manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];

export interface NotificationConfig { approvals: boolean; finish: boolean; fail: boolean }
const DEFAULT_NOTIFICATIONS: NotificationConfig = { approvals: true, finish: true, fail: true };

export interface HistoryAnswerConfig {
  preference: ("claude" | "codex" | "opencode")[];
  claudeModel: string; codexModel: string; opencodeModel: string | null;
}
const DEFAULT_HISTORY_ANSWER: HistoryAnswerConfig = { preference: ["codex", "claude", "opencode"], claudeModel: "haiku", codexModel: "gpt-6-luna", opencodeModel: null };

export interface BridgeConfig {
  projectGroups: boolean;
  historyAnswer: HistoryAnswerConfig;
  /** Peer name; defaults to "<agent>-<cwd basename>". */
  name: string | null;
  autoWake: boolean;
  /** Claude: a message addressed to this session wakes it without general auto-wake. */
  wakeOnDirect: boolean;
  maxHops: number;
  /** Background subagents running at once per session. */
  maxJobs: number;
  /** Maximum child depth, counted from the top session at depth zero. */
  maxDelegateDepth: number;
  /** MCP tools subagents may call without asking the parent (server.tool patterns or presets; see tool-allow.ts). */
  autoApproveTools: string[];
  /** Machine-wide named resource capacities, shared by all jobs using this home directory. */
  resourceSlots: Record<string, number>;
  delivery: DeliveryMode;
  claudeBin: string;
  codexBin: string;
  /** Match a TUI attached to a non-default app-server; never start another daemon to wake it. */
  codexWakeRemote?: string | null;
  codexWakeRemoteAuthTokenEnv?: string | null;
  /** Open native Codex child threads per job (0 disables); separate from bridge maxJobs. */
  codexSubagents: number;
  /** Default sandbox for delegated Codex runs. */
  codexSandbox: CodexSandbox;
  /** Restricted-token runs keep files owned by the bridge user. Elevated is an explicit opt-in. */
  codexWindowsSandbox: "unelevated" | "elevated";
  /** Push and safely reap explicitly closed worktree jobs. Never enabled implicitly. */
  jobCloseCleanup: boolean;
  /** Reviewer for eligible delegated Codex approvals; does not change the sandbox. */
  codexApprovalsReviewer: CodexApprovalsReviewer;
  /** Worktree edit runs: null inherits codexSandbox, with workspace-write for a read-only default. */
  codexWorktreeSandbox: CodexSandbox | null;
  /** null keeps Codex's own sandbox_workspace_write.network_access setting. */
  codexWorkspaceWriteNetworkAccess: boolean | null;
  /** Default permission mode for delegated Claude runs. */
  claudePermissionMode: ClaudePermissionMode;
  /** Listen window after sending, in seconds (0 disables). */
  lingerSec: number;
  /** Default model for delegated Codex / Claude runs (null = the CLI's own default). */
  codexModel: string | null;
  claudeModel: string | null;
  opencodeBin: string;
  /** Google's Antigravity CLI is named agy. */
  antigravityBin: string;
  antigravityModel: string | null;
  /** opencode model as provider/model, e.g. "anthropic/claude-sonnet-5". */
  opencodeModel: string | null;
  /** Default reasoning effort for subagents: one level for all, or per target agent ({ "codex": "high" }). */
  effort: Partial<Record<AgentKind, string>>;
  /** Pass --auto to headless opencode runs (auto-approve permission requests). */
  opencodeAutoApprove: boolean;
  /** Run the web dashboard inside whichever session hosts the bridge. */
  dashboard: boolean;
  dashboardPort: number;
  /** Desktop notifications contain only fixed event text, never job commands or reports. */
  notifications: NotificationConfig;
  /** Broker federation is opt-in and read only when the broker starts. */
  network: NetworkConfig;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  projectGroups: true,
  historyAnswer: DEFAULT_HISTORY_ANSWER,
  name: null,
  autoWake: false,
  wakeOnDirect: true,
  maxHops: DEFAULT_MAX_HOPS,
  maxJobs: DEFAULT_MAX_JOBS,
  maxDelegateDepth: DEFAULT_MAX_DELEGATE_DEPTH,
  autoApproveTools: [],
  resourceSlots: {},
  delivery: "auto",
  claudeBin: DEFAULT_CLAUDE_BIN,
  codexBin: DEFAULT_CODEX_BIN,
  codexSubagents: DEFAULT_CODEX_SUBAGENTS,
  codexSandbox: "read-only",
  codexWindowsSandbox: "unelevated",
  jobCloseCleanup: false,
  codexApprovalsReviewer: DEFAULT_CODEX_APPROVALS_REVIEWER,
  codexWorktreeSandbox: null,
  codexWorkspaceWriteNetworkAccess: null,
  claudePermissionMode: "default",
  lingerSec: DEFAULT_LINGER_SEC,
  codexModel: null,
  claudeModel: null,
  opencodeBin: DEFAULT_OPENCODE_BIN,
  antigravityBin: "agy",
  antigravityModel: null,
  opencodeModel: null,
  effort: {},
  opencodeAutoApprove: false,
  dashboard: true,
  dashboardPort: DEFAULT_DASHBOARD_PORT,
  notifications: DEFAULT_NOTIFICATIONS,
  network: DEFAULT_NETWORK_CONFIG,
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

function historyAnswer(v: unknown): HistoryAnswerConfig | undefined {
  if (!isRecord(v)) return undefined;
  const agents = ["claude", "codex", "opencode"];
  if (v.preference !== undefined && (!Array.isArray(v.preference) || !v.preference.length || !v.preference.every((a) => agents.includes(String(a))))) return undefined;
  const out = { ...DEFAULT_HISTORY_ANSWER, preference: [...DEFAULT_HISTORY_ANSWER.preference] };
  if (Array.isArray(v.preference)) out.preference = [...new Set(v.preference)] as HistoryAnswerConfig["preference"];
  for (const key of ["claudeModel", "codexModel", "opencodeModel"] as const) {
    if (v[key] === undefined) continue;
    if (key === "opencodeModel" && v[key] === null) { out.opencodeModel = null; continue; }
    const model = modelName(v[key]);
    if (!model) return undefined;
    out[key] = model;
  }
  return out;
}

function notifications(v: unknown): NotificationConfig | undefined {
  if (!isRecord(v)) return undefined;
  const out = { ...DEFAULT_NOTIFICATIONS };
  for (const key of Object.keys(out) as (keyof NotificationConfig)[]) {
    if (v[key] === undefined) continue;
    const value = parseBool(v[key]);
    if (value === undefined) return undefined;
    out[key] = value;
  }
  return out;
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
export const RESOURCE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_RESOURCE_SLOTS = 100;

function resourceSlots(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const entries = Object.entries(v);
  if (!entries.every(([name, count]) => RESOURCE_NAME_PATTERN.test(name) && typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= MAX_RESOURCE_SLOTS)) return undefined;
  return Object.fromEntries(entries);
}

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
export function watchConfig(home: string, agent: AgentKind, log: Logger, onChange: (cfg: BridgeConfig) => void, projectDir?: string | (() => string)): () => void {
  const path = join(home, CONFIG_FILE_NAME);
  let local = typeof projectDir === "function" ? projectDir() : projectDir;
  let localPath = local ? join(local, ".agent-bridge", CONFIG_FILE_NAME) : null;
  const listener = (cur: { mtimeMs: number }, prev: { mtimeMs: number }) => {
    if (cur.mtimeMs === prev.mtimeMs) return;
    log.info("config file changed; applying it", { path });
    onChange(loadConfig(home, agent, log, process.env, local));
  };
  watchFile(path, { interval: CONFIG_POLL_MS, persistent: false }, listener);
  if (localPath) watchFile(localPath, { interval: CONFIG_POLL_MS, persistent: false }, listener);
  const timer = typeof projectDir === "function" ? setInterval(() => {
    const next = projectDir();
    if (next === local) return;
    if (localPath) unwatchFile(localPath, listener);
    local = next; localPath = join(next, ".agent-bridge", CONFIG_FILE_NAME);
    watchFile(localPath, { interval: CONFIG_POLL_MS, persistent: false }, listener);
    onChange(loadConfig(home, agent, log, process.env, local));
  }, CONFIG_POLL_MS) : null;
  timer?.unref();
  return () => { unwatchFile(path, listener); if (localPath) unwatchFile(localPath, listener); if (timer) clearInterval(timer); };
}

/** Set one top-level value in config.json, keeping the rest of the file. */
export function saveConfigValue(home: string, key: string, value: unknown): void {
  const path = join(home, CONFIG_FILE_NAME);
  const previous = readJsonStore(path);
  const file = isRecord(previous) ? previous : {};
  writeJsonStore(path, { ...file, [key]: value }, previous);
}

/** Config file (~/.agent-bridge/config.json) with optional per-agent sections, overridden by env vars. */
export function loadConfig(home: string, agent: AgentKind, log: Logger, env: NodeJS.ProcessEnv = process.env, projectDir?: string): BridgeConfig {
  let file: Record<string, unknown> = {};
  const path = join(home, CONFIG_FILE_NAME);
  try {
    file = (readJsonStore(path, log) ?? {}) as Record<string, unknown>;
    log.debug("config file loaded", { path });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn("ignoring unreadable config file", { path, err: (err as Error).message });
  }
  let project: Record<string, unknown> = {};
  if (projectDir) {
    const localPath = join(projectDir, ".agent-bridge", CONFIG_FILE_NAME);
    try { const value: unknown = JSON.parse(readFileSync(localPath, "utf8")); if (isRecord(value)) project = value; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn("ignoring unreadable project config", { path: localPath, err: String(err) }); }
  }
  const section = isRecord(file[agent]) ? file[agent] : {};
  const localSection = isRecord(project[agent]) ? project[agent] : {};
  for (const values of [localSection,project]) if (values.codexSubagents===undefined && values.native_subagents!==undefined) values.codexSubagents=typeof values.native_subagents === "boolean" ? (values.native_subagents ? DEFAULT_CODEX_SUBAGENTS : 0) : values.native_subagents;
  /** First valid value wins: env var, then the agent section, then the top level of the file. */
  const pick = <T>(key: keyof BridgeConfig, envKey: string | null, parse: (v: unknown) => T | undefined): T | undefined => {
    for (const v of [envKey ? env[envKey] : undefined, localSection[key], project[key], section[key], file[key]]) {
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
    projectGroups: [localSection.projectGroups, project.projectGroups, section.projectGroups, file.projectGroups].find((v) => v !== undefined) === undefined ? true : [localSection.projectGroups, project.projectGroups, section.projectGroups, file.projectGroups].find((v) => v !== undefined) === true,
    name: pick("name", ENV.name, str) ?? d.name,
    autoWake: pick("autoWake", ENV.autoWake, parseBool) ?? d.autoWake,
    wakeOnDirect: pick("wakeOnDirect", ENV.wakeOnDirect, parseBool) ?? d.wakeOnDirect,
    maxHops: pick("maxHops", ENV.maxHops, (v) => parseIntInRange(v, 0, MAX_HOPS_LIMIT)) ?? d.maxHops,
    maxJobs: pick("maxJobs", ENV.maxJobs, (v) => parseIntInRange(v, 1, MAX_JOBS_LIMIT)) ?? d.maxJobs,
    maxDelegateDepth: pick("maxDelegateDepth", ENV.maxDelegateDepth, (v) => parseIntInRange(v, 1, MAX_DELEGATE_DEPTH_LIMIT)) ?? d.maxDelegateDepth,
    autoApproveTools: pick("autoApproveTools", ENV.autoApproveTools, toolPatterns) ?? d.autoApproveTools,
    // Capacities must agree across agents; per-agent sections cannot override shared resources.
    resourceSlots: resourceSlots(file.resourceSlots) ?? d.resourceSlots,
    delivery: pick("delivery", ENV.delivery, (v) => oneOf(v, DELIVERY_MODES)) ?? d.delivery,
    claudeBin: pick("claudeBin", ENV.claudeBin, str) ?? d.claudeBin,
    codexBin: pick("codexBin", ENV.codexBin, str) ?? d.codexBin,
    codexWakeRemote: pick("codexWakeRemote", "AGENT_BRIDGE_CODEX_WAKE_REMOTE", str) ?? null,
    codexWakeRemoteAuthTokenEnv: pick("codexWakeRemoteAuthTokenEnv", "AGENT_BRIDGE_CODEX_WAKE_REMOTE_AUTH_TOKEN_ENV", str) ?? null,
    codexSubagents: pick("codexSubagents", null, (v) => {
      const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
      return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_CODEX_SUBAGENTS ? n : undefined;
    }) ?? d.codexSubagents,
    codexSandbox: pick("codexSandbox", null, (v) => oneOf(v, CODEX_SANDBOXES)) ?? d.codexSandbox,
    codexWindowsSandbox: pick("codexWindowsSandbox", null, (v) => oneOf(v, ["unelevated", "elevated"] as const)) ?? d.codexWindowsSandbox,
    jobCloseCleanup: pick("jobCloseCleanup", null, parseBool) ?? d.jobCloseCleanup,
    codexApprovalsReviewer: pick("codexApprovalsReviewer", null, (v) => oneOf(v, CODEX_APPROVALS_REVIEWERS)) ?? d.codexApprovalsReviewer,
    codexWorktreeSandbox: pick("codexWorktreeSandbox", null, (v) => oneOf(v, CODEX_SANDBOXES)) ?? d.codexWorktreeSandbox,
    codexWorkspaceWriteNetworkAccess: pick("codexWorkspaceWriteNetworkAccess", null, parseBool) ?? d.codexWorkspaceWriteNetworkAccess,
    claudePermissionMode: pick("claudePermissionMode", null, (v) => oneOf(v, CLAUDE_PERMISSION_MODES)) ?? d.claudePermissionMode,
    lingerSec: pick("lingerSec", ENV.lingerSec, (v) => parseIntInRange(v, 0, MAX_LINGER_SEC)) ?? d.lingerSec,
    codexModel: pick("codexModel", null, modelName) ?? d.codexModel,
    claudeModel: pick("claudeModel", null, modelName) ?? d.claudeModel,
    opencodeBin: pick("opencodeBin", ENV.opencodeBin, str) ?? d.opencodeBin,
    antigravityBin: pick("antigravityBin", "AGENT_BRIDGE_ANTIGRAVITY_BIN", str) ?? d.antigravityBin,
    antigravityModel: pick("antigravityModel", null, modelName) ?? d.antigravityModel,
    opencodeModel: pick("opencodeModel", null, modelName) ?? d.opencodeModel,
    effort: Object.assign({}, d.effort, ...[file, section, project, localSection].map((values) => effortLevels(values.effort) ?? {})),
    opencodeAutoApprove: pick("opencodeAutoApprove", null, parseBool) ?? d.opencodeAutoApprove,
    dashboard: pick("dashboard", ENV.dashboard, parseBool) ?? d.dashboard,
    dashboardPort: pick("dashboardPort", null, (v) => parseIntInRange(v, 1, 65_535)) ?? d.dashboardPort,
    historyAnswer: pick("historyAnswer", null, historyAnswer) ?? d.historyAnswer,
    notifications: pick("notifications", null, notifications) ?? d.notifications,
    network: pick("network", null, parseNetworkConfig) ?? d.network,
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
