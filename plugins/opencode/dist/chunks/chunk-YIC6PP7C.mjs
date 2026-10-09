import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  ResourceSlots
} from "./chunk-A2SWCN6M.mjs";
import {
  bundleDirectory
} from "./chunk-D5ZW6VFT.mjs";
import {
  completionMessageId
} from "./chunk-JTZGNEMM.mjs";
import {
  isPureAcknowledgement
} from "./chunk-7OVAI3PR.mjs";
import {
  tokensEqual
} from "./chunk-PCXGTT2Z.mjs";
import {
  archiveJobs,
  drainScanResponsive,
  findHistoryJob,
  historyJobsSteps,
  readArchivedJobSnapshot,
  readArchivedJobs,
  readHistoryJson,
  readRunLogs,
  readRunLogsResponsive,
  recordAskCompletion
} from "./chunk-2KLFTBBJ.mjs";
import {
  ARCHIVE_AGE_ENV,
  DEFAULT_ARCHIVE_AGE_MS
} from "./chunk-ETHEYCLK.mjs";
import {
  canonicalProjectRoot,
  migrateProjectJobs,
  object,
  parse,
  safeFile
} from "./chunk-CUZHUOFY.mjs";
import {
  CLAUDE_PERMISSION_MODES,
  CODEX_APPROVALS_REVIEWERS,
  CODEX_SANDBOXES,
  DEFAULT_CODEX_APPROVALS_REVIEWER,
  MODEL_NAME_PATTERN,
  loadConfig
} from "./chunk-QI6BOSWF.mjs";
import {
  ACK_CONVERSATION_SUFFIX,
  AGENT_KINDS,
  isQuietMessage
} from "./chunk-L3WJOWYS.mjs";
import {
  external_exports
} from "./chunk-FDMEMG4Z.mjs";
import {
  JSON_STORE_VERSION,
  archiveFile,
  assertStoreUpgrade,
  assertWritableStore,
  backupPath,
  cloneJson,
  configureSqlite,
  indexedJobProjectionCurrent,
  isRecord,
  isSqliteBusy,
  mergeStoreFields,
  metadataFileLease,
  readIndexedJobs,
  readJsonSnapshot,
  readJsonStore,
  readProcessIdentity,
  refreshStorePeerIdentities,
  retainBackups,
  retentionLimit,
  writeJsonStore
} from "./chunk-EVPBD2NK.mjs";
import {
  assertUnlinked,
  selectedWorker
} from "./chunk-SFW3GO73.mjs";
import {
  APP_VERSION,
  DEFAULT_CODEX_SUBAGENTS,
  DEFAULT_MAX_DELEGATE_DEPTH,
  DEFAULT_MAX_JOBS,
  DELEGATION_METADATA_VERSION,
  ENV,
  JOBS_FILE,
  MAX_BODY_CHARS,
  MAX_CODEX_SUBAGENTS,
  MAX_DELEGATE_DEPTH_LIMIT
} from "./chunk-7EOIPV3B.mjs";

// src/core/job-ownership.ts
function text(value) {
  return typeof value === "string" && value ? value : void 0;
}
function primaryFor(job) {
  return (!job.parentJob && (!Array.isArray(job.ownershipHistory) || !job.ownershipHistory.length) ? text(job.owner) : void 0) ?? text(job.rootName) ?? text(job.owner) ?? "";
}
function mastersFor(job) {
  const history = Array.isArray(job.ownershipHistory) ? job.ownershipHistory : [];
  const names = [
    job.parentJob || !text(job.owner) || history.length ? text(job.rootName) : void 0,
    !job.parentJob ? text(job.owner) : void 0,
    ...Array.isArray(job.masters) ? job.masters.filter((v) => typeof v === "string") : [],
    ...history.flatMap((h) => h && typeof h === "object" ? [text(h.fromRootName), text(h.rootName), !job.parentJob ? text(h.from) : void 0, !job.parentJob ? text(h.to) : void 0] : [])
  ];
  return [...new Set(names.filter((v) => Boolean(v) && !v.includes("/")))];
}
function canControlJob(job, name, groupMasters = []) {
  return !name.includes("/") && (mastersFor(job).includes(name) || groupMasters.some((p) => p.name === name && !p.host && !p.jobAgent && !p.subagent));
}
function chooseJobRecipient(job, livePeers, groupMasters = []) {
  const primary = primaryFor(job);
  const live = new Set(livePeers.filter((p) => !p.host && !p.jobAgent && !p.subagent && !p.unavailable && !p.name.includes("/")).map((p) => p.name));
  if (live.has(primary)) return primary;
  const history = Array.isArray(job.ownershipHistory) ? job.ownershipHistory : [];
  const previous = history.slice().reverse().flatMap((h) => h && typeof h === "object" ? [text(h.fromRootName), !job.parentJob ? text(h.from) : void 0] : []);
  const grants = mastersFor(job).slice().reverse();
  const group = [...groupMasters].sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name));
  return [...previous, ...grants, ...group.map((p) => p.name)].find((name) => name && live.has(name)) ?? primary;
}

// src/core/worktree-processes.ts
import { execFile } from "node:child_process";
import { readdir, readlink } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
var exec = promisify(execFile);
async function worktreeProcesses(path, exclude = [process.pid]) {
  const root = resolve(path);
  try {
    if (process.platform === "win32") {
      const literal = root.replaceAll("'", "''");
      const script = `$root='${literal}'; @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {$_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0} | ForEach-Object { $identity=$null;try{$identity=[string](Get-Process -Id $_.ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().Ticks}catch{}; @{pid=[int]$_.ProcessId;identity=$identity;name=$_.Name} }) | ConvertTo-Json -Compress`;
      const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 1e4, maxBuffer: 1024 * 1024 });
      const value = JSON.parse(stdout || "[]");
      const rows = Array.isArray(value) ? value : [value];
      return { processes: rows.filter((p) => Number.isSafeInteger(p.pid) && p.pid > 0 && !exclude.includes(p.pid) && p.name !== "powershell.exe"), complete: true };
    }
    if (process.platform === "linux") {
      const processes = [];
      for (const name of await readdir("/proc")) {
        const pid = Number(name);
        if (!pid || exclude.includes(pid)) continue;
        try {
          const cwd = await readlink("/proc/" + pid + "/cwd");
          if (cwd === root || cwd.startsWith(root + sep)) processes.push({ pid, identity: await readProcessIdentity(pid), name: "process with matching cwd" });
        } catch {
        }
      }
      return { processes, complete: false };
    }
  } catch {
  }
  return { processes: [], complete: false };
}
function worktreeProcessReport(evidence) {
  return "Worktree process evidence (association only; no termination attempted): " + (evidence.processes.length ? evidence.processes.map((p) => `PID ${p.pid}, ${p.name}, creation identity ${p.identity ?? "unknown"}`).join("; ") : "no associated process observed") + ". " + (evidence.complete ? "Command-line association checked; open handles and unmentioned cwd remain unknown." : "Probe incomplete; surviving background processes may remain.") + " Supervisor review required before cleanup.";
}

// src/core/context-journal.ts
import { appendFile, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
var writes = /* @__PURE__ */ new Map();
async function appendContextEvent(home, event) {
  const dir = join(home, "context-events");
  const file = join(
    dir,
    `${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}-${process.pid}.jsonl`
  );
  const write = (writes.get(file) ?? Promise.resolve()).catch(() => {
  }).then(async () => {
    await mkdir(dir, { recursive: true, mode: 448 });
    try {
      const fd2 = await open(file, "wx", 384);
      try {
        await fd2.writeFile('{"version":1,"format":"context-events"}\n');
        await fd2.sync();
      } finally {
        await fd2.close();
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    await appendFile(
      file,
      JSON.stringify({ ...event, at: event.at ?? Date.now() }) + "\n"
    );
    const fd = await open(file, "a");
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  });
  writes.set(file, write);
  try {
    await write;
  } finally {
    if (writes.get(file) === write) writes.delete(file);
  }
}

// src/mcp/jobs.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { setTimeout as delay3 } from "node:timers/promises";
import { isDeepStrictEqual as isDeepStrictEqual2 } from "node:util";
import { closeSync as closeSync2, constants as fsConstants, copyFileSync, fsyncSync as fsyncSync2, openSync as openSync2 } from "node:fs";
import { dirname as dirname4 } from "node:path";

// src/core/codex-subagents.ts
function codexSubagentConfig(count = DEFAULT_CODEX_SUBAGENTS) {
  if (!Number.isInteger(count) || count < 0 || count > MAX_CODEX_SUBAGENTS) throw new Error(`native_subagents must be an integer from 0 to ${MAX_CODEX_SUBAGENTS}`);
  return {
    "features.multi_agent": count > 0,
    // V2 takes precedence over agents.enabled. Clear an inherited V2 table (including its cap).
    // If the model selects V2, it derives its cap from agents.max_threads plus the coordinator.
    "features.multi_agent_v2": false,
    "agents.enabled": count > 0,
    // Codex rejects zero here even when the feature is disabled.
    "agents.max_threads": Math.max(1, count)
  };
}

// src/core/codex-env.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
function codexWindowsSandbox(home = homedir(), platform = process.platform) {
  if (platform !== "win32") return null;
  let toml;
  try {
    toml = readFileSync(join2(home, ".codex", "config.toml"), "utf8");
  } catch {
    return null;
  }
  const table = /^\[windows\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? "";
  return /^\s*sandbox\s*=\s*"([^"]+)"/m.exec(table)?.[1] ?? null;
}
function codexEnvironmentNote(home = homedir(), platform = process.platform) {
  if (platform !== "win32") return "";
  const elevated = codexWindowsSandbox(home, platform) === "elevated";
  return ` On Windows, danger-full-access executes as the bridge process user, normally the logged-in user, even when windows.sandbox is elevated. Sandboxed jobs may lack USB/adb or user-profile access; use danger-full-access when authorized, or a claude/opencode subagent for device work. An empty adb list does not prove no device is connected: verify whoami and the adb executable/server first. If running as the sandbox user, report "can't see devices from the sandbox".` + (elevated ? ` This machine uses a separate Windows sandbox user for sandboxed commands (elevated sandbox), which cannot read the user's profile. Tools installed there, such as Python under AppData\\Local\\Programs or user-level pip/npm installs, are unavailable to that user ("python is not recognized"). For sandboxed work that needs them, point Codex to an interpreter inside the repository (e.g. a .venv in the worktree), or use a claude/opencode subagent.` : "");
}
function codexExecutionPrompt(prompt, sandbox, platform = process.platform) {
  if (platform !== "win32") return prompt;
  return `${prompt}

(Windows device probes: ${sandbox === "danger-full-access" ? "Full-access commands should run as the bridge process user; verify with whoami before device work." : "Sandboxed commands may run as a separate user without USB/adb or user-profile access; verify with whoami."} An empty adb devices result is not proof that no device is connected. Check the adb executable and server context. If the command runs as the sandbox user, report "can't see devices from the sandbox" and ask the supervisor to use an authorized full-access job or a claude/opencode subagent for device work. Do not change permissions or switch users yourself.)`;
}

// src/core/job-environment.ts
function jobEnvironment(env = process.env, platform = process.platform) {
  const result = { ...env };
  const defaults = { DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: "0", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1" };
  for (const [key, value] of Object.entries(defaults)) {
    const present = Object.hasOwn(env, key) || platform === "win32" && Object.keys(env).some((existing) => existing.toUpperCase() === key);
    if (!present) result[key] = value;
  }
  return result;
}

// src/core/delegate.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync as readFileSync3, realpathSync as realpathSync2 } from "node:fs";
import { delimiter, extname, isAbsolute, join as join4, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// src/core/claude-mcp.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3, resolve as resolve2 } from "node:path";
var OWN_SERVER_RULE = "mcp__plugin_agent-bridge_bridge";
var ACCOUNT_CONNECTORS_RULE = "mcp__claude_ai_*";
var BUILT_IN_RULES = ["mcp__claude-in-chrome"];
function readJson(path) {
  try {
    return JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    return null;
  }
}
function serverNames(mcp) {
  return mcp && typeof mcp === "object" ? Object.keys(mcp) : [];
}
function pluginServers(home) {
  const installed = readJson(join3(home, ".claude", "plugins", "installed_plugins.json"));
  const out = [];
  for (const [key, entries] of Object.entries(installed?.plugins ?? {})) {
    const plugin = key.split("@")[0];
    for (const e of Array.isArray(entries) ? entries : [entries]) {
      const root = e?.installPath;
      if (typeof root !== "string") continue;
      const manifest = readJson(join3(root, ".claude-plugin", "plugin.json"));
      const declared = manifest?.mcpServers;
      const servers = typeof declared === "string" ? readJson(resolve2(root, declared))?.mcpServers ?? readJson(resolve2(root, declared)) : declared;
      const names = /* @__PURE__ */ new Set([...serverNames(servers), ...serverNames(readJson(join3(root, ".mcp.json"))?.mcpServers)]);
      for (const s of names) out.push(`mcp__plugin_${plugin}_${s}`);
    }
  }
  return out;
}
function claudeMcpDenyRules(cwd, home = homedir2()) {
  const config = readJson(join3(home, ".claude.json"));
  const norm = (p) => resolve2(p).replace(/\\/g, "/").toLowerCase();
  const project = Object.entries(config?.projects ?? {}).find(([p]) => norm(p) === norm(cwd))?.[1];
  const names = [
    ...pluginServers(home),
    ...serverNames(config?.mcpServers).map((s) => `mcp__${s}`),
    ...serverNames(project?.mcpServers).map((s) => `mcp__${s}`),
    ...serverNames(readJson(join3(cwd, ".mcp.json"))?.mcpServers).map((s) => `mcp__${s}`),
    ACCOUNT_CONNECTORS_RULE,
    ...BUILT_IN_RULES
  ];
  return [...new Set(names)].filter((n) => n !== OWN_SERVER_RULE);
}

// src/core/parent-link.ts
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
var PARENT_URL_ENV = "AGENT_BRIDGE_PARENT_URL";
var PARENT_TOKEN_ENV = "AGENT_BRIDGE_PARENT_TOKEN";
var PARENT_NAME_ENV = "AGENT_BRIDGE_PARENT_NAME";
var HOST = "127.0.0.1";
var SECRET_BYTES = 24;
var MAX_REQUEST_BYTES = 256 * 1024;
var MAX_NOTE_CHARS = 200;
var CHILD_REQUEST_TIMEOUT_MS = 5e3;
var ParentLink = class {
  constructor(parentName, onMessage, log, onProgress = () => {
  }, siblings, onEscalate) {
    this.parentName = parentName;
    this.onMessage = onMessage;
    this.log = log;
    this.onProgress = onProgress;
    this.siblings = siblings;
    this.onEscalate = onEscalate;
  }
  parentName;
  onMessage;
  log;
  onProgress;
  siblings;
  onEscalate;
  server = null;
  secret = randomBytes(SECRET_BYTES).toString("hex");
  url = "";
  pending = [];
  /** Picked up by the subagent but not answered yet (it may have seen them only as it finished). */
  unanswered = [];
  async start() {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        (body) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        },
        (err) => {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      );
    });
    await new Promise((resolve4, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, HOST, () => resolve4());
    });
    this.url = `http://${HOST}:${this.server.address().port}`;
  }
  childEnv() {
    return { [PARENT_URL_ENV]: this.url, [PARENT_TOKEN_ENV]: this.secret, [PARENT_NAME_ENV]: this.parentName };
  }
  /** Queue a message for the subagent; it gets it at its next step. */
  post(body, sibling) {
    const m = { id: sibling?.id ?? randomUUID(), body, ...sibling ? { sibling } : {} };
    this.pending.push(m);
    return m;
  }
  /** A task report answers instructions already consumed in that turn; no separate ack is needed. */
  reportCompleted() {
    this.unanswered = this.unanswered.filter((m) => m.sibling);
  }
  /**
   * Stop the link; returns the messages the subagent never picked up or never answered (they become a
   * follow-up, so a message that arrived as it finished is not lost).
   */
  async close() {
    const left = [...this.unanswered.splice(0), ...this.pending.splice(0)].filter((m) => !m.sibling).map((m) => m.body);
    const s = this.server;
    this.server = null;
    if (s) await new Promise((r) => s.close(() => r()));
    return left;
  }
  async handle(req) {
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokensEqual(auth, this.secret)) throw new Error("unauthorized");
    if (req.method === "POST" && req.url === "/inbox") {
      const messages = this.pending.splice(0);
      this.unanswered.push(...messages);
      this.siblings?.consumed?.(messages.filter((m) => m.sibling).map((m) => m.id));
      if (messages.length) this.log.info("subagent picked up messages", { count: messages.length });
      return { messages };
    }
    if (req.method === "POST" && req.url === "/progress") {
      const body = JSON.parse(await readBody(req));
      const percent = Math.round(Number(body.percent));
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error("percent must be 0-100");
      let eta;
      if (body.eta_minutes !== void 0) {
        if (typeof body.eta_minutes !== "number" || !Number.isFinite(body.eta_minutes) || body.eta_minutes < 0 || body.eta_minutes > 1440) throw new Error("eta_minutes must be 0-1440");
        const etaReportedAt = Date.now();
        eta = { etaAt: etaReportedAt + body.eta_minutes * 6e4, etaReportedAt };
      }
      this.onProgress(percent, String(body.note ?? "").trim().slice(0, MAX_NOTE_CHARS), eta);
      return { ok: true };
    }
    if (req.method === "POST" && req.url === "/siblings") {
      return { peers: this.siblings ? await this.siblings.peers() : [] };
    }
    if (req.method === "POST" && req.url === "/messaging-policy") {
      return this.siblings?.policy ? this.siblings.policy() : { maxHops: 0, sendTo: [] };
    }
    if (req.method === "POST" && req.url === "/sibling-message") {
      if (!this.siblings) throw new Error("sibling messaging unavailable");
      const body = JSON.parse(await readBody(req));
      if (typeof body.to !== "string" || typeof body.body !== "string" || !body.body.trim()) throw new Error("invalid sibling message");
      if (body.body.length > MAX_BODY_CHARS) throw new Error("message too large");
      const replyTo = typeof body.reply_to === "string" ? body.reply_to : void 0;
      const result = await this.siblings.send(body.to, body.body, replyTo);
      if (replyTo) this.unanswered = this.unanswered.filter((m) => m.sibling?.conversationId !== result.messages[0]?.conversationId);
      return result;
    }
    if (req.method === "POST" && (req.url === "/message" || req.url === "/message-kind")) {
      const body = JSON.parse(await readBody(req));
      const text2 = String(body.body ?? "").trim();
      if (!text2) throw new Error("empty message");
      if (body.kind !== void 0 && body.kind !== "note" && body.kind !== "question") throw new Error("invalid message kind");
      if (body.kind !== "note" && !isPureAcknowledgement(text2)) this.unanswered = this.unanswered.filter((m) => m.sibling);
      this.onMessage(text2, typeof body.reply_to === "string" ? body.reply_to : null, body.kind);
      return { ok: true };
    }
    if (req.method === "POST" && req.url === "/escalate") {
      if (!this.onEscalate) throw new Error("approval escalation unavailable");
      const body = JSON.parse(await readBody(req));
      if (typeof body.body !== "string" || !body.body.trim() || body.body.length > MAX_BODY_CHARS) throw new Error("invalid escalation");
      await this.onEscalate(body.body);
      return { ok: true };
    }
    throw new Error("not found");
  }
};
async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_REQUEST_BYTES) throw new Error("request too large");
  }
  return raw;
}
function parentFromEnv(env = process.env, timeoutMs = CHILD_REQUEST_TIMEOUT_MS) {
  const url = env[PARENT_URL_ENV];
  const token = env[PARENT_TOKEN_ENV];
  if (!url || !token) return null;
  const call = async (path, payload) => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal
      });
      const out = await res.json();
      if (!res.ok) throw new Error(String(out.error ?? `HTTP ${res.status}`));
      return out;
    } catch (err) {
      if ((path === "/message" || path === "/message-kind" || path === "/sibling-message") && signal.aborted) {
        throw new Error("Delivery is unconfirmed after the parent-link response timed out. The message may already be queued; check inbox/history before resending.", { cause: err });
      }
      throw err;
    }
  };
  return {
    name: env[PARENT_NAME_ENV] || "parent",
    inbox: async () => (await call("/inbox", {})).messages ?? [],
    // A distinct endpoint makes legacy parents refuse rather than silently discard note/question intent.
    send: async (body, replyTo, kind) => void await call(kind ? "/message-kind" : "/message", { body, reply_to: replyTo ?? null, kind }),
    escalate: async (body) => void await call("/escalate", { body }),
    progress: async (percent, note, etaMinutes) => void await call("/progress", { percent, note, eta_minutes: etaMinutes }),
    siblings: {
      peers: async () => (await call("/siblings", {})).peers ?? [],
      send: async (to, body, replyTo) => await call("/sibling-message", { to, body, reply_to: replyTo }),
      policy: async () => await call("/messaging-policy", {})
    }
  };
}

// src/core/final-answers.ts
var FinalAnswers = class {
  finals = /* @__PURE__ */ new Map();
  unphased = /* @__PURE__ */ new Map();
  lastMessage = "";
  add(item) {
    if (!item.text.trim()) return;
    this.lastMessage = item.text;
    const messages = item.phase === "final_answer" ? this.finals : item.phase ? null : this.unphased;
    messages?.set(item.id ?? String(messages.size), item.text);
  }
  text() {
    const messages = this.finals.size ? this.finals : this.unphased;
    return messages.size ? [...messages.values()].join("\n\n") : this.lastMessage;
  }
};

// src/core/progress.ts
var MAX_STATUS_CHARS = 140;
var MAX_SAY_CHARS = 160;
function txt(s, max = MAX_STATUS_CHARS) {
  return { text: clip(s, max), full: s.trim() };
}
function clip(s, max = MAX_STATUS_CHARS) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}\u2026` : one;
}
function firstString(o, keys) {
  for (const k of keys) if (typeof o?.[k] === "string" && o[k]) return o[k];
  return null;
}
var INPUT_KEYS = ["command", "file_path", "filePath", "path", "pattern", "query", "url", "description"];
var EDIT_TOOLS = /^(edit|write|multiedit|patch|apply_patch|notebookedit)$/i;
var CMD_TOOLS = /^(bash|shell|powershell)$/i;
var READ_TOOLS = /^(read|grep|glob|list|ls|find)$/i;
function kindOfTool(name) {
  if (EDIT_TOOLS.test(name)) return "edit";
  if (CMD_TOOLS.test(name)) return "cmd";
  if (READ_TOOLS.test(name)) return "read";
  return "tool";
}
function say(text2) {
  return text2.trim() ? { kind: "say", text: `says: ${clip(text2, MAX_SAY_CHARS)}`, full: `says: ${text2.trim()}` } : null;
}
function codexCommandFailure(item) {
  const code = item.exitCode ?? item.exit_code;
  const status = typeof item.status === "string" ? item.status : "unknown";
  const output = String(item.aggregatedOutput ?? item.aggregated_output ?? "");
  const timedOut = item.timedOut === true || item.timed_out === true || status === "timedOut" || status === "timed_out" || /^Command failed because it timed out\.(?:\r?\n|$)/.test(output);
  if (!timedOut && !(typeof code === "number" && code !== 0) && !["failed", "declined", "interrupted", "cancelled"].includes(status)) return null;
  const outcome = timedOut ? "timeout reported by Codex command tool" : status === "declined" ? "declined by Codex" : "termination cause not reported";
  const duration = item.durationMs ?? item.duration_ms;
  const detail = `command failed [${item.id ?? "unknown id"}]: exit=${typeof code === "number" ? code : "unknown"}, status=${status}${typeof duration === "number" ? `, duration=${duration}ms` : ""}; ${outcome}`;
  const command = Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? "");
  return {
    kind: "failure",
    id: item.id,
    text: detail,
    full: `${detail}
Command: ${command}
${output.trim() ? `Output tail:
${output.slice(-4e3)}` : "No command output was reported."}
A forced termination can skip finally/cleanup; verify owned locks and child processes before retrying.`
  };
}
function describeCodexEvent(ev) {
  const item = ev?.item;
  if (ev?.type === "item.completed" && item?.type === "command_execution") return codexCommandFailure(item);
  if (ev?.type === "item.started" && item) {
    switch (item.type) {
      case "command_execution":
        return { kind: "cmd", ...txt(`running: ${item.command ?? ""}`), id: item.id };
      case "file_change": {
        const paths = (item.changes ?? []).map((c) => c?.path).filter(Boolean);
        return { kind: "edit", ...txt(`editing ${paths.join(", ") || "files"}`), id: item.id };
      }
      case "mcp_tool_call":
        return { kind: "tool", ...txt(`tool ${item.server ?? ""}.${item.tool ?? ""}`), id: item.id };
      case "web_search":
        return { kind: "tool", ...txt(`searching the web${item.query ? `: ${item.query}` : ""}`), id: item.id };
    }
  }
  if (ev?.type === "item.completed" && item?.type === "reasoning") return { kind: "think", text: "thinking" };
  if (ev?.type === "item.completed" && item?.type === "agent_message") return say(String(item.text ?? ""));
  return null;
}
function describeClaudeEvent(ev) {
  if (ev?.type !== "assistant") return null;
  const blocks = ev.message?.content ?? [];
  const tool = blocks.find((b) => b?.type === "tool_use");
  if (tool) {
    const detail = firstString(tool.input, INPUT_KEYS);
    return { kind: kindOfTool(String(tool.name)), ...txt(`${tool.name}${detail ? `: ${detail}` : ""}`), id: tool.id };
  }
  const text2 = blocks.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
  if (text2) return say(text2);
  if (blocks.some((b) => b?.type === "thinking")) return { kind: "think", text: "thinking" };
  return null;
}
function describeOpencodeEvent(ev) {
  const part = ev?.part ?? {};
  if (ev?.type === "tool_use" || part.type === "tool") {
    const tool = String(part.tool ?? "tool");
    const detail = firstString(part.state?.input, INPUT_KEYS);
    return { kind: kindOfTool(tool), ...txt(`${tool}${detail ? `: ${detail}` : ""}`), id: part.id };
  }
  if (ev?.type === "text" || part.type === "text") return say(String(part.text ?? ""));
  if (ev?.type === "reasoning" || part.type === "reasoning") return { kind: "think", text: "thinking" };
  return null;
}
function describeAntigravityEvent(ev) {
  const step = ev?.step_update;
  if (!step || typeof step !== "object") return null;
  if (typeof step.tool_name !== "string") return typeof step.text_delta === "string" ? say(step.text_delta) : null;
  const name = step.tool_name, id = String(step.step_index);
  const detail = firstString(step.tool_info?.parameters, ["CommandLine", "TargetFile", "AbsolutePath", "SearchPath", "Query", "ToolName"]) ?? "";
  if (step.state === "ERROR") return { kind: "failure", id, ...txt(`${name} failed: ${step.tool_info?.error?.message ?? "native tool error"}`) };
  const kind = name === "run_command" ? "cmd" : /^(write_to_file|replace_file_content|multi_replace_file_content|notebook_edit)$/.test(name) ? "edit" : /^(view_file|grep_search|find_by_name|list_dir|read_url_content|read_resource)$/.test(name) ? "read" : "tool";
  return { kind, id, ...txt(`${name}${detail ? `: ${detail}` : ""}`) };
}
var DESCRIBERS = {
  antigravity: describeAntigravityEvent,
  codex: describeCodexEvent,
  claude: describeClaudeEvent,
  opencode: describeOpencodeEvent
};
function formatElapsed(ms) {
  const m = Math.floor(ms / 6e4);
  return m < 1 ? `${Math.round(ms / 1e3)}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function progressEventHandler(agent, onProgress, now = Date.now) {
  if (!onProgress) return void 0;
  const started = now();
  const seen = /* @__PURE__ */ new Set();
  const counts = { cmd: 0, edit: 0, read: 0, tool: 0, say: 0, think: 0, failure: 0 };
  let steps = 0;
  let last = "";
  return (ev) => {
    const step = DESCRIBERS[agent](ev);
    if (!step) return;
    if (step.id) {
      const key = `${step.kind}:${step.id}`;
      if (seen.has(key)) return;
      seen.add(key);
    }
    if (step.text === last) return;
    last = step.text;
    if (step.kind !== "think" && step.kind !== "say" && step.kind !== "failure") steps++;
    counts[step.kind]++;
    const totals = [counts.cmd && `${counts.cmd} cmds`, counts.edit && `${counts.edit} edits`].filter(Boolean).join(", ");
    const where = steps ? ` \xB7 step ${steps}${totals ? ` (${totals})` : ""}` : "";
    const head = `${formatElapsed(now() - started)}${where} \xB7 `;
    onProgress(head + step.text, step.full ? head + step.full : void 0);
  };
}
function progressLineHandler(agent, onProgress) {
  const handle = progressEventHandler(agent, onProgress);
  if (!handle) return void 0;
  return (line) => {
    if (!line.startsWith("{")) return;
    try {
      handle(JSON.parse(line));
    } catch {
    }
  };
}

// src/core/codex-paths.ts
import { realpathSync } from "node:fs";
function codexDriveMappings(text2, platform = process.platform, canonical = realpathSync.native) {
  if (platform !== "win32") return [];
  const drives = new Set([...text2.matchAll(/\b([a-z]):[\\/]/gi)].map((m) => `${m[1].toUpperCase()}:\\`));
  const mappings = [];
  for (const alias of drives) {
    try {
      const real = canonical(alias).replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").replace(/[\\/]*$/, "\\");
      if (real.toLowerCase() !== alias.toLowerCase()) mappings.push({ alias, real });
    } catch {
    }
  }
  return mappings;
}
function codexPathPrompt(prompt, mappings) {
  let text2 = prompt;
  for (const { alias, real } of mappings) {
    const drive = alias[0];
    text2 = text2.replace(new RegExp(`\\b${drive}:[\\\\/]`, "gi"), () => real);
  }
  if (!mappings.length) return text2;
  return `${text2}

(agent-bridge: Windows drive aliases resolved by the supervisor: ${mappings.map((m) => `${m.alias} = ${m.real}`).join(", ")}. These are the same folders. Use the real paths supplied above, including for new output files, without requesting path confirmation. In your report name both the requested alias and the real path.)`;
}
function codexPathReport(mappings) {
  return mappings.length ? `Windows path mappings (same folders): ${mappings.map((m) => `${m.alias} = ${m.real}`).join(", ")}. Outputs using the real paths are also available through these supervisor aliases.` : null;
}

// src/core/delegate.ts
var DELEGATE_DEPTH_ENV = "AGENT_BRIDGE_DELEGATE_DEPTH";
var PARENT_JOB_ENV = "AGENT_BRIDGE_PARENT_JOB";
var ROOT_SESSION_ENV = "AGENT_BRIDGE_ROOT_SESSION";
var ROOT_NAME_ENV = "AGENT_BRIDGE_ROOT_NAME";
var KILL_GRACE_MS = 3e3;
var MAX_CAPTURE_CHARS = 8 * 1024 * 1024;
var STDERR_TAIL_CHARS = 4e3;
var WINDOWS_SHIM_EXTS = /* @__PURE__ */ new Set([".cmd", ".bat"]);
var DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
function currentDelegateDepth(env = process.env) {
  const n = Number.parseInt(env[DELEGATE_DEPTH_ENV] ?? "0", 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
var DelegateError = class _DelegateError extends Error {
  constructor(message, kind, stderrTail = "", partialStdout = "", sessionId = null) {
    super(message);
    this.kind = kind;
    this.stderrTail = stderrTail;
    this.partialStdout = partialStdout;
    this.sessionId = sessionId;
    this.name = "DelegateError";
  }
  kind;
  stderrTail;
  partialStdout;
  sessionId;
  /** The agent never got going (its startup timed out): trying again is safe. */
  startupFailed = false;
  static startup(message, stderrTail, sessionId) {
    const err = new _DelegateError(message, "failed", stderrTail, "", sessionId);
    err.startupFailed = true;
    return err;
  }
};
function resolveBinary(bin, env = process.env, platform = process.platform) {
  const isWin = platform === "win32";
  const exts = isWin ? (env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter(Boolean) : [""];
  const candidates = (base) => isWin && !extname(base) ? exts.map((e) => base + e.toLowerCase()) : [base];
  if (isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    return candidates(bin).find((c) => existsSync(c)) ?? null;
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const c of candidates(join4(dir, bin))) if (existsSync(c)) return c;
  }
  return null;
}
function unwrapNpmShim(shimPath, readFile = (p) => readFileSync3(p, "utf8")) {
  let text2;
  try {
    text2 = readFile(shimPath);
  } catch {
    return null;
  }
  const dir = win32.dirname(shimPath);
  const exe = /"%~?dp0%?\\([^"]+?\.exe)"\s+%\*/i.exec(text2);
  if (exe) return { command: win32.join(dir, exe[1]), prefix: [] };
  const js = /"%~?dp0%?\\([^"]+?\.(?:c|m)?js)"\s+%\*/i.exec(text2);
  if (js) return { command: process.execPath, prefix: [win32.join(dir, js[1])] };
  return null;
}
var liveChildren = /* @__PURE__ */ new Map();
function killTree(child, reason = "delegate cleanup") {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  liveChildren.get(child)?.info("stopping delegate process tree", { pid, reason, method: process.platform === "win32" ? "taskkill /PID /T /F" : "process group signals" });
  const closed = new Promise((resolve4) => child.once("close", () => resolve4()));
  return new Promise((resolve4) => {
    if (process.platform === "win32") {
      const tk = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      tk.on("error", () => (child.kill(), resolve4()));
      tk.on("close", (code) => {
        if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill();
        resolve4();
      });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const force = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
        }
        resolve4();
      }, KILL_GRACE_MS);
      child.once("exit", () => (clearTimeout(force), resolve4()));
    }
  }).then(() => closed);
}
function killPid(pid, log) {
  log?.info("stopping job runner process tree", { pid, reason: "job cancellation fallback", method: process.platform === "win32" ? "taskkill /PID /T /F" : "runner signals" });
  if (process.platform === "win32") {
    const tk = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    tk.on("error", () => {
      try {
        process.kill(pid);
      } catch {
      }
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }, KILL_GRACE_MS).unref();
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
async function killAllDelegates(capMs = KILL_GRACE_MS) {
  const all = [...liveChildren.keys()].map((c) => killTree(c, "server shutdown"));
  await Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, capMs))]);
}
function trackChild(child, log) {
  liveChildren.set(child, log);
  log?.info("delegate process started", { pid: child.pid });
  child.once("exit", () => {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
        log?.info("stopped surviving delegate process group", { pgid: child.pid, reason: "delegate root exited" });
      } catch {
      }
    }
    liveChildren.delete(child);
  });
}
function resolveCommand(bin, argsIn, env, log) {
  let resolved = resolveBinary(bin, env);
  if (!resolved) throw new DelegateError(`executable not found: ${bin}`, "not_found");
  let args = argsIn;
  let needsShell = process.platform === "win32" && WINDOWS_SHIM_EXTS.has(extname(resolved).toLowerCase());
  if (needsShell) {
    const target = unwrapNpmShim(resolved);
    if (target && existsSync(target.command) && target.prefix.every((p) => existsSync(p))) {
      log.debug("unwrapped npm shim", { shim: resolved, command: target.command, prefix: target.prefix });
      resolved = target.command;
      args = [...target.prefix, ...args];
      needsShell = false;
    }
  }
  if (needsShell) {
    for (const a of args) {
      if (/[&|<>^%"\s]/.test(a)) throw new DelegateError(`unsafe argument for shell invocation: ${a}`, "failed");
    }
  }
  return { resolved: needsShell ? `"${resolved}"` : resolved, args, needsShell };
}
function exitDescription(res) {
  return res.code === null && res.signal ? `was killed by signal ${res.signal}` : `exited with code ${res.code}`;
}
function runProcess(opts) {
  let command;
  try {
    command = resolveCommand(opts.bin, opts.args, opts.env, opts.log);
  } catch (err) {
    return Promise.reject(err);
  }
  const { resolved, args, needsShell } = command;
  opts.log.debug("spawning delegate", { bin: resolved, args, cwd: opts.cwd, shell: needsShell });
  return new Promise((resolve4, reject) => {
    const child = spawn(resolved, args, {
      cwd: opts.cwd,
      // Some CLIs (opencode) take their project folder from PWD rather than the real cwd; keep them in sync.
      env: { ...jobEnvironment(opts.env), PWD: opts.cwd },
      shell: needsShell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group on POSIX, so the whole tree can be killed (see killTree).
      detached: process.platform !== "win32"
    });
    trackChild(child, opts.log);
    let head = "";
    let tail = "";
    const captured = () => tail ? `${head}
${tail.slice(tail.indexOf("\n") + 1)}` : head;
    let stderr = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = (reason) => killTree(child, reason);
    const timer = setTimeout(() => {
      const seconds = Math.round(opts.timeoutMs / 1e3);
      const message = opts.what ? `${opts.what} timed out after ${seconds}s` : `delegate timed out after ${seconds}s (its time limit, timeout_sec)`;
      finish(() => {
        const failed = () => reject(new DelegateError(message, "timeout", stderr.slice(-STDERR_TAIL_CHARS), captured()));
        void kill("delegate time limit").then(failed, failed);
      });
    }, opts.timeoutMs);
    const onAbort = () => {
      finish(() => {
        const failed = () => reject(new DelegateError("delegate aborted", "aborted", "", captured()));
        void kill("delegate aborted").then(failed, failed);
      });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let pending2 = "";
    child.stdout.setEncoding("utf8").on("data", (d) => {
      if (head.length < MAX_CAPTURE_CHARS / 2) head += d;
      else tail = (tail + d).slice(-MAX_CAPTURE_CHARS / 2);
      if (!opts.onLine) return;
      pending2 += d;
      let nl;
      while ((nl = pending2.indexOf("\n")) >= 0) {
        const line = pending2.slice(0, nl).trim();
        pending2 = pending2.slice(nl + 1);
        if (line) {
          try {
            opts.onLine(line);
          } catch {
          }
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (d) => {
      stderr = (stderr + d).slice(-MAX_CAPTURE_CHARS);
    });
    child.on("error", (err) => finish(() => reject(new DelegateError(`failed to start ${opts.bin}: ${err.message}`, "failed"))));
    child.on("close", (code, signal) => finish(() => resolve4({ code, signal, stdout: captured(), stderr })));
    child.stdin.on("error", () => {
    });
    child.stdin.end(opts.stdin);
  });
}
var OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";
var CODEX_STRICT_APPROVALS = 'approvals_reviewer="user"';
var CODEX_RELAY_APPROVALS = 'approvals_reviewer="auto_review"';
var CODEX_ASK_POLICY = 'approval_policy="on-request"';
var CODEX_NO_APPROVALS = 'approval_policy="never"';
var CODEX_ASK_HINT = "(The workspace is read-only on purpose: when you need to change files or run a command the sandbox blocks, request escalated permissions for it. The user is asked and decides; if denied, stop and report.)";
var OPENCODE_READ_ONLY_PERMISSIONS = { edit: "ask", bash: "ask" };
var OPENCODE_READ_ONLY_TOOLS = {
  "*_*": false,
  bridge_send: true,
  bridge_report_progress: true,
  bridge_peers: true,
  bridge_health: true,
  bridge_search_history: true,
  bridge_get_conversation: true,
  bridge_spawn_codex: true,
  bridge_spawn_claude: true,
  bridge_ask_codex: true,
  bridge_ask_claude: true,
  bridge_spawn_antigravity: true,
  bridge_ask_antigravity: true,
  bridge_message_subagent: true,
  bridge_cancel_subagent: true,
  bridge_inbox: true,
  bridge_wait_for_message: true
};
function childEnv(extra = {}) {
  const {
    CLAUDE_PROJECT_DIR: _parentProject,
    AGENT_BRIDGE_PLUGIN_RUNTIME_HOME: _parentRuntime,
    AGENT_BRIDGE_LAUNCH_PLUGIN_ROOT: _parentPlugin,
    ...env
  } = process.env;
  return jobEnvironment({ ...env, ...extra, [ENV.internal]: "1", [DELEGATE_DEPTH_ENV]: String(currentDelegateDepth() + 1) });
}
function checkDepth(max = Number(process.env[ENV.maxDelegateDepth] ?? DEFAULT_MAX_DELEGATE_DEPTH), env = process.env) {
  const limit = Number.isInteger(max) && max >= 1 ? Math.min(max, MAX_DELEGATE_DEPTH_LIMIT) : DEFAULT_MAX_DELEGATE_DEPTH;
  if (currentDelegateDepth(env) >= limit) {
    throw new DelegateError(`delegation depth limit ${limit} reached`, "depth");
  }
}
function sessionInLine(agent, line) {
  if (!line.startsWith("{")) return null;
  try {
    const ev = JSON.parse(line);
    const id = agent === "codex" ? ev.type === "thread.started" ? ev.thread_id : null : agent === "claude" ? ev.session_id : ev.sessionID ?? ev.part?.sessionID;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}
function withSessionSniffer(agent, next, onSession) {
  if (!onSession) return next;
  let seen = false;
  return (line) => {
    if (!seen) {
      const id = sessionInLine(agent, line);
      if (id) {
        seen = true;
        onSession(id);
      }
    }
    next?.(line);
  };
}
function parseCodexJsonl(stdout) {
  let threadId = null;
  const messages = new FinalAnswers();
  let error = null;
  let usage = null;
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    switch (ev.type) {
      case "thread.started":
        threadId = ev.thread_id ?? threadId;
        break;
      case "item.completed":
        if (ev.item?.type === "agent_message" && typeof ev.item.text === "string") messages.add(ev.item);
        break;
      case "turn.completed":
        usage = ev.usage ?? usage;
        error = null;
        break;
      case "turn.failed":
        error = ev.error?.message ?? "turn failed";
        break;
      case "error":
        error = ev.message ?? "error";
        break;
    }
  }
  return { threadId, text: messages.text(), error, usage };
}
function realFolder(dir) {
  try {
    return realpathSync2.native(dir);
  } catch {
    return dir;
  }
}
async function delegateToCodex(req) {
  checkDepth(req.maxDelegateDepth);
  req = { ...req, cwd: realFolder(req.cwd), prompt: codexExecutionPrompt(codexPathPrompt(req.prompt, codexDriveMappings(`${req.cwd}
${req.prompt}`)), req.sandbox) };
  if (req.relayApprovals && req.sandbox !== "danger-full-access") req = { ...req, prompt: `${req.prompt}

${CODEX_ASK_HINT}` };
  const common = ["--json", "--skip-git-repo-check", ...req.model ? ["-m", req.model] : [], ...req.effort ? ["-c", `model_reasoning_effort="${req.effort}"`] : []];
  if (process.platform === "win32" && req.sandbox !== "danger-full-access") common.push("-c", `windows.sandbox="${req.windowsSandbox ?? "unelevated"}"`);
  for (const [key, value] of Object.entries(codexSubagentConfig(req.nativeSubagents))) common.push("-c", `${key}=${value}`);
  if (req.writableRoots?.length && req.sandbox === "workspace-write") {
    common.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(req.writableRoots.map(realFolder))}`);
  }
  if (req.sandbox === "workspace-write" && req.networkAccess !== void 0) common.push("-c", `sandbox_workspace_write.network_access=${req.networkAccess}`);
  const strict = req.sandbox === "danger-full-access" ? ["-c", CODEX_STRICT_APPROVALS, "-c", CODEX_NO_APPROVALS] : req.relayApprovals ? ["-c", CODEX_RELAY_APPROVALS, "-c", CODEX_ASK_POLICY] : ["-c", CODEX_STRICT_APPROVALS];
  const args = req.sessionId ? ["exec", "resume", ...common, ...strict, "-c", `sandbox_mode="${req.sandbox}"`, req.sessionId, "-"] : ["exec", ...common, ...strict, "-s", req.sandbox, "-C", req.cwd, "-"];
  const res = await withResumeHint("codex", (o) => parseCodexJsonl(o).threadId, () => runProcess({
    bin: req.bin,
    args,
    stdin: req.prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutSec * 1e3,
    env: childEnv(req.extraEnv),
    log: req.log,
    signal: req.signal,
    onLine: withSessionSniffer("codex", progressLineHandler("codex", req.onProgress), req.onSession)
  }));
  const parsed2 = parseCodexJsonl(res.stdout);
  const isError = res.code !== 0 || parsed2.error !== null;
  if (isError && !parsed2.text) {
    throw new DelegateError(parsed2.error ?? `codex ${exitDescription(res)}`, "failed", res.stderr.slice(-STDERR_TAIL_CHARS), "", parsed2.threadId ?? req.sessionId ?? null);
  }
  req.log.info("codex delegate finished", { threadId: parsed2.threadId, code: res.code, isError });
  return {
    sessionId: parsed2.threadId ?? req.sessionId ?? null,
    text: parsed2.text,
    isError,
    details: { exitCode: res.code, signal: res.signal ?? null, usage: parsed2.usage, error: parsed2.error }
  };
}
function parseClaudeJson(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  const resultLine = [...lines].reverse().find((l) => l.includes('"type":"result"'));
  const candidate = resultLine ?? (stdout.indexOf("{") >= 0 ? stdout.slice(stdout.indexOf("{")) : null);
  if (!candidate) return null;
  try {
    const o = JSON.parse(candidate);
    return {
      sessionId: typeof o.session_id === "string" ? o.session_id : null,
      text: typeof o.result === "string" ? o.result : "",
      isError: Boolean(o.is_error) || o.subtype === "error",
      cost: o.total_cost_usd ?? null
    };
  } catch {
    return null;
  }
}
var CLAUDE_PARENT_SEND_TOOL = "mcp__plugin_agent-bridge_bridge__send";
var CLAUDE_PARENT_PROGRESS_TOOL = "mcp__plugin_agent-bridge_bridge__report_progress";
var CLAUDE_READ_ONLY_DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"];
function isClaudeReadOnly(mode) {
  return CLAUDE_READ_ONLY_MODES.has(mode);
}
var CLAUDE_READ_ONLY_MODES = /* @__PURE__ */ new Set(["default", "manual", "plan"]);
function bundledCli() {
  const cli = join4(bundleDirectory(import.meta.url), "cli.mjs");
  return existsSync(cli) ? cli : null;
}
function spawnsWithoutShell(bin, log) {
  try {
    return !resolveCommand(bin, [], process.env, log).needsShell;
  } catch {
    return false;
  }
}
function claudePermissionHookSettings(cli, node = process.execPath) {
  const hook = { type: "command", command: node, args: [cli, "permission-hook", "claude"], timeout: CLAUDE_HOOK_TIMEOUT_SEC };
  return JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [hook] }] } });
}
function claudeForwardsPrompts(mode, req) {
  return !isClaudeReadOnly(mode) && Boolean(req.canApprove && req.approve);
}
var CLAUDE_HOOK_TIMEOUT_SEC = 900;
function claudeInitSniffer(next, onInfo) {
  if (!onInfo) return next;
  let seen = false;
  return (line) => {
    if (!seen && line.includes('"subtype":"init"')) {
      seen = true;
      try {
        const model = JSON.parse(line).model;
        if (typeof model === "string" && model) onInfo({ model });
      } catch {
      }
    }
    next?.(line);
  };
}
async function delegateToClaude(req) {
  checkDepth(req.maxDelegateDepth);
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", req.permissionMode];
  const readOnly = isClaudeReadOnly(req.permissionMode);
  if (readOnly) args.push("--disallowedTools", [...CLAUDE_READ_ONLY_DENIED_TOOLS, ...claudeMcpDenyRules(req.cwd)].join(","));
  if (req.model) args.push("--model", req.model);
  if (req.effort) args.push("--effort", req.effort);
  if (req.sessionId) args.push("--resume", req.sessionId);
  if (req.extraEnv?.[PARENT_URL_ENV]) args.push("--allowedTools", `${CLAUDE_PARENT_SEND_TOOL},${CLAUDE_PARENT_PROGRESS_TOOL}`);
  const hookCli = claudeForwardsPrompts(req.permissionMode, req) ? req.hookCli ?? bundledCli() : null;
  let relay = null;
  const extraEnv = { ...req.extraEnv };
  if (hookCli && spawnsWithoutShell(req.bin, req.log)) {
    const approve = req.approve;
    relay = new PermissionRelay(async (r) => {
      const d = await approve(r);
      return d.allow ? { allow: true } : { allow: false, message: d.message || "Denied by the parent session." };
    }, req.log);
    await relay.start();
    Object.assign(extraEnv, relay.childEnv());
    args.push("--settings", claudePermissionHookSettings(hookCli));
  } else if (hookCli) {
    req.log.warn("claude runs through a shell; its permission prompts are not forwarded", { bin: req.bin });
  }
  let res;
  try {
    res = await withResumeHint("claude", (o) => claudeSessionFromStream(o), () => runProcess({
      bin: req.bin,
      args,
      stdin: req.prompt,
      cwd: req.cwd,
      timeoutMs: req.timeoutSec * 1e3,
      env: childEnv(extraEnv),
      log: req.log,
      signal: req.signal,
      onLine: claudeInitSniffer(withSessionSniffer("claude", progressLineHandler("claude", req.onProgress), req.onSession), req.onInfo)
    }));
  } finally {
    await relay?.stop();
  }
  const parsed2 = parseClaudeJson(res.stdout);
  if (!parsed2) {
    throw new DelegateError(`claude ${exitDescription(res)} without a JSON result`, "failed", (res.stderr || res.stdout).slice(-STDERR_TAIL_CHARS), "", claudeSessionFromStream(res.stdout) ?? req.sessionId ?? null);
  }
  req.log.info("claude delegate finished", { sessionId: parsed2.sessionId, code: res.code, isError: parsed2.isError });
  return {
    sessionId: parsed2.sessionId ?? req.sessionId ?? null,
    text: parsed2.text,
    isError: parsed2.isError || res.code !== 0,
    details: { exitCode: res.code, signal: res.signal ?? null, costUsd: parsed2.cost }
  };
}
function parseOpencodeJsonl(stdout) {
  let sessionId = null;
  const textByMessage = /* @__PURE__ */ new Map();
  let lastMessage = "";
  let error = null;
  let input = 0;
  let output = 0;
  let cost = 0;
  let sawUsage = false;
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (typeof ev.sessionID === "string") sessionId ??= ev.sessionID;
    if (ev.type === "step_finish" && ev.part?.tokens) {
      sawUsage = true;
      input += Number(ev.part.tokens.input) || 0;
      output += Number(ev.part.tokens.output) || 0;
      cost += Number(ev.part.cost) || 0;
    }
    if (ev.type === "text" && typeof ev.part?.text === "string") {
      const mid = String(ev.part.messageID ?? "");
      if (!textByMessage.has(mid)) textByMessage.set(mid, []);
      textByMessage.get(mid).push(ev.part.text);
      lastMessage = mid;
    } else if (ev.type === "error") {
      error = ev.error?.data?.message ?? ev.error?.message ?? ev.message ?? "opencode reported an error";
    }
  }
  const text2 = (textByMessage.get(lastMessage) ?? []).join("");
  return sawUsage ? { sessionId, text: text2, error, usage: { input, output }, cost } : { sessionId, text: text2, error };
}
var opencodeVersions = /* @__PURE__ */ new Map();
function opencodeV2(bin, cwd, log) {
  const key = resolveBinary(bin) ?? bin;
  let cached = opencodeVersions.get(key);
  if (!cached) {
    cached = runProcess({ bin, args: ["--version"], stdin: "", cwd, timeoutMs: 1e4, env: childEnv(), log }).then((res) => /(?:^|\s)(?:opencode\s+)?v?2\.\d+\.\d+/.test(res.stdout.trim())).catch(() => false);
    opencodeVersions.set(key, cached);
  }
  return cached;
}
async function delegateToOpencode(req) {
  checkDepth(req.maxDelegateDepth);
  const v2 = await opencodeV2(req.bin, req.cwd, req.log);
  const args = ["run", "--format", "json"];
  if (v2) args.push("--standalone");
  if (req.model) args.push("-m", v2 && req.effort ? `${req.model.split("#")[0]}#${req.effort}` : req.model);
  if (req.effort && !v2) args.push("--variant", req.effort);
  if (req.effort && v2 && !req.model) throw new DelegateError("OpenCode 2 requires an explicit model when selecting effort", "failed");
  if (req.sessionId) args.push("-s", req.sessionId);
  if (req.autoApprove) args.push("--auto");
  const env = childEnv(req.extraEnv);
  if (!req.autoApprove) env[OPENCODE_CONFIG_CONTENT_ENV] = JSON.stringify({ permission: OPENCODE_READ_ONLY_PERMISSIONS, tools: OPENCODE_READ_ONLY_TOOLS });
  const res = await withResumeHint("opencode", (o) => parseOpencodeJsonl(o).sessionId, () => runProcess({
    bin: req.bin,
    args,
    stdin: req.prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutSec * 1e3,
    env,
    log: req.log,
    signal: req.signal,
    onLine: withSessionSniffer("opencode", progressLineHandler("opencode", req.onProgress), req.onSession)
  }));
  const parsed2 = parseOpencodeJsonl(res.stdout);
  const isError = res.code !== 0 || parsed2.error !== null;
  if (isError && !parsed2.text) {
    throw new DelegateError(parsed2.error ?? `opencode ${exitDescription(res)}`, "failed", res.stderr.slice(-STDERR_TAIL_CHARS), "", parsed2.sessionId ?? req.sessionId ?? null);
  }
  req.log.info("opencode delegate finished", { sessionId: parsed2.sessionId, code: res.code, isError });
  return { sessionId: parsed2.sessionId ?? req.sessionId ?? null, text: parsed2.text, isError, details: { exitCode: res.code, signal: res.signal ?? null, error: parsed2.error, usage: parsed2.usage ?? null, costUsd: parsed2.cost || null } };
}
var checkDepthPublic = checkDepth;
var childEnvPublic = (extra = {}) => childEnv(extra);
function claudeSessionFromStream(stdout) {
  const m = /"session_id":"([^"]+)"/.exec(stdout);
  return m ? m[1] : null;
}
async function withResumeHint(agent, sessionOf, run) {
  try {
    return await run();
  } catch (err) {
    if (err instanceof DelegateError && !err.sessionId) err.sessionId = sessionOf(err.partialStdout);
    if (err instanceof DelegateError && err.kind === "timeout") {
      const id = err.sessionId;
      if (id) {
        throw new DelegateError(
          `${err.message}. The ${agent} session ${id} keeps its progress: call again with session_id="${id}" (and a longer timeout_sec, or use spawn_${agent}) to continue instead of starting over.`,
          "timeout",
          err.stderrTail,
          err.partialStdout,
          id
        );
      }
    }
    throw err;
  }
}
var TRANSIENT_ERROR_RE = /(?:model|selected model) is at capacity|not valid JSON|upstream|overloaded|bad gateway|service unavailable|gateway time-?out|internal server error|\b50[0-4]\b|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|connection (?:reset|closed|error|refused)|stream (?:error|closed|disconnected|ended)|network error|fetch failed|temporarily unavailable|routing discovery timed out/i;
var CAPACITY_ERROR_RE = /model is at capacity/i;
var DATABASE_LOCK_ERROR_RE = /\bdatabase (?:is |table is |schema is )?locked\b|\bSQLITE_(?:BUSY|LOCKED)\b/i;
var CAPACITY_RETRY_DELAYS_MS = [15e3, 3e4, 6e4];
var DATABASE_RETRY_DELAYS_MS = [1e3, 2e3, 4e3];
var TRANSIENT_RETRY_LIMIT = 1;
var MS_PER_SECOND = 1e3;
var LIMIT_ERROR_RE = /usage limit|rate.?limit|quota|too many requests|\b429\b|insufficient (?:credits|balance)|billing/i;
function isTransientProviderError(message) {
  return TRANSIENT_ERROR_RE.test(message) && !LIMIT_ERROR_RE.test(message);
}
var TRANSIENT_RETRY_MESSAGE = "Your previous turn was cut off by a temporary provider error. Continue where you stopped and finish the task. Then give your final answer.";
async function retryTransient(req, run) {
  const deadline = Date.now() + req.timeoutSec * MS_PER_SECOND;
  let sessionId = req.sessionId ?? null;
  let model = req.model;
  let firstCause = null;
  let retries = 0;
  for (; ; ) {
    if (req.signal?.aborted) throw new DelegateError("delegate aborted", "aborted", "", "", sessionId);
    const remainingSec = (deadline - Date.now()) / MS_PER_SECOND;
    if (remainingSec <= 0) throw new DelegateError("delegate timed out during provider retry backoff", "timeout", "", "", sessionId);
    let res;
    let failure2;
    let failed = false;
    let cause = "";
    try {
      res = await run({
        ...req,
        model,
        sessionId,
        timeoutSec: remainingSec,
        prompt: retries && sessionId ? TRANSIENT_RETRY_MESSAGE : req.prompt,
        onSession: (id) => {
          sessionId = id;
          req.onSession?.(id);
        },
        onInfo: (info) => {
          model ??= info.model;
          req.onInfo?.(info);
        }
      });
      sessionId = res.sessionId ?? sessionId;
      cause = res.isError && typeof res.details?.error === "string" ? res.details.error : "";
    } catch (err) {
      failure2 = err;
      failed = true;
      if (err instanceof DelegateError) {
        sessionId = err.sessionId ?? sessionId;
        cause = err.kind === "failed" ? err.message : "";
      }
    }
    const capacity = CAPACITY_ERROR_RE.test(cause);
    const databaseLock = DATABASE_LOCK_ERROR_RE.test(cause);
    const limit = databaseLock ? Infinity : capacity ? CAPACITY_RETRY_DELAYS_MS.length : TRANSIENT_RETRY_LIMIT;
    if (!databaseLock && !isTransientProviderError(cause) || !sessionId && !capacity && !databaseLock || retries >= limit) {
      if (failed) {
        if (failure2 instanceof DelegateError && firstCause) {
          failure2.message += ` (after ${retries === 1 ? "one automatic retry" : `${retries} automatic retries`}: the first attempt had failed with "${firstCause}")`;
          failure2.sessionId ??= sessionId;
        }
        throw failure2;
      }
      if (!firstCause) return res;
      const count = retries === 1 ? "once" : `${retries} times`;
      const note = `(A temporary provider error interrupted the run ("${firstCause}"); agent-bridge ${sessionId ? "resumed the same session" : "retried"} ${count} on the selected model.)`;
      return { ...res, text: `${note}

${res.text}`, details: { ...res.details, retriedAfter: firstCause, retries } };
    }
    firstCause ??= cause;
    const waitMs = databaseLock ? DATABASE_RETRY_DELAYS_MS[Math.min(retries, DATABASE_RETRY_DELAYS_MS.length - 1)] : capacity ? CAPACITY_RETRY_DELAYS_MS[retries] : 0;
    if (Date.now() + waitMs >= deadline) throw new DelegateError("delegate timed out during provider retry backoff", "timeout", "", "", sessionId);
    retries++;
    req.log.warn("transient provider error; retrying on the selected model", { sessionId, model, cause, retries, waitMs });
    req.onProgress?.(`temporary provider error: ${cause}; retry ${retries}${databaseLock ? "" : `/${limit}`} in ${waitMs / MS_PER_SECOND}s on the same model, ${sessionId ? "preserving session progress" : "before session start"}`);
    try {
      await delay(waitMs, void 0, { signal: req.signal });
    } catch {
      throw new DelegateError("delegate aborted", "aborted", "", "", sessionId);
    }
  }
}
function stderrSummary(stderr) {
  const lines = stderr.trim().split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-5).join("\n").slice(-800);
}
function labelError(message) {
  return LIMIT_ERROR_RE.test(message) ? `usage or rate limit reached: ${message}` : `error: ${message}`;
}
function failureCause(outcome) {
  if (outcome.result) {
    const d = outcome.result.details ?? {};
    const parts = [];
    if (typeof d.error === "string" && d.error) parts.push(labelError(d.error));
    if (typeof d.exitCode === "number" && d.exitCode !== 0) parts.push(`the agent exited with code ${d.exitCode}`);
    else if (typeof d.signal === "string" && d.signal) parts.push(`the agent was killed by signal ${d.signal}`);
    return parts.join("; ") || "the agent ended its turn with an error but gave no details";
  }
  const err = outcome.error;
  if (!(err instanceof DelegateError)) return `error: ${String(err?.message ?? err)}`;
  switch (err.kind) {
    case "aborted":
      return "cancelled: it was stopped (cancel_subagent, or the session that started it ended)";
    case "timeout":
      return `timeout: ${err.message}`;
    case "not_found":
      return `could not start: ${err.message}`;
    default: {
      const tail = err.stderrTail ? stderrSummary(err.stderrTail) : "";
      return `${labelError(err.message)}${tail && !err.message.includes(tail) ? `
Last error output:
${tail}` : ""}`;
    }
  }
}

// src/core/antigravity-plugin.ts
import { existsSync as existsSync2, readFileSync as readFileSync4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname2, join as join5 } from "node:path";
var antigravityPluginDir = (home = homedir3()) => join5(home, ".gemini", "config", "plugins", "agent-bridge");
var antigravityRuntimeHome = (dir = antigravityPluginDir()) => join5(dirname2(dir), ".agent-bridge-runtime");
function antigravityRuntimeDir(dir = antigravityPluginDir()) {
  const selected = selectedWorker(antigravityRuntimeHome(dir), "antigravity", join5(dir, "dist", "server.mjs"));
  return dirname2(dirname2(selected.worker));
}
function antigravityHookCommand(cli, event, node = process.execPath, platform = process.platform) {
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  if (platform === "win32") {
    const script = `$ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $hookInput = [Console]::In.ReadToEnd(); $hookInput | & ${quote(node)} ${quote(cli)} antigravity-hook ${quote(event)}; exit $LASTEXITCODE`;
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
  return `${shellQuote(node)} ${shellQuote(cli)} antigravity-hook ${event}`;
}
function requireAntigravityPlugin(dir = antigravityPluginDir()) {
  try {
    assertUnlinked(dir);
    const runtime = antigravityRuntimeDir(dir);
    assertUnlinked(runtime);
    const hooks = JSON.parse(readFileSync4(join5(dir, "hooks.json"), "utf8"))["agent-bridge"];
    if (readFileSync4(join5(dir, ".agent-bridge-owned"), "utf8").trim() !== "agent-bridge" || hooks?.enabled === false || !hooks?.PreToolUse?.some((group) => group.matcher === "*" && group.hooks?.some((hook) => hook.command === antigravityHookCommand(join5(runtime, "dist", "cli.mjs"), "PreToolUse"))) || !existsSync2(join5(runtime, "dist", "server.mjs")) || !existsSync2(join5(runtime, "dist", "cli.mjs"))) throw new Error("incomplete plugin");
  } catch {
    throw new DelegateError("Antigravity needs its enabled agent-bridge plugin: run agent-bridge install antigravity --yes, then restart agy", "failed");
  }
}

// src/core/antigravity.ts
var ANTIGRAVITY_ACCESS_ENV = "AGENT_BRIDGE_ANTIGRAVITY_ACCESS";
var ANTIGRAVITY_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
function parseAntigravityJsonl(stdout) {
  let sessionId = null;
  let result = null;
  for (const line of stdout.split(/\r?\n/)) {
    const ev = parse(line);
    const id = ev.conversation_id ?? ev.step_update?.conversation_id ?? ev.result?.conversation_id;
    if (typeof id === "string" && id) sessionId = id;
    if (ev.event === "result") result = object(ev.result);
  }
  const denied = Array.isArray(result?.denied_actions) ? result.denied_actions : [];
  const isError = !result || result.status !== "SUCCESS" || denied.length > 0 && !result.response;
  return { sessionId, text: typeof result?.response === "string" && result.response ? result.response : String(result?.error ?? (denied.length ? `Antigravity denied permissions: ${denied.map((action) => action.action ?? action.display_name ?? "tool").join(", ")}` : result ? `Antigravity ended with ${result.status ?? "unknown status"}` : "Antigravity emitted no result")), isError, details: { status: result?.status ?? null, usage: result?.usage ?? null, deniedActions: denied } };
}
async function delegateToAntigravity(req) {
  checkDepth(req.maxDelegateDepth);
  if (req.signal?.aborted) throw new DelegateError("delegate aborted", "aborted", "", "", req.sessionId ?? null);
  if (req.effort && !ANTIGRAVITY_EFFORTS.includes(req.effort)) throw new DelegateError("Antigravity effort must be low, medium, high, xhigh or max", "failed");
  requireAntigravityPlugin();
  const args = ["--output-format", "stream-json", "--input-format", "stream-json", "--print-timeout", `${req.timeoutSec}s`];
  if (req.sessionId) args.push("--conversation", req.sessionId);
  if (req.model) args.push("--model", req.model);
  if (req.effort) args.push("--effort", req.effort);
  if (req.sandbox) args.push("--sandbox");
  if (req.access !== "edit" || req.autoApprove) args.push("--dangerously-skip-permissions");
  let sessionId = req.sessionId ?? null;
  const progress = progressEventHandler("antigravity", req.onProgress);
  const approvals = new AbortController();
  const approve = async (request) => {
    const ended = { allow: false, message: "Antigravity run ended" };
    if (approvals.signal.aborted) return ended;
    let stop;
    const aborted = new Promise((resolve4) => {
      stop = () => resolve4(ended);
    });
    approvals.signal.addEventListener("abort", stop, { once: true });
    try {
      return await Promise.race([req.approve(request), aborted]);
    } finally {
      approvals.signal.removeEventListener("abort", stop);
    }
  };
  const relay = req.access === "ask" && req.approve ? new PermissionRelay(approve, req.log) : null;
  try {
    await relay?.start();
    const res = await runProcess({
      bin: req.bin,
      args,
      cwd: req.cwd,
      stdin: JSON.stringify({ event: "user", message: { content: req.prompt } }) + "\n",
      timeoutMs: req.timeoutSec * 1e3,
      signal: req.signal,
      env: childEnv({ ...req.extraEnv, ...relay?.childEnv(), [ANTIGRAVITY_ACCESS_ENV]: req.access }),
      log: req.log,
      onLine: (line) => {
        const ev = parse(line), id = ev.conversation_id ?? ev.step_update?.conversation_id ?? ev.result?.conversation_id;
        if (!sessionId && typeof id === "string" && id) {
          sessionId = id;
          req.onSession?.(id);
        }
        if (ev.event === "init") req.onInfo?.({ model: ev.init?.model ?? req.model, effort: req.effort, permission: req.access === "edit" && req.autoApprove !== void 0 ? req.autoApprove ? "bypass" : "native" : req.access });
        progress?.(ev);
      }
    });
    const parsed2 = parseAntigravityJsonl(res.stdout);
    const isError = res.code !== 0 || parsed2.isError;
    const stderr = res.stderr.slice(-4e3);
    const error = [parsed2.isError ? parsed2.text : "", stderr].filter(Boolean).join("\n") || `Antigravity exited with code ${res.code}`;
    return { ...parsed2, sessionId: parsed2.sessionId ?? sessionId, isError, details: { ...parsed2.details, exitCode: res.code, ...isError ? { error } : {}, ...res.code !== 0 ? { stderr } : {} } };
  } catch (err) {
    if (err instanceof DelegateError) err.sessionId = sessionId ?? parseAntigravityJsonl(err.partialStdout).sessionId;
    throw err;
  } finally {
    approvals.abort();
    await relay?.stop();
  }
}

// src/core/opencode-models.ts
var LIST_TIMEOUT_MS = 6e4;
var CACHE_TTL_MS = 10 * 60 * 1e3;
var MODEL_LINE = /^[A-Za-z0-9._-]+\/\S+$/;
var MAX_SUGGESTIONS = 8;
var cache = /* @__PURE__ */ new Map();
async function listOpencodeModels(bin, cwd, log) {
  const key = JSON.stringify([resolveBinary(bin) ?? bin, cwd]);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.models;
  const v2 = await opencodeV2(bin, cwd, log);
  const res = await runProcess({ bin, args: ["models", ...v2 ? ["--standalone"] : []], stdin: "", cwd, timeoutMs: LIST_TIMEOUT_MS, env: childEnv(), log });
  const models = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => MODEL_LINE.test(l));
  if (models.length) cache.set(key, { at: Date.now(), models });
  return models;
}
function resolveOpencodeModel(input, models) {
  const want = input.trim();
  if (models.length === 0) return { model: want, note: null };
  if (models.includes(want)) return { model: want, note: null };
  const lower = want.toLowerCase();
  const exactCi = models.filter((m) => m.toLowerCase() === lower);
  if (exactCi.length === 1) return { model: exactCi[0], note: null };
  const [provider, ...rest] = lower.includes("/") ? lower.split("/") : ["", lower];
  const name = rest.join("/");
  const matches = models.filter((m) => {
    const [mp, ...mr] = m.toLowerCase().split("/");
    const mn = mr.join("/");
    if (provider && mp !== provider) return false;
    return mn === name || mn.startsWith(name) || mn.includes(name);
  });
  const prefixed = matches.filter((m) => m.toLowerCase().split("/").slice(1).join("/").startsWith(name));
  const best = prefixed.length ? prefixed : matches;
  if (best.length === 1) return { model: best[0], note: `model "${want}" resolved to "${best[0]}"` };
  const suggest = (list) => list.slice(0, MAX_SUGGESTIONS).join(", ");
  if (best.length > 1) return { error: `The opencode model "${want}" is ambiguous. Pass one of: ${suggest(best)}${best.length > MAX_SUGGESTIONS ? ", \u2026" : ""}` };
  const near = models.filter((m) => name.split(/[-._]/).some((part) => part.length > 2 && m.toLowerCase().includes(part)));
  return {
    error: `Unknown opencode model "${want}". Use "provider/model" from \`opencode models\`${near.length ? `, e.g. ${suggest(near)}` : ""}.`
  };
}

// src/core/opencode-served.ts
import { spawn as spawn2 } from "node:child_process";
import { randomBytes as randomBytes2 } from "node:crypto";
import { extname as extname2 } from "node:path";
var SERVE_START_TIMEOUT_MS = 3e4;
var LISTEN_RE = /listening on (https?:\/\/[^\s]+)/i;
var SERVER_USER = "opencode";
var PASSWORD_BYTES = 24;
var MAX_DETAIL_CHARS = 4e3;
var OPENCODE_ASK_PERMISSIONS = { edit: "ask", bash: "ask" };
var START_WATCHDOG_MS = 6e4;
var SERVE_OUTPUT_TAIL_CHARS = 4e3;
function watchServeOutput(onListening) {
  let out = "";
  let listening = false;
  return {
    onData: (d) => {
      if (listening) return;
      out = (out + d.toString()).slice(-SERVE_OUTPUT_TAIL_CHARS);
      const m = LISTEN_RE.exec(out);
      if (m) {
        listening = true;
        out = "";
        onListening(m[1].replace(/\/+$/, ""));
      }
    },
    tail: () => out
  };
}
function startServe(bin, cwd, env, log) {
  let resolved = resolveBinary(bin, env);
  if (!resolved) return Promise.reject(new DelegateError(`executable not found: ${bin}`, "not_found"));
  let prefix = [];
  if (process.platform === "win32" && [".cmd", ".bat"].includes(extname2(resolved).toLowerCase())) {
    const target = unwrapNpmShim(resolved);
    if (!target) return Promise.reject(new DelegateError(`cannot start ${bin} without a shell`, "failed"));
    resolved = target.command;
    prefix = target.prefix;
  }
  return new Promise((resolve4, reject) => {
    const child = spawn2(resolved, [...prefix, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd,
      env: { ...env, PWD: cwd },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    trackChild(child, log);
    const output = watchServeOutput((url) => {
      clearTimeout(timer);
      resolve4({ child, url });
    });
    const timer = setTimeout(() => {
      void killTree(child, "opencode startup timeout");
      reject(new DelegateError(`opencode serve did not start within ${SERVE_START_TIMEOUT_MS / 1e3}s (startup timeout)`, "timeout", output.tail()));
    }, SERVE_START_TIMEOUT_MS);
    child.stdout.on("data", output.onData);
    child.stderr.on("data", output.onData);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new DelegateError(`failed to start opencode serve: ${err.message}`, "failed"));
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new DelegateError(`opencode serve exited early (${signal ? `signal ${signal}` : `code ${code}`})`, "failed", output.tail()));
    });
  });
}
async function* sse(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data);
      } catch {
      }
    }
  }
}
function mcpToolPrefix(server) {
  return `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}_`;
}
function opencodePermissionRequest(p, mcpServers, cwd) {
  const permission = String(p.permission ?? "unknown");
  const detail = permissionDetail(p);
  const server = [...mcpServers].sort((a, b) => b.length - a.length).find((s) => permission.startsWith(mcpToolPrefix(s)));
  if (server) return { agent: "opencode", tool: `mcp:${server}`, detail: `${permission}: ${detail}`.slice(0, MAX_DETAIL_CHARS), cwd };
  return { agent: "opencode", tool: permission, detail, cwd };
}
function permissionDetail(p) {
  const patterns = Array.isArray(p.patterns) ? p.patterns.join(", ") : "";
  const meta = p.metadata && typeof p.metadata === "object" ? p.metadata : {};
  const cmd = typeof meta.command === "string" ? meta.command : typeof meta.filepath === "string" ? meta.filepath : "";
  return (cmd || patterns || JSON.stringify(meta)).slice(0, MAX_DETAIL_CHARS);
}
async function delegateToOpencodeServed(req) {
  checkDepthPublic(req.maxDelegateDepth);
  const v2 = await opencodeV2(req.bin, req.cwd, req.log);
  const password = randomBytes2(PASSWORD_BYTES).toString("hex");
  const permissions = req.permissions === void 0 ? OPENCODE_ASK_PERMISSIONS : req.permissions;
  const env = childEnvPublic({
    ...req.extraEnv,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: SERVER_USER,
    ...permissions ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: permissions }) } : {}
  });
  const { child, url } = await startServe(req.bin, req.cwd, env, req.log);
  const auth = `Basic ${Buffer.from(`${SERVER_USER}:${password}`).toString("base64")}`;
  const q = `directory=${encodeURIComponent(req.cwd)}`;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  req.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), req.timeoutSec * 1e3);
  const api = async (method, path, body) => {
    const res = await fetch(v2 ? `${url}/api${path}` : `${url}${path}${path.includes("?") ? "&" : "?"}${q}`, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal: ac.signal
    });
    if (!res.ok) throw new DelegateError(`opencode API ${method} ${path} failed: HTTP ${res.status}`, "failed", await res.text().catch(() => ""));
    const text2 = await res.text();
    const parsed2 = text2 ? JSON.parse(text2) : null;
    return v2 ? parsed2?.data ?? parsed2 : parsed2;
  };
  let knownSession = req.sessionId ?? null;
  try {
    if (v2) {
      const [providerID2, ...rest2] = (req.model ?? "").split("/");
      const [id, variant] = rest2.join("/").split("#");
      const model = req.model ? { providerID: providerID2, id, ...req.effort || variant ? { variant: req.effort ?? variant } : {} } : void 0;
      const sessionId2 = req.sessionId ?? (await api("POST", "/session", { location: { directory: req.cwd }, ...model ? { model } : {} })).id;
      knownSession = sessionId2;
      req.onSession?.(sessionId2);
      if (req.sessionId && model) await api("POST", `/session/${sessionId2}/model`, { model });
      const servers = await api("GET", `/mcp?directory=${encodeURIComponent(req.cwd)}`).catch(() => []);
      const mcpServers2 = Array.isArray(servers) ? servers.map((s) => s.name ?? s.id).filter((name) => typeof name === "string") : [];
      const events2 = await fetch(`${url}/api/event`, { headers: { authorization: auth, accept: "text/event-stream" }, signal: ac.signal });
      if (!events2.ok || !events2.body) throw new DelegateError(`opencode event stream failed: HTTP ${events2.status}`, "failed");
      await api("POST", `/session/${sessionId2}/prompt`, { text: req.prompt });
      const textByMessage = /* @__PURE__ */ new Map();
      let lastMessage = "";
      let failure3 = null;
      let usage = null;
      let costUsd = null;
      const onEvent2 = progressEventHandler("opencode", req.onProgress);
      for await (const ev of sse(events2.body)) {
        const p = ev.data ?? {};
        if (p.sessionID !== sessionId2) continue;
        if (ev.type === "permission.asked") {
          const decision = await req.onPermission(opencodePermissionRequest({ ...p, permission: p.action, patterns: p.resources }, mcpServers2, req.cwd));
          await api("POST", `/session/${sessionId2}/permission/${p.id}/reply`, { decision: decision.allow ? "once" : "reject", ...!decision.allow ? { message: decision.message } : {} });
        } else if (ev.type === "session.text.ended") {
          lastMessage = p.assistantMessageID;
          if (!textByMessage.has(lastMessage)) textByMessage.set(lastMessage, /* @__PURE__ */ new Map());
          textByMessage.get(lastMessage).set(p.ordinal, p.text);
          onEvent2?.({ part: { id: ev.id, type: "text", text: p.text } });
        } else if (ev.type === "session.usage.updated" || ev.type === "session.step.ended") {
          usage = p.tokens;
          costUsd = p.cost;
        } else if (ev.type === "session.execution.failed") {
          failure3 = p.error?.message ?? "opencode session error";
          break;
        } else if (ev.type === "session.execution.succeeded" || ev.type === "session.execution.interrupted") {
          if (ev.type.endsWith("interrupted")) failure3 = "opencode session interrupted";
          break;
        }
      }
      const text3 = [...textByMessage.get(lastMessage) ?? []].sort(([a], [b]) => a - b).map(([, value]) => value).join("");
      if (failure3 && !text3) throw new DelegateError(failure3, "failed", "", "", sessionId2);
      if (!text3 && !failure3) throw new DelegateError("opencode event stream ended without a response", "failed", "", "", sessionId2);
      return { sessionId: sessionId2, text: text3, isError: failure3 !== null, details: { error: failure3, usage, costUsd } };
    }
    const sessionId = req.sessionId ?? (await api("POST", "/session", {})).id;
    req.onSession?.(sessionId);
    knownSession = sessionId;
    const mcpServers = Object.keys(await api("GET", "/mcp").catch(() => null) ?? {});
    const events = await fetch(`${url}/event?${q}`, { headers: { authorization: auth, accept: "text/event-stream" }, signal: ac.signal });
    if (!events.ok || !events.body) throw new DelegateError(`opencode event stream failed: HTTP ${events.status}`, "failed");
    const [providerID, ...rest] = (req.model ?? "").split("/");
    const body = { parts: [{ type: "text", text: req.prompt }] };
    if (req.model && rest.length) body.model = { providerID, modelID: rest.join("/") };
    if (req.effort) body.variant = req.effort;
    await api("POST", `/session/${sessionId}/prompt_async`, body);
    let failure2 = null;
    const onEvent = progressEventHandler("opencode", req.onProgress);
    let alive = false;
    const watchdog = setTimeout(() => {
      if (alive) return;
      failure2 = "opencode did not start working on the prompt within 60 seconds (check the model id and the provider's login).";
      ac.abort();
    }, START_WATCHDOG_MS);
    try {
      for await (const ev of sse(events.body)) {
        const type = String(ev.type ?? "");
        const p = ev.properties ?? {};
        const mine = p.sessionID === sessionId || p.part?.sessionID === sessionId || p.info?.sessionID === sessionId;
        if (mine) alive = true;
        if (type === "session.error" && !p.sessionID) {
          failure2 = String(p.error?.data?.message ?? p.error?.message ?? "opencode reported an error");
          break;
        }
        if (type === "permission.asked" && p.sessionID === sessionId) {
          const decision = await req.onPermission(opencodePermissionRequest(p, mcpServers, req.cwd));
          await api("POST", `/permission/${p.id}/reply`, decision.allow ? { reply: "once" } : { reply: "reject", message: decision.message });
        } else if (type === "message.part.updated" && p.part?.sessionID === sessionId) {
          const part = p.part;
          const ready = part.type === "tool" && (part.state?.status === "running" || part.state?.status === "completed") || part.type === "text" && part.time?.end || part.type === "reasoning" && part.time?.end;
          if (ready) onEvent?.({ part });
        } else if (type === "session.error" && p.sessionID === sessionId) {
          failure2 = String(p.error?.data?.message ?? p.error?.message ?? "opencode session error");
          break;
        } else if (type === "session.idle" && p.sessionID === sessionId || type === "session.status" && p.sessionID === sessionId && p.status?.type === "idle") {
          break;
        }
      }
    } catch (err) {
      if (!failure2) throw err;
    } finally {
      clearTimeout(watchdog);
    }
    if (failure2 && !alive) throw new DelegateError(failure2, "failed", "", "", sessionId);
    const messages = await api("GET", `/session/${sessionId}/message`) ?? [];
    const last = [...messages].reverse().find((m) => m.info?.role === "assistant");
    const text2 = (last?.parts ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
    if (failure2 && !text2) throw new DelegateError(failure2, "failed", "", "", sessionId);
    const tokens = last?.info?.tokens;
    return {
      sessionId,
      text: text2,
      isError: failure2 !== null,
      details: {
        error: failure2,
        usage: tokens ? { input: Number(tokens.input) || 0, output: Number(tokens.output) || 0 } : null,
        costUsd: typeof last?.info?.cost === "number" ? last.info.cost : null
      }
    };
  } catch (err) {
    if (ac.signal.aborted && !(err instanceof DelegateError)) {
      if (req.signal?.aborted) throw new DelegateError("delegate aborted", "aborted", "", "", knownSession);
      const hint = knownSession ? `. The opencode session ${knownSession} keeps its progress: call again with session_id="${knownSession}" (and a longer timeout_sec, or use spawn_opencode) to continue instead of starting over.` : "";
      throw new DelegateError(`delegate timed out after ${req.timeoutSec}s (its time limit, timeout_sec)${hint}`, "timeout", "", "", knownSession);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
    ac.abort();
    await killTree(child);
  }
}

// src/core/codex-appserver.ts
import { spawn as spawn3 } from "node:child_process";
var STEER_HEADER = (from) => `[Message from ${from}, who gave you this task, sent while you work. Apply its instructions and continue the task. Reply only with results, blockers, questions or requested information. Do not send pure acknowledgements or repeat a tool reply as a note.]`;
var SIBLING_STEER_HEADER = '[Message from a sibling job working for the same supervisor. Coordinate within your assigned task. Reply only when adding information, using agent-bridge "send" with to=<from> and reply_to=<id>. Do not send pure acknowledgements.]';
var OPT_OUT = [
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta"
];
var STDERR_TAIL_CHARS2 = 4e3;
var AUTO_REVIEW_COMPLETED = "item/autoApprovalReview/completed";
var AUTO_REVIEW_REFUSALS = /* @__PURE__ */ new Set(["denied", "timedOut", "aborted"]);
var AUTO_REVIEW_ASK_HINT = "(The workspace is read-only on purpose: request escalated permissions when a necessary command or edit is blocked. Codex automatically reviews eligible requests. Refusals go to the supervisor when available; never work around a denial.)";
var STARTUP_TIMEOUT_MS = 18e4;
var CODEX_FULL_ACCESS_APPROVAL_POLICY = {
  granular: { sandbox_approval: false, rules: false, mcp_elicitations: true }
};
function innerCommand(s) {
  const m = /^(?:"[^"]*[\\/]|[^\s"]*[\\/])?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?"?\s+(?:-NoProfile\s+|-NoLogo\s+)*(?:-Command|-lc|-c|\/c)\s+([\s\S]*)$/i.exec(s.trim());
  if (!m) return s;
  const c = m[1].trim();
  return /^'[\s\S]*'$|^"[\s\S]*"$/.test(c) ? c.slice(1, -1) : c;
}
function codexTurnSandbox(sandbox, cwd, roots = [], reported, networkAccess) {
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  const inherited = reported?.type === "workspaceWrite" ? reported : {};
  return {
    ...inherited,
    type: "workspaceWrite",
    writableRoots: [.../* @__PURE__ */ new Set([cwd, ...roots, ...Array.isArray(inherited.writableRoots) ? inherited.writableRoots : []])],
    ...networkAccess !== void 0 ? { networkAccess } : {}
  };
}
function asExecEvent(kind, item) {
  const type = { agentMessage: "agent_message", commandExecution: "command_execution", fileChange: "file_change", mcpToolCall: "mcp_tool_call", webSearch: "web_search", reasoning: "reasoning" }[item?.type] ?? item?.type;
  return { type: kind, item: { ...item, type } };
}
async function delegateToCodexAppServer(req) {
  checkDepth(req.maxDelegateDepth);
  const mappings = codexDriveMappings(`${req.cwd}
${req.prompt}`);
  req = { ...req, prompt: codexExecutionPrompt(codexPathPrompt(req.prompt, mappings), req.sandbox) };
  const cwd = realFolder(req.cwd);
  const env = childEnv(req.extraEnv);
  const startupArgs = req.sandbox === "danger-full-access" ? ["-c", 'sandbox_mode="danger-full-access"'] : [];
  if (process.platform === "win32" && req.sandbox !== "danger-full-access") startupArgs.push("-c", `windows.sandbox="${req.windowsSandbox ?? "unelevated"}"`);
  const { resolved, args, needsShell } = resolveCommand(req.bin, ["app-server", ...startupArgs], env, req.log);
  req.log.debug("starting codex app-server", { bin: resolved, cwd });
  const child = spawn3(resolved, args, { cwd, env: { ...env, PWD: cwd }, shell: needsShell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  trackChild(child, req.log);
  let nextId = 1;
  const pending2 = /* @__PURE__ */ new Map();
  let stderr = "";
  let threadId = req.sessionId ?? null;
  let turnId = null;
  let finalAnswers = new FinalAnswers();
  let usage = null;
  let retryableError = null;
  let finished = () => {
  };
  let turnDone = new Promise((r) => finished = r);
  const approvalsReviewer = req.sandbox === "danger-full-access" ? "user" : req.approvalsReviewer ?? DEFAULT_CODEX_APPROVALS_REVIEWER;
  const reviewed = /* @__PURE__ */ new Set();
  const reviewTasks = [];
  const reviewInputs = [];
  const earlyReviews = [];
  let reviewInterrupted = false;
  const completions = /* @__PURE__ */ new Map();
  const answers = [];
  let awaitingAnswer = false;
  const onEvent = progressEventHandler("codex", req.onProgress);
  const write = (msg) => {
    if (!child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(msg)}
`);
  };
  const request = (method, params) => new Promise((resolve4, reject) => {
    const id = nextId++;
    pending2.set(id, { resolve: resolve4, reject });
    write({ id, method, params });
  });
  const editPaths = /* @__PURE__ */ new Map();
  const denialMessages = [];
  const deliverDenials = async () => {
    if (!threadId || !turnId) return;
    for (const message of denialMessages.splice(0)) {
      try {
        await request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: message, text_elements: [] }] });
      } catch (err) {
        req.log.warn("could not deliver approval denial reason", { message, err: err.message });
        req.onDenied?.(message);
      }
    }
  };
  const decide = async (tool, detail, automaticReview = false) => {
    if (!req.approve) return { allow: false, message: "Denied by agent-bridge: no approval handler is available." };
    try {
      return await req.approve({ agent: "codex", tool, detail, cwd, ...automaticReview ? { automaticReview } : {} });
    } catch (err) {
      return { allow: false, message: `Denied by agent-bridge: approval forwarding failed: ${String(err?.message ?? err)}` };
    }
  };
  const forwardReview = (params) => {
    if (approvalsReviewer !== "auto_review" || req.signal?.aborted || !AUTO_REVIEW_REFUSALS.has(params.review?.status)) return;
    if (!turnId) {
      earlyReviews.push(params);
      return;
    }
    if (params.threadId !== threadId || turnId && params.turnId !== turnId || typeof params.reviewId !== "string" || reviewed.has(params.reviewId)) return;
    reviewed.add(params.reviewId);
    const action = params.action ?? {};
    const tool = action.type === "mcpToolCall" ? `mcp:${action.server}` : action.type === "applyPatch" ? "edit" : action.type === "command" || action.type === "execve" || action.type === "writeStdin" ? "command" : String(action.type ?? "approval");
    const detail = JSON.stringify(action);
    const reason = `Automatic approval review ${params.review.status}: ${params.review.rationale ?? "no rationale supplied"}`;
    req.onProgress?.(`${reason}. ${detail}`);
    if (!req.approve || !req.canApprove) {
      req.onDenied?.(`${reason}. No supervisor approval handler is available. ${detail}`);
      return;
    }
    const pause = reviewInterrupted ? Promise.resolve() : request("turn/interrupt", { threadId, turnId: params.turnId }).catch((err) => req.log.debug("review turn already ended", { err: err.message }));
    reviewInterrupted = true;
    reviewTasks.push((async () => {
      await pause;
      const decision = await decide(tool, `${action.type === "mcpToolCall" ? `tool "${action.toolName}"
` : ""}${reason}
Action: ${detail}
Approve a retry of this exact action? Codex policy still applies.`, true);
      reviewInputs.push(`Supervisor ${decision.allow ? "approved one retry of" : "denied"} this exact action after ${reason}.
Action: ${detail}
${decision.allow ? "Retry only if Codex policy permits; retain automatic review and all sandbox limits. This is not a blanket approval or a policy override." : `Supervisor reason: ${decision.message || "no reason supplied"}
Do not retry or work around this denial. Continue with a materially safer alternative, or report the blocker.`}`);
    })());
  };
  const answerRequest = async (id, method, params) => {
    const reply = (result) => write({ id, result });
    const answer = (decision, result, tool) => {
      reply(result);
      if (!decision.allow) {
        const message = `Approval denied for ${tool}. ${decision.message || "Denied by the approval handler; no reason supplied."}`;
        req.onProgress?.(message);
        denialMessages.push(message);
        void deliverDenials();
      }
    };
    const sandboxDenial = { allow: false, message: "Denied by agent-bridge: this job's access does not allow sandbox escalations; the supervisor was not asked." };
    switch (method) {
      case "mcpServer/elicitation/request": {
        const tool = `mcp:${params.serverName ?? "tool"}`;
        const decision = await decide(tool, String(params.message ?? "an MCP tool call"));
        const props = params.requestedSchema?.properties ?? {};
        const content = Object.fromEntries(Object.entries(props).filter(([, v]) => v && "default" in v).map(([k, v]) => [k, v.default]));
        return answer(decision, decision.allow ? { action: "accept", content } : { action: "decline", content: null }, tool);
      }
      case "item/commandExecution/requestApproval": {
        const decision = req.sandbox === "danger-full-access" ? { allow: true } : req.canApprove || req.askMode || req.sandbox === "workspace-write" ? await decide("command", innerCommand(String(params.command ?? params.reason ?? "a command"))) : sandboxDenial;
        return answer(decision, { decision: decision.allow ? "accept" : "decline" }, "command");
      }
      case "item/fileChange/requestApproval": {
        const paths = editPaths.get(params.itemId) ?? [];
        const decision = req.sandbox === "danger-full-access" ? { allow: true } : req.canApprove || req.askMode || req.sandbox === "workspace-write" ? await decide("edit", paths.length ? paths.join(", ") : String(params.reason ?? "file changes")) : sandboxDenial;
        return answer(decision, { decision: decision.allow ? "accept" : "decline" }, "edit");
      }
      case "item/permissions/requestApproval": {
        const decision = req.canApprove || req.askMode || req.sandbox === "workspace-write" ? await decide("permissions", `${params.reason ?? "additional permissions"}
${JSON.stringify(params.permissions ?? {})}`) : sandboxDenial;
        return answer(decision, { permissions: decision.allow ? params.permissions ?? {} : {}, scope: "turn" }, "permissions");
      }
      default:
        req.log.warn("codex app-server request refused", { method });
        return write({ id, error: { code: -32601, message: "not supported by agent-bridge" } });
    }
  };
  const handle = (msg) => {
    if (msg.id !== void 0 && msg.method === void 0) {
      const p = pending2.get(msg.id);
      if (!p) return;
      pending2.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "app-server error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== void 0 && msg.method) {
      void answerRequest(msg.id, msg.method, msg.params ?? {});
      return;
    }
    const params = msg.params ?? {};
    switch (msg.method) {
      case AUTO_REVIEW_COMPLETED:
        forwardReview(params);
        break;
      case "item/started":
        onEvent?.(asExecEvent("item.started", params.item));
        if (params.item?.type === "fileChange") editPaths.set(params.item.id, (params.item.changes ?? []).map((c) => c?.path).filter(Boolean));
        break;
      case "item/completed": {
        if (turnId && params.turnId && params.turnId !== turnId) break;
        const item = params.item ?? {};
        onEvent?.(asExecEvent("item.completed", item));
        if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
          finalAnswers.add(item);
          if (awaitingAnswer) {
            awaitingAnswer = false;
            answers.push(item.text);
            req.live?.onAnswer(item.text);
          }
        }
        break;
      }
      case "thread/tokenUsage/updated":
        usage = params.tokenUsage?.total ?? params.total ?? usage;
        break;
      case "error":
        if (!params.willRetry) retryableError = params.error?.message ?? "error";
        break;
      case "turn/completed":
        completions.set(String(params.turn?.id), { status: String(params.turn?.status ?? "completed"), error: params.turn?.error?.message ?? null });
        if (turnId && completions.has(turnId)) finished(completions.get(turnId));
        break;
    }
  };
  let buf = "";
  child.stdout.setEncoding("utf8").on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      try {
        handle(JSON.parse(line));
      } catch (err) {
        req.log.debug("bad app-server line", { err: err.message });
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (d) => {
    stderr = (stderr + d).slice(-STDERR_TAIL_CHARS2);
  });
  const exited = new Promise((_, reject) => {
    child.on("error", (err) => reject(new DelegateError(`failed to start ${req.bin}: ${err.message}`, "failed", "", "", threadId)));
    child.on("exit", (code, signal) => reject(new DelegateError(`codex app-server ${signal ? "was terminated externally" : turnId && !completions.has(turnId) ? "was terminated externally or exited unexpectedly" : "ended"} (${exitDescription({ code, signal })})`, "failed", stderr, "", threadId)));
  });
  exited.catch(() => {
  });
  let timer;
  const stopped = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DelegateError(`delegate timed out after ${req.timeoutSec}s (its time limit, timeout_sec)`, "timeout", stderr, "", threadId)), req.timeoutSec * 1e3);
    req.signal?.addEventListener("abort", () => reject(new DelegateError("delegate aborted", "aborted", "", "", threadId)), { once: true });
  });
  stopped.catch(() => {
  });
  const race = (p) => Promise.race([p, exited, stopped]);
  let step = "initialize";
  let startupTimer;
  const startup = new Promise((_, reject) => {
    startupTimer = setTimeout(
      () => reject(DelegateError.startup(`codex app-server did not answer ${step} within ${Math.round((req.startupTimeoutMs ?? STARTUP_TIMEOUT_MS) / 1e3)}s (startup timeout)`, stderr, threadId)),
      req.startupTimeoutMs ?? STARTUP_TIMEOUT_MS
    );
  });
  startup.catch(() => {
  });
  const boot = (p) => Promise.race([p, exited, stopped, startup]);
  const steering = {
    rename: async (title) => {
      if (threadId) await race(request("thread/name/set", { threadId, name: title }));
    },
    send: async (message, sibling = false) => {
      if (!threadId || !turnId) return false;
      try {
        const header = sibling ? SIBLING_STEER_HEADER : STEER_HEADER(req.live?.from ?? "the session that started you");
        await request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: `${header}

${message}`, text_elements: [] }] });
        if (!sibling) awaitingAnswer = true;
        return true;
      } catch (err) {
        req.log.info("steering refused; the turn has ended", { err: err.message });
        return false;
      }
    }
  };
  let stopReason = "codex turn completed";
  try {
    await boot(request("initialize", { clientInfo: { name: "agent-bridge", title: "agent-bridge", version: APP_VERSION }, capabilities: { experimentalApi: req.sandbox === "danger-full-access", optOutNotificationMethods: OPT_OUT } }));
    write({ method: "initialized", params: {} });
    const approvalPolicy = req.sandbox === "danger-full-access" ? CODEX_FULL_ACCESS_APPROVAL_POLICY : "on-request";
    const config = codexSubagentConfig(req.nativeSubagents);
    if (process.platform === "win32" && req.sandbox !== "danger-full-access") config["windows.sandbox"] = req.windowsSandbox ?? "unelevated";
    if (req.sandbox === "workspace-write" && (req.writableRoots?.length || req.networkAccess !== void 0)) {
      config.sandbox_workspace_write = {
        ...req.writableRoots?.length ? { writable_roots: req.writableRoots.map(realFolder) } : {},
        ...req.networkAccess !== void 0 ? { network_access: req.networkAccess } : {}
      };
    }
    if (req.effort) config.model_reasoning_effort = req.effort;
    const threadParams = { cwd, sandbox: req.sandbox, approvalPolicy, approvalsReviewer, ...Object.keys(config).length ? { config } : {}, ...req.model ? { model: req.model } : {} };
    step = req.sessionId ? "thread/resume" : "thread/start";
    const thread = req.sessionId ? await boot(request("thread/resume", { ...threadParams, threadId: req.sessionId, excludeTurns: true })) : await boot(request("thread/start", threadParams));
    threadId = thread?.thread?.id ?? threadId;
    if (threadId) req.onSession?.(threadId);
    if (threadId && req.title) {
      step = "thread/name/set";
      await boot(request("thread/name/set", { threadId, name: req.title })).catch((err) => req.log.warn("could not name the Codex thread", { err: err.message }));
    }
    if (typeof thread?.model === "string")
      req.onInfo?.({
        model: thread.model,
        effort: req.effort ?? (typeof thread.reasoningEffort === "string" ? thread.reasoningEffort : null),
        // The sandbox Codex really applies to this thread (its config can differ from what was asked).
        permission: typeof thread.sandbox?.type === "string" ? thread.sandbox.type : null
      });
    const prompt = req.askMode && req.sandbox !== "danger-full-access" ? `${req.prompt}

${approvalsReviewer === "auto_review" ? AUTO_REVIEW_ASK_HINT : CODEX_ASK_HINT}` : req.prompt;
    step = "turn/start";
    const sandboxPolicy = codexTurnSandbox(req.sandbox, cwd, req.writableRoots?.map(realFolder), thread?.sandbox, req.networkAccess);
    const startTurn = (text2) => request("turn/start", {
      threadId,
      input: [{ type: "text", text: text2, text_elements: [] }],
      ...req.model ? { model: req.model } : {},
      sandboxPolicy,
      approvalPolicy,
      approvalsReviewer,
      ...req.effort ? { effort: req.effort } : {}
    });
    const turn = await boot(startTurn(prompt));
    req.onInfo?.({ model: req.model ?? thread?.model ?? null, permission: req.sandbox, effort: req.effort ?? (typeof thread?.reasoningEffort === "string" ? thread.reasoningEffort : null) });
    turnId = turn?.turn?.id ?? null;
    for (const review of earlyReviews.splice(0)) forwardReview(review);
    void deliverDenials();
    clearTimeout(startupTimer);
    if (turnId && completions.has(turnId)) finished(completions.get(turnId));
    req.live?.onSteering(steering);
    let outcome = await race(turnDone);
    while (reviewTasks.length) {
      while (reviewTasks.length) await race(Promise.all(reviewTasks.splice(0)));
      if (!reviewInputs.length) break;
      turnId = null;
      retryableError = null;
      reviewInterrupted = false;
      finalAnswers = new FinalAnswers();
      turnDone = new Promise((r) => finished = r);
      const continuation = await race(startTurn(reviewInputs.splice(0).join("\n\n")));
      turnId = continuation?.turn?.id ?? null;
      for (const review of earlyReviews.splice(0)) forwardReview(review);
      if (turnId && completions.has(turnId)) finished(completions.get(turnId));
      outcome = await race(turnDone);
    }
    req.live?.onSteering(null);
    const error = outcome.error ?? (outcome.status === "failed" ? retryableError ?? "turn failed" : null);
    req.log.info("codex turn ended", { threadId, turnId, status: outcome.status, error: outcome.error, retryableError });
    if (outcome.status === "interrupted") throw new DelegateError(`codex interrupted the turn${outcome.error ? `: ${outcome.error}` : ""}`, "failed", stderr, "", threadId);
    if (error && !finalAnswers.text()) throw new DelegateError(error, "failed", stderr, "", threadId);
    req.log.info("codex delegate finished", { threadId, status: outcome.status });
    return { sessionId: threadId, text: finalAnswers.text(), isError: Boolean(error), details: { usage, error, answers: answers.length } };
  } catch (err) {
    stopReason = err instanceof DelegateError ? `codex delegate ${err.kind}` : "codex delegate failed";
    req.live?.onSteering(null);
    if (threadId && turnId) await Promise.race([request("turn/interrupt", { threadId, turnId }).catch(() => {
    }), new Promise((r) => setTimeout(r, 2e3))]);
    if (err instanceof DelegateError) {
      err.sessionId = err.sessionId ?? threadId;
      throw err;
    }
    throw new DelegateError(err.message, "failed", stderr, "", threadId);
  } finally {
    for (const message of denialMessages.splice(0)) req.onDenied?.(message);
    clearTimeout(timer);
    clearTimeout(startupTimer);
    for (const p of pending2.values()) p.reject(new Error("closed"));
    child.stdin.end();
    await killTree(child, stopReason);
  }
}

// src/mcp/targets.ts
var nativeSubagentsSchema = external_exports.number().int().min(0).max(MAX_CODEX_SUBAGENTS).optional().describe(`Maximum concurrent native Codex child threads per job (0 disables). Default: config codexSubagents (${DEFAULT_CODEX_SUBAGENTS}). Separate from bridge maxJobs/depth. Changes apply from the next turn.`);
var CODEX_EXEC_ENV = "AGENT_BRIDGE_CODEX_EXEC";
var ACCESS_LEVELS = ["read", "ask", "edit"];
var CODEX_SANDBOX_FOR = { read: "read-only", ask: "read-only", edit: "workspace-write" };
var CLAUDE_MODE_FOR = { read: "manual", ask: "manual", edit: "acceptEdits" };
var OPENCODE_AUTO_FOR = { read: false, ask: false, edit: true };
function claudeModeFor(cfg, a) {
  return a.permission_mode ?? (a.access ? CLAUDE_MODE_FOR[a.access] : cfg.claudePermissionMode);
}
function supportsAsk(target, relay) {
  if (target === "antigravity") return true;
  if (!relay) return false;
  if (target === "opencode") return true;
  if (target === "codex") return process.env[CODEX_EXEC_ENV] !== "1" || relay.codexHookTrusted;
  return false;
}
function opencodeEditAsks(base, a) {
  return a.access === "edit" && a.auto_approve === void 0 && Boolean(base.approve && base.canApprove);
}
var DELEGATION_TARGETS = {
  antigravity: {
    title: "Google Antigravity CLI (agy)",
    modelExample: 'a slug from agy models, e.g. "gemini-3.8-flash-low"',
    effortExample: '"low", "medium", "high", "xhigh" or "max" (model-dependent)',
    defaultModel: (cfg) => cfg.antigravityModel,
    schema: {
      terminal_sandbox: external_exports.boolean().optional().describe("Enable agy's terminal sandbox (separate from read/ask tool permissions)"),
      bypass_permissions: external_exports.boolean().optional().describe("Exact Antigravity permission override: true bypasses native approvals, false retains native policy. Overrides read/ask access; handoff restrictions remain.")
    },
    permissionNote: () => "Requires the installed agent-bridge Antigravity plugin. Read denies non-reading tools; ask relays them; edit retains native policy. Idle TUI mail waits for the next turn.",
    permission: (_cfg, a) => a.bypass_permissions === void 0 ? a.access ?? "read" : a.bypass_permissions ? "bypass" : "native",
    run: async (cfg, base, a) => {
      return delegateToAntigravity({ ...base, bin: cfg.antigravityBin, access: a.bypass_permissions === void 0 ? a.access ?? "read" : "edit", autoApprove: a.bypass_permissions, sandbox: a.terminal_sandbox, extraEnv: { ...base.extraEnv, ...a.relay?.env ?? {} } });
    }
  },
  codex: {
    title: "OpenAI Codex",
    modelExample: '"gpt-6-sol"',
    effortExample: '"low", "medium", "high", "xhigh", "max" or "ultra" (depends on the model)',
    defaultModel: (cfg) => cfg.codexModel,
    schema: {
      native_subagents: nativeSubagentsSchema,
      sandbox: external_exports.enum(CODEX_SANDBOXES).optional().describe("Overrides access with an exact Codex sandbox mode"),
      approvals_reviewer: external_exports.enum(CODEX_APPROVALS_REVIEWERS).optional().describe("Codex reviewer: auto_review (approve for me, default) or user (forward approvals). Does not change the sandbox.")
    },
    permissionNote: (cfg) => `Codex runs in the "${cfg.codexSandbox}" sandbox unless you pass access or sandbox. Worktree edit runs use "${cfg.codexWorktreeSandbox ?? (cfg.codexSandbox === "read-only" ? "workspace-write" : cfg.codexSandbox)}" (config codexWorktreeSandbox); workspace-write can restrict builds and network access.${codexEnvironmentNote()}`,
    permission: (cfg, a) => a.sandbox ?? (a.access ? CODEX_SANDBOX_FOR[a.access] : cfg.codexSandbox),
    run: async (cfg, base, a) => {
      base = { ...base, nativeSubagents: a.native_subagents ?? cfg.codexSubagents };
      const sandbox = a.sandbox ?? (a.access ? CODEX_SANDBOX_FOR[a.access] : cfg.codexSandbox);
      const relay = a.access === "ask" && Boolean(a.relay?.codexHookTrusted);
      if (process.env[CODEX_EXEC_ENV] !== "1") {
        let sessionId = base.sessionId ?? null;
        for (let attempt = 1; ; attempt++) {
          try {
            return await delegateToCodexAppServer({ ...base, sessionId, bin: cfg.codexBin, sandbox, windowsSandbox: cfg.codexWindowsSandbox, approvalsReviewer: a.approvals_reviewer ?? cfg.codexApprovalsReviewer, networkAccess: cfg.codexWorkspaceWriteNetworkAccess ?? void 0, writableRoots: base.writableRoots, askMode: a.access === "ask", approve: a.access === "ask" && a.relay ? a.relay.onPermission : base.approve });
          } catch (err) {
            if (err instanceof DelegateError && err.startupFailed && attempt === 1 && !base.signal?.aborted) {
              base.log.warn("codex app-server startup timed out; retrying once", { err: err.message });
              base.onProgress?.(`${err.message}; retrying once`);
              sessionId = err.sessionId ?? sessionId;
              continue;
            }
            if (!(err instanceof DelegateError) || err.kind !== "failed" || err.sessionId) throw err;
            base.log.warn("codex app-server unavailable, using codex exec", { err: err.message });
            break;
          }
        }
      }
      return delegateToCodex({
        ...base,
        bin: cfg.codexBin,
        sandbox,
        windowsSandbox: cfg.codexWindowsSandbox,
        networkAccess: cfg.codexWorkspaceWriteNetworkAccess ?? void 0,
        ...relay ? { relayApprovals: true, extraEnv: { ...base.extraEnv, ...a.relay.env } } : {}
      });
    }
  },
  claude: {
    title: "Claude Code",
    modelExample: '"opus", "sonnet" or a full model id',
    effortExample: '"low", "medium", "high", "xhigh" or "max"',
    defaultModel: (cfg) => cfg.claudeModel,
    schema: { permission_mode: external_exports.enum(CLAUDE_PERMISSION_MODES).optional().describe("Overrides access with an exact Claude permission mode") },
    permissionNote: (cfg) => `Claude runs with permission mode "${cfg.claudePermissionMode}" unless you pass access or permission_mode.`,
    permission: (cfg, a) => claudeModeFor(cfg, a),
    run: (cfg, base, a) => delegateToClaude({
      ...base,
      bin: cfg.claudeBin,
      permissionMode: claudeModeFor(cfg, a)
    })
  },
  opencode: {
    title: "opencode",
    effortExample: `the model's variant, such as "low", "high" or "max" (provider-specific)`,
    modelExample: '"provider/model", e.g. "anthropic/claude-sonnet-5" or "opencode/muse-spark-1.3-contributor-free"',
    defaultModel: (cfg) => cfg.opencodeModel,
    schema: { auto_approve: external_exports.boolean().optional().describe("Overrides access: auto-approve every opencode permission request (opencode run --auto)") },
    permissionNote: (cfg) => cfg.opencodeAutoApprove ? "opencode auto-approves permission requests unless you pass access=read or auto_approve=false." : "Headless opencode rejects every permission request (edits, commands) unless you pass access=edit or auto_approve=true.",
    permission: (cfg, a) => a.auto_approve ?? (a.access ? OPENCODE_AUTO_FOR[a.access] : cfg.opencodeAutoApprove) ? "auto-approve" : "read-only",
    run: async (cfg, base, a) => {
      let note = null;
      if (base.model) {
        const models = await listOpencodeModels(cfg.opencodeBin, base.cwd, base.log).catch(() => []);
        const r = resolveOpencodeModel(base.model, models);
        if ("error" in r) throw new DelegateError(r.error, "failed");
        base = { ...base, model: r.model };
        note = r.note;
      }
      const res = a.access === "ask" && a.auto_approve === void 0 && supportsAsk("opencode", a.relay) ? await delegateToOpencodeServed({ ...base, bin: cfg.opencodeBin, onPermission: a.relay.onPermission }) : opencodeEditAsks(base, a) ? (
        // "edit": what the user's opencode rules leave to "ask" (MCP tools, folders outside the project,
        // commands they marked) goes to the parent instead of `opencode run --auto` approving it blindly.
        await delegateToOpencodeServed({ ...base, bin: cfg.opencodeBin, onPermission: base.approve, permissions: null })
      ) : await delegateToOpencode({
        ...base,
        bin: cfg.opencodeBin,
        autoApprove: a.auto_approve ?? (a.access ? OPENCODE_AUTO_FOR[a.access] : cfg.opencodeAutoApprove)
      });
      return note ? { ...res, text: `(${note})

${res.text}` } : res;
    }
  }
};

// src/mcp/job-settings.ts
var JOB_SETTING_KEYS = ["native_subagents", "model", "effort", "access", "sandbox", "terminal_sandbox", "bypass_permissions", "approvals_reviewer", "permission_mode", "auto_approve"];
var EXACT_PERMISSION_KEYS = ["sandbox", "permission_mode", "auto_approve", "bypass_permissions"];
var PERMISSION_KEY_AGENT = { native_subagents: "codex", sandbox: "codex", terminal_sandbox: "antigravity", bypass_permissions: "antigravity", approvals_reviewer: "codex", permission_mode: "claude", auto_approve: "opencode" };
var EFFORT_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
function changedJobArgs(args, settings) {
  const next = { ...args };
  if (settings.access !== void 0) for (const key of EXACT_PERMISSION_KEYS) delete next[key];
  else if (EXACT_PERMISSION_KEYS.some((key) => settings[key] !== void 0)) delete next.access;
  for (const key of JOB_SETTING_KEYS) if (settings[key] !== void 0) next[key] = settings[key];
  return next;
}
function parseJobSettings(input, agent) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "settings must be an object";
  const raw = input;
  const unknownKey = Object.keys(raw).find((key) => !JOB_SETTING_KEYS.includes(key));
  if (unknownKey) return `unknown setting: ${unknownKey}`;
  const settings = {};
  if (raw.native_subagents !== void 0) {
    if (typeof raw.native_subagents !== "number" || !Number.isInteger(raw.native_subagents) || raw.native_subagents < 0 || raw.native_subagents > MAX_CODEX_SUBAGENTS) return "invalid native_subagents";
    settings.native_subagents = raw.native_subagents;
  }
  if (raw.model !== void 0) {
    if (typeof raw.model !== "string" || !MODEL_NAME_PATTERN.test(raw.model)) return "invalid model";
    settings.model = raw.model;
  }
  if (raw.effort !== void 0) {
    if (typeof raw.effort !== "string" || !EFFORT_PATTERN.test(raw.effort)) return "invalid effort";
    if (agent === "antigravity" && !ANTIGRAVITY_EFFORTS.includes(raw.effort)) return "Antigravity effort must be low, medium, high, xhigh or max";
    settings.effort = raw.effort;
  }
  if (raw.access !== void 0) {
    if (!ACCESS_LEVELS.includes(raw.access)) return "invalid access";
    settings.access = raw.access;
  }
  if (raw.sandbox !== void 0) {
    if (!CODEX_SANDBOXES.includes(raw.sandbox)) return "invalid sandbox";
    settings.sandbox = raw.sandbox;
  }
  if (raw.approvals_reviewer !== void 0) {
    if (!CODEX_APPROVALS_REVIEWERS.includes(raw.approvals_reviewer)) return "invalid approvals_reviewer";
    settings.approvals_reviewer = raw.approvals_reviewer;
  }
  if (raw.permission_mode !== void 0) {
    if (!CLAUDE_PERMISSION_MODES.includes(raw.permission_mode)) return "invalid permission_mode";
    settings.permission_mode = raw.permission_mode;
  }
  if (raw.auto_approve !== void 0) {
    if (typeof raw.auto_approve !== "boolean") return "invalid auto_approve";
    settings.auto_approve = raw.auto_approve;
  }
  if (raw.terminal_sandbox !== void 0) {
    if (typeof raw.terminal_sandbox !== "boolean") return "invalid terminal_sandbox";
    settings.terminal_sandbox = raw.terminal_sandbox;
  }
  if (raw.bypass_permissions !== void 0) {
    if (typeof raw.bypass_permissions !== "boolean") return "invalid bypass_permissions";
    settings.bypass_permissions = raw.bypass_permissions;
  }
  for (const [key, owner] of Object.entries(PERMISSION_KEY_AGENT)) {
    if (settings[key] !== void 0 && agent !== owner) return `${key} applies only to ${owner} jobs.`;
  }
  if (!Object.keys(settings).length) return "no settings given";
  return settings;
}

// src/core/notifications.ts
import { spawn as spawn4 } from "node:child_process";
import { mkdirSync, readFileSync as readFileSync5, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join as join6 } from "node:path";
var TITLE = "agent-bridge";
var TEXT = {
  approvals: "A subagent needs approval. Open the agent-bridge dashboard.",
  finish: "A subagent finished. Open the agent-bridge dashboard for its report.",
  fail: "A subagent failed. Open the agent-bridge dashboard for its report."
};
var NOTIFICATION_TIMEOUT_MS = 5e3;
var EVENT_INTERVAL_MS = 5e3;
var RATE_WINDOW_MS = 6e4;
var MAX_NOTIFICATIONS_PER_WINDOW = 10;
var MAX_RATE_HOMES = 100;
var RATE_STATE_FILE = "notification-rate.json";
var RATE_LOCK_DIR = "notification-rate.lock";
var WINDOWS_POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
function notificationCommands(platform, event) {
  const body = TEXT[event];
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
      "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
      `$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${TITLE}</text><text>${body}</text></binding></visual></toast>')`,
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_POWERSHELL_APP_ID}').Show($toast)`
    ].join("; ");
    return [{ bin: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] }];
  }
  if (platform === "darwin") return [
    { bin: "terminal-notifier", args: ["-title", TITLE, "-message", body] },
    { bin: "osascript", args: ["-e", `display notification "${body}" with title "${TITLE}"`] }
  ];
  if (platform === "linux") return [{ bin: "notify-send", args: ["--app-name", TITLE, "--", TITLE, body] }];
  return [];
}
var NotificationLimiter = class {
  homes = /* @__PURE__ */ new Map();
  take(home, event, now = Date.now()) {
    let state = this.homes.get(home);
    if (!state) {
      if (this.homes.size >= MAX_RATE_HOMES) this.homes.delete(this.homes.keys().next().value);
      state = { times: [], events: {} };
      this.homes.set(home, state);
    }
    state.times = state.times.filter((at) => now - at < RATE_WINDOW_MS);
    const last = state.events[event];
    if (last !== void 0 && now - last < EVENT_INTERVAL_MS || state.times.length >= MAX_NOTIFICATIONS_PER_WINDOW) return false;
    state.times.push(now);
    state.events[event] = now;
    return true;
  }
};
var limiter = new NotificationLimiter();
function takeNotificationSlot(home, event, now = Date.now()) {
  const lock = join6(home, RATE_LOCK_DIR);
  try {
    try {
      mkdirSync(lock);
    } catch {
      if (now - statSync(lock).mtimeMs < NOTIFICATION_TIMEOUT_MS) return false;
      rmdirSync(lock);
      mkdirSync(lock);
    }
  } catch {
    return false;
  }
  try {
    const file = join6(home, RATE_STATE_FILE);
    let state = { times: [], events: {} };
    try {
      const stored = JSON.parse(readFileSync5(file, "utf8"));
      if (Array.isArray(stored.times) && stored.times.every((at) => typeof at === "number") && stored.events && typeof stored.events === "object") state = stored;
    } catch {
    }
    state.times = state.times.filter((at) => now - at < RATE_WINDOW_MS);
    const last = state.events[event];
    if (typeof last === "number" && now - last < EVENT_INTERVAL_MS || state.times.length >= MAX_NOTIFICATIONS_PER_WINDOW) return false;
    state.times.push(now);
    state.events[event] = now;
    writeFileSync(file, JSON.stringify(state), { mode: 384 });
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmdirSync(lock);
    } catch {
    }
  }
}
function launch(commands, log) {
  const command = commands[0];
  if (!command) return;
  try {
    const child = spawn4(command.bin, command.args, { stdio: "ignore", windowsHide: true, detached: true });
    const timer = setTimeout(() => child.kill(), NOTIFICATION_TIMEOUT_MS);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
    child.once("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT" && commands.length > 1) launch(commands.slice(1), log);
      else log.debug("desktop notification unavailable");
    });
    child.unref();
  } catch {
    log.debug("desktop notification unavailable");
  }
}
function questionNotificationCommands(platform, dashboardUrl, sound = true) {
  const url = new URL(dashboardUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || [...url.searchParams.keys()].join(",") !== "t" || !/^#\/approvals\?question=[0-9a-f-]{36}$/.test(url.hash) || !/^[0-9a-f]{48}$/.test(url.searchParams.get("t") ?? "")) throw new Error("Invalid question dashboard link");
  const body = "A question needs your answer. Click to answer in agent-bridge.";
  if (platform === "win32") {
    const xmlUrl = dashboardUrl.replaceAll("&", "&amp;");
    const command = notificationCommands(platform, "approvals")[0];
    const script = Buffer.from(command.args.at(-1), "base64").toString("utf16le").replace("<toast>", `<toast activationType="protocol" launch="${xmlUrl}">`).replace(TEXT.approvals, body).replace("</toast>", `${sound ? '<audio src="ms-winsoundevent:Notification.Default"/>' : '<audio silent="true"/>'}</toast>`);
    return [{ ...command, args: [...command.args.slice(0, -1), Buffer.from(script, "utf16le").toString("base64")] }];
  }
  if (platform === "darwin") return [
    { bin: "terminal-notifier", args: ["-title", TITLE, "-message", body, "-open", dashboardUrl, ...sound ? ["-sound", "default"] : []] },
    { bin: "osascript", args: ["-e", `display notification "${body}" with title "${TITLE}"${sound ? ' sound name "Glass"' : ""}`] }
  ];
  if (platform === "linux") return [{ bin: "notify-send", args: ["--app-name", TITLE, "--expire-time=15000", "--action=answer=Answer", "--wait", "--hint", sound ? "string:sound-name:message-new-instant" : "boolean:suppress-sound:true", "--", TITLE, body] }];
  return [];
}
function notifyOwnerQuestion(url, log, sound = true) {
  if (process.platform !== "linux") {
    launch(questionNotificationCommands(process.platform, url, sound), log);
    return;
  }
  const command = questionNotificationCommands("linux", url, sound)[0];
  const child = spawn4(command.bin, command.args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const timer = setTimeout(() => child.kill(), 2e4);
  timer.unref();
  let action = "";
  child.stdout.on("data", (data) => {
    action = (action + String(data)).slice(0, 100);
  });
  child.once("exit", () => {
    clearTimeout(timer);
    if (action.trim() === "answer") {
      const opener = spawn4("xdg-open", [url], { stdio: "ignore", detached: true });
      opener.on("error", () => log.debug("question link opener unavailable"));
      opener.unref();
    }
  });
  child.once("error", () => {
    clearTimeout(timer);
    log.debug("desktop notification unavailable");
  });
  child.unref();
}
function notifyJobEvent(home, event, log) {
  const task = setImmediate(() => {
    try {
      if (!loadConfig(home, "other", log).notifications[event] || !limiter.take(home, event) || !takeNotificationSlot(home, event)) return;
      launch(notificationCommands(process.platform, event), log);
    } catch {
      log.debug("desktop notification unavailable");
    }
  });
  task.unref();
}

// src/core/root-concurrency.ts
import { createHash } from "node:crypto";
import { join as join7 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay2 } from "node:timers/promises";
var ROOT_LIMIT_DB = "root-limits.sqlite";
var LOCK_WAIT_MS = 3e3;
var RootConcurrency = class {
  constructor(home, rootSession) {
    this.rootSession = rootSession;
    this.resource = `root-${createHash("sha256").update(rootSession).digest("hex").slice(0, 40)}`;
    this.slots = new ResourceSlots(home);
    this.db = new DatabaseSync(join7(home, ROOT_LIMIT_DB));
    configureSqlite(this.db);
    this.db.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}; CREATE TABLE IF NOT EXISTS root_limits (root TEXT PRIMARY KEY, capacity INTEGER NOT NULL);`);
  }
  rootSession;
  slots;
  db;
  resource;
  setLimit(capacity) {
    this.db.prepare("INSERT INTO root_limits(root, capacity) VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET capacity = excluded.capacity").run(this.rootSession, capacity);
  }
  ensureLimit(capacity) {
    this.db.prepare("INSERT INTO root_limits(root, capacity) VALUES (?, ?) ON CONFLICT(root) DO NOTHING").run(this.rootSession, capacity);
  }
  limit() {
    return Number(this.db.prepare("SELECT capacity FROM root_limits WHERE root = ?").get(this.rootSession)?.capacity ?? 0);
  }
  available() {
    return this.slots.list().filter((s) => s.resource === this.resource && s.held).length < this.limit();
  }
  acquire(owner) {
    const limit = this.limit();
    if (limit < 1) return false;
    if (this.slots.tryAcquire(this.resource, limit, owner)) return true;
    this.slots.release(owner, this.resource);
    return false;
  }
  /** Keep a FIFO ticket while another coordinator is using the same root's capacity. */
  async acquireWhenAvailable(owner, signal) {
    try {
      for (; ; ) {
        signal.throwIfAborted();
        try {
          const limit = this.limit();
          if (limit > 0 && this.slots.tryAcquire(this.resource, limit, owner)) return;
        } catch (err) {
          if (!isSqliteBusy(err)) throw err;
        }
        await delay2(250, void 0, { signal });
      }
    } catch (err) {
      this.release(owner);
      throw err;
    }
  }
  moveJobs(names) {
    this.slots.moveJobs(this.resource, names);
  }
  // Lease ids are unique per turn. A handoff may have moved their resource since acquisition.
  release(owner) {
    this.slots.release(owner);
  }
  renew(owner) {
    this.slots.renew(owner);
  }
  close() {
    this.slots.close();
    this.db.close();
  }
};

// src/core/job-recovery.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { join as join8 } from "node:path";

// src/core/job-recovery-feed.ts
import { open as open2, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as yieldIO } from "node:timers/promises";
var CACHE_BYTES = 64 * 1024 * 1024;
var CACHE_ENTRIES = 512;
var snapshots = /* @__PURE__ */ new Map();
var pending = /* @__PURE__ */ new Map();
var cachedBytes = 0;
function signature(st) {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}
async function scan(file) {
  const handle = await open2(file, "r");
  try {
    const identity = signature(await handle.stat()), decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024), prompt = [], fragments = [];
    let header = "", first = true, finished = false;
    const line = (text2) => {
      if (first) {
        header = text2;
        first = false;
      } else if (text2.trim() === "---") finished = true;
      else prompt.push(text2.replace(/^ {9}/, ""));
    };
    const consume = (text2) => {
      let start = 0;
      while (!finished) {
        const end = text2.indexOf("\n", start);
        if (end < 0) {
          if (start < text2.length) fragments.push(text2.slice(start));
          break;
        }
        fragments.push(text2.slice(start, end));
        line(fragments.join(""));
        fragments.length = 0;
        start = end + 1;
      }
    };
    while (!finished) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) {
        consume(decoder.end());
        if (!finished && fragments.length) line(fragments.join(""));
        break;
      }
      consume(decoder.write(buffer.subarray(0, bytesRead)));
      await yieldIO();
    }
    if (!finished) throw new Error("Retained run feed has no complete prompt separator");
    const value = { header, prompt: prompt.join("\n") };
    const stable = signature(await handle.stat()) === identity && signature(await stat(file)) === identity;
    if (!stable) throw new Error("Retained run feed changed during recovery");
    return { value, signature: identity };
  } finally {
    await handle.close();
  }
}
async function readRecoveryHeader(file) {
  let identity;
  try {
    identity = signature(await stat(file));
  } catch {
    return void 0;
  }
  const cached = snapshots.get(file);
  if (cached?.signature === identity) {
    snapshots.delete(file);
    snapshots.set(file, cached);
    return { ...cached.value };
  }
  const key = `${file}\0${identity}`, active = pending.get(key);
  if (active) {
    const value2 = await active;
    return value2 ? { ...value2 } : void 0;
  }
  const read = (async () => {
    try {
      const result = await scan(file), bytes = Buffer.byteLength(result.value.header) + Buffer.byteLength(result.value.prompt);
      if (result.signature && bytes <= CACHE_BYTES) {
        const prior = snapshots.get(file);
        if (prior) cachedBytes -= prior.bytes;
        snapshots.delete(file);
        snapshots.set(file, { ...result, bytes });
        cachedBytes += bytes;
        while (cachedBytes > CACHE_BYTES || snapshots.size > CACHE_ENTRIES) {
          const oldest = snapshots.keys().next().value;
          cachedBytes -= snapshots.get(oldest).bytes;
          snapshots.delete(oldest);
        }
      }
      return result.value;
    } catch {
      return void 0;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, read);
  const value = await read;
  return value ? { ...value } : void 0;
}

// src/core/job-recovery.ts
function runStart(run) {
  if (run.meta.jobStartedAt !== void 0) return run.meta.jobStartedAt;
  const stamp = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(run.name);
  return stamp ? Date.UTC(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5], +stamp[6]) : run.updatedAt;
}
function recoverJobRecord(home, ref) {
  const recovery = prepareRecovery(home, ref);
  if (!recovery) return void 0;
  let payload = { prompt: "", header: "" };
  if (needsHeader(recovery) && recovery.run) {
    try {
      const lines = readFileSync6(recovery.run.file, "utf8").split("\n"), end = lines.findIndex((line) => line.trim() === "---");
      payload = { header: lines[0] ?? "", prompt: end > 0 ? lines.slice(1, end).map((line) => line.replace(/^ {9}/, "")).join("\n") : "" };
    } catch {
    }
  }
  return finishRecovery(home, recovery, payload);
}
async function recoverJobRecordAsync(home, ref) {
  const recovery = await prepareRecoveryAsync(home, ref);
  if (!recovery) return void 0;
  const payload = needsHeader(recovery) && recovery.run ? await readRecoveryHeader(recovery.run.file) : { prompt: "", header: "" };
  if (!payload) return void 0;
  const latest = await prepareRecoveryAsync(home, ref);
  if (!latest) return void 0;
  if (!needsHeader(latest)) return finishRecovery(home, latest, { prompt: "", header: "" });
  if (latest.run?.file !== recovery.run?.file || latest.run?.signature !== recovery.run?.signature || contextIdentity(latest) !== contextIdentity(recovery)) return void 0;
  return finishRecovery(home, latest, payload);
}
function prepareRecovery(home, ref) {
  const id = recoveryId(ref);
  if (!id) return void 0;
  const history = findHistoryJob(home, ref, id);
  const { spec, launch: launch2 } = recoverySpec(home, id);
  return selectRecovery(ref, id, history, spec, launch2, readRunLogs(home));
}
async function prepareRecoveryAsync(home, ref) {
  const id = recoveryId(ref);
  if (!id) return void 0;
  const history = await drainScanResponsive((function* () {
    const snapshot = yield* historyJobsSteps(home, true, { ids: /* @__PURE__ */ new Set([id]), names: /* @__PURE__ */ new Set([ref]) });
    for (const job of snapshot.values()) {
      yield;
      if (job.name === ref || job.id === id) return cloneJson(job);
    }
    return void 0;
  })());
  const { spec, launch: launch2 } = recoverySpec(home, id);
  return selectRecovery(ref, id, history, spec, launch2, await readRunLogsResponsive(home));
}
function recoveryId(ref) {
  const id = ref.replace(/^.*-(?:job|ask)-/, "");
  return /^[\w-]+$/.test(id) ? id : void 0;
}
function recoverySpec(home, id) {
  const file = safeFile(home, join8(home, "jobs", `${id}.spec.json`));
  const spec = file ? readHistoryJson(file) : null;
  const launch2 = isRecord(spec) && isRecord(spec.job) ? spec.job : void 0;
  return { spec, launch: launch2 };
}
function selectRecovery(ref, id, history, spec, launch2, runLogs) {
  const runs = runLogs.filter((r) => r.meta.job === ref || r.meta.job === history?.name || r.name.endsWith(`-${launch2?.agent ?? history?.agent ?? ref.split("-")[0]}-${id}`)).sort((a, b) => runStart(b) - runStart(a));
  const run = runs[0], meta = run?.meta;
  const name = history?.name ?? launch2?.name ?? meta?.job ?? (run && /^[\w]+-(?:job|ask)-[\w-]+$/.test(ref) ? ref : void 0);
  const agent = history?.agent ?? launch2?.agent ?? ref.split("-")[0];
  if (typeof name !== "string" || !AGENT_KINDS.includes(agent)) return void 0;
  const base = { ...launch2, ...history };
  return { id, history, spec, launch: launch2, run, meta, name, agent, base };
}
function contextIdentity({ id, name, agent, base, meta }) {
  return JSON.stringify([
    id,
    name,
    agent,
    base.id,
    base.startedAt,
    base.sessionId,
    base.threadId,
    meta?.jobStartedAt,
    meta?.session,
    meta?.continues,
    meta?.by,
    meta?.job
  ]);
}
function needsHeader({ run, base, meta }) {
  return Boolean(run && (typeof base.prompt !== "string" || typeof base.owner !== "string" && !meta?.by));
}
function finishRecovery(home, { id, history, spec, launch: launch2, run, meta, name, agent, base }, { prompt, header }) {
  const stateFile = safeFile(home, join8(home, "jobs", `${id}.json`));
  const rawState = stateFile ? readHistoryJson(stateFile) : null;
  const state = isRecord(rawState) && typeof rawState.pid === "number" ? rawState : void 0;
  const startedAt = typeof base.startedAt === "number" ? base.startedAt : run ? runStart(run) : 0;
  const currentState = state && typeof state.updatedAt === "number" && state.updatedAt >= startedAt ? state : void 0;
  const alive = currentState?.status === "running" && pidAlive(Number(currentState.pid));
  const owner = typeof base.owner === "string" ? base.owner : meta?.by ?? / by ([\w.-]+)/.exec(header)?.[1];
  if (!owner) return void 0;
  const sessionId = currentState?.sessionId ?? base.sessionId ?? base.threadId ?? meta?.session ?? meta?.continues ?? null;
  if (!history && !launch2 && !sessionId) return void 0;
  return {
    ...base,
    id: typeof base.id === "string" ? base.id : id,
    name,
    agent,
    model: base.model ?? meta?.model ?? null,
    prompt: typeof base.prompt === "string" ? base.prompt : prompt,
    startedAt,
    owner,
    rootName: base.rootName ?? owner,
    rootSession: base.rootSession ?? meta?.rootSession,
    parentJob: base.parentJob ?? meta?.parentJob,
    projectRoot: base.projectRoot ?? (isRecord(spec) ? spec.cwd : void 0) ?? meta?.byCwd ?? meta?.repoRoot,
    args: {
      ...meta?.access ? { access: meta.access } : {},
      ...meta?.model ? { model: meta.model } : {},
      ...meta?.effort ? { effort: meta.effort } : {},
      ...meta?.title ? { title: meta.title } : {},
      ...isRecord(spec) && isRecord(spec.base) ? spec.base : {},
      ...isRecord(base.args) ? base.args : {}
    },
    sessionId,
    workdir: currentState?.workdir ?? base.workdir ?? meta?.workdir ?? null,
    worktree: currentState?.worktree ?? base.worktree ?? null,
    status: alive ? "running" : ["done", "failed", "cancelled"].includes(String(currentState?.status)) ? currentState.status : ["done", "failed", "cancelled"].includes(String(base.status)) ? base.status : "interrupted",
    host: alive ? { pid: currentState.pid, peer: currentState.peer ?? name, startedAt } : null
  };
}

// src/core/job-pending-journal.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync as mkdirSync2, openSync, readFileSync as readFileSync7, readdirSync, renameSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname3, join as join9, resolve as resolve3 } from "node:path";
import { isDeepStrictEqual } from "node:util";
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
var MAX_RECEIPT_BYTES = 32 * 1024 * 1024;
var writerSequences = /* @__PURE__ */ new Map();
var parsed = /* @__PURE__ */ new Map();
var indexes = /* @__PURE__ */ new Map();
var cachedBytes2 = 0;
function cache2(path, statSignature, receipt) {
  const bytes = receipt ? Buffer.byteLength(JSON.stringify(receipt.value)) : 0;
  cachedBytes2 -= parsed.get(path)?.bytes ?? 0;
  if (bytes > MAX_RECEIPT_BYTES) {
    parsed.delete(path);
    return;
  }
  parsed.delete(path);
  parsed.set(path, { signature: statSignature, receipt, bytes });
  cachedBytes2 += bytes;
  while (parsed.size > 512 || cachedBytes2 > 64 * 1024 * 1024) {
    const first = parsed.keys().next().value;
    cachedBytes2 -= parsed.get(first).bytes;
    parsed.delete(first);
  }
}
var failure = (message) => Object.assign(new Error(message), { code: "EJOBRECEIPT" });
function physical(path, directory) {
  const stat2 = lstatSync(path);
  if (stat2.isSymbolicLink() || (directory ? !stat2.isDirectory() : !stat2.isFile())) throw failure("pending job receipt path is not physical");
}
function ancestors(path) {
  for (let at = resolve3(path); ; ) {
    try {
      physical(at, true);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname3(at);
    if (parent === at) return;
    at = parent;
  }
}
function pendingJobRoot(store) {
  return join9(dirname3(store), "pending-job-writes", "v1");
}
function digest(bytes) {
  return createHash2("sha256").update(bytes).digest("hex");
}
function immutable(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function detached(value) {
  return JSON.parse(JSON.stringify(value));
}
function signature2(path) {
  physical(path, false);
  const stat2 = lstatSync(path);
  return `${stat2.dev}:${stat2.ino}:${stat2.birthtimeMs}:${stat2.ctimeMs}:${stat2.mtimeMs}:${stat2.size}`;
}
function readPhysical(path, witnessed) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat2 = fstatSync(fd), bound = `${stat2.dev}:${stat2.ino}:${stat2.birthtimeMs}:${stat2.ctimeMs}:${stat2.mtimeMs}:${stat2.size}`;
    if (!stat2.isFile() || bound !== witnessed || stat2.size > MAX_RECEIPT_BYTES) throw failure("pending job receipt physical identity changed");
    const bytes = readFileSync7(fd, "utf8");
    ancestors(dirname3(path));
    if (signature2(path) !== witnessed) throw failure("pending job receipt changed during read");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function retainPendingJob(store, writer, job, baseJob) {
  const root = pendingJobRoot(store);
  ancestors(root);
  mkdirSync2(root, { recursive: true });
  physical(root, true);
  const dir = join9(root, randomUUID2());
  mkdirSync2(dir);
  physical(dir, true);
  const sequence = (writerSequences.get(writer.nonce) ?? 0) + 1;
  writerSequences.set(writer.nonce, sequence);
  const value = { schemaVersion: 1, writer, sequence, recordedAt: Date.now(), job, baseJob };
  const bytes = JSON.stringify(value);
  const partial = join9(dir, "receipt.partial"), path = join9(dir, "receipt.json");
  const index = {
    schemaVersion: 1,
    writerName: writer.name,
    owner: job.owner,
    parentJob: job.parentJob,
    handoff: Array.isArray(job.ownershipHistory) ? job.ownershipHistory.at(-1) : void 0
  };
  const indexFd = openSync(join9(dir, "writer.json"), "wx");
  try {
    writeFileSync2(indexFd, JSON.stringify(index));
    fsyncSync(indexFd);
  } finally {
    closeSync(indexFd);
  }
  const fd = openSync(partial, "wx");
  try {
    writeFileSync2(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  physical(dir, true);
  physical(partial, false);
  linkSync(partial, path);
  const receipt = immutable({ path, signature: signature2(path), digest: digest(bytes), value: JSON.parse(bytes) });
  cache2(path, receipt.signature, receipt);
  return receipt;
}
function readPendingJobs(store, warn, accept, readBudget = MAX_RECEIPT_BYTES) {
  const root = pendingJobRoot(store), result = [];
  try {
    ancestors(root);
    physical(root, true);
  } catch (error) {
    if (error.code !== "ENOENT") warn?.(error);
    return result;
  }
  for (const name of readdirSync(root)) {
    if (!UUID.test(name)) continue;
    const path = join9(root, name, "receipt.json");
    try {
      physical(dirname3(path), true);
      physical(path, false);
      if (accept) {
        const indexPath = join9(dirname3(path), "writer.json"), indexSignature = signature2(indexPath);
        let indexed = indexes.get(indexPath);
        if (indexed?.signature !== indexSignature) {
          if (lstatSync(indexPath).size > 4096) throw failure("pending job receipt index exceeds supported size");
          const value2 = JSON.parse(readPhysical(indexPath, indexSignature));
          if (!isRecord(value2) || value2.schemaVersion !== 1 || typeof value2.writerName !== "string") continue;
          indexed = { signature: indexSignature, value: value2 };
          indexes.set(indexPath, indexed);
          if (indexes.size > 4096) indexes.delete(indexes.keys().next().value);
        }
        if (!accept(indexed.value)) continue;
      }
      const statSignature = signature2(path), cached = parsed.get(path);
      if (lstatSync(path).size > readBudget) throw failure("pending job receipt exceeds automatic recovery budget; bytes retained for manual recovery");
      if (cached?.signature === statSignature) {
        if (cached.receipt) result.push(cached.receipt);
        continue;
      }
      const bytes = readPhysical(path, statSignature), value = JSON.parse(bytes);
      if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.writer) || typeof value.writer.name !== "string" || typeof value.writer.nonce !== "string" || !UUID.test(value.writer.nonce) || typeof value.recordedAt !== "number" || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !isRecord(value.job) || typeof value.job.id !== "string" || typeof value.job.name !== "string" || value.baseJob !== void 0 && !isRecord(value.baseJob)) {
        cache2(path, statSignature, null);
        continue;
      }
      const receipt = immutable({ path, signature: statSignature, digest: digest(bytes), value });
      cache2(path, statSignature, receipt);
      result.push(receipt);
    } catch (error) {
      if (error.code !== "ENOENT") warn?.(error);
    }
  }
  return result.sort((a, b) => a.value.writer.nonce === b.value.writer.nonce ? a.value.sequence - b.value.sequence : a.value.recordedAt - b.value.recordedAt || a.path.localeCompare(b.path));
}
var AUTHORITY = ["owner", "supervisor", "rootSession", "rootName", "parentJob", "ownershipHistory", "executionOwner"];
var final = (job) => job.status === "done" || job.status === "failed" || job.status === "cancelled";
function mergePendingJob(current, receipt, base) {
  if (!current) return detached(receipt);
  if (AUTHORITY.some((key) => !isDeepStrictEqual(current[key], receipt[key])) || Number(current.startedAt ?? 0) > Number(receipt.startedAt ?? 0) || Number(current.metadataVersion ?? 0) > Number(receipt.metadataVersion ?? 0) || current.startedAt === receipt.startedAt && final(current) && !final(receipt)) return null;
  if (Number(receipt.startedAt ?? 0) > Number(current.startedAt ?? 0)) return detached(mergeStoreFields(current, receipt));
  const merged = { ...current };
  for (const [key, value] of Object.entries(receipt)) {
    if (key === "deliveryHistory") {
      const envelopes = Array.isArray(current[key]) ? [...current[key]] : [];
      for (const message of Array.isArray(value) ? value : []) if (!envelopes.some((old) => isDeepStrictEqual(old, message))) envelopes.push(message);
      merged[key] = envelopes;
      continue;
    }
    if (final(current) && ["status", "finishedAt", "sessionId", "host"].includes(key)) continue;
    if (base && isDeepStrictEqual(current[key], base[key])) merged[key] = value;
    else if (!(key in current)) merged[key] = value;
  }
  return detached(merged);
}
function contains(current, expected) {
  if (isRecord(expected) && isRecord(current)) return Object.entries(expected).every(([key, value]) => contains(current[key], value));
  return isDeepStrictEqual(current, expected);
}
function archivePendingJob(receipt, durable) {
  const original = receipt.value.job;
  const incorporated = contains(durable, original);
  const superseded = durable.id === original.id && !AUTHORITY.some((key) => !isDeepStrictEqual(durable[key], original[key])) && Number(durable.startedAt ?? 0) >= Number(original.startedAt ?? 0) && Number(durable.metadataVersion ?? 0) >= Number(original.metadataVersion ?? 0) && (Number(durable.startedAt ?? 0) > Number(original.startedAt ?? 0) || final(durable)) && (Array.isArray(original.deliveryHistory) ? original.deliveryHistory : []).every((message) => Array.isArray(durable.deliveryHistory) && durable.deliveryHistory.some((saved) => isDeepStrictEqual(saved, message)));
  if (!incorporated && !superseded) return false;
  ancestors(dirname3(receipt.path));
  physical(receipt.path, false);
  if (signature2(receipt.path) !== receipt.signature) throw failure("pending job receipt verification failed; retained");
  const archive = join9(dirname3(dirname3(receipt.path)), "archive");
  ancestors(archive);
  mkdirSync2(archive, { recursive: true });
  physical(archive, true);
  const source = dirname3(receipt.path), target = join9(archive, randomUUID2());
  const fd = openSync(join9(source, "verification.json"), "wx");
  try {
    writeFileSync2(fd, JSON.stringify({
      schemaVersion: 1,
      kind: incorporated ? "incorporated" : "superseded",
      receiptSha256: receipt.digest,
      durableJobSha256: digest(JSON.stringify(durable)),
      jobId: durable.id,
      startedAt: durable.startedAt,
      status: durable.status,
      verifiedAt: Date.now(),
      retainedOnlyFields: Object.keys(original).filter((key) => !contains(durable[key], original[key])),
      retainedOnlyDataExecuted: false
    }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(source, target);
  cache2(receipt.path, receipt.signature, null);
  return true;
}

// src/mcp/jobs.ts
var JOB_ID_LENGTH = 8;
var PROMPT_PREVIEW_CHARS = 120;
var HISTORY_LIMIT = 50;
var STORE_LIMIT = 200;
var MAX_NOTES = 500;
var INTERRUPTED_LISTED_MS = 24 * 60 * 60 * 1e3;
var ROOT_WAIT_POLL_MS = 1e3;
var NOTE_CONVERSATION_SUFFIX = ":note";
var DEFAULT_FOLLOW_UP = "Continue where you stopped and finish the task. Then give your final answer.";
var HOST_POLL_MS = 2e3;
var CANCEL_GRACE_MS = 5e3;
var QUEUED_FOLLOW_UP_NOTE = "(Your queued follow-up was sent to it; its answer will arrive as another message.)";
function jobReport(job, status, seconds, text2, cause) {
  const how = job.sessionId ? status === "failed" ? ` To recover it with its context, call message_subagent(job="${job.name}") (optionally with a message).` : ` Continue it with its context: message_subagent(job="${job.name}", message=...).` : "";
  const header = `Subagent ${job.name} (${job.agent}${job.model ? `, model ${job.model}` : ""}) ${status} after ${seconds}s.${how}`;
  return [header, cause ? `Cause: ${cause}` : "", text2 && cause ? `Its last message:
${text2}` : text2].filter(Boolean).join("\n\n");
}
var approvalAnswers = /* @__PURE__ */ new WeakMap();
function denyPendingApprovals(job, reason = "job finished") {
  for (const answer of [...approvalAnswers.get(job) ?? []]) answer(reason, "job completion");
}
function waitForApproval(job, question, timeoutMs, post, log, home, request, askUser, escalate, forceEscalate = false) {
  return new Promise((resolve4) => {
    let settled = false;
    let cleanup;
    const askedAt = Date.now();
    const approvalId = newApprovalId();
    let escalated = false;
    let published = !home;
    let escalationRequested = forceEscalate;
    const escalateOnce = () => {
      if (!escalate || escalated || settled) return;
      if (!published) {
        escalationRequested = true;
        return;
      }
      escalated = true;
      void escalate(`Nested subagent ${job.name} asks its top supervisor for approval: ${question}

Answer the pending dashboard approval ${approvalId}, or decide(approval_id="${approvalId}", decision="allow" or "deny").`).catch(() => {
        escalated = false;
        log.warn("could not escalate nested approval", { job: job.name });
      });
    };
    const settle = (answer, by = "session") => {
      if (settled) return false;
      if (/^\s*escalate\b/i.test(answer) && escalate && Date.now() < askedAt + timeoutMs) {
        escalateOnce();
        return true;
      }
      if (Date.now() >= askedAt + timeoutMs) {
        answer = "no answer in time";
        by = "timeout";
      }
      settled = true;
      clearTimeout(timer);
      job.controller.signal.removeEventListener("abort", aborted);
      const answers2 = approvalAnswers.get(job);
      answers2?.delete(settle);
      job.pendingApproval = answers2?.values().next().value ?? null;
      if (!answers2?.size) approvalAnswers.delete(job);
      try {
        cleanup?.();
      } catch {
        log.warn("could not remove pending approval", { job: job.name });
      }
      const allow = /^\s*(allow|yes|y|approve|approved|ok|okay|go ahead|accept)\b/i.test(answer);
      try {
        post(by === "timeout" ? `Approval for ${job.name} expired without a decision; permission remains ungranted. Check bridge availability and request approval again before retrying. No owner denial was received.` : `Approval for ${job.name} ${allow ? "allowed" : "denied"} by ${by}.`);
      } catch {
        log.warn("could not report approval answer", { job: job.name });
      }
      resolve4({ allow, reason: answer.trim() });
      return true;
    };
    const timer = setTimeout(() => settle("no answer in time", "timeout"), timeoutMs);
    timer.unref?.();
    const aborted = () => settle("job cancelled", "cancellation");
    job.controller.signal.addEventListener("abort", aborted, { once: true });
    let answers = approvalAnswers.get(job);
    if (!answers) {
      answers = /* @__PURE__ */ new Set();
      approvalAnswers.set(job, answers);
    }
    answers.add(settle);
    job.pendingApproval = answers.values().next().value;
    if (job.controller.signal.aborted) {
      aborted();
      return;
    }
    if (home) {
      void publishApproval(home, {
        id: approvalId,
        owner: job.rootName ?? job.owner ?? "",
        job: job.name,
        agent: job.agent,
        parentJob: job.parentJob,
        rootSession: job.rootSession,
        tool: request?.tool ?? "approval",
        command: request?.detail ?? question,
        reason: request?.reason ?? question,
        askedAt,
        deadline: askedAt + timeoutMs
      }, settle).then((close) => {
        if (settled) close();
        else {
          cleanup = close;
          published = true;
          notifyJobEvent(home, "approvals", log);
          if (escalationRequested) escalateOnce();
        }
      }).catch(() => log.warn("could not publish pending approval", { job: job.name }));
    }
    log.info("subagent asks for approval", { job: job.name });
    post(
      `Subagent ${job.name} asks for approval: ${question}

Decide as its supervisor: use decide(approval_id="${approvalId}", decision="allow" or "deny", reason=...). ` + (escalate ? `If the decision needs the owner, use decide(approval_id="${approvalId}", decision="escalate") to forward the same pending request. ` : "") + `It waits for your answer; no answer within ${Math.round(timeoutMs / 6e4)} minutes counts as deny.`
    );
    if (askUser) {
      void Promise.resolve().then(askUser).then(
        (decision) => settle(decision.allow ? "allow" : `deny: ${decision.message}`, "user in session"),
        () => settle("deny: The permission dialog failed.", "user in session")
      );
    }
  });
}
var JobManager = class {
  constructor(node, log, storePath = null, maxJobs = DEFAULT_MAX_JOBS, lineage, restorePolicy) {
    this.node = node;
    this.log = log;
    this.storePath = storePath;
    this.maxJobs = maxJobs;
    this.lineage = lineage;
    this.restorePolicy = restorePolicy;
    node.on("shared_job_control", async ({ job: name, control }) => {
      try {
        if (!await this.share(name) || !this.find(name, false)) return;
        this.sharedControl = true;
        try {
          if (control.type === "message") this.followUp(name, control.body);
          else if (control.type === "cancel") this.cancel(name);
          else if (control.type === "settings") this.setSettings(name, control.settings);
          else if (control.type === "title") this.setTitle(name, control.title);
          else if (control.type === "effort") this.setEffort(name, control.effort);
        } finally {
          this.sharedControl = false;
        }
      } catch (error) {
        this.log.warn("shared job control failed", { job: name, err: String(error) });
      }
    });
    node.on("jobs_changed", () => this.refreshOwnership());
    node.on("inline_job_control", ({ job: name, control }) => {
      this.refreshOwnership();
      const job = [...this.running.values(), ...this.foreground.values()].find((j) => j.name === name && (j.executionOwner ?? j.owner) === this.node.name);
      if (!job) return;
      if (control.type === "cancel") {
        job.queue = [];
        job.controller.abort();
      } else if (control.type === "message") {
        if (job.controller.signal.aborted && job.resume && job.sessionId) {
          job.queue.push(control.body);
          this.waitForSlot(job);
        } else if (job.live) {
          job.awaitingAnswer = true;
          job.live.post(control.body);
        } else job.queue.push(control.body);
      } else if (control.type === "settings") job.args = changedJobArgs(job.args, control.settings);
      else if (control.type === "title") {
        job.args = { ...job.args, title: control.title };
        job.retitle?.(control.title);
      } else if (control.type === "effort") job.args = { ...job.args, effort: control.effort };
      this.persist();
    });
    node.on("message", (m) => {
      const jobId = /(?:^|\/)job:([0-9a-f]+)$/.exec(m.from.id)?.[1];
      if (!jobId) return;
      const job = this.running.get(jobId);
      if (job?.host) this.checkHostedSafely(job);
    });
    node.on("connected", () => {
      this.reportsStopped = false;
      const attached = [...this.running.values()];
      this.refreshOwnership();
      for (const job of attached) if (job.host && this.running.has(job.id)) this.runners?.send(job, { type: "attach" });
      if (this.pendingReports.size) this.persist();
    });
    node.on("stopped", () => {
      this.retainOwnedState();
      this.reportsStopped = true;
      this.persistenceGeneration++;
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      if (this.reportTimer) {
        clearTimeout(this.reportTimer);
        this.reportTimer = null;
      }
    });
  }
  node;
  log;
  storePath;
  maxJobs;
  lineage;
  restorePolicy;
  running = /* @__PURE__ */ new Map();
  foreground = /* @__PURE__ */ new Map();
  history = /* @__PURE__ */ new Map();
  /** Finished jobs whose continuation waits for a free slot, in arrival order; the messages are in job.queue. */
  waitingJobs = /* @__PURE__ */ new Map();
  pendingRuns = /* @__PURE__ */ new Map();
  /** Ids of status notes from running subagents (see fromSubagent). */
  notes = /* @__PURE__ */ new Set();
  /** Jobs this manager started, continued or took over: only these are saved (others' entries stay as they are on disk). */
  own = /* @__PURE__ */ new Set();
  /** Background jobs run in detached job runners where it can (they survive a restart of this server); null: all here. */
  runners = null;
  hostTimer = null;
  pendingHosts = /* @__PURE__ */ new Map();
  explicitCancellations = /* @__PURE__ */ new WeakSet();
  restoreResume = null;
  rootWaitTimer = null;
  persistTimer = null;
  persistReadiness = null;
  persistRetryMs = 25;
  pendingReports = /* @__PURE__ */ new Map();
  reporting = /* @__PURE__ */ new Set();
  reportsStopped = false;
  reportTimer = null;
  receiptWriter = randomUUID3();
  retainedSnapshots = /* @__PURE__ */ new Map();
  receipts = [];
  durableBases = /* @__PURE__ */ new Map();
  receiptError = null;
  persistenceGeneration = 0;
  sharedControl = false;
  sharedGrants = /* @__PURE__ */ new Set();
  sharedAuthority = /* @__PURE__ */ new Map();
  get limit() {
    return this.maxJobs;
  }
  /** Change the limit now. A higher one starts waiting continuations; a lower one stops no running subagent. */
  setLimit(max) {
    if (this.lineage) throw new Error("Only the top session can change the root subagent limit.");
    this.maxJobs = max;
    this.withRootBudget((budget) => budget.setLimit(max));
    this.log.info("subagent limit changed", { max });
    this.startWaiting();
  }
  /**
   * A newer server of this session took over (the bridge replaced this one): stay out of the job store and the
   * runners, so two servers never settle or save the same jobs. Ends when this server takes its place back.
   */
  dormant = false;
  setDormant(dormant) {
    if (this.dormant === dormant) return;
    if (dormant) this.retainOwnedState();
    this.dormant = dormant;
    this.persistenceGeneration++;
    if (dormant) for (const controller of this.pendingHosts.values()) controller.abort(new Error("Detached startup paused because another supervisor took over"));
    if (dormant && this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (dormant && this.reportTimer) {
      clearTimeout(this.reportTimer);
      this.reportTimer = null;
    }
    this.log.info(dormant ? "another server of this session took over: jobs paused here" : "this server took its place back: jobs resumed");
    if (dormant && this.hostTimer) {
      clearInterval(this.hostTimer);
      this.hostTimer = null;
    }
    if (!dormant && [...this.running.values()].some((j) => j.host)) this.watchHosted();
    if (!dormant && this.own.size) this.persist();
  }
  /** Save this session's jobs, merged with those other sessions saved. Best effort: never breaks a run. */
  persist() {
    if (!this.storePath || this.dormant || !this.own.size) return;
    if (this.reportsStopped) {
      this.retainOwnedState();
      return;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    let lock = () => {
    };
    let prepared;
    try {
      lock = acquireLock(`${this.storePath}.lock`, 0);
      const previous = readJobsDocument(this.storePath, this.log);
      assertWritableStore(previous);
      const entries = Array.isArray(previous) ? previous : isRecord(previous) ? previous.jobs : [];
      const archived = /* @__PURE__ */ new Map();
      const compared = /* @__PURE__ */ new Set([...this.history.keys(), ...entries.filter(isRecord).map((entry) => String(entry.id))]);
      for (const record of readArchivedJobSnapshot(this.storePath, { ids: compared }).jobs) archived.set(record.id, record);
      const byId = /* @__PURE__ */ new Map();
      const duplicates = /* @__PURE__ */ new Set();
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        if (byId.has(entry.id)) duplicates.add(entry.id);
        byId.set(entry.id, entry);
      }
      const mine = [...this.history.values()].filter((j) => this.own.has(j.id)).map((j) => {
        const old = byId.get(j.id) ?? (archived.has(j.id) ? cloneJson(archived.get(j.id)) : j.recoveredRecord);
        if (isRecord(old)) {
          const envelopes = [...Array.isArray(old.deliveryHistory) ? old.deliveryHistory : []];
          for (const message of j.deliveryHistory ?? []) if (!envelopes.some((existing) => isDeepStrictEqual2(existing, message))) envelopes.push(message);
          j.deliveryHistory = envelopes;
          if (typeof old.startedAt === "number" && j.startedAt < old.startedAt) return { ...old, deliveryHistory: j.deliveryHistory };
        }
        if (isRecord(old) && Array.isArray(old.ownershipHistory) && old.ownershipHistory.length) {
          Object.assign(j, {
            owner: old.owner,
            supervisor: old.supervisor,
            rootSession: old.rootSession,
            rootName: old.rootName,
            parentJob: old.parentJob,
            ownershipHistory: old.ownershipHistory,
            masters: old.masters
          });
          if (j.startedAt === old.startedAt) j.executionOwner = old.executionOwner;
          j.args = { ...j.args, ...isRecord(old.args) ? { send_to: old.args.send_to } : {} };
          if (old.owner !== this.node.name && old.executionOwner !== this.node.name && !(j.executionOwner === this.node.name && canControlJob(old, this.node.name)) && !this.lineage || old.executionOwner && old.executionOwner !== this.node.name && old.status === "running" && j.startedAt === old.startedAt) return old;
        }
        if (isRecord(old) && old.startedAt === j.startedAt && (old.status === "done" || old.status === "failed") && j.status === "running") {
          const pending2 = toStored(j);
          this.retainOwnedState([mergeStoreFields(old, pending2)]);
          const terminal = mergePendingJob(
            { ...old, deliveryHistory: j.deliveryHistory },
            { ...pending2, status: old.status, finishedAt: old.finishedAt, sessionId: old.sessionId, host: old.host },
            this.durableBases.get(j.id) ?? j.recoveredRecord
          ) ?? { ...old, deliveryHistory: j.deliveryHistory };
          const executing = (this.running.get(j.id) === j || this.foreground.get(j.id) === j) && (!j.executionOwner || j.executionOwner === this.node.name);
          if (!executing) {
            Object.assign(j, terminal);
            j.queue = [...Array.isArray(terminal.queuedMessages) ? terminal.queuedMessages : []];
            this.running.delete(j.id);
            this.waitingJobs.delete(j.id);
            if (j.queue.length && this.isMine(j.owner) && j.resume) {
              this.waitForSlot(j);
              queueMicrotask(() => {
                if (this.dormant || this.reportsStopped) return;
                try {
                  this.startWaiting();
                } catch (error) {
                  this.log.warn("could not resume completed handoff", { err: String(error) });
                }
              });
            }
          }
          return terminal;
        }
        return mergeStoreFields(isRecord(old) ? old : {}, toStored(j));
      });
      prepared = mine;
      const ids = new Set(mine.map((j) => j.id));
      if ([...duplicates].some((id) => ids.has(id))) {
        const backup = backupPath(this.storePath);
        copyFileSync(this.storePath, backup, fsConstants.COPYFILE_EXCL);
        const fd = openSync2(backup, "r+");
        try {
          fsyncSync2(fd);
        } finally {
          closeSync2(fd);
        }
        retainBackups(this.storePath);
      }
      const others = entries.filter((j) => !isRecord(j) || !ids.has(j.id));
      const all = migrateProjectJobs([...others, ...mine]).sort((a, b) => {
        const started = (entry) => isRecord(entry) && typeof entry.startedAt === "number" ? entry.startedAt : 0;
        return started(a) - started(b);
      });
      const finished = all.filter((j) => isStoredJob(j) && (j.status === "done" || j.status === "failed" || j.status === "cancelled")).sort((a, b) => a.startedAt - b.startedAt);
      const limit = retentionLimit("AGENT_BRIDGE_JOB_STORE_LIMIT", STORE_LIMIT);
      const age = retentionLimit(ARCHIVE_AGE_ENV, DEFAULT_ARCHIVE_AGE_MS);
      const overflow = /* @__PURE__ */ new Set([
        ...limit ? finished.slice(0, Math.max(0, finished.length - limit)) : [],
        ...finished.filter((j) => age > 0 && typeof j.finishedAt === "number" && j.finishedAt < Date.now() - age)
      ]);
      if (overflow.size) {
        const unpublished = [...overflow].filter((job) => !isDeepStrictEqual2(archived.get(job.id), job));
        if (unpublished.length) {
          archiveJobs(this.storePath, unpublished);
          this.log.info("archived finished jobs", { count: unpublished.length });
        }
      }
      let retainCompatibility = false;
      try {
        assertStoreUpgrade(dirname4(this.storePath), "jobArchive", 0, 1);
      } catch (error) {
        if (error.code !== "STORE_UPGRADE_DEFERRED") throw error;
        retainCompatibility = true;
      }
      writeJsonStore(this.storePath, { ...isRecord(previous) ? previous : {}, jobs: all.filter((j) => retainCompatibility || !overflow.has(j)) }, previous);
      this.persistRetryMs = 25;
      for (const entry of all) if (isRecord(entry) && typeof entry.id === "string" && this.own.has(entry.id)) this.durableBases.set(entry.id, cloneJson(entry));
      this.verifyRetainedState();
      this.flushStoredReports(all);
    } catch (err) {
      this.retainOwnedState(prepared);
      if (err.code === "EJOBLOCKED") {
        this.schedulePersist();
        return;
      }
      if (err.code === "STORE_UPGRADE_DEFERRED") this.scheduleReadyPersist();
      this.log.warn("could not save subagent jobs", { err: err.message });
    } finally {
      lock();
    }
  }
  /** Refresh durable authority without resetting controllers or interrupting inline runs. */
  refreshOwnership() {
    if (!this.storePath || this.dormant) return;
    const tracked = /* @__PURE__ */ new Set([...this.history.keys(), ...this.running.keys(), ...this.foreground.keys(), ...this.waitingJobs.keys()]);
    const stored = readScopedStore(this.storePath, tracked, /* @__PURE__ */ new Set([this.node.name, ...this.adoptedOwners]), this.lineage?.parentJob, this.log);
    if (this.lineage) {
      const parent = stored.find((j) => j.name === this.lineage.parentJob);
      if (parent?.rootSession && parent.rootName) {
        this.lineage.rootSession = parent.rootSession;
        this.lineage.rootName = parent.rootName;
      }
    }
    for (const s of stored) {
      if (!this.own.has(s.id) && !this.canRestoreSaved(s)) continue;
      const directlyOwned = this.lineage ? s.parentJob === this.lineage.parentJob : this.isMine(s.owner) && !s.parentJob;
      if (!s.ownershipHistory?.length && (!directlyOwned || this.running.has(s.id) || this.foreground.has(s.id) || s.status === "running" && !s.host)) continue;
      let job = this.history.get(s.id);
      const mine = directlyOwned;
      if (job && (s.executionOwner === this.node.name || mine)) {
        const executing = (this.running.get(s.id) === job || this.foreground.get(s.id) === job) && (!job.executionOwner || job.executionOwner === this.node.name) || this.pendingHosts.get(s.id) === job.controller;
        Object.assign(job, {
          owner: s.owner,
          supervisor: s.supervisor,
          parentJob: s.parentJob,
          rootSession: s.rootSession,
          rootName: s.rootName,
          ownershipHistory: s.ownershipHistory,
          executionOwner: s.executionOwner,
          masters: s.masters
        });
        if (!executing && !job.host) {
          Object.assign(job, s);
          if (s.status !== "running" && !job.queue.length) job.queue = [...s.queuedMessages ?? []];
        }
      } else if (job && !mine) {
        this.running.delete(s.id);
        this.waitingJobs.delete(s.id);
        this.foreground.delete(s.id);
        this.own.delete(s.id);
        this.history.delete(s.id);
        continue;
      }
      if (!mine) continue;
      if (!job) {
        job = { ...s, controller: new AbortController(), progress: null, queue: [...s.queuedMessages ?? []], resume: this.restoreResume?.(s.agent, s.args ?? {}) };
        this.history.set(s.id, job);
      }
      this.own.add(s.id);
      if (s.status !== "running" && job.queue.length && !this.waitingJobs.has(s.id)) this.waitForSlot(job);
      if (s.status === "running" && s.host && !this.running.has(s.id) && this.takeOver(job)) {
        this.running.set(s.id, job);
        job.status = "running";
        this.runners?.send(job, { type: "attach" });
        this.watchHosted();
      } else if (s.status === "running" && s.executionOwner && s.executionOwner !== this.node.name) {
        this.running.set(s.id, job);
        this.watchHosted();
      } else if (s.status !== "running" && this.pendingHosts.get(s.id) !== job.controller) this.running.delete(s.id);
    }
  }
  schedulePersist(delayMs) {
    if (this.persistTimer || this.dormant || this.reportsStopped || !this.storePath) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, delayMs ?? 25 + Math.floor(Math.random() * 50));
  }
  scheduleReadyPersist() {
    if (this.persistReadiness || this.dormant || this.reportsStopped || !this.storePath) return;
    const retryMs = this.persistRetryMs;
    const generation = this.persistenceGeneration;
    this.persistRetryMs = Math.min(1e3, retryMs * 2);
    this.persistReadiness = Promise.resolve().then(() => generation !== this.persistenceGeneration || this.dormant || this.reportsStopped ? void 0 : refreshStorePeerIdentities(dirname4(this.storePath))).catch((error) => this.log.warn("job persistence reader verification deferred", { err: String(error) })).then(() => {
      if (generation === this.persistenceGeneration) this.schedulePersist(retryMs);
    }).finally(() => {
      this.persistReadiness = null;
    });
  }
  flushStoredReports(stored) {
    if (this.dormant || this.reportsStopped || !this.node.reportInlineJob) return;
    for (const [id, pending2] of this.pendingReports) {
      if (this.reporting.has(id) || !stored.some((entry) => isRecord(entry) && entry.id === pending2.jobId && Array.isArray(entry.deliveryHistory) && entry.deliveryHistory.some((message) => isDeepStrictEqual2(message, pending2.message)))) continue;
      this.reporting.add(id);
      const generation = this.persistenceGeneration;
      void Promise.resolve().then(() => {
        if (generation !== this.persistenceGeneration || this.dormant || this.reportsStopped) return false;
        const durable = this.storePath && readStoredJob(this.storePath, pending2.jobId, this.history.get(pending2.jobId)?.name ?? "", this.log);
        if (!durable || durable.id !== pending2.jobId || ![durable.owner, durable.executionOwner, durable.rootName].includes(this.node.name) || !durable.deliveryHistory?.some((message) => isDeepStrictEqual2(message, pending2.message))) return false;
        return this.node.reportInlineJob(pending2.message).then(() => true);
      }).then((sent) => {
        if (sent) this.pendingReports.delete(id);
      }, (error) => {
        this.log.warn("inline report delivery failed; retained for replay", { err: String(error) });
      }).finally(() => {
        this.reporting.delete(id);
        this.scheduleReportRetry();
      });
    }
  }
  scheduleReportRetry() {
    if (this.reportTimer || this.dormant || this.reportsStopped || !this.storePath || !this.pendingReports.size) return;
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null;
      if (!this.dormant && !this.reportsStopped) this.flushStoredReports(readScopedStore(
        this.storePath,
        new Set([...this.pendingReports.values()].map((report) => report.jobId)),
        /* @__PURE__ */ new Set(),
        void 0,
        this.log
      ));
    }, 500);
  }
  /** Small versioned receipts survive incompatible readers and immediate exit. */
  retainOwnedState(prepared) {
    if (!this.storePath || this.dormant) return;
    try {
      const ids = new Set(prepared?.map((job) => job.id) ?? [...this.history.keys()].filter((id) => this.own.has(id)));
      const existing = new Map(readScopedStore(this.storePath, ids, /* @__PURE__ */ new Set(), void 0, this.log).map((job) => [job.id, job]));
      const snapshots2 = prepared ?? [...this.history.values()].filter((job) => this.own.has(job.id)).map((job) => mergeStoreFields(existing.get(job.id) ?? job.recoveredRecord ?? {}, toStored(job)));
      for (const snapshot of snapshots2) {
        if (typeof snapshot.id !== "string") continue;
        const bytes = JSON.stringify(snapshot);
        if (isDeepStrictEqual2(existing.get(snapshot.id), JSON.parse(bytes))) continue;
        if (this.retainedSnapshots.get(snapshot.id) === bytes) continue;
        const job = this.history.get(snapshot.id);
        const base = prepared ? existing.get(snapshot.id) : this.durableBases.get(snapshot.id) ?? job?.recoveredRecord;
        const receipt = retainPendingJob(this.storePath, { name: this.node.name, session: this.node.currentSessionId ?? null, nonce: this.receiptWriter }, snapshot, base);
        this.receipts.push(receipt);
        this.retainedSnapshots.set(snapshot.id, bytes);
      }
    } catch (error) {
      this.receiptError = String(error);
      this.log.error("pending job retention failed; receipt retained for inspection", { err: this.receiptError });
    }
  }
  verifyRetainedState() {
    if (!this.storePath || this.receiptError || !this.receipts.length) return;
    try {
      const durable = new Map(readScopedStore(
        this.storePath,
        new Set(this.receipts.map((receipt) => receipt.value.job.id)),
        /* @__PURE__ */ new Set(),
        void 0,
        this.log
      ).map((job) => [job.id, job]));
      for (let i = this.receipts.length - 1; i >= 0; i--) {
        const receipt = this.receipts[i], job = durable.get(receipt.value.job.id);
        if (job && archivePendingJob(receipt, job)) this.receipts.splice(i, 1);
      }
    } catch (error) {
      this.receiptError = String(error);
      this.log.error("pending job receipt verification failed; recovery paused", { err: this.receiptError });
    }
  }
  /**
   * Load the jobs saved before this session (re)started, so message_subagent can continue them with their
   * context. Jobs that were still running are marked interrupted: a follow-up without a message recovers them.
   * A job of this session whose job runner is still at work (it outlived the old server) is running: this
   * manager takes it over. Another session's runner-hosted job keeps its status for that session to take over.
   */
  restore(makeResume) {
    this.restoreResume = makeResume;
    if (!this.storePath) return;
    const stored = readStore(this.storePath, this.log, true);
    const durableIds = new Set(stored.map((job) => job.id));
    const appliedReceipts = /* @__PURE__ */ new Map();
    if (!this.dormant && !this.reportsStopped) for (const receipt of readPendingJobs(
      this.storePath,
      (error) => this.log.warn("pending job receipt retained", { err: String(error) }),
      (index) => {
        const handoff = isRecord(index.handoff) ? index.handoff : void 0;
        const explicit = this.restorePolicy?.canReceiveHandoff() && handoff?.reason === "explicit-handoff" && handoff.to === this.node.name && (handoff.rootSession === this.node.currentSessionId || handoff.rootSession === this.node.id);
        return this.isMine(typeof index.owner === "string" ? index.owner : void 0) && (this.isMine(index.writerName) || Boolean(explicit)) && (this.lineage ? index.parentJob === this.lineage.parentJob : !index.parentJob) && (!this.restorePolicy || this.restorePolicy.canRestore() || Boolean(explicit));
      }
    )) {
      const saved = receipt.value.job;
      const handoff = isStoredJob(saved) ? saved.ownershipHistory?.at(-1) : void 0;
      const explicit = this.restorePolicy?.canReceiveHandoff() && handoff?.reason === "explicit-handoff" && handoff.to === this.node.name && (handoff.rootSession === this.node.currentSessionId || handoff.rootSession === this.node.id);
      if (!isStoredJob(saved) || !this.canRestoreSaved(saved) || !this.isMine(saved.owner) || !(this.isMine(receipt.value.writer.name) || explicit) || (this.lineage ? saved.parentJob !== this.lineage.parentJob : Boolean(saved.parentJob))) continue;
      const index = stored.findIndex((job) => job.id === saved.id);
      const priorReceipt = appliedReceipts.get(saved.id);
      const base = !durableIds.has(saved.id) && priorReceipt?.value.writer.nonce === receipt.value.writer.nonce && priorReceipt.value.sequence < receipt.value.sequence && index >= 0 ? stored[index] : receipt.value.baseJob;
      const merged = mergePendingJob(index < 0 ? void 0 : stored[index], saved, base);
      if (!merged || !isStoredJob(merged)) continue;
      if (index < 0) stored.push(merged);
      else stored[index] = merged;
      appliedReceipts.set(saved.id, receipt);
      this.own.add(saved.id);
      this.receipts.push(receipt);
      for (const message of merged.deliveryHistory ?? []) this.pendingReports.set(message.id, { jobId: saved.id, message });
    }
    const adopted = [];
    const recentIds = new Set(stored.slice(-HISTORY_LIMIT).map((s) => s.id));
    for (const s of stored.filter((x) => recentIds.has(x.id) || x.status === "running" || x.waitingForStart)) {
      if (!this.canRestoreSaved(s)) continue;
      if (this.lineage && s.parentJob !== this.lineage.parentJob) continue;
      if (!this.lineage && s.parentJob) continue;
      const existing = this.history.get(s.id);
      if (existing) {
        if (this.receipts.some((receipt) => receipt.value.job.id === s.id) && !this.running.has(s.id) && !this.foreground.has(s.id) && !this.pendingHosts.has(s.id)) {
          Object.assign(existing, s, { recoveredRecord: cloneJson(s), queue: [...s.queuedMessages ?? []] });
        }
        existing.resume ??= makeResume(existing.agent, existing.args ?? {});
        continue;
      }
      const hosted = s.status === "running" && Boolean(s.host);
      const mine = this.isMine(s.owner);
      const job = {
        ...s,
        recoveredRecord: cloneJson(s),
        status: s.status === "running" && !(hosted && !mine) ? "interrupted" : s.status,
        controller: new AbortController(),
        progress: null,
        queue: [...s.queuedMessages ?? []],
        resume: makeResume(s.agent, s.args ?? {})
      };
      this.history.set(s.id, job);
      if (hosted && mine && this.takeOver(job)) adopted.push(job);
    }
    if (stored.length) this.log.info("restored subagent jobs", { count: Math.min(stored.length, HISTORY_LIMIT), runnerHosted: adopted.length });
    this.assignLegacySupervisors();
    this.settleAdopted(adopted);
    for (const job of this.history.values()) if (job.waitingForStart && this.isMine(job.owner)) this.waitForSlot(job);
    this.persist();
  }
  /** Whether a runner-hosted job can be taken over here (its runner lives, or finished and left its report). */
  takeOver(job) {
    if (!this.runners) return false;
    const state = this.runners.state(job);
    if (state) Object.assign(job, { sessionId: state.sessionId ?? job.sessionId, workdir: state.workdir ?? job.workdir, worktree: state.worktree ?? job.worktree });
    if (this.runners.alive(job, state) || state && state.status !== "running") return true;
    job.status = "interrupted";
    if (state?.sessionId) this.own.add(job.id);
    return false;
  }
  settleAdopted(adopted) {
    for (const job of adopted) {
      job.status = "running";
      job.owner = this.node.name;
      this.running.set(job.id, job);
      this.own.add(job.id);
      this.checkHosted(job);
    }
    if (adopted.length) {
      this.watchHosted();
      this.persist();
    }
  }
  /** Record facts learned while it runs (its session, its folder), so a restart can continue it. */
  note(job, facts) {
    if (facts.sessionId) job.sessionId = facts.sessionId;
    if (facts.workdir) job.workdir = facts.workdir;
    if (facts.worktree) job.worktree = facts.worktree;
    this.persist();
  }
  /** Hook-only snapshot: never performs storage recovery or runner polling. */
  hookJobs() {
    return [...this.history.values(), ...this.running.values(), ...this.foreground.values()];
  }
  runningCount() {
    return [...this.running.values()].filter((j) => this.isMine(j.owner)).length;
  }
  /** Background jobs plus blocking ask_* runs, so the session (and its coordinator) can see all of them. */
  list() {
    this.refreshOwnership();
    for (const job of [...this.running.values()]) if (job.host) this.checkHosted(job);
    return [...this.running.values(), ...this.foreground.values()].filter((j) => this.isMine(j.owner));
  }
  /** Supervisor fallback that uses the saved runner links, never a broker authority RPC. */
  broadcastRunning(message) {
    return this.list().filter((job) => job.status === "running").map((job) => {
      try {
        if (this.hostedRunning(job)) {
          const cid = randomUUID3();
          (job.forwarded ??= []).push({ cid, body: message });
          this.runners.send(job, { type: "message", body: message, cid });
        } else if (job.live) {
          job.awaitingAnswer = true;
          job.live.post(message);
        } else if (job.remoteControl) {
          job.remoteControl({ type: "message", body: message, cid: randomUUID3() });
        } else {
          job.queue.push(message);
          this.persist();
          return { name: job.name, outcome: "queued for follow-up; no live link" };
        }
        return { name: job.name, outcome: "delivery attempted on existing runner link; queueing and consumption unconfirmed" };
      } catch (err) {
        return { name: job.name, outcome: `failed: ${err.message}` };
      }
    });
  }
  /** Continuations waiting for a free slot, first in line first. */
  waiting() {
    return [...this.waitingJobs.values()];
  }
  /** Recently finished subagents, newest first (they can still be messaged). */
  /**
   * Whether a job belongs to this session. A session briefly runs under a "-N" stand-in of its name when a
   * reload starts its new server while the old one is still connected; jobs started then are its too.
   */
  isMine(owner) {
    return !owner || owner === this.node.name || this.adoptedOwners.has(owner);
  }
  /** "-N" stand-in names of this session whose jobs it adopted (see adoptStandIns). */
  adoptedOwners = /* @__PURE__ */ new Set();
  /** Whether `owner` is a "-N" stand-in of this session's name ("claude-x-2" for "claude-x"). */
  isStandIn(owner) {
    const base = this.node.name.replace(/-\d+$/, "");
    return owner !== this.node.name && (owner === base || owner.startsWith(`${base}-`) && /^\d+$/.test(owner.slice(base.length + 1)));
  }
  canRestoreSaved(job) {
    if (!this.restorePolicy || this.restorePolicy.canRestore()) return true;
    const handoff = job.ownershipHistory?.at(-1);
    return Boolean(this.restorePolicy.canReceiveHandoff() && handoff?.reason === "explicit-handoff" && handoff.to === this.node.name && (handoff.rootSession === this.node.currentSessionId || handoff.rootSession === this.node.id) && this.isMine(job.owner) && !job.parentJob);
  }
  standInOwners(online) {
    if (this.dormant || this.restorePolicy && !this.restorePolicy.canRestore()) return [];
    return [...new Set([...this.history.values()].map((j) => j.owner).filter((owner) => Boolean(owner) && this.isStandIn(owner) && !online.has(owner)))];
  }
  /**
   * A reload can run a session briefly under a "-N" stand-in name; jobs started then carry it. Once on the
   * bridge, adopt those whose stand-in name no live peer holds (a live "-2" is another session of the folder).
   */
  adoptStandIns(online, verifiedGone = /* @__PURE__ */ new Set()) {
    if (this.dormant) return [];
    const owners = new Set(this.standInOwners(online).filter((owner) => verifiedGone.has(owner)));
    if (!owners.size) return [];
    for (const o of owners) this.adoptedOwners.add(o);
    this.assignLegacySupervisors();
    const taken = [];
    for (const job of this.history.values()) {
      if (!job.owner || !owners.has(job.owner)) continue;
      if (job.status === "running" && job.host && !this.running.has(job.id) && this.takeOver(job)) taken.push(job);
      else if (job.status === "running" && !this.running.has(job.id)) job.status = "interrupted";
    }
    this.log.info("adopted jobs started under a stand-in name of this session", { owners: [...owners], runnerHosted: taken.length });
    this.settleAdopted(taken);
    this.persist();
    return [...owners];
  }
  /** Finished jobs of this session: every interrupted one (they need recovering), then the newest others. */
  recent(limit = 5) {
    this.refreshOwnership();
    const mine = [...this.history.values()].filter((j) => j.status !== "running" && !this.waitingJobs.has(j.id) && this.isMine(j.owner)).sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt));
    const interrupted = mine.filter((j) => j.status === "interrupted" && Date.now() - (j.finishedAt ?? j.startedAt) < INTERRUPTED_LISTED_MS);
    return [...interrupted, ...mine.filter((j) => !interrupted.includes(j)).slice(0, limit)];
  }
  /** Recheck group authority at each tool call; grants remain local and are never persisted. */
  async share(ref) {
    const saved = await this.node.jobAuthority?.(ref);
    if (!saved) {
      const old = [...this.history.values()].find((j) => j.id === ref || j.name === ref);
      const id = old?.id ?? ref.replace(/^.*-(?:job|ask)-/, "");
      this.sharedGrants.delete(id);
      this.sharedAuthority.delete(id);
      return this.findAsync(ref);
    }
    this.sharedGrants.add(saved.id);
    this.sharedAuthority.set(saved.id, this.authorityWitness(saved));
    const durable = this.storePath && readStoredJob(this.storePath, saved.id, saved.name, this.log);
    if (durable) this.recheckSharedGrant(durable);
    if (!this.sharedGrants.has(saved.id) || durable && durable.startedAt > saved.startedAt) return this.findAsync(ref);
    const existing = this.history.get(saved.id);
    if (existing && (this.running.has(saved.id) || this.foreground.has(saved.id))) {
      Object.assign(existing, {
        owner: saved.owner,
        supervisor: saved.supervisor,
        parentJob: saved.parentJob,
        rootSession: saved.rootSession,
        rootName: saved.rootName,
        ownershipHistory: saved.ownershipHistory,
        masters: saved.masters
      });
    } else if (existing) Object.assign(existing, saved, { sessionId: saved.sessionId ?? existing.sessionId, workdir: saved.workdir ?? existing.workdir, worktree: saved.worktree ?? existing.worktree });
    else this.history.set(saved.id, { ...saved, recoveredRecord: saved, controller: new AbortController(), progress: null, queue: [], resume: this.restoreResume?.(saved.agent, saved.args ?? {}) });
    this.adoptRecoveredRunner(this.history.get(saved.id));
    return this.find(saved.name);
  }
  /** Lazy lookup must attach a surviving runner, rather than queue into an unpolled history entry. */
  adoptRecoveredRunner(job) {
    if (job.status !== "running" || this.running.has(job.id) || this.foreground.has(job.id)) return;
    if (job.host && this.takeOver(job)) {
      this.running.set(job.id, job);
      if (this.isMine(job.owner)) this.own.add(job.id);
      this.watchHosted();
    } else if (!job.executionOwner && this.isMine(job.owner) || job.executionOwner === this.node.name) job.status = "interrupted";
  }
  recipient(job) {
    return this.node.jobRecipient?.(job.name) ?? Promise.resolve(job.rootName ?? job.owner ?? this.node.name);
  }
  find(ref, recover = true) {
    const current = this.lookupCurrent(ref);
    if (current || !this.storePath || !this.restoreResume) return this.lookupAllowed(current);
    const id = ref.replace(/^.*-(?:job|ask)-/, "");
    return this.adoptLookup(readStoredJob(this.storePath, id, ref, this.log) ?? (recover ? recoverJobRecord(dirname4(this.storePath), ref) : void 0));
  }
  /** Request-path recovery yields during retained-feed reads and rechecks authority afterward. */
  async findAsync(ref) {
    let current = this.lookupCurrent(ref);
    if (current || !this.storePath || !this.restoreResume) return this.lookupAllowed(current);
    const id = ref.replace(/^.*-(?:job|ask)-/, "");
    const saved = readStoredJob(this.storePath, id, ref, this.log);
    if (saved) return this.adoptLookup(saved);
    const recovered = await recoverJobRecordAsync(dirname4(this.storePath), ref);
    current = this.lookupCurrent(ref);
    if (current) return this.lookupAllowed(current);
    if (this.dormant || this.reportsStopped) return void 0;
    return this.adoptLookup(readStoredJob(this.storePath, id, ref, this.log) ?? recovered);
  }
  lookupCurrent(ref) {
    this.refreshOwnership();
    const id = ref.replace(/^.*-(?:job|ask)-/, "");
    const active = [...this.running.values(), ...this.foreground.values(), ...this.waitingJobs.values()];
    return active.find((j) => j.id === id || j.name === ref) ?? this.history.get(id) ?? [...this.history.values()].find((j) => j.name === ref);
  }
  lookupAllowed(current) {
    if (!current) return void 0;
    const durable = this.storePath && readStoredJobSnapshot(this.storePath, current.id, current.name, this.log);
    const authority = durable || current;
    const permitted = this.lookupPermitted(authority);
    this.recheckSharedGrant(authority);
    if (durable && durable.startedAt > current.startedAt) return void 0;
    if (durable) Object.assign(current, cloneJson({
      owner: durable.owner,
      masters: durable.masters,
      ownershipHistory: durable.ownershipHistory,
      parentJob: durable.parentJob,
      ...durable.supervisor !== void 0 ? { supervisor: durable.supervisor } : {},
      ...durable.rootName !== void 0 ? { rootName: durable.rootName } : {},
      ...durable.rootSession !== void 0 ? { rootSession: durable.rootSession } : {}
    }));
    if (!this.sharedGrants.has(current.id) && !permitted) return void 0;
    return current;
  }
  lookupPermitted(authority) {
    return canControlJob(authority, this.node.name) || this.isMine(authority.owner) || Boolean(this.lineage && authority.parentJob === this.lineage.parentJob);
  }
  authorityWitness(authority) {
    return JSON.stringify([
      authority.id,
      authority.name,
      authority.owner,
      authority.supervisor,
      authority.masters,
      authority.ownershipHistory?.map((change) => [
        change.id,
        change.at,
        change.from,
        change.to,
        change.fromRootName,
        change.rootName,
        change.rootSession
      ]),
      authority.parentJob,
      authority.rootName,
      authority.rootSession,
      authority.projectRoot,
      authority.remote
    ]);
  }
  recheckSharedGrant(authority) {
    if (this.sharedGrants.has(authority.id) && !this.lookupPermitted(authority) && this.sharedAuthority.get(authority.id) !== this.authorityWitness(authority)) {
      this.sharedGrants.delete(authority.id);
      this.sharedAuthority.delete(authority.id);
    }
  }
  adoptLookup(saved) {
    if (!this.restoreResume) return void 0;
    if (saved) this.recheckSharedGrant(saved);
    if (!saved || !this.lineage && !this.isMine(saved.owner) && !canControlJob(saved, this.node.name) && !this.sharedGrants.has(saved.id)) return void 0;
    if (!this.sharedGrants.has(saved.id) && (this.lineage ? saved.parentJob !== this.lineage.parentJob : saved.parentJob)) return void 0;
    const job = { ...saved, recoveredRecord: saved, controller: new AbortController(), progress: null, queue: [], resume: this.restoreResume(saved.agent, saved.args ?? {}) };
    this.history.set(job.id, job);
    this.adoptRecoveredRunner(job);
    return job;
  }
  remember(job) {
    this.history.set(job.id, job);
    this.own.add(job.id);
    while (this.history.size > HISTORY_LIMIT) {
      const oldest = [...this.history.values()].find((entry) => entry.status !== "running" && !this.waitingJobs.has(entry.id));
      if (!oldest) break;
      this.history.delete(oldest.id);
    }
    this.persist();
  }
  newJob(agent, model, prompt, kind, resume, args) {
    this.refreshOwnership();
    const id = randomUUID3().replace(/-/g, "").slice(0, JOB_ID_LENGTH);
    return {
      id,
      name: `${agent}-${kind}-${id}`,
      agent,
      model,
      prompt,
      startedAt: Date.now(),
      controller: new AbortController(),
      progress: null,
      status: "running",
      sessionId: null,
      workdir: null,
      worktree: null,
      resume,
      queue: [],
      args,
      projectRoot: canonicalProjectRoot(typeof args?.cwd === "string" ? args.cwd : this.node.cwd ?? process.cwd()) ?? void 0,
      owner: this.node.name,
      // Keep the first job's identity when hooks learn the session id later, or a server reload adopts it.
      supervisor: this.supervisorIdentity(),
      metadataVersion: DELEGATION_METADATA_VERSION,
      parentJob: this.lineage?.parentJob,
      rootSession: this.lineage?.rootSession ?? this.supervisorIdentity(),
      rootName: this.lineage?.rootName ?? this.node.name
    };
  }
  supervisorIdentity() {
    if (this.lineage) return this.lineage.rootSession;
    return [...this.running.values(), ...this.foreground.values(), ...this.history.values()].find((j) => this.isMine(j.owner) && j.supervisor)?.supervisor ?? this.node.currentSessionId ?? this.node.id ?? this.node.name;
  }
  rootIdentity() {
    this.refreshOwnership();
    return this.lineage?.rootSession ?? this.supervisorIdentity();
  }
  assignLegacySupervisors() {
    const supervisor = this.supervisorIdentity();
    for (const job of this.history.values()) {
      if (!job.supervisor && this.isMine(job.owner)) {
        job.supervisor = supervisor;
        this.own.add(job.id);
      }
    }
  }
  /**
   * Register a blocking ask_* run for visibility in peers. Returns a progress sink and `end`, which records
   * the outcome so the run can be continued later with message_subagent.
   */
  track(agent, model, prompt, resume, args) {
    const job = { ...this.newJob(agent, model, prompt, "ask", resume, args), foreground: true };
    this.foreground.set(job.id, job);
    this.remember(job);
    return {
      job,
      onProgress: (message) => {
        job.progress = message;
      },
      end: (outcome) => {
        denyPendingApprovals(job);
        this.foreground.delete(job.id);
        job.foreground = false;
        job.etaAt = void 0;
        job.etaReportedAt = void 0;
        job.finishedAt = Date.now();
        job.status = job.controller.signal.aborted ? "cancelled" : outcome?.result?.status ?? (outcome?.result && !outcome.result.isError ? "done" : "failed");
        if (this.storePath) notifyJobEvent(dirname4(this.storePath), job.status === "done" ? "finish" : "fail", this.log);
        job.sessionId = outcome?.result?.sessionId ?? sessionOfError(outcome?.error) ?? job.sessionId;
        job.workdir = outcome?.result?.workdir ?? job.workdir;
        job.worktree = outcome?.result?.worktree ?? job.worktree;
        if (this.storePath) recordAskCompletion(dirname4(this.storePath), job);
        this.persist();
        if (job.foregroundRecipient && job.foregroundRecipient !== this.node.name || job.ownershipHistory?.length && !this.isMine(job.owner)) {
          this.post(job, jobReport(job, job.status, Math.round((Date.now() - job.startedAt) / 1e3), outcome?.result?.text ?? "", job.status === "failed" ? failureCause(outcome ?? {}) : null));
        }
        if (job.queue.length && job.resume && job.sessionId && !job.controller.signal.aborted && this.isMine(job.owner)) {
          if (this.canStart()) {
            let run;
            try {
              run = job.resume(job.queue.join("\n\n"), job.sessionId, job.workdir, job.worktree);
            } catch (error) {
              this.failContinuation(job, error);
              return;
            }
            job.queue.splice(0);
            this.launch(job, run);
          } else this.waitForSlot(job);
        }
      }
    };
  }
  canStart() {
    this.refreshOwnership();
    for (const job of [...this.running.values()]) if (job.host) this.checkHostedSafely(job, true);
    return this.runningCount() + [...this.foreground.values()].filter((j) => this.isMine(j.owner)).length < this.maxJobs && this.withRootBudget((budget) => {
      if (!this.lineage) budget.setLimit(this.maxJobs);
      return budget.available();
    });
  }
  withRootBudget(fn) {
    if (!this.storePath) return true;
    const budget = new RootConcurrency(dirname4(this.storePath), this.lineage?.rootSession ?? this.supervisorIdentity());
    try {
      return fn(budget);
    } finally {
      budget.close();
    }
  }
  start(agent, model, prompt, run, resume, args) {
    const job = this.newJob(agent, model, prompt, "job", resume, args);
    if (!this.canStart() || this.waitingJobs.size) {
      job.status = "interrupted";
      job.waitingForStart = true;
      job.progress = "queued: waiting for a subagent slot";
      this.pendingRuns.set(job.id, run);
      this.waitForSlot(job);
      this.remember(job);
      return job;
    }
    this.remember(job);
    this.log.info("subagent started", { job: job.name, model, prompt: prompt.slice(0, PROMPT_PREVIEW_CHARS) });
    this.launch(job, run);
    return job;
  }
  /** Save next-turn settings and send them to a runner that continues the job itself. */
  setSettings(ref, settings) {
    const job = this.find(ref);
    if (!job) return false;
    job.args = changedJobArgs(job.args, settings);
    if (settings.model !== void 0 && job.status !== "running") job.model = settings.model;
    if (!this.sharedControl && !this.isMine(job.owner) && !this.lineage || job.status === "running" && job.executionOwner && job.executionOwner !== this.node.name) void this.node.controlInlineJob?.(job.name, { type: "settings", settings });
    else if (this.hostedRunning(job)) this.runners.send(job, { type: "settings", settings });
    else job.remoteControl?.({ type: "settings", settings });
    this.own.add(job.id);
    this.persist();
    return true;
  }
  /** Change a job's thinking level for its next turns (a turn already running keeps its own). */
  setEffort(ref, effort) {
    const job = this.find(ref);
    if (!job) return false;
    job.args = { ...job.args, effort };
    if (!this.sharedControl && !this.isMine(job.owner) && !this.lineage || job.status === "running" && job.executionOwner && job.executionOwner !== this.node.name) void this.node.controlInlineJob?.(job.name, { type: "effort", effort });
    else if (this.hostedRunning(job)) this.runners.send(job, { type: "effort", effort });
    else job.remoteControl?.({ type: "effort", effort });
    this.own.add(job.id);
    this.persist();
    return true;
  }
  /** Name or rename a job; its next turn (and the dashboard) uses the title. */
  setTitle(ref, title) {
    const job = this.find(ref);
    if (!job) return false;
    job.args = { ...job.args, title };
    job.retitle?.(title);
    if (!this.sharedControl && !this.isMine(job.owner) && !this.lineage || job.status === "running" && job.executionOwner && job.executionOwner !== this.node.name) void this.node.controlInlineJob?.(job.name, { type: "title", title });
    else if (this.hostedRunning(job)) this.runners.send(job, { type: "title", title });
    else job.remoteControl?.({ type: "title", title });
    this.own.add(job.id);
    this.persist();
    return true;
  }
  /**
   * Send a follow-up to a subagent: queued while it runs, otherwise its session is resumed in the background,
   * as soon as a slot is free.
   */
  followUp(ref, message) {
    const job = this.find(ref);
    if (!job) return { outcome: "unknown" };
    if (job.status === "running" && job.executionOwner && job.executionOwner !== this.node.name && job.owner === this.node.name) {
      void this.node.controlInlineJob?.(job.name, { type: "message", body: message, cid: randomUUID3() });
      return { outcome: "delivered", job };
    }
    if (!this.sharedControl && !this.isMine(job.owner) && !this.lineage) {
      void this.node.controlInlineJob?.(job.name, { type: "message", body: message, cid: randomUUID3() }).catch((err) => this.log.warn("inline job control failed", { err: String(err) }));
      return { outcome: "delivered", job };
    }
    if (this.hostedRunning(job)) this.checkHosted(job);
    if (this.waitingJobs.has(job.id)) {
      job.queue.push(message);
      this.persist();
      return { outcome: "waiting", job };
    }
    if (job.status === "running" && job.controller.signal.aborted) {
      if (!job.resume || !job.sessionId) return { outcome: "no-session", job };
      job.queue.push(message);
      this.waitForSlot(job);
      this.persist();
      return { outcome: "waiting", job };
    }
    if (this.hostedRunning(job)) {
      const state = this.runners.state(job);
      const cid = randomUUID3();
      (job.forwarded ??= []).push({ cid, body: message });
      this.runners.send(job, { type: "message", body: message, cid });
      return { outcome: state?.live ? "delivered" : "queued", job, approvalPending: Boolean(state?.asking) };
    }
    if (job.status === "running") {
      if (job.live) {
        job.awaitingAnswer = true;
        job.live.post(message);
        return { outcome: "delivered", job, approvalPending: Boolean(job.pendingApproval) };
      }
      job.queue.push(message);
      return { outcome: "queued", job, approvalPending: Boolean(job.pendingApproval) };
    }
    if (!job.resume || !job.sessionId) return { outcome: "no-session", job };
    const admitted = this.canStart();
    job.queue.push(message);
    if (!admitted) {
      job.continuationFailure = null;
      this.waitForSlot(job);
      this.persist();
      return { outcome: "waiting", job };
    }
    let run;
    try {
      run = job.resume(job.queue.join("\n\n"), job.sessionId, job.workdir, job.worktree);
    } catch (error) {
      this.failContinuation(job, error);
      throw error;
    }
    job.queue.splice(0);
    this.log.info("subagent resumed", { job: job.name, sessionId: job.sessionId });
    this.launch(job, run);
    return { outcome: "started", job };
  }
  /** Continue this finished job (its queued messages) once a slot frees up. */
  waitForSlot(job) {
    if (job.continuationFailure?.turn === job.startedAt) return;
    this.waitingJobs.set(job.id, job);
    if (this.storePath && !this.rootWaitTimer) {
      this.rootWaitTimer = setInterval(() => {
        try {
          if (!this.dormant) this.startWaiting();
        } catch (err) {
          this.log.warn("could not check waiting root slots", { err: String(err) });
        }
        if (!this.waitingJobs.size && this.rootWaitTimer) {
          clearInterval(this.rootWaitTimer);
          this.rootWaitTimer = null;
        }
      }, ROOT_WAIT_POLL_MS);
      this.rootWaitTimer.unref();
    }
    this.log.info("subagent continuation waits for a free slot", { job: job.name, running: this.running.size, position: this.waitingJobs.size });
  }
  /** Start waiting continuations while there are free slots, oldest first. */
  startWaiting() {
    for (const job of this.waitingJobs.values()) {
      if (job.continuationFailure?.turn === job.startedAt) {
        this.waitingJobs.delete(job.id);
        continue;
      }
      if (job.status === "running") continue;
      if (!this.canStart()) return;
      if (job.waitingForStart) {
        this.waitingJobs.delete(job.id);
        try {
          const run2 = job.resume?.(job.prompt, "", job.workdir, job.worktree) ?? this.pendingRuns.get(job.id);
          this.pendingRuns.delete(job.id);
          if (run2) this.launch(job, run2);
          else {
            this.waitingJobs.set(job.id, job);
            return;
          }
        } catch (err) {
          this.pendingRuns.delete(job.id);
          job.waitingForStart = void 0;
          this.finish(job, "failed", "", null, failureCause({ error: err }));
        }
        continue;
      }
      if (!job.queue.length || !job.resume || !job.sessionId) {
        this.waitingJobs.delete(job.id);
        continue;
      }
      let run;
      try {
        run = job.resume(job.queue.join("\n\n"), job.sessionId, job.workdir, job.worktree);
      } catch (error) {
        this.failContinuation(job, error);
        continue;
      }
      this.waitingJobs.delete(job.id);
      job.queue.splice(0);
      this.log.info("subagent resumed (was waiting for a slot)", { job: job.name, sessionId: job.sessionId });
      this.launch(job, run);
    }
  }
  failContinuation(job, error) {
    job.continuationFailure = { turn: job.startedAt, error: String(error) };
    this.waitingJobs.delete(job.id);
    this.log.warn("subagent continuation could not be prepared; queued messages retained for explicit retry", {
      job: job.name,
      queued: job.queue.length,
      err: String(error)
    });
    this.persist();
  }
  launch(job, run) {
    this.waitingJobs.delete(job.id);
    job.continuationFailure = null;
    job.waitingForStart = void 0;
    if (typeof job.args?.model === "string") job.model = job.args.model;
    job.status = "running";
    job.executionOwner = !this.isMine(job.owner) ? this.node.name : void 0;
    job.startedAt = Math.max(Date.now(), job.startedAt + 1);
    job.controller = new AbortController();
    job.progress = null;
    job.etaAt = void 0;
    job.etaReportedAt = void 0;
    job.foreground = false;
    job.host = null;
    this.running.set(job.id, job);
    this.own.add(job.id);
    const controller = job.controller;
    const authority = () => JSON.stringify([
      job.startedAt,
      job.owner,
      job.supervisor,
      job.executionOwner,
      job.rootSession,
      job.rootName,
      job.ownershipHistory,
      this.node.name,
      this.node.currentSessionId
    ]);
    const generation = authority();
    const turn = cloneJson(toStored(job));
    const executor = this.node.name;
    const current = () => {
      if (this.dormant || this.running.get(job.id) !== job || job.controller !== controller || job.status !== "running") return false;
      this.refreshOwnership();
      return this.running.get(job.id) === job && job.controller === controller && job.status === "running" && generation === authority();
    };
    const admission = { signal: controller.signal, isCurrent: () => !controller.signal.aborted && current() };
    let hosted;
    try {
      hosted = this.runners ? run.hosted?.(job, admission) ?? null : null;
    } catch (err) {
      this.finish(job, "failed", "", sessionOfError(err), failureCause({ error: err }));
      return;
    }
    if (hosted instanceof Promise) {
      this.pendingHosts.set(job.id, controller);
      job.progress = "queued: preparing detached runner storage";
      this.persist();
      const abandoned = () => {
        if (this.running.get(job.id) !== job || job.controller !== controller) return;
        this.running.delete(job.id);
        job.status = "interrupted";
        job.progress = "queued start lost its supervisor authority; no delegate was launched";
      };
      hosted.then(async (host) => {
        if (host) {
          if (!current()) {
            await this.retainHostedStart(turn, host, executor);
            if (job.controller === controller) {
              job.host = host;
              job.progress = "runner started; retained for its current supervisor";
            }
            return;
          }
          job.progress = null;
          this.launchPrepared(job, run, host);
          if (this.explicitCancellations.has(controller)) this.cancel(job.name);
          return;
        }
        if (!current()) {
          abandoned();
          return;
        }
        if (controller.signal.aborted) {
          this.finish(job, "failed", "", null, "cancelled before detached runner startup");
          return;
        }
        job.progress = null;
        this.launchPrepared(job, run, host);
      }, (err) => {
        if (!current()) {
          abandoned();
          return;
        }
        this.finish(job, "failed", "", sessionOfError(err), failureCause({ error: err }));
      }).catch((err) => this.log.warn("detached startup processing failed", { job: job.name, err: String(err) })).finally(() => {
        if (this.pendingHosts.get(job.id) === controller) this.pendingHosts.delete(job.id);
      });
      return;
    }
    this.launchPrepared(job, run, hosted);
  }
  /** Publish a real late launch without rolling durable ownership/turn facts back. */
  async retainHostedStart(turn, host, executor) {
    if (!this.storePath) return;
    const fact = { version: 1, turn, host, executor, observedAt: Date.now() };
    for (; ; ) {
      let release = () => {
      };
      try {
        release = acquireLock(`${this.storePath}.lock`, 0);
        const previous = readJobsDocument(this.storePath, this.log);
        assertWritableStore(previous);
        const entries = Array.isArray(previous) ? previous : isRecord(previous) && Array.isArray(previous.jobs) ? previous.jobs : [];
        const jobs = entries.map((entry) => {
          if (!isRecord(entry) || entry.id !== turn.id) return entry;
          if (entry.startedAt === turn.startedAt && !entry.host)
            return {
              ...entry,
              host,
              executionOwner: entry.executionOwner ?? executor,
              status: entry.status === "interrupted" ? "running" : entry.status
            };
          return entry;
        });
        const envelope = isRecord(previous) ? previous : {};
        writeJsonStore(this.storePath, {
          ...envelope,
          jobs,
          retainedHostedStarts: [...Array.isArray(envelope.retainedHostedStarts) ? envelope.retainedHostedStarts : [], fact]
        }, previous);
        this.log.info("retained detached runner launched during supervisor change", { job: turn.name, peer: host.peer });
        return;
      } catch (error) {
        if (!["EBUSY", "EJOBLOCKED", "STORE_UPGRADE_DEFERRED"].includes(error.code ?? "")) throw error;
      } finally {
        release();
      }
      await delay3(50);
    }
  }
  launchPrepared(job, run, host) {
    job.host = host;
    job.forwarded = [];
    this.persist();
    if (job.host) {
      this.log.info("subagent runs in a job runner", { job: job.name, peer: job.host.peer });
      this.watchHosted();
      return;
    }
    const onProgress = (message) => {
      job.progress = message;
      this.log.debug("subagent progress", { job: job.name, message });
    };
    let promise;
    try {
      promise = run(job.controller.signal, onProgress, job);
    } catch (err) {
      this.finish(job, "failed", "", sessionOfError(err), failureCause({ error: err }));
      return;
    }
    promise.then(
      (res) => {
        job.workdir = res.workdir ?? job.workdir;
        job.worktree = res.worktree ?? job.worktree;
        this.finish(job, res.status ?? (res.isError ? "failed" : "done"), res.text || "(no answer text returned)", res.sessionId, res.isError ? failureCause({ result: res }) : null);
      },
      // The cause is the whole report here: the error says what happened (and, for a worktree, where the work is).
      (err) => this.finish(job, "failed", "", sessionOfError(err), failureCause({ error: err }))
    ).catch((err) => this.log.warn("subagent completion processing failed; broker remains available", { job: job.name, err: String(err) }));
  }
  /** A running job of this manager that a job runner hosts. */
  hostedRunning(job) {
    return job.status === "running" && Boolean(job.host) && Boolean(this.runners) && this.running.get(job.id) === job;
  }
  /** Check runner-hosted jobs while any runs. */
  watchHosted() {
    if (this.hostTimer || this.dormant) return;
    this.hostTimer = setInterval(() => {
      this.refreshOwnership();
      const hosted = [...this.running.values()].filter((j) => j.host);
      if (!hosted.length && ![...this.running.values()].some((j) => j.executionOwner) && this.hostTimer) {
        clearInterval(this.hostTimer);
        this.hostTimer = null;
      }
      for (const job of hosted) this.checkHostedSafely(job, true);
    }, HOST_POLL_MS);
    this.hostTimer.unref();
  }
  /** Poll and message callbacks run outside a tool request's error boundary. A temporary storage
   * or runner fault must not terminate the hosting broker or prevent other jobs being checked.
   */
  checkHostedSafely(job, ownershipRefreshed = false) {
    try {
      this.checkHosted(job, ownershipRefreshed);
    } catch (err) {
      this.log.warn("job runner check deferred after failure", { job: job.name, err: String(err) });
    }
  }
  /**
   * Take what a job's runner reports: its progress and facts, and its end. The runner delivers the report
   * itself (a message on the bridge, so it waits for the session even while no server of it runs); this
   * session only posts it when the runner could not, or says why a runner ended without one.
   */
  checkHosted(job, ownershipRefreshed = false) {
    if (!ownershipRefreshed) this.refreshOwnership();
    if (!this.running.has(job.id) || job.executionOwner && job.executionOwner !== this.node.name) return;
    if (!this.hostedRunning(job)) return;
    const runners = this.runners;
    const state = runners.state(job);
    if (state) {
      job.host.pid = state.pid;
      if (state.model !== void 0) job.model = state.model;
      job.progress = state.progress ?? job.progress;
      if (state.percent !== void 0) {
        const etaAt = state.status === "running" ? state.etaAt : void 0;
        const etaReportedAt = state.status === "running" ? state.etaReportedAt : void 0;
        const changed = job.percent !== state.percent || job.progressNote !== state.progressNote || job.etaAt !== etaAt || job.etaReportedAt !== etaReportedAt;
        job.percent = state.percent;
        job.progressNote = state.progressNote;
        job.etaAt = etaAt;
        job.etaReportedAt = etaReportedAt;
        if (changed) this.schedulePersist();
      }
      if (state.sessionId && state.sessionId !== job.sessionId || state.workdir && state.workdir !== job.workdir || state.worktree && !job.worktree) {
        this.note(job, { sessionId: state.sessionId, workdir: state.workdir, worktree: state.worktree });
      }
    }
    const alive = runners.alive(job, state);
    if (state && state.status !== "running") {
      if (!job.remote && state.delivered || !alive) this.settleHosted(job, state);
    } else if (!alive) this.settleHosted(job, null);
  }
  /** A runner-hosted job ended: with its runner's final state, or without (the runner is gone). */
  settleHosted(job, final2) {
    const seen = new Set(final2?.seen ?? this.runners?.state(job)?.seen ?? []);
    job.queue.push(...(job.forwarded ?? []).filter((f) => !seen.has(f.cid)).map((f) => f.body));
    job.forwarded = [];
    const pid = job.host?.pid;
    job.host = null;
    if (final2) {
      this.finish(
        job,
        final2.status === "done" ? "done" : final2.status === "cancelled" ? "cancelled" : "failed",
        "",
        final2.sessionId ?? null,
        null,
        final2.delivered ? null : final2.report,
        final2.reportId ? completionMessageId(`job:${job.id}`, final2.reportId) : void 0
      );
      return;
    }
    const cause = job.controller.signal.aborted ? "cancelled" : `its job runner${pid ? ` (process ${pid})` : ""} ended without reporting a result`;
    this.finish(job, job.controller.signal.aborted ? "cancelled" : "failed", "", job.sessionId, cause);
    if (job.worktree?.path) {
      void worktreeProcesses(job.worktree.path).then((evidence) => this.post(job, worktreeProcessReport(evidence))).catch((error) => this.post(job, "Surviving worktree process probe failed; supervisor review required: " + String(error)));
    }
  }
  /** Cancel a background job, a blocking ask_* run or a continuation waiting for a slot, by name or id. */
  cancel(ref) {
    const owned = this.find(ref);
    if (!owned) return false;
    if (!this.sharedControl && !this.isMine(owned.owner) && !this.lineage || owned.status === "running" && owned.executionOwner && owned.executionOwner !== this.node.name) {
      void this.node.controlInlineJob?.(owned.name, { type: "cancel" }).catch((err) => this.log.warn("inline cancel failed", { err: String(err) }));
      return true;
    }
    const id = ref.replace(/^.*-(?:job|ask)-/, "");
    const waiting = [...this.waitingJobs.values()].find((j) => j.id === id || j.name === ref);
    if (waiting) {
      this.waitingJobs.delete(waiting.id);
      this.pendingRuns.delete(waiting.id);
      waiting.queue = [];
      if (waiting.waitingForStart) {
        waiting.waitingForStart = void 0;
        waiting.controller.abort();
        this.finish(waiting, "cancelled", "", null, "cancelled before starting");
      }
      this.log.info("waiting subagent continuation cancelled", { job: waiting.name });
      return true;
    }
    const job = [...this.running.values(), ...this.foreground.values()].find((j) => j.id === id || j.name === ref);
    if (!job) {
      if (owned.status !== "interrupted") return false;
      owned.queue = [];
      owned.queuedMessages = [];
      owned.controller.abort();
      this.own.add(owned.id);
      this.finish(owned, "cancelled", "", owned.sessionId, "cancelled");
      return true;
    }
    job.queue = [];
    this.explicitCancellations.add(job.controller);
    job.controller.abort();
    if (this.hostedRunning(job)) {
      job.forwarded = [];
      const runners = this.runners;
      const cancelledHost = job.host, cancelledController = job.controller;
      runners.send(job, { type: "cancel" });
      setTimeout(() => {
        if (!this.hostedRunning(job) || job.host !== cancelledHost || job.controller !== cancelledController) return;
        if (runners.alive(job, runners.state(job))) {
          this.log.warn("job runner did not stop in time; killing it", { job: job.name, pid: job.host?.pid });
          runners.kill(job);
        }
        this.checkHostedSafely(job);
      }, CANCEL_GRACE_MS).unref();
    }
    return true;
  }
  /**
   * Stop every subagent of this process (the server shuts down). Runner-hosted ones keep running: the next
   * server of this session takes them over, and their results wait for it on the bridge.
   */
  cancelAll() {
    if (this.rootWaitTimer) {
      clearInterval(this.rootWaitTimer);
      this.rootWaitTimer = null;
    }
    for (const j of this.waitingJobs.values()) if (!j.waitingForStart) j.queue = [];
    this.waitingJobs.clear();
    this.pendingRuns.clear();
    for (const j of this.running.values()) if (!j.host && (!j.executionOwner || j.executionOwner === this.node.name)) j.controller.abort();
    for (const j of this.foreground.values()) denyPendingApprovals(j, "session closed");
    if (this.hostTimer) clearInterval(this.hostTimer);
    this.hostTimer = null;
  }
  /** `report`: null when the runner already delivered it, a text to post as it is, or undefined to compose it here. */
  finish(job, status, text2, sessionId, cause = null, report, messageId) {
    if (job.controller.signal.aborted) status = "cancelled";
    denyPendingApprovals(job);
    this.running.delete(job.id);
    job.etaAt = void 0;
    job.etaReportedAt = void 0;
    job.status = status;
    job.finishedAt = Date.now();
    job.sessionId = sessionId ?? job.sessionId;
    this.persist();
    const seconds = Math.round((Date.now() - job.startedAt) / 1e3);
    this.log.info("subagent finished", { job: job.name, status, seconds, sessionId: job.sessionId, cause });
    if (this.storePath && !job.host) notifyJobEvent(dirname4(this.storePath), status === "done" ? "finish" : "fail", this.log);
    const message = report === void 0 ? jobReport(job, status, seconds, text2, cause) : report;
    if (job.queue.length && job.resume && job.sessionId && !job.controller.signal.aborted && this.isMine(job.owner) && job.continuationFailure?.turn !== job.startedAt) {
      let run;
      try {
        run = job.resume(job.queue.join("\n\n"), job.sessionId, job.workdir, job.worktree);
      } catch (error) {
        this.failContinuation(job, error);
        if (message !== null) this.post(job, message, null, "", messageId);
        this.startWaiting();
        return;
      }
      if (message !== null) this.post(job, `${message}

${QUEUED_FOLLOW_UP_NOTE}`, null, "", messageId);
      job.queue.splice(0);
      this.launch(job, run);
      return;
    }
    if (message !== null) this.post(job, message, null, "", messageId);
    this.startWaiting();
  }
  /**
   * Ask this session's agent to approve something the running subagent wants to do (an MCP tool call, for
   * example). The question arrives as a message from the job; the agent answers with message_subagent.
   * No answer within the time limit counts as "deny".
   */
  askParent(job, question, timeoutMs, request) {
    return waitForApproval(job, question, timeoutMs, (body) => this.post(job, body), this.log, this.storePath ? dirname4(this.storePath) : void 0, request, void 0, this.lineage?.escalate, Boolean(job.foreground && this.lineage));
  }
  async escalateApproval(job, body) {
    if (this.lineage) await this.lineage.escalate(body);
    else this.post(job, body);
  }
  /**
   * A message the running subagent sent to this session. An answer (to a live message, or marked as a reply)
   * wakes the session; a note it sends on its own ("tests pass, merging next") stays in explicit
   * inbox reads and dashboard history, so status chatter costs no extra turn.
   */
  fromSubagent(job, body, replyTo, isAnswer = false, forceNote = false) {
    const answer = !forceNote && (isAnswer || replyTo !== null || job.awaitingAnswer === true);
    if (!forceNote && !isPureAcknowledgement(body)) job.awaitingAnswer = false;
    this.log.info("message from subagent", { job: job.name, note: !answer });
    const id = this.post(job, body, replyTo, isPureAcknowledgement(body) ? ACK_CONVERSATION_SUFFIX : answer ? "" : NOTE_CONVERSATION_SUFFIX);
    if (!answer) {
      this.notes.add(id);
      if (this.notes.size > MAX_NOTES) this.notes.delete(this.notes.values().next().value);
    }
  }
  /** Whether a message is a running subagent's own status note (it should not wake the session). */
  isNote(m) {
    return this.notes.has(m.id) || m.conversationId.endsWith(NOTE_CONVERSATION_SUFFIX) || isQuietMessage(m);
  }
  post(job, body, replyTo = null, suffix = "", id = randomUUID3()) {
    const m = {
      id,
      from: { id: `job:${job.id}`, name: job.name, agent: job.agent },
      to: job.owner ?? this.node.name,
      recipient: job.owner ?? this.node.name,
      conversationId: `job-${job.id}${suffix}`,
      replyTo,
      hop: 0,
      body,
      createdAt: Date.now(),
      readAt: null
    };
    if ((job.ownershipHistory?.length || this.storePath && !this.lineage) && this.node.reportInlineJob) {
      job.deliveryHistory = [...job.deliveryHistory ?? [], m];
      this.pendingReports.set(m.id, { jobId: job.id, message: m });
      this.persist();
    } else this.node.deliverLocal(m);
    return m.id;
  }
};
function sessionOfError(err) {
  return err instanceof DelegateError ? err.sessionId ?? null : null;
}
function toStored(j) {
  return {
    id: j.id,
    name: j.name,
    agent: j.agent,
    model: j.model,
    prompt: j.prompt,
    startedAt: j.startedAt,
    status: j.status,
    waitingForStart: j.waitingForStart,
    sessionId: j.sessionId,
    workdir: j.workdir,
    worktree: j.worktree,
    args: j.args,
    owner: j.owner,
    ownershipHistory: j.ownershipHistory,
    masters: j.masters,
    projectRoot: j.projectRoot,
    executionOwner: j.executionOwner,
    queuedMessages: [...j.queue],
    continuationFailure: j.continuationFailure,
    deliveryHistory: j.deliveryHistory,
    forwarded: j.forwarded,
    supervisor: j.supervisor,
    metadataVersion: j.metadataVersion,
    parentJob: j.parentJob,
    rootSession: j.rootSession,
    rootName: j.rootName,
    percent: j.percent,
    progressNote: j.progressNote,
    etaAt: j.etaAt,
    etaReportedAt: j.etaReportedAt,
    finishedAt: j.finishedAt,
    host: j.host ?? null,
    remote: j.remote
  };
}
function isStoredJob(j) {
  return isRecord(j) && typeof j.id === "string" && typeof j.name === "string";
}
function readJobsDocument(path, log) {
  return readJsonStore(path, log, (data) => Array.isArray(data) || isRecord(data) && Array.isArray(data.jobs));
}
function readStore(path, log, includeArchived = false) {
  try {
    const data = readJobsDocument(path, log);
    const jobs = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : [];
    const all = /* @__PURE__ */ new Map();
    if (includeArchived) for (const job of readArchivedJobs(path).filter(isStoredJob)) all.set(job.id, job);
    for (const job of jobs.filter(isStoredJob)) all.set(job.id, job);
    return [...all.values()];
  } catch (err) {
    log?.warn("could not read jobs store", { path, err: String(err) });
    return [];
  }
}
function readScopedStore(path, tracked, owners, parentName, log) {
  try {
    if (indexedJobProjectionCurrent(path)) {
      const ids = new Set(tracked);
      for (const record of readIndexedJobs(path, { active: true, metadata: true }).jobs) {
        const owned = parentName !== void 0 ? record.parentJob === parentName : !record.parentJob && (!record.owner || owners.has(String(record.owner)));
        if (typeof record.id === "string" && (owned || record.name === parentName)) ids.add(record.id);
      }
      return readIndexedJobs(path, { ids, names: parentName ? /* @__PURE__ */ new Set([parentName]) : /* @__PURE__ */ new Set() }).jobs.filter(isStoredJob).map(cloneJson);
    }
    const current = activeJobSnapshot(path);
    const activeIds = new Set(current.keys());
    const archived = [];
    for (const record of readArchivedJobSnapshot(path, { ids: tracked, names: parentName ? /* @__PURE__ */ new Set([parentName]) : /* @__PURE__ */ new Set() }).jobs) {
      if (!isStoredJob(record) || activeIds.has(record.id)) continue;
      if (tracked.has(record.id) || parentName !== void 0 && record.name === parentName) archived.push(cloneJson(
        record.status === "running" && !record.host ? { ...record, status: "interrupted" } : record
      ));
    }
    for (const record of current.values()) {
      const owned = parentName !== void 0 ? record.parentJob === parentName : !record.parentJob && (!record.owner || owners.has(record.owner));
      if (tracked.has(record.id) || owned || record.name === parentName) archived.push(cloneJson(record));
    }
    return archived;
  } catch (err) {
    log?.warn("could not refresh tracked jobs store", { path, err: String(err) });
    return [];
  }
}
function readStoredJob(path, id, name, log) {
  try {
    const selected = readStoredJobSnapshot(path, id, name, log);
    return selected ? cloneJson(selected) : void 0;
  } catch (err) {
    log?.warn("could not look up stored job", { path, err: String(err) });
  }
  return void 0;
}
function readStoredJobSnapshot(path, id, name, log) {
  try {
    if (indexedJobProjectionCurrent(path)) {
      const selection = { ids: /* @__PURE__ */ new Set([id]), names: /* @__PURE__ */ new Set([name]) };
      const active = readIndexedJobs(path, { ...selection, active: true }).jobs.find(isStoredJob);
      if (active) return active;
      return readIndexedJobs(path, selection).jobs.find((record) => isStoredJob(record) && record.status !== "running");
    }
    const current = activeJobSnapshot(path);
    for (const record of current.values()) if (record.id === id || record.name === name) return record;
    for (const record of readArchivedJobSnapshot(path, { ids: /* @__PURE__ */ new Set([id]), names: /* @__PURE__ */ new Set([name]) }).jobs) {
      if (isStoredJob(record) && record.status !== "running" && !current.has(record.id) && (record.id === id || record.name === name)) return record;
    }
  } catch (err) {
    log?.warn("could not look up stored job", { path, err: String(err) });
  }
  return void 0;
}
function activeJobSnapshot(path) {
  let value;
  try {
    value = readJsonSnapshot(path).value;
  } catch (err) {
    if (err.code === "ENOENT") return /* @__PURE__ */ new Map();
    throw err;
  }
  const entries = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.jobs) ? value.jobs : null;
  if (!entries) {
    if (isRecord(value) && typeof value.version === "number" && value.version > JSON_STORE_VERSION) return /* @__PURE__ */ new Map();
    throw new Error("invalid jobs store structure");
  }
  const jobs = /* @__PURE__ */ new Map();
  for (const entry of entries) if (isStoredJob(entry)) jobs.set(entry.id, entry);
  return jobs;
}
var LOCK_WAIT_MS2 = 2e3;
function acquireLock(path, waitMs = LOCK_WAIT_MS2) {
  try {
    return metadataFileLease(path, waitMs, waitMs === 0);
  } catch (error) {
    if (error.code !== "ELEASEBUSY") throw error;
    throw Object.assign(new Error("timed out locking jobs store"), { code: "EJOBLOCKED" });
  }
}

// src/core/relay.ts
import { randomBytes as randomBytes3, randomUUID as randomUUID4 } from "node:crypto";
import { mkdirSync as mkdirSync3, readFileSync as readFileSync8, readdirSync as readdirSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join10 } from "node:path";
import { createServer as createServer2 } from "node:http";
var RELAY_URL_ENV = "AGENT_BRIDGE_RELAY_URL";
var RELAY_TOKEN_ENV = "AGENT_BRIDGE_RELAY_TOKEN";
var RELAY_HOST = "127.0.0.1";
var RELAY_PATH = "/permission";
var MAX_REQUEST_BYTES2 = 256 * 1024;
var SECRET_BYTES2 = 24;
var KEEP_ALIVE_MS = 6e4;
var PermissionRelay = class {
  constructor(handler, log) {
    this.handler = handler;
    this.log = log;
  }
  handler;
  log;
  server = null;
  secret = randomBytes3(SECRET_BYTES2).toString("hex");
  url = "";
  async start() {
    this.server = createServer2((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      const keepAlive = setInterval(() => res.write(" "), KEEP_ALIVE_MS);
      void this.handle(req).catch((err) => {
        this.log.warn("permission relay request failed", { err: err.message });
        return { allow: false, message: "agent-bridge relay error" };
      }).then((body) => {
        clearInterval(keepAlive);
        res.end(JSON.stringify(body));
      });
    });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    await new Promise((resolve4, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, RELAY_HOST, () => resolve4());
    });
    const { port } = this.server.address();
    this.url = `http://${RELAY_HOST}:${port}${RELAY_PATH}`;
    this.log.debug("permission relay listening", { url: this.url });
  }
  /** Environment variables that let a child process reach this relay. */
  childEnv() {
    return { [RELAY_URL_ENV]: this.url, [RELAY_TOKEN_ENV]: this.secret };
  }
  async stop() {
    const s = this.server;
    this.server = null;
    if (s) await new Promise((r) => s.close(() => r()));
  }
  async handle(req) {
    if (req.method !== "POST" || req.url !== RELAY_PATH) throw new Error("not found");
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokensEqual(auth, this.secret)) throw new Error("unauthorized");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_REQUEST_BYTES2) throw new Error("request too large");
    }
    const body = JSON.parse(raw);
    const request = {
      agent: String(body.agent ?? "subagent"),
      tool: String(body.tool ?? "unknown"),
      detail: String(body.detail ?? "").slice(0, 4e3),
      cwd: body.cwd ? String(body.cwd) : void 0,
      ...typeof body.reason === "string" ? { reason: body.reason.slice(0, MAX_APPROVAL_REASON_CHARS) } : {}
    };
    this.log.info("permission requested by subagent", { agent: request.agent, tool: request.tool });
    const decision = await this.handler(request);
    this.log.info("permission decided", { tool: request.tool, allow: decision.allow });
    return decision;
  }
};
async function askRelay(req, env = process.env) {
  const url = env[RELAY_URL_ENV];
  const token = env[RELAY_TOKEN_ENV];
  if (!url || !token) return { allow: false, message: "agent-bridge: no permission relay for this run" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(req)
    });
    const body = await res.json();
    return body.allow === true ? { allow: true } : { allow: false, message: body.message ?? "denied" };
  } catch (err) {
    return { allow: false, message: `agent-bridge: permission relay unreachable (${err.message})` };
  }
}
var APPROVALS_DIR = "approvals";
var APPROVAL_ID = /^[0-9a-f-]{36}$/;
var ANSWER_PATH = "/answer";
var ANSWER_TIMEOUT_MS = 5e3;
var MAX_PORT = 65535;
var MAX_APPROVAL_REASON_CHARS = 4e3;
async function publishApproval(home, approval, answer) {
  await appendContextEvent(home, { kind: "approval", agent: approval.agent, job: approval.job, payload: { event: "requested", ...approval } });
  if (!APPROVAL_ID.test(approval.id)) throw new Error("invalid approval id");
  const token = randomBytes3(SECRET_BYTES2).toString("hex");
  const dir = join10(home, APPROVALS_DIR);
  const file = join10(dir, `${approval.id}.json`);
  const server = createServer2((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    void (async () => {
      if (req.method !== "POST" || req.url !== ANSWER_PATH || !tokensEqual(String(req.headers.authorization ?? ""), `Bearer ${token}`)) return reply(403, { error: "forbidden" });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_REQUEST_BYTES2) return reply(400, { error: "request too large" });
      }
      const body = JSON.parse(raw);
      if (!body || body.decision !== "allow" && body.decision !== "deny" || body.reason !== void 0 && (typeof body.reason !== "string" || body.reason.length > MAX_APPROVAL_REASON_CHARS)) return reply(400, { error: "invalid answer" });
      if (body.source !== void 0 && body.source !== "dashboard" && body.source !== "MCP decide") return reply(400, { error: "invalid source" });
      const accepted = Date.now() < approval.deadline && await answer(`${body.decision}${body.reason ? `: ${body.reason}` : ""}`, body.source ?? "dashboard");
      await appendContextEvent(home, { kind: "approval", agent: approval.agent, job: approval.job, payload: { event: "answered", approval: approval.id, ...body, accepted } });
      reply(accepted ? 200 : 409, { outcome: accepted ? "answered" : "expired" });
    })().catch(() => reply(400, { error: "invalid answer" }));
  });
  server.requestTimeout = ANSWER_TIMEOUT_MS;
  server.headersTimeout = ANSWER_TIMEOUT_MS;
  await new Promise((resolve4, reject) => {
    server.once("error", reject);
    server.listen(0, RELAY_HOST, resolve4);
  });
  server.unref();
  try {
    mkdirSync3(dir, { recursive: true, mode: 448 });
    writeFileSync3(file, JSON.stringify({ ...approval, pid: process.pid, port: server.address().port, token }), { mode: 384, flag: "wx" });
  } catch (err) {
    server.close();
    throw err;
  }
  return () => {
    try {
      archiveFile(file);
    } finally {
      server.close();
    }
  };
}
function readApproval(home, id) {
  if (!APPROVAL_ID.test(id)) return null;
  try {
    const r = JSON.parse(readFileSync8(join10(home, APPROVALS_DIR, `${id}.json`), "utf8"));
    if (r.id !== id || !Number.isInteger(r.pid) || r.pid < 1 || !pidAlive(r.pid) || !Number.isSafeInteger(r.deadline) || r.deadline <= Date.now() || !Number.isSafeInteger(r.askedAt) || r.deadline <= r.askedAt || !Number.isInteger(r.port) || r.port < 1 || r.port > MAX_PORT || typeof r.token !== "string" || !r.token) return null;
    if (![r.owner, r.job, r.agent, r.tool, r.command, r.reason].every((value) => typeof value === "string")) return null;
    return r;
  } catch {
    return null;
  }
}
function listPendingApprovals(home) {
  let files;
  try {
    files = readdirSync2(join10(home, APPROVALS_DIR));
  } catch {
    return [];
  }
  const jobs = readStore(join10(home, JOBS_FILE));
  return files.flatMap((file) => {
    if (!file.endsWith(".json")) return [];
    const r = readApproval(home, file.slice(0, -5));
    const job = r && jobs.find((j) => j.name === r.job && j.ownershipHistory?.length);
    if (r && job) {
      r.owner = job.rootName ?? job.owner ?? r.owner;
      r.rootSession = job.rootSession;
      r.parentJob = job.parentJob;
    }
    return r ? [{
      id: r.id,
      owner: r.owner,
      job: r.job,
      agent: r.agent,
      tool: r.tool,
      command: r.command,
      reason: r.reason,
      askedAt: r.askedAt,
      deadline: r.deadline,
      ...typeof r.parentJob === "string" ? { parentJob: r.parentJob } : {},
      ...typeof r.rootSession === "string" ? { rootSession: r.rootSession } : {}
    }] : [];
  }).sort((a, b) => a.askedAt - b.askedAt);
}
function newApprovalId() {
  return randomUUID4();
}
async function answerPendingApproval(home, id, body) {
  const r = readApproval(home, id);
  if (!r) return "expired";
  try {
    const res = await fetch(`http://${RELAY_HOST}:${r.port}${ANSWER_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${r.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS)
    });
    return res.status === 200 ? "answered" : res.status === 409 ? "expired" : "unavailable";
  } catch {
    return readApproval(home, id) ? "unavailable" : "expired";
  }
}

export {
  primaryFor,
  mastersFor,
  canControlJob,
  chooseJobRecipient,
  worktreeProcesses,
  worktreeProcessReport,
  jobEnvironment,
  ParentLink,
  parentFromEnv,
  appendContextEvent,
  RELAY_URL_ENV,
  PermissionRelay,
  askRelay,
  MAX_APPROVAL_REASON_CHARS,
  publishApproval,
  listPendingApprovals,
  answerPendingApproval,
  codexDriveMappings,
  codexPathReport,
  PARENT_JOB_ENV,
  ROOT_SESSION_ENV,
  ROOT_NAME_ENV,
  currentDelegateDepth,
  DelegateError,
  resolveBinary,
  unwrapNpmShim,
  killTree,
  killPid,
  pidAlive,
  killAllDelegates,
  resolveCommand,
  runProcess,
  childEnv,
  checkDepth,
  parseCodexJsonl,
  delegateToCodex,
  parseClaudeJson,
  bundledCli,
  delegateToClaude,
  parseOpencodeJsonl,
  opencodeV2,
  delegateToOpencode,
  retryTransient,
  failureCause,
  antigravityPluginDir,
  antigravityRuntimeHome,
  antigravityHookCommand,
  ANTIGRAVITY_ACCESS_ENV,
  delegateToAntigravity,
  listOpencodeModels,
  delegateToOpencodeServed,
  delegateToCodexAppServer,
  nativeSubagentsSchema,
  ACCESS_LEVELS,
  supportsAsk,
  DELEGATION_TARGETS,
  JOB_SETTING_KEYS,
  PERMISSION_KEY_AGENT,
  changedJobArgs,
  parseJobSettings,
  notifyOwnerQuestion,
  RootConcurrency,
  recoverJobRecord,
  recoverJobRecordAsync,
  NOTE_CONVERSATION_SUFFIX,
  DEFAULT_FOLLOW_UP,
  QUEUED_FOLLOW_UP_NOTE,
  jobReport,
  denyPendingApprovals,
  waitForApproval,
  JobManager,
  sessionOfError,
  readJobsDocument,
  readStore,
  acquireLock
};
