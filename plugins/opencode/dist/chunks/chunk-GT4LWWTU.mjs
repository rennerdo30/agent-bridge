import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  AGENT_KINDS,
  CODING_AGENTS
} from "./chunk-4QXHCXBU.mjs";
import {
  DEFAULT_QUESTION_ALERTS,
  questionAlertSettingsSchema
} from "./chunk-FVGCFSLA.mjs";
import {
  external_exports
} from "./chunk-FDMEMG4Z.mjs";
import {
  isRecord,
  mergeStoreFields,
  readJsonStore,
  writeJsonStore
} from "./chunk-NYEIO7DU.mjs";
import {
  CONFIG_FILE_NAME,
  DEFAULT_CLAUDE_BIN,
  DEFAULT_CODEX_BIN,
  DEFAULT_CODEX_SUBAGENTS,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_LINGER_SEC,
  DEFAULT_MAX_DELEGATE_DEPTH,
  DEFAULT_MAX_HOPS,
  DEFAULT_MAX_JOBS,
  DEFAULT_OPENCODE_BIN,
  ENV,
  MAX_CODEX_SUBAGENTS,
  MAX_DELEGATE_DEPTH_LIMIT,
  MAX_JOBS_LIMIT
} from "./chunk-7EOIPV3B.mjs";

// src/network/constants.ts
var NETWORK_VERSION = 1;
var DEFAULT_NETWORK_PORT = 48148;
var DISCOVERY_PORT = 48149;
var DISCOVERY_GROUP = "239.255.48.49";
var DISCOVERY_BIND = "0.0.0.0";
var DISCOVERY_MULTICAST_TTL = 1;
var DISCOVERY_INTERVAL_MS = 5e3;
var DISCOVERY_TTL_MS = 2e4;
var MAX_DISCOVERY_BYTES = 1024;
var MAX_DISCOVERED_INSTANCES = 128;
var MAX_NETWORK_PEERS = 256;
var MAX_NETWORK_LINKS = 16;
var MAX_NETWORK_FRAME_BYTES = 2 * 1024 * 1024;
var MAX_NETWORK_REQUESTS = 64;
var NETWORK_TIMEOUT_MS = 5e3;
var NETWORK_REFRESH_MS = 2e3;
var NETWORK_HEARTBEAT_TIMEOUT_MS = 3e4;
var PAIRING_TTL_MS = 10 * 60 * 1e3;
var PAIRING_KEY_BYTES = 32;
var MAX_PAIRING_CODE_CHARS = 1024;
var NETWORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var MAX_NETWORK_NAME_CHARS = 64;
var MAX_NETWORK_HOST_CHARS = 255;
var MAX_PORT = 65535;
var TLS_CIPHER = "TLS_AES_128_GCM_SHA256";
var OWNER_FILE_MODE = 384;
var OWNER_DIR_MODE = 448;

// src/network/config.ts
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
var MAX_FETCH_ROOT_CHARS = 1024;
var MAX_FETCH_ROOTS = 128;
var networkConfigSchema = external_exports.object({
  enabled: external_exports.boolean().default(false),
  name: external_exports.string().regex(NETWORK_NAME_PATTERN).default(hostname().replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, MAX_NETWORK_NAME_CHARS) || "host"),
  bind: external_exports.string().min(1).max(MAX_NETWORK_HOST_CHARS).default("127.0.0.1"),
  port: external_exports.number().int().min(0).max(MAX_PORT).default(DEFAULT_NETWORK_PORT),
  discovery: external_exports.boolean().default(false),
  remoteJobs: external_exports.object({
    enabled: external_exports.boolean().default(false),
    allowRoots: external_exports.array(external_exports.string().min(1).max(4096)).max(50).default([]),
    agents: external_exports.array(external_exports.enum(CODING_AGENTS)).max(3).default([]),
    /** Pair names explicitly permitted to request jobs; no pair is trusted implicitly. */
    allowPeers: external_exports.array(external_exports.string().regex(NETWORK_NAME_PATTERN)).max(50).default([])
  }).default({ enabled: false, allowRoots: [], agents: [], allowPeers: [] }),
  maxTransferBytes: external_exports.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  fetchRoots: external_exports.array(external_exports.string().min(1).max(MAX_FETCH_ROOT_CHARS).refine(isAbsolute, "fetch roots must be absolute paths")).max(MAX_FETCH_ROOTS).optional()
});
var DEFAULT_NETWORK_CONFIG = networkConfigSchema.parse({});
function parseNetworkConfig(value) {
  const result = networkConfigSchema.safeParse(value);
  return result.success ? result.data : void 0;
}
function readNetworkConfig(home, fallback) {
  try {
    const value = JSON.parse(readFileSync(join(home, CONFIG_FILE_NAME), "utf8"));
    return isRecord(value) ? parseNetworkConfig(value.network) ?? fallback : fallback;
  } catch {
    return fallback;
  }
}
function writeNetworkConfig(home, value) {
  const config = networkConfigSchema.parse(value);
  const path = join(home, CONFIG_FILE_NAME);
  const previous = readJsonStore(path);
  writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { network: config }), previous);
  return config;
}

// src/core/config.ts
import { readFileSync as readFileSync2, unwatchFile, watchFile } from "node:fs";
import { basename, join as join2, isAbsolute as isAbsolute2 } from "node:path";
var DELIVERY_MODES = ["auto", "channel", "hooks"];
var CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];
var CODEX_APPROVALS_REVIEWERS = ["user", "auto_review"];
var DEFAULT_CODEX_APPROVALS_REVIEWER = "auto_review";
var CLAUDE_PERMISSION_MODES = ["default", "manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];
var DEFAULT_NOTIFICATIONS = { approvals: true, finish: true, fail: true };
var DEFAULT_HISTORY_ANSWER = { preference: ["codex", "claude", "opencode"], claudeModel: "haiku", codexModel: "gpt-6-luna", opencodeModel: null };
var DEFAULT_CONFIG = {
  history: { ingest: true, budgetBytes: 32 * 1024 ** 3 },
  questionAlerts: DEFAULT_QUESTION_ALERTS,
  projectGroups: true,
  historyAnswer: DEFAULT_HISTORY_ANSWER,
  name: null,
  worktreeRoot: null,
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
  network: DEFAULT_NETWORK_CONFIG
};
var TRUE_VALUES = /* @__PURE__ */ new Set(["1", "true", "yes", "on"]);
var FALSE_VALUES = /* @__PURE__ */ new Set(["0", "false", "no", "off"]);
function parseBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return void 0;
  const s = v.trim().toLowerCase();
  if (TRUE_VALUES.has(s)) return true;
  if (FALSE_VALUES.has(s)) return false;
  return void 0;
}
function historyAnswer(v) {
  if (!isRecord(v)) return void 0;
  const agents = ["claude", "codex", "opencode"];
  if (v.preference !== void 0 && (!Array.isArray(v.preference) || !v.preference.length || !v.preference.every((a) => agents.includes(String(a))))) return void 0;
  const out = { ...DEFAULT_HISTORY_ANSWER, preference: [...DEFAULT_HISTORY_ANSWER.preference] };
  if (Array.isArray(v.preference)) out.preference = [...new Set(v.preference)];
  for (const key of ["claudeModel", "codexModel", "opencodeModel"]) {
    if (v[key] === void 0) continue;
    if (key === "opencodeModel" && v[key] === null) {
      out.opencodeModel = null;
      continue;
    }
    const model = modelName(v[key]);
    if (!model) return void 0;
    out[key] = model;
  }
  return out;
}
function notifications(v) {
  if (!isRecord(v)) return void 0;
  const out = { ...DEFAULT_NOTIFICATIONS };
  for (const key of Object.keys(out)) {
    if (v[key] === void 0) continue;
    const value = parseBool(v[key]);
    if (value === void 0) return void 0;
    out[key] = value;
  }
  return out;
}
function parseIntInRange(v, min, max) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : void 0;
}
function oneOf(v, allowed) {
  return typeof v === "string" && allowed.includes(v) ? v : void 0;
}
var MAX_HOPS_LIMIT = 100;
var MAX_LINGER_SEC = 3600;
var RESOURCE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
var MAX_RESOURCE_SLOTS = 100;
function resourceSlots(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return void 0;
  const entries = Object.entries(v);
  if (!entries.every(([name, count]) => RESOURCE_NAME_PATTERN.test(name) && typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= MAX_RESOURCE_SLOTS)) return void 0;
  return Object.fromEntries(entries);
}
var MODEL_NAME_PATTERN = /^[^\s"'`&|<>^%$;()]{1,200}$/;
function modelName(v) {
  return typeof v === "string" && MODEL_NAME_PATTERN.test(v.trim()) ? v.trim() : void 0;
}
var EFFORT_NAME = /^[A-Za-z0-9_-]{1,20}$/;
function effortLevels(v) {
  if (typeof v === "string" && EFFORT_NAME.test(v)) return Object.fromEntries(AGENT_KINDS.map((k) => [k, v]));
  if (!v || typeof v !== "object" || Array.isArray(v)) return void 0;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (AGENT_KINDS.includes(k) && typeof x === "string" && EFFORT_NAME.test(x)) out[k] = x;
  return out;
}
function toolPatterns(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!list || !list.every((x) => typeof x === "string")) return void 0;
  return list.map((x) => x.trim()).filter(Boolean);
}
var CONFIG_POLL_MS = 2e3;
function watchConfig(home, agent, log, onChange, projectDir) {
  const path = join2(home, CONFIG_FILE_NAME);
  let local = typeof projectDir === "function" ? projectDir() : projectDir;
  let localPath = local ? join2(local, ".agent-bridge", CONFIG_FILE_NAME) : null;
  const listener = (cur, prev) => {
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
    local = next;
    localPath = join2(next, ".agent-bridge", CONFIG_FILE_NAME);
    watchFile(localPath, { interval: CONFIG_POLL_MS, persistent: false }, listener);
    onChange(loadConfig(home, agent, log, process.env, local));
  }, CONFIG_POLL_MS) : null;
  timer?.unref();
  return () => {
    unwatchFile(path, listener);
    if (localPath) unwatchFile(localPath, listener);
    if (timer) clearInterval(timer);
  };
}
function saveConfigValue(home, key, value) {
  const path = join2(home, CONFIG_FILE_NAME);
  const previous = readJsonStore(path);
  const file = isRecord(previous) ? previous : {};
  writeJsonStore(path, { ...file, [key]: value }, previous);
}
var PROJECT_CONFIG_KEYS = /* @__PURE__ */ new Set([
  "projectGroups",
  "codexSubagents",
  "native_subagents",
  "effort",
  "name",
  "codexModel",
  "claudeModel",
  "opencodeModel",
  "antigravityModel",
  "autoWake",
  "wakeOnDirect",
  "delivery",
  "lingerSec",
  "maxHops"
]);
function projectOverrides(values, ignored, sections = false) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (PROJECT_CONFIG_KEYS.has(key) || sections && AGENT_KINDS.includes(key)) out[key] = value;
    else ignored.add(key);
  }
  return out;
}
function loadConfig(home, agent, log, env = process.env, projectDir) {
  let file = {};
  const path = join2(home, CONFIG_FILE_NAME);
  try {
    file = readJsonStore(path, log) ?? {};
    log.debug("config file loaded", { path });
  } catch (err) {
    if (err.code !== "ENOENT") log.warn("ignoring unreadable config file", { path, err: err.message });
  }
  let project = {};
  if (projectDir) {
    const localPath = join2(projectDir, ".agent-bridge", CONFIG_FILE_NAME);
    try {
      const value = JSON.parse(readFileSync2(localPath, "utf8"));
      if (isRecord(value)) project = value;
    } catch (err) {
      if (err.code !== "ENOENT") log.warn("ignoring unreadable project config", { path: localPath, err: String(err) });
    }
  }
  const ignored = /* @__PURE__ */ new Set();
  project = projectOverrides(project, ignored, true);
  const section = isRecord(file[agent]) ? file[agent] : {};
  const localSection = isRecord(project[agent]) ? projectOverrides(project[agent], ignored) : {};
  for (const kind of AGENT_KINDS) if (kind !== agent && isRecord(project[kind])) projectOverrides(project[kind], ignored);
  if (ignored.size && projectDir) log.warn("ignoring project config keys that only the home config may set", { project: projectDir, keys: [...ignored].sort() });
  for (const values of [localSection, project]) if (values.codexSubagents === void 0 && values.native_subagents !== void 0) values.codexSubagents = typeof values.native_subagents === "boolean" ? values.native_subagents ? DEFAULT_CODEX_SUBAGENTS : 0 : values.native_subagents;
  const pick = (key, envKey, parse) => {
    for (const v of [envKey ? env[envKey] : void 0, localSection[key], project[key], section[key], file[key]]) {
      if (v === void 0) continue;
      const parsed = parse(v);
      if (parsed !== void 0) return parsed;
      log.warn("ignoring invalid config value", { key, value: String(v) });
    }
    return void 0;
  };
  const str = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
  const d = DEFAULT_CONFIG;
  const cfg = {
    history: {
      ingest: env.AGENT_BRIDGE_HISTORY_INGEST === "false" || env.AGENT_BRIDGE_HISTORY_INGEST === "0" ? false : !(isRecord(file.history) && file.history.ingest === false),
      budgetBytes: isRecord(file.history) && Number.isSafeInteger(file.history.budgetBytes) && Number(file.history.budgetBytes) >= 0 ? Number(file.history.budgetBytes) : d.history.budgetBytes
    },
    projectGroups: [localSection.projectGroups, project.projectGroups, section.projectGroups, file.projectGroups].find((v) => v !== void 0) === void 0 ? true : [localSection.projectGroups, project.projectGroups, section.projectGroups, file.projectGroups].find((v) => v !== void 0) === true,
    name: pick("name", ENV.name, str) ?? d.name,
    worktreeRoot: pick("worktreeRoot", "AGENT_BRIDGE_WORKTREE_ROOT", (v) => typeof v === "string" && isAbsolute2(v) ? v : void 0) ?? d.worktreeRoot,
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
      return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_CODEX_SUBAGENTS ? n : void 0;
    }) ?? d.codexSubagents,
    codexSandbox: pick("codexSandbox", null, (v) => oneOf(v, CODEX_SANDBOXES)) ?? d.codexSandbox,
    codexWindowsSandbox: pick("codexWindowsSandbox", null, (v) => oneOf(v, ["unelevated", "elevated"])) ?? d.codexWindowsSandbox,
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
    dashboardPort: pick("dashboardPort", null, (v) => parseIntInRange(v, 1, 65535)) ?? d.dashboardPort,
    historyAnswer: pick("historyAnswer", null, historyAnswer) ?? d.historyAnswer,
    notifications: pick("notifications", null, notifications) ?? d.notifications,
    questionAlerts: pick("questionAlerts", null, (v) => questionAlertSettingsSchema.safeParse(isRecord(v) ? { ...DEFAULT_QUESTION_ALERTS, ...v } : v).data) ?? d.questionAlerts,
    network: pick("network", null, parseNetworkConfig) ?? d.network
  };
  log.debug("effective config", { ...cfg });
  return cfg;
}
function parseAgentKind(v) {
  return oneOf(v?.trim().toLowerCase(), AGENT_KINDS) ?? "other";
}
function defaultPeerName(agent, cwd) {
  const folder = basename(cwd).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+/, "").slice(0, 40);
  return `${agent}-${folder || "session"}`;
}

export {
  NETWORK_VERSION,
  DEFAULT_NETWORK_PORT,
  DISCOVERY_PORT,
  DISCOVERY_GROUP,
  DISCOVERY_BIND,
  DISCOVERY_MULTICAST_TTL,
  DISCOVERY_INTERVAL_MS,
  DISCOVERY_TTL_MS,
  MAX_DISCOVERY_BYTES,
  MAX_DISCOVERED_INSTANCES,
  MAX_NETWORK_PEERS,
  MAX_NETWORK_LINKS,
  MAX_NETWORK_FRAME_BYTES,
  MAX_NETWORK_REQUESTS,
  NETWORK_TIMEOUT_MS,
  NETWORK_REFRESH_MS,
  NETWORK_HEARTBEAT_TIMEOUT_MS,
  PAIRING_TTL_MS,
  PAIRING_KEY_BYTES,
  MAX_PAIRING_CODE_CHARS,
  NETWORK_NAME_PATTERN,
  MAX_NETWORK_HOST_CHARS,
  MAX_PORT,
  TLS_CIPHER,
  OWNER_FILE_MODE,
  OWNER_DIR_MODE,
  networkConfigSchema,
  readNetworkConfig,
  writeNetworkConfig,
  CODEX_SANDBOXES,
  CODEX_APPROVALS_REVIEWERS,
  DEFAULT_CODEX_APPROVALS_REVIEWER,
  CLAUDE_PERMISSION_MODES,
  DEFAULT_CONFIG,
  RESOURCE_NAME_PATTERN,
  MODEL_NAME_PATTERN,
  watchConfig,
  saveConfigValue,
  loadConfig,
  parseAgentKind,
  defaultPeerName
};
