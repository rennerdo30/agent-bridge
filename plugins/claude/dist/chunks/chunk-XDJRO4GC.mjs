import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  codexHome,
  codexPermissionHookHash,
  codexPermissionHookTrusted,
  recordCodexHookObservation
} from "./chunk-IOGZQ3DT.mjs";
import {
  MessageStore,
  SQLITE_STORE_VERSION,
  agentQueueKey,
  registrationIdentity
} from "./chunk-OSPAFVQU.mjs";
import {
  DECISION_MESSAGE_HOP,
  MAX_DECISION_TEXT_CHARS,
  MAX_DECISION_TOPIC_CHARS,
  decisionApplies,
  decisionScopeSchema
} from "./chunk-ZVUNLWSK.mjs";
import {
  t
} from "./chunk-G553VMJN.mjs";
import {
  BridgeClient
} from "./chunk-QKVEMNKK.mjs";
import {
  formatSiblingMessages,
  formatUsage
} from "./chunk-ZWQQ2IRN.mjs";
import {
  conversationPageSchema,
  readConversation
} from "./chunk-QZHT7RY5.mjs";
import {
  historySearchSchema,
  listNativeSubagents,
  readTranscript,
  validTranscriptCursor
} from "./chunk-URQRJGSR.mjs";
import {
  DESK_READ_PATTERNS,
  approvalHint,
  isAutoApproved,
  isHandoffToolCall,
  isOwnServerCall
} from "./chunk-HFRXC4WN.mjs";
import {
  CONTROL_CONVERSATION_PREFIX,
  JOB_OUTCOME_CONTRACT_VERSION,
  JobRunners,
  MAX_REMOTE_JOBS,
  REMOTE_JOB_CAPABILITY,
  REMOTE_JOB_FRAME,
  REMOTE_JOB_LOCAL_TIMEOUT_MS,
  REMOTE_JOB_RATE_LIMIT,
  REMOTE_JOB_RATE_WINDOW_MS,
  REMOTE_JOB_REQUEST_TIMEOUT_MS,
  REMOTE_JOB_SPAWN_LIMIT,
  ReadJournal,
  deriveJobOutcome,
  invalidateWorktreePathProof,
  listJobOutcomes,
  prepareWorktreeContinuation,
  readRunnerState,
  recordLocalResult,
  recordWorktreeOrigin,
  remoteJobRequestSchema,
  remoteJobSnapshotSchema,
  remoteJobWireSchema,
  worktreeLease
} from "./chunk-B4KIN2UR.mjs";
import {
  WORKTREE_LINK_HINT,
  changedFiles,
  createWorktree,
  finishWorktree,
  git,
  gitChangeSnapshot,
  gitDirsOutside,
  handoffWarning,
  scanWorktreeLinks,
  subagentCommitMessage,
  trustArgs,
  worktreeLinkWarning,
  worktreeReport
} from "./chunk-3BS5BGPD.mjs";
import {
  resolveDbPath,
  resolvePipePath
} from "./chunk-AAHUVIX2.mjs";
import {
  assertPhysicalPath
} from "./chunk-R3TJGIIC.mjs";
import {
  COMPLETION_DEDUPE_PREFIX,
  DEFAULT_RUN_PAGE_SIZE,
  DELEGATION_TARGETS,
  DelegateError,
  JOB_SETTING_KEYS,
  MAX_RUN_PAGE_SIZE,
  PARENT_JOB_ENV,
  ParentLink,
  PermissionRelay,
  ROOT_NAME_ENV,
  ROOT_SESSION_ENV,
  RootConcurrency,
  acquireLock,
  answerPendingApproval,
  appendContextEvent,
  bundledCli,
  canControlJob,
  checkDepth,
  chooseJobRecipient,
  codexDriveMappings,
  codexPathReport,
  completionMessageId,
  denyPendingApprovals,
  listPendingApprovals,
  mastersFor,
  pageRuns,
  parseJobSettings,
  primaryFor,
  publishApproval,
  readHistoryJobs,
  readJobsDocument,
  readRunLogs,
  readStore,
  recoverJobRecord,
  retryTransient,
  supportsAsk,
  waitForApproval
} from "./chunk-QA5RZM2I.mjs";
import {
  ResourceSlots,
  SLOT_OWNER_ENV,
  SLOT_PID_ENV,
  SLOT_RENEW_MS,
  resourceSlotHint
} from "./chunk-3W4JHJFI.mjs";
import {
  DISCOVERY_BIND,
  DISCOVERY_GROUP,
  DISCOVERY_INTERVAL_MS,
  DISCOVERY_MULTICAST_TTL,
  DISCOVERY_PORT,
  DISCOVERY_TTL_MS,
  MAX_DISCOVERED_INSTANCES,
  MAX_DISCOVERY_BYTES,
  MAX_NETWORK_FRAME_BYTES,
  MAX_NETWORK_HOST_CHARS,
  MAX_NETWORK_LINKS,
  MAX_NETWORK_PEERS,
  MAX_NETWORK_REQUESTS,
  MAX_PAIRING_CODE_CHARS,
  MAX_PORT,
  NETWORK_HEARTBEAT_TIMEOUT_MS,
  NETWORK_NAME_PATTERN,
  NETWORK_REFRESH_MS,
  NETWORK_TIMEOUT_MS,
  NETWORK_VERSION,
  OWNER_DIR_MODE,
  OWNER_FILE_MODE,
  PAIRING_KEY_BYTES,
  PAIRING_TTL_MS,
  TLS_CIPHER,
  loadConfig,
  readNetworkConfig,
  writeNetworkConfig
} from "./chunk-IUXF4RKH.mjs";
import {
  startRunFeed
} from "./chunk-QQ6WJKON.mjs";
import {
  MAX_JOB_SEND_TARGETS,
  isJobSendTarget,
  siblingMaxHops
} from "./chunk-GZUPJ35X.mjs";
import {
  loadOrCreateToken,
  tokensEqual
} from "./chunk-PCXGTT2Z.mjs";
import {
  AGENT_KINDS,
  BROADCAST,
  BridgeError,
  CODING_AGENTS,
  FrameDecoder,
  SIBLING_CONVERSATION_PREFIX,
  SIBLING_NOTE_SUFFIX,
  TRANSFER_PROGRESS_PREFIX,
  encodeFrame,
  isQuietMessage
} from "./chunk-SOPZATYP.mjs";
import {
  TRANSCRIPT_ID,
  canonicalProjectRoot,
  migrateProjectJobs,
  projectGroupsEnabled,
  projectKey,
  readArchivedJobSnapshot,
  readJsonSnapshot,
  transcriptPaths
} from "./chunk-424BA3TS.mjs";
import {
  isPluginCacheCwd
} from "./chunk-JJMNBQDB.mjs";
import {
  isSqliteBusy
} from "./chunk-AGX4O262.mjs";
import {
  external_exports
} from "./chunk-JYWG6ADH.mjs";
import {
  JSON_STORE_VERSION,
  assertWritableStore,
  isRecord,
  readJsonStore,
  recordStorePeer,
  retentionLimit,
  validStoreCapabilities,
  writeJsonStore
} from "./chunk-CLF3ZYME.mjs";
import {
  APP_VERSION,
  BROKER_TESTED_JOB_LOAD,
  DEFAULT_DELEGATE_TIMEOUT_SEC,
  DEFAULT_MAX_HOPS,
  DELEGATION_METADATA_VERSION,
  ELECTION_MAX_ATTEMPTS,
  ELECTION_RETRY_MAX_MS,
  ELECTION_RETRY_MIN_MS,
  ENV,
  JOBS_FILE,
  MAX_BODY_CHARS,
  MAX_FRAME_BYTES,
  MAX_JOB_TIMEOUT_SEC,
  MESSAGE_TTL_MS,
  PROTOCOL_VERSION,
  PURGE_INTERVAL_MS,
  QUEUED_MAIL_MAX_AGE_MS,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_MIN_MS
} from "./chunk-DQEWVRBU.mjs";

// src/core/project-groups.ts
import { join } from "node:path";
var ProjectGroups = class {
  constructor(home) {
    this.home = home;
  }
  home;
  roots = /* @__PURE__ */ new Map();
  jobRoots = /* @__PURE__ */ new Map();
  settings = /* @__PURE__ */ new Map();
  dispatchRoots = /* @__PURE__ */ new Map();
  enabled(root, agent) {
    const key = JSON.stringify([root, agent]);
    if (!this.settings.has(key)) {
      if (!this.settings.size) queueMicrotask(() => this.settings.clear());
      this.settings.set(key, projectGroupsEnabled(root, this.home, agent));
    }
    return this.settings.get(key);
  }
  root(cwd) {
    if (!this.roots.has(cwd)) this.roots.set(cwd, canonicalProjectRoot(cwd));
    return this.roots.get(cwd) ?? null;
  }
  same(a, b) {
    const left = this.root(a), right = this.root(b);
    return Boolean(left && right && projectKey(left) === projectKey(right) && this.enabled(left));
  }
  decorate(peer) {
    const root = this.root(peer.cwd);
    return { ...peer, projectRoot: root ?? void 0, projectGroup: root && peer.agent !== "other" && !peer.jobAgent && !peer.subagent && this.enabled(root, peer.agent) ? projectKey(root) : void 0 };
  }
  /** Paired-PC jobs remain outside local group authority. */
  shareable(job) {
    return !job.remote;
  }
  jobRoot(job, peers) {
    if (!this.dispatchRoots.has(job)) {
      if (!this.dispatchRoots.size) queueMicrotask(() => this.dispatchRoots.clear());
      this.dispatchRoots.set(job, this.resolveJobRoot(job, peers));
    }
    return this.dispatchRoots.get(job) ?? null;
  }
  resolveJobRoot(job, peers) {
    const worktree = job.worktree;
    for (const value of [job.projectRoot, worktree?.repoRoot]) {
      if (typeof value === "string") {
        const root = this.root(value);
        if (root) {
          this.jobRoots.set(String(job.id), root);
          return root;
        }
      }
    }
    const runner = peers.find((p) => p.jobAgent && p.id === `job:${job.id}`);
    let spec;
    if (this.home && typeof job.id === "string" && /^[a-zA-Z0-9_-]+$/.test(job.id)) {
      try {
        spec = readJsonSnapshot(join(this.home, "jobs", `${job.id}.spec.json`)).value;
      } catch {
      }
    }
    for (const value of [isRecord(spec) ? spec.cwd : void 0, job.workdir, runner?.cwd]) {
      if (typeof value === "string") {
        const root = this.root(value);
        if (root) {
          this.jobRoots.set(String(job.id), root);
          return root;
        }
      }
    }
    const history = Array.isArray(job.ownershipHistory) ? job.ownershipHistory : [];
    const original = history.length ? history[0]?.fromRootName ?? history[0]?.from : job.rootName ?? job.owner;
    const owner = peers.find((p) => !p.jobAgent && p.name === original);
    if (owner) {
      const root = this.root(owner.cwd);
      if (root) this.jobRoots.set(String(job.id), root);
      return root;
    }
    return this.jobRoots.get(String(job.id)) ?? null;
  }
  canControl(peer, job, local) {
    if (peer.host) return false;
    if (peer.jobAgent && peer.name === job.parentJob) return true;
    if (peer.jobAgent || peer.subagent) return false;
    if (canControlJob(job, peer.name)) return true;
    if (!this.shareable(job)) return false;
    return this.members(job, local).some((p) => p.name === peer.name);
  }
  members(job, local) {
    if (!this.shareable(job)) return [];
    const root = this.jobRoot(job, local);
    if (!root) return [];
    return local.filter((p) => {
      if (p.agent === "other" || p.jobAgent || p.subagent || p.host) return false;
      const candidate = this.root(p.cwd);
      return Boolean(candidate && projectKey(candidate) === projectKey(root) && this.enabled(root, p.agent));
    });
  }
  candidate(job, local) {
    if (!this.shareable(job)) return void 0;
    return this.members(job, local).filter((p) => !p.unavailable).sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name))[0];
  }
};

// src/mcp/delegate-run.ts
import { randomUUID as randomUUID11 } from "node:crypto";
import { isAbsolute as isAbsolute3, join as join10, relative as relative2, resolve as resolve3 } from "node:path";

// src/core/effort.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
function defaultEffort(agent, model, read = (p) => readFileSync(p, "utf8")) {
  try {
    if (agent === "codex") return codexConfigEffort(read(join2(codexHome(), "config.toml")));
    if (agent === "claude") return claudeSettingsEffort(read(join2(process.env.CLAUDE_CONFIG_DIR?.trim() || join2(homedir(), ".claude"), "settings.json")), model);
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

// src/core/node.ts
import { randomUUID as randomUUID10 } from "node:crypto";
import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import { dirname as dirname4, join as join9 } from "node:path";

// src/core/history-background.ts
import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join as join3 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var HistoryBackground = class {
  worker;
  stopped = false;
  exited = false;
  restart = null;
  id = 0;
  pending = /* @__PURE__ */ new Map();
  constructor(file, log) {
    let entry = new URL("./history-worker.mjs", import.meta.url);
    if (import.meta.url.endsWith(".ts")) {
      const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      const path = join3(root, ".agent-bridge-test", "history-worker.mjs");
      const inputs = [
        "history-worker.ts",
        "history.ts",
        "conversations.ts",
        "project-store.ts"
      ];
      if (!existsSync(path) || inputs.some(
        (name2) => statSync(join3(root, "src/core", name2)).mtimeMs > statSync(path).mtimeMs
      )) {
        mkdirSync(dirname(path), { recursive: true });
        createRequire(import.meta.url)("esbuild").buildSync({
          entryPoints: [join3(root, "src/core/history-worker.ts")],
          outfile: path,
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node22",
          external: ["node:*"],
          logLevel: "silent"
        });
      }
      entry = pathToFileURL(path);
    }
    const start = () => {
      this.exited = false;
      this.worker = new Worker(entry, {
        workerData: { file, home: dirname(file), paths: transcriptPaths() },
        execArgv: []
      });
      this.worker.on("message", (message) => {
        if (message.id) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending?.reject(new Error(message.error));
          else pending?.resolve(message.result);
        } else if (message.error)
          log.warn("history background batch deferred", { err: message.error });
      });
      this.worker.on("error", (err) => {
        log.warn("history worker failed", { err: String(err) });
        for (const p of this.pending.values())
          p.reject(err instanceof Error ? err : new Error(String(err)));
        this.pending.clear();
      });
      this.worker.on("exit", (code) => {
        this.exited = true;
        for (const p of this.pending.values())
          p.reject(new Error(`History worker exited (${code})`));
        this.pending.clear();
        if (!this.stopped) {
          log.warn("history worker restarting", { code });
          this.restart = setTimeout(start, 2e3);
          this.restart.unref();
        }
      });
      this.worker.unref();
    };
    start();
  }
  tick(reset = false) {
    if (this.stopped || this.exited)
      return Promise.reject(
        new Error("History worker unavailable; backfill will resume")
      );
    return new Promise((resolve4, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve: resolve4, reject });
      this.worker.postMessage({ id, reset });
    });
  }
  async close() {
    this.stopped = true;
    if (this.restart) clearTimeout(this.restart);
    for (const p of this.pending.values())
      p.reject(new Error("History worker closed"));
    this.pending.clear();
    if (this.exited) return;
    await new Promise((resolve4) => {
      const timer = setTimeout(() => {
        void this.worker.terminate().then(() => resolve4());
      }, 2e3);
      this.worker.once("exit", () => {
        clearTimeout(timer);
        resolve4();
      });
      this.worker.postMessage({ stop: true });
    });
  }
};

// src/core/broker.ts
import { randomUUID as randomUUID8 } from "node:crypto";
import { createServer as createServer2 } from "node:net";

// src/core/job-handoff.ts
import { randomUUID } from "node:crypto";
import { readFileSync as readFileSync2 } from "node:fs";
var handoffSchema = external_exports.object({
  to: external_exports.string().min(1).max(64),
  jobs: external_exports.union([external_exports.literal("all"), external_exports.array(external_exports.string().min(1).max(80)).min(1).max(1e3)]).default("all"),
  note: external_exports.string().max(4e3).optional(),
  switch_project_main: external_exports.boolean().optional()
}).strict();
function commitHandoff(path, source, target, input, options = {}) {
  const args = handoffSchema.parse(input);
  if (source.jobAgent) throw new BridgeError("unauthorized", "Only the current supervisor session can hand off its own jobs.");
  if (isPluginCacheCwd(source.cwd) || isPluginCacheCwd(target.cwd) || target.host || target.name.includes("/") || target.jobAgent || !CODING_AGENTS.includes(target.agent)) {
    throw new BridgeError("bad_request", "The target must be an exact live local Claude Code, Codex, opencode or Antigravity session. Paired-PC handoff is not supported.");
  }
  if (target.name === source.name && options.reason !== "group-restored" && !options.canControl) throw new BridgeError("bad_request", "Choose another local supervisor session.");
  const unlock = acquireLock(`${path}.lock`, 0);
  try {
    let previous = null;
    try {
      previous = JSON.parse(readFileSync2(path, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const migrated = migrateJobOwnership(previous);
    const activeRecords = migrated.jobs;
    const byId = /* @__PURE__ */ new Map();
    for (const j of [...readArchivedJobSnapshot(path).jobs, ...activeRecords]) {
      if (isRecord(j) && typeof j.id === "string" && typeof j.name === "string") byId.set(j.id, j);
    }
    const records = [...byId.values()];
    const own = records.filter((j) => !j.parentJob && (j.owner === source.name || options.canControl?.(j)));
    const selected = args.jobs === "all" ? own : args.jobs.map((name2) => {
      const job = own.find((j) => j.name === name2);
      if (!job) throw new BridgeError("unauthorized", `Job ${name2} is not controlled by this master (use an exact job name).`);
      return job;
    });
    if (selected.length && selected.every((job) => primaryFor(job) === target.name) && options.reason !== "group-restored") throw new BridgeError("bad_request", "The target is already the primary for these jobs.");
    const moved = new Set(selected.map((j) => j.name));
    for (let changed = true; changed; ) {
      changed = false;
      for (const j of records) if (j.parentJob && moved.has(j.parentJob) && !moved.has(j.name)) {
        moved.add(j.name);
        changed = true;
      }
    }
    const jobs = records.filter((j) => moved.has(j.name));
    if (!jobs.length) throw new BridgeError("bad_request", "This supervisor has no jobs to hand off.");
    if (jobs.some((j) => j.remote || j.args?.host)) throw new BridgeError("bad_request", "Remote jobs (remote-jobs-v1) cannot be handed off yet. Select only local jobs; no jobs were moved.");
    const existing = records.find((j) => j.owner === target.name && !j.parentJob && j.supervisor);
    const rootSession = existing?.supervisor ?? target.sessionId ?? target.id;
    const receipt = {
      id: randomUUID(),
      at: Date.now(),
      from: source.name,
      to: target.name,
      rootSession,
      note: args.note,
      reason: options.reason ?? "explicit-handoff",
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        title: String(j.args?.title ?? "Untitled job"),
        status: j.status,
        from: j.owner ?? source.name,
        to: j.parentJob ?? target.name,
        oldRoot: j.rootName
      }))
    };
    const updates = new Map(jobs.map((j) => {
      const history = j.ownershipHistory;
      const change = {
        id: receipt.id,
        at: receipt.at,
        from: j.owner ?? source.name,
        to: j.parentJob ?? target.name,
        fromRoot: j.rootSession,
        fromRootName: j.rootName,
        rootSession,
        rootName: target.name,
        note: args.note,
        reason: receipt.reason
      };
      const sendTo = j.args?.send_to;
      return [j.id, {
        ...j,
        owner: change.to,
        supervisor: rootSession,
        rootSession,
        rootName: target.name,
        masters: [.../* @__PURE__ */ new Set([target.name, source.name, ...Array.isArray(j.masters) ? j.masters : []])],
        ...j.status === "running" && !j.host ? { executionOwner: j.executionOwner ?? j.owner } : {},
        args: { ...j.args, ...Array.isArray(sendTo) ? { send_to: [...new Set(sendTo.map((name2) => name2 === source.name ? target.name : name2))] } : {} },
        ownershipHistory: [...Array.isArray(history) ? history : [], change]
      }];
    }));
    const active = activeRecords;
    const ids = new Set(active.filter(isRecord).map((j) => j.id));
    const all = active.map((j) => isRecord(j) ? updates.get(String(j.id)) ?? j : j);
    for (const [id, job] of updates) if (!ids.has(id)) all.push(job);
    const journal = isRecord(previous) && Array.isArray(previous.handoffs) ? previous.handoffs : [];
    writeJsonStore(path, { ...migrated, jobs: all, handoffs: [...journal, receipt] }, previous);
    return receipt;
  } finally {
    unlock();
  }
}
function handoffJournal(path) {
  const value = readJobsDocument(path);
  return isRecord(value) && Array.isArray(value.handoffs) ? value.handoffs : [];
}
function migrateJobOwnership(previous) {
  assertWritableStore(previous);
  if (previous !== null && !Array.isArray(previous) && (!isRecord(previous) || !Array.isArray(previous.jobs))) throw new Error("Invalid job registry; migration left it untouched.");
  const jobs = Array.isArray(previous) ? previous : isRecord(previous) ? previous.jobs : [];
  if (isRecord(previous) && previous.handoffs !== void 0 && !Array.isArray(previous.handoffs)) throw new Error("Invalid handoff history; migration left it untouched.");
  return { ...isRecord(previous) ? previous : {}, version: JSON_STORE_VERSION, jobs: migrateProjectJobs(jobs), handoffs: isRecord(previous) ? previous.handoffs ?? [] : [] };
}

// src/network/link.ts
import { randomBytes as randomBytes2, randomUUID as randomUUID5 } from "node:crypto";
import { connect, createServer } from "node:tls";

// src/network/discovery.ts
import { createSocket } from "node:dgram";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";

// src/network/pairing.ts
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID as randomUUID2 } from "node:crypto";
import { chmodSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync3, renameSync, writeFileSync } from "node:fs";
import { join as join4 } from "node:path";
var DEFAULT_SYSTEM_ROOT = "C:\\Windows";
var SYSTEM32 = join4(process.env.SystemRoot || DEFAULT_SYSTEM_ROOT, "System32");
var WHOAMI = join4(SYSTEM32, "whoami.exe");
var ICACLS = join4(SYSTEM32, "icacls.exe");
var keySchema = external_exports.string().regex(/^[0-9a-f]{64}$/);
var identitySchema = external_exports.object({ id: external_exports.uuid(), key: keySchema });
var publicIdentitySchema = external_exports.object({ id: external_exports.uuid(), name: external_exports.string().regex(NETWORK_NAME_PATTERN), fingerprint: keySchema });
var invitationSchema = external_exports.object({ key: keySchema, expiresAt: external_exports.number().int() });
var pairSchema = publicIdentitySchema.extend({ key: keySchema, host: external_exports.string().min(1).max(MAX_NETWORK_HOST_CHARS).optional(), port: external_exports.number().int().min(1).max(MAX_PORT).optional() });
var stateSchema = external_exports.object({ identity: identitySchema, invitations: external_exports.array(invitationSchema).max(MAX_NETWORK_LINKS), pairs: external_exports.array(pairSchema).max(MAX_NETWORK_LINKS) });
var codeSchema = publicIdentitySchema.extend({ v: external_exports.literal(NETWORK_VERSION), key: keySchema });
function keyFingerprint(key) {
  return createHash("sha256").update(Buffer.from(key, "hex")).digest("hex");
}
var ACL_PRINCIPAL = /([^\s:][^:]*?):\(/;
function protect(path, mode) {
  if (process.platform !== "win32") return chmodSync(path, mode);
  const [account, sid] = (execFileSync(WHOAMI, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).match(/"([^"]+)","(S-\d+(?:-\d+)+)"/) ?? []).slice(1);
  if (!sid || !account) throw new Error("cannot identify the account for network key permissions");
  const grant = mode === OWNER_DIR_MODE ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  execFileSync(ICACLS, [path, "/inheritance:r", "/grant:r", grant, "/Q"], { windowsHide: true, stdio: "pipe" });
  const others = execFileSync(ICACLS, [path], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).map((line) => (line.startsWith(path) ? line.slice(path.length) : line).trim()).map((line) => ACL_PRINCIPAL.exec(line)?.[1]).filter((p) => Boolean(p) && p.toLowerCase() !== account.toLowerCase());
  for (const principal of new Set(others)) execFileSync(ICACLS, [path, "/remove:g", principal, "/Q"], { windowsHide: true, stdio: "pipe" });
  const acl = execFileSync(ICACLS, [path], { encoding: "utf8", windowsHide: true });
  if ((acl.match(/:\(/g) ?? []).length !== 1 || acl.includes("(I)")) throw new Error("network key location has additional ACL grants; restrict it to the current account");
}
function decodePairingCode(code) {
  if (code.length > MAX_PAIRING_CODE_CHARS || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("invalid pairing code");
  return codeSchema.parse(JSON.parse(Buffer.from(code, "base64url").toString("utf8")));
}
var PairingStore = class {
  constructor(home, name2, now = Date.now) {
    this.name = name2;
    this.now = now;
    if (!NETWORK_NAME_PATTERN.test(name2)) throw new Error("invalid network instance name");
    this.dir = join4(home, "network");
    this.file = join4(this.dir, "keys.json");
    mkdirSync2(this.dir, { recursive: true, mode: OWNER_DIR_MODE });
    protect(this.dir, OWNER_DIR_MODE);
    if (existsSync2(this.file)) {
      protect(this.file, OWNER_FILE_MODE);
      this.state = stateSchema.parse(JSON.parse(readFileSync3(this.file, "utf8")));
    } else {
      this.state = { identity: { id: randomUUID2(), key: randomBytes(PAIRING_KEY_BYTES).toString("hex") }, invitations: [], pairs: [] };
      this.save();
    }
  }
  name;
  now;
  dir;
  file;
  state;
  get identity() {
    return { id: this.state.identity.id, name: this.name, fingerprint: keyFingerprint(this.state.identity.key) };
  }
  pairs() {
    return this.state.pairs.map((p) => ({ ...p }));
  }
  invite() {
    return this.inviteWithExpiry().code;
  }
  inviteWithExpiry() {
    this.state.invitations = this.state.invitations.filter((p) => p.expiresAt > this.now());
    if (this.state.invitations.length + this.state.pairs.length >= MAX_NETWORK_LINKS) throw new Error("network pairing limit reached");
    const key = randomBytes(PAIRING_KEY_BYTES).toString("hex");
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.state.invitations.push({ key, expiresAt });
    this.save();
    return { code: Buffer.from(JSON.stringify({ v: NETWORK_VERSION, ...this.identity, key })).toString("base64url"), expiresAt };
  }
  keyFor(identity) {
    return this.state.pairs.find((p) => keyFingerprint(p.key) === identity)?.key ?? this.state.invitations.find((p) => p.expiresAt > this.now() && keyFingerprint(p.key) === identity)?.key;
  }
  accept(key, remote) {
    if (remote.id === this.identity.id || remote.name === this.name) throw new Error("network instance ids and names must differ");
    const known = this.state.pairs.find((p) => p.key === key);
    if (known) {
      if (known.id !== remote.id || known.name !== remote.name || known.fingerprint !== remote.fingerprint) throw new Error("paired identity changed");
      return known;
    }
    const invitation = this.state.invitations.find((p) => p.key === key && p.expiresAt > this.now());
    if (!invitation) throw new Error("pairing code expired or revoked");
    this.checkNew(remote);
    const pair = { ...remote, key };
    this.state.pairs.push(pair);
    this.state.invitations = this.state.invitations.filter((p) => p !== invitation);
    this.save();
    return pair;
  }
  remember(code, host, port) {
    const parsed = this.validatePair(code, host, port);
    this.state.pairs = this.state.pairs.filter((p) => p.id !== parsed.id);
    this.state.pairs.push(parsed);
    this.save();
    return parsed;
  }
  validatePair(code, host, port) {
    const parsed = pairSchema.parse({ id: code.id, name: code.name, fingerprint: code.fingerprint, key: code.key, host, port });
    const old = this.state.pairs.find((p) => p.id === code.id);
    if (old && (old.key !== code.key || old.fingerprint !== code.fingerprint || old.name !== code.name)) throw new Error("unlink the existing peer before pairing again");
    if (!old) this.checkNew(parsed);
    return parsed;
  }
  checkNew(remote) {
    if (remote.id === this.identity.id || remote.name === this.name) throw new Error("cannot pair with this instance");
    if (this.state.pairs.length >= MAX_NETWORK_LINKS) throw new Error("network pairing limit reached");
    if (this.state.pairs.some((p) => p.id === remote.id || p.name === remote.name)) throw new Error("instance already paired; unlink it first");
  }
  remove(id) {
    this.state.pairs = this.state.pairs.filter((p) => p.id !== id);
    this.save();
  }
  save() {
    const temp = join4(this.dir, `${randomUUID2()}.tmp`);
    writeFileSync(temp, JSON.stringify(this.state, null, 2) + "\n", { mode: OWNER_FILE_MODE, flag: "wx" });
    protect(temp, OWNER_FILE_MODE);
    renameSync(temp, this.file);
  }
};

// src/network/discovery.ts
var announcementSchema = publicIdentitySchema.extend({ service: external_exports.literal("agent-bridge"), v: external_exports.literal(NETWORK_VERSION), port: external_exports.number().int().min(1).max(MAX_PORT) });
var VIRTUAL_INTERFACE = /vethernet|hyper-v|wsl|docker|vbox|vmware|virtualbox|^virbr|^br-|^utun|^tun\d|^tap\d|^tailscale|^wg\d/i;
var IPV4_BITS = 32;
var IPV4_OCTET_BITS = 8;
var IPV4_OCTET_MASK = 255;
var MIN_BROADCAST_HOST_MASK = 3;
var ipv4Number = (address) => address.split(".").reduce((value, octet) => value << IPV4_OCTET_BITS | Number(octet), 0) >>> 0;
var ipv4Address = (value) => Array.from({ length: IPV4_BITS / IPV4_OCTET_BITS }, (_, i) => value >>> IPV4_BITS - IPV4_OCTET_BITS * (i + 1) & IPV4_OCTET_MASK).join(".");
function discoveryInterfaces(all) {
  const interfaces = [], skippedInterfaces = [];
  for (const [name2, addresses] of Object.entries(all)) for (const entry of addresses ?? []) {
    if (entry.family !== "IPv4") continue;
    let reason = "";
    if (entry.internal || entry.address.startsWith("127.")) reason = "loopback";
    else if (VIRTUAL_INTERFACE.test(name2)) reason = "virtual or tunnel adapter";
    else if (entry.address.startsWith("169.254.") || entry.address === "0.0.0.0") reason = "no LAN address";
    else if (!isIPv4(entry.address) || !isIPv4(entry.netmask)) reason = "invalid IPv4 subnet";
    else {
      const mask = ipv4Number(entry.netmask), hostMask = ~mask >>> 0;
      if (mask === 0 || hostMask < MIN_BROADCAST_HOST_MASK || (hostMask & hostMask + 1) !== 0) reason = "no broadcast subnet";
    }
    if (reason) skippedInterfaces.push({ name: name2, address: entry.address, reason });
    else if (!interfaces.some((item) => item.address === entry.address)) interfaces.push({
      name: name2,
      address: entry.address,
      netmask: entry.netmask,
      broadcast: ipv4Address(ipv4Number(entry.address) | ~ipv4Number(entry.netmask))
    });
  }
  return { interfaces, skippedInterfaces };
}
var NetworkDiscovery = class {
  constructor(opts) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }
  opts;
  socket = null;
  timer = null;
  found = /* @__PURE__ */ new Map();
  now;
  senders = /* @__PURE__ */ new Map();
  refreshing = null;
  skippedInterfaces = [];
  lastSentAt = null;
  lastReceivedAt = null;
  lastError = null;
  get port() {
    return this.socket?.address().port ?? 0;
  }
  diagnostics() {
    return {
      bind: this.opts.bind ?? DISCOVERY_BIND,
      port: this.port,
      multicastGroup: DISCOVERY_GROUP,
      multicastTTL: DISCOVERY_MULTICAST_TTL,
      interfaces: [...this.senders.values()].map(({ info }) => ({ ...info })),
      skippedInterfaces: this.skippedInterfaces.map((entry) => ({ ...entry })),
      lastSentAt: this.lastSentAt,
      lastReceivedAt: this.lastReceivedAt,
      lastError: this.lastError && { ...this.lastError }
    };
  }
  error(error) {
    this.lastError = { at: this.now(), message: error.message };
    this.opts.onError?.(error);
  }
  makeSocket() {
    const socket = this.opts.createSocket?.() ?? createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", (err) => this.error(err));
    return socket;
  }
  bind(socket, port, address) {
    return new Promise((resolve4, reject) => {
      socket.once("error", reject);
      socket.bind(port, address, () => {
        socket.off("error", reject);
        resolve4();
      });
    });
  }
  async refreshInterfaces() {
    const listener = this.socket;
    if (!listener) return;
    const selection = discoveryInterfaces((this.opts.interfaces ?? networkInterfaces)());
    this.skippedInterfaces = selection.skippedInterfaces;
    for (const [address, sender] of this.senders) if (!selection.interfaces.some((entry) => entry.address === address && entry.netmask === sender.info.netmask)) {
      if (sender.info.multicast) {
        try {
          listener.dropMembership(DISCOVERY_GROUP, address);
        } catch {
        }
      }
      await this.closeSocket(sender.socket);
      this.senders.delete(address);
    }
    for (const entry of selection.interfaces) {
      if (this.senders.has(entry.address)) continue;
      const socket = this.makeSocket();
      try {
        await this.bind(socket, 0, entry.address);
        socket.setBroadcast(true);
        const info = { ...entry, announcing: true, multicast: false, lastSentAt: null };
        this.senders.set(entry.address, { socket, info });
        try {
          socket.setMulticastTTL(DISCOVERY_MULTICAST_TTL);
          socket.setMulticastInterface(entry.address);
          listener.addMembership(DISCOVERY_GROUP, entry.address);
          info.multicast = true;
        } catch (err) {
          this.error(new Error(`Discovery multicast on ${entry.name} (${entry.address}): ${err.message}`));
        }
      } catch (err) {
        this.error(new Error(`Discovery interface ${entry.name} (${entry.address}): ${err.message}`));
        await this.closeSocket(socket);
      }
    }
  }
  async start() {
    if (this.socket) throw new Error("network discovery already started");
    const socket = this.makeSocket();
    this.socket = socket;
    socket.on("message", (data, source) => this.observe(data, source.address));
    try {
      await this.bind(socket, this.opts.udpPort ?? DISCOVERY_PORT, this.opts.bind ?? DISCOVERY_BIND);
    } catch (err) {
      await this.close();
      throw err;
    }
    this.timer = setInterval(() => {
      void this.announce();
    }, DISCOVERY_INTERVAL_MS);
    this.timer.unref();
    await this.announce();
  }
  async announce(port = this.opts.udpPort === 0 ? this.port : this.opts.udpPort ?? DISCOVERY_PORT) {
    if (!this.socket) return;
    const data = Buffer.from(JSON.stringify({ service: "agent-bridge", v: NETWORK_VERSION, ...this.opts.identity, port: this.opts.port }));
    if (this.opts.destination && this.opts.destination !== DISCOVERY_GROUP) {
      this.send(this.socket, data, port, this.opts.destination);
      return;
    }
    if (!this.refreshing) this.refreshing = this.refreshInterfaces().catch((err) => this.error(err)).finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
    if (!this.socket) return;
    for (const { socket, info } of this.senders.values()) {
      this.send(socket, data, port, info.broadcast, info);
      if (info.multicast) this.send(socket, data, port, DISCOVERY_GROUP, info);
    }
  }
  send(socket, data, port, destination, info) {
    try {
      socket.send(data, port, destination, (err) => {
        if (err) this.error(new Error(`Discovery send to ${destination}: ${err.message}`));
        else {
          this.lastSentAt = this.now();
          if (info) info.lastSentAt = this.lastSentAt;
        }
      });
    } catch (err) {
      this.error(err);
    }
  }
  observe(data, host) {
    if (data.length > MAX_DISCOVERY_BYTES || !isIPv4(host)) return;
    try {
      const parsed = announcementSchema.safeParse(JSON.parse(data.toString("utf8")));
      if (!parsed.success || parsed.data.id === this.opts.identity.id) return;
      this.lastReceivedAt = this.now();
      const { id, name: name2, fingerprint, port } = parsed.data;
      this.instances();
      if (!this.found.has(id) && this.found.size >= MAX_DISCOVERED_INSTANCES) return;
      this.found.set(id, { id, name: name2, fingerprint, port, host, seenAt: this.now() });
    } catch {
    }
  }
  instances() {
    for (const [id, entry] of this.found) if (this.now() - entry.seenAt >= DISCOVERY_TTL_MS) this.found.delete(id);
    return [...this.found.values()].map((x) => ({ ...x }));
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    await this.refreshing;
    await Promise.all([...this.senders.values()].map((sender) => this.closeSocket(sender.socket)));
    this.senders.clear();
    if (socket) await this.closeSocket(socket);
    this.found.clear();
  }
  closeSocket(socket) {
    return new Promise((resolve4) => {
      try {
        socket.close(() => resolve4());
      } catch {
        resolve4();
      }
    });
  }
};

// src/network/files.ts
import { createHash as createHash2, randomUUID as randomUUID3 } from "node:crypto";
import { existsSync as existsSync3, lstatSync, mkdirSync as mkdirSync3, mkdtempSync, readFileSync as readFileSync4, readdirSync, renameSync as renameSync2, rmSync, statfsSync, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, join as join5, parse, resolve, sep } from "node:path";
var MAX_TRANSFER_BYTES = 1024 * 1024;
var MAX_TRANSFER_ENTRIES = 128;
var MAX_TRANSFER_DEPTH = 16;
var MAX_PATH_CHARS = 1024;
var MAX_COMPONENT_CHARS = 255;
var MAX_ID_CHARS = 128;
var MAX_BASE64_CHARS = Math.ceil(MAX_TRANSFER_BYTES / 3) * 4;
var pathSchema = external_exports.string().min(1).max(MAX_PATH_CHARS);
var entrySchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("directory"), path: pathSchema }),
  external_exports.object({ kind: external_exports.literal("file"), path: pathSchema, data: external_exports.string().max(MAX_BASE64_CHARS), sha256: external_exports.string().regex(/^[0-9a-f]{64}$/) })
]);
var transferSchema = external_exports.object({
  id: external_exports.uuid(),
  to: external_exports.string().regex(NETWORK_NAME_PATTERN),
  from: external_exports.object({ id: external_exports.string().min(1).max(MAX_ID_CHARS), name: external_exports.string().regex(NETWORK_NAME_PATTERN), agent: external_exports.enum(AGENT_KINDS) }),
  entries: external_exports.array(entrySchema).min(1).max(MAX_TRANSFER_ENTRIES)
});
var transferResultSchema = external_exports.object({ id: external_exports.uuid(), inbox: external_exports.string().max(MAX_PATH_CHARS), files: external_exports.number().int().nonnegative().max(MAX_TRANSFER_ENTRIES), bytes: external_exports.number().int().nonnegative().max(MAX_TRANSFER_BYTES) });
function checksum(data) {
  return createHash2("sha256").update(data).digest("hex");
}
function assertTransferPath(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join5(current, component);
    if (lstatSync(current).isSymbolicLink()) throw new Error("file transfer does not follow symlinks or junctions");
  }
}
function ensureTransferDirectory(path) {
  if (!existsSync3(path)) {
    const parent = resolve(path, "..");
    ensureTransferDirectory(parent);
    mkdirSync3(path, { mode: OWNER_DIR_MODE });
  }
  assertTransferPath(path);
  if (!lstatSync(path).isDirectory()) throw new Error("transfer directory is not a directory");
}
function safeTransferPath(path) {
  const components = path.split("/");
  return path.length <= MAX_PATH_CHARS && components.length <= MAX_TRANSFER_DEPTH && components.every((part) => part.length > 0 && part.length <= MAX_COMPONENT_CHARS && part !== "." && part !== ".." && !/[<>:"\\|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part));
}
function collectTransfer(paths, cwd, to, from) {
  if (!paths.length || paths.length > MAX_TRANSFER_ENTRIES) throw new Error("invalid number of transfer paths");
  const entries = [];
  let bytes = 0;
  const walk = (source, path) => {
    if (!safeTransferPath(path)) throw new Error("unsafe or too deep transfer path");
    if (entries.length >= MAX_TRANSFER_ENTRIES) throw new Error("too many transfer entries");
    assertTransferPath(source);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error("file transfer does not follow symlinks or junctions");
    if (stat.isDirectory()) {
      entries.push({ kind: "directory", path });
      for (const name2 of readdirSync(source).sort()) walk(join5(source, name2), `${path}/${name2}`);
    } else if (stat.isFile()) {
      if (stat.size > MAX_TRANSFER_BYTES - bytes) throw new Error("transfer exceeds size limit");
      const data = readFileSync4(source);
      bytes += data.length;
      if (bytes > MAX_TRANSFER_BYTES) throw new Error("transfer exceeds size limit");
      entries.push({ kind: "file", path, data: data.toString("base64"), sha256: checksum(data) });
    } else throw new Error("only regular files and directories can be transferred");
  };
  for (const path of paths) {
    const source = resolve(cwd, path);
    walk(source, basename(source));
  }
  const transfer = transferSchema.parse({ id: randomUUID3(), to, from, entries });
  validateEntries(transfer);
  return transfer;
}
function validateEntries(transfer) {
  const kinds = /* @__PURE__ */ new Map();
  let bytes = 0;
  let files = 0;
  const entries = transfer.entries.map((entry) => {
    const path = entry.path;
    const key = path.toLowerCase();
    if (!safeTransferPath(path) || kinds.has(key)) throw new Error("unsafe or duplicate transfer path");
    kinds.set(key, entry.kind);
    if (entry.kind === "directory") return { path, data: null };
    const data = Buffer.from(entry.data, "base64");
    if (data.toString("base64") !== entry.data || checksum(data) !== entry.sha256) throw new Error("file checksum or encoding mismatch");
    bytes += data.length;
    files++;
    if (bytes > MAX_TRANSFER_BYTES) throw new Error("transfer exceeds size limit");
    return { path, data };
  });
  for (const entry of entries) {
    const parts = entry.path.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++) if (kinds.get(parts.slice(0, i).join("/")) !== "directory") throw new Error("missing directory or file used as parent");
  }
  return { entries, bytes, files };
}
function receiveTransfer(home, input) {
  const transfer = transferSchema.parse(input);
  const { entries, bytes, files } = validateEntries(transfer);
  assertTransferPath(home);
  const disk = statfsSync(home, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(bytes)) throw new Error("insufficient free disk space for transfer");
  const inbox = join5(home, "inbox");
  ensureTransferDirectory(inbox);
  if (lstatSync(inbox).isSymbolicLink()) throw new Error("inbox cannot be a symlink");
  assertTransferPath(inbox);
  const final = join5(inbox, transfer.id);
  if (existsSync3(final)) throw new Error("transfer already received");
  const staging = mkdtempSync(join5(inbox, ".partial-"));
  try {
    for (const entry of entries.filter((e) => e.data === null).sort((a, b) => a.path.length - b.path.length)) mkdirSync3(join5(staging, ...entry.path.split("/")), { mode: OWNER_DIR_MODE });
    for (const entry of entries) if (entry.data !== null) writeFileSync2(join5(staging, ...entry.path.split("/")), entry.data, { flag: "wx", mode: OWNER_FILE_MODE });
    renameSync2(staging, final);
    return { id: transfer.id, inbox: final, files, bytes };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

// src/network/transfers.ts
import { createHash as createHash3, randomUUID as randomUUID4 } from "node:crypto";
import { constants, existsSync as existsSync4, lstatSync as lstatSync2, mkdirSync as mkdirSync4, readdirSync as readdirSync2, readFileSync as readFileSync5, renameSync as renameSync3, statSync as statSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { open, link, unlink, statfs, lstat, opendir } from "node:fs/promises";
import { basename as basename2, dirname as dirname2, isAbsolute, join as join6, relative, resolve as resolve2, sep as sep2 } from "node:path";
var FILE_STREAM_CAPABILITY = "file-stream-v1";
var TRANSFER_CHUNK_BYTES = 256 * 1024;
var DEFAULT_MAX_STREAM_BYTES = 8 * 1024 * 1024 * 1024;
var MAX_STREAM_ENTRIES = 4096;
var MAX_ACTIVE_TRANSFERS = 4;
var MAX_TRANSFER_HISTORY = 200;
var TRANSFER_REQUEST_TIMEOUT_MS = 3e4;
var TRANSFER_HEARTBEAT_MS = 5e3;
var TRANSFER_RETRY_MS = 2e3;
var TRANSFER_PROGRESS_MS = 1e3;
var SHA_RECORD_BYTES = 65;
var MAX_PATH_CHARS2 = 1024;
var MAX_SENDER_ID_CHARS = 128;
var MAX_ERROR_CHARS = 512;
var MIN_TRANSFER_FREE_BYTES = 16 * 1024 * 1024;
var SHA_PATTERN = /^[0-9a-f]{64}$/;
var RETRYABLE_TRANSFER_ERROR = /^(network link closed|network write limit reached|paired instance is not connected|file transfer request timed out|sender not advertised by paired instance|file (source peer|recipient|sender) is not online|transfer operation already in progress|too many active file transfers)$/;
var TERMINAL = /* @__PURE__ */ new Set(["completed", "cancelled", "failed"]);
var senderSchema = external_exports.object({ id: external_exports.string().min(1).max(MAX_SENDER_ID_CHARS), name: external_exports.string().regex(NETWORK_NAME_PATTERN), agent: external_exports.enum(AGENT_KINDS) });
var entrySchema2 = external_exports.object({ path: external_exports.string().min(1).max(MAX_PATH_CHARS2), kind: external_exports.enum(["file", "directory"]), size: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
var base = { id: external_exports.uuid(), rid: external_exports.uuid(), kind: external_exports.literal("request") };
var fileStreamRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ ...base, op: external_exports.literal("offer"), from: senderSchema, to: external_exports.string().regex(NETWORK_NAME_PATTERN), entries: external_exports.array(entrySchema2).min(1).max(MAX_STREAM_ENTRIES) }),
  external_exports.object({ ...base, op: external_exports.literal("chunk"), index: external_exports.number().int().nonnegative().max(MAX_STREAM_ENTRIES - 1), offset: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), data: external_exports.string().max(Math.ceil(TRANSFER_CHUNK_BYTES / 3) * 4), sha256: external_exports.string().regex(SHA_PATTERN) }),
  external_exports.object({ ...base, op: external_exports.literal("finish-file"), index: external_exports.number().int().nonnegative().max(MAX_STREAM_ENTRIES - 1), sha256: external_exports.string().regex(SHA_PATTERN) }),
  external_exports.object({ ...base, op: external_exports.literal("finish") }),
  external_exports.object({ ...base, op: external_exports.literal("cancel") }),
  external_exports.object({ ...base, op: external_exports.literal("abort"), error: external_exports.string().min(1).max(MAX_ERROR_CHARS) }),
  external_exports.object({ ...base, op: external_exports.literal("fetch"), from: senderSchema, source: external_exports.string().regex(NETWORK_NAME_PATTERN), paths: external_exports.array(external_exports.string().min(1).max(MAX_PATH_CHARS2)).min(1).max(MAX_STREAM_ENTRIES) })
]);
var responseSchema = external_exports.object({ kind: external_exports.literal("response"), rid: external_exports.uuid(), id: external_exports.uuid(), error: external_exports.string().max(MAX_ERROR_CHARS).optional(), data: external_exports.object({ offsets: external_exports.array(external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).max(MAX_STREAM_ENTRIES).optional(), status: external_exports.enum(["queued", "preparing", "running", "paused", "completed", "cancelled", "failed"]).optional() }).default({}) });
var RemoteTransferError = class extends Error {
};
function digest(data) {
  return createHash3("sha256").update(data).digest("hex");
}
function transferSummary(home, state) {
  const bytes = state.entries.reduce((sum, entry) => sum + entry.offset, 0);
  return {
    id: state.id,
    direction: state.direction,
    peer: state.peer,
    status: state.status,
    bytes,
    totalBytes: state.totalBytes,
    files: state.entries.filter((entry) => entry.kind === "file" && entry.complete).length,
    totalFiles: state.entries.filter((entry) => entry.kind === "file").length,
    percent: state.status === "completed" ? 100 : state.totalBytes ? Math.floor(bytes / state.totalBytes * 100) : 0,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...state.direction === "receive" ? { inbox: join6(home, "inbox", state.id) } : {},
    ...state.error ? { error: state.error } : {}
  };
}
function persistTransfer(root, state) {
  assertTransferPath(root);
  state.updatedAt = Date.now();
  const file = join6(root, `${state.id}.json`);
  if (existsSync4(file)) assertTransferPath(file);
  const temp = `${file}.${randomUUID4()}.tmp`;
  writeFileSync3(temp, JSON.stringify(state), { flag: "wx", mode: OWNER_FILE_MODE, flush: true });
  renameSync3(temp, file);
}
function cancelStoredTransfer(home, id) {
  external_exports.uuid().parse(id);
  const root = join6(home, "network", "transfers");
  const path = join6(root, `${id}.json`);
  if (!existsSync4(path)) throw new Error("unknown transfer");
  assertTransferPath(path);
  const state = JSON.parse(readFileSync5(path, "utf8"));
  if (state.version !== 1 || state.id !== id) throw new Error("invalid persisted transfer");
  if (state.status === "completed" || state.status === "failed" || state.legacySent) return { id, cancelled: false };
  state.status = "cancelled";
  state.cancelPending = !state.legacy;
  persistTransfer(root, state);
  return { id, cancelled: true };
}
function readTransferHistory(home) {
  const root = join6(home, "network", "transfers");
  if (!existsSync4(root)) return [];
  assertTransferPath(root);
  return readdirSync2(root).filter((file) => /^[0-9a-f-]{36}\.json$/.test(file)).map((file) => {
    const path = join6(root, file);
    assertTransferPath(path);
    return { path, mtime: statSync2(path).mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_TRANSFER_HISTORY).map(({ path }) => {
    const state = JSON.parse(readFileSync5(path, "utf8"));
    if (state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > MAX_STREAM_ENTRIES) throw new Error("invalid persisted transfer");
    return transferSummary(home, state);
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}
function allowedFetchPath(path, cwd, roots) {
  const source = resolve2(cwd, path);
  assertTransferPath(source);
  if (!roots.some((root) => {
    if (!isAbsolute(root)) return false;
    assertTransferPath(root);
    const rel = relative(resolve2(root), source);
    return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep2}`);
  })) throw new Error("fetch is disabled or path is outside allowed fetch roots");
  return source;
}
async function writeAll(file, data, position) {
  let written = 0;
  while (written < data.length) {
    const result = await file.write(data, written, data.length - written, position + written);
    if (!result.bytesWritten) throw new Error("file write made no progress");
    written += result.bytesWritten;
  }
}
var TransferManager = class {
  constructor(home, transport, log, options = {}) {
    this.home = home;
    this.transport = transport;
    this.log = log;
    this.options = options;
    assertTransferPath(home);
    this.root = join6(home, "network", "transfers");
    ensureTransferDirectory(this.root);
    assertTransferPath(this.root);
    for (const file of readdirSync2(this.root).filter((file2) => /^[0-9a-f-]{36}\.json$/.test(file2))) {
      const state = this.read(file.slice(0, -5));
      if (state && (!TERMINAL.has(state.status) || state.cancelPending || state.abortPending)) {
        if (this.states.size >= MAX_ACTIVE_TRANSFERS) {
          this.log.warn("transfer recovery limit reached", { id: state.id });
          continue;
        }
        state.status = TERMINAL.has(state.status) ? state.status : "paused";
        this.save(state);
      }
    }
    this.timer = setInterval(() => this.resume(), TRANSFER_RETRY_MS);
    this.timer.unref();
  }
  home;
  transport;
  log;
  options;
  states = /* @__PURE__ */ new Map();
  active = /* @__PURE__ */ new Set();
  receiving = /* @__PURE__ */ new Set();
  pending = /* @__PURE__ */ new Map();
  notified = /* @__PURE__ */ new Map();
  timer;
  closed = false;
  root;
  read(id) {
    const file = join6(this.root, `${id}.json`);
    if (!existsSync4(file)) return void 0;
    assertTransferPath(file);
    const state = JSON.parse(readFileSync5(file, "utf8"));
    if (state.version !== 1 || state.id !== id || !Array.isArray(state.entries) || state.entries.length > MAX_STREAM_ENTRIES) throw new Error("invalid persisted transfer");
    return state;
  }
  get(id) {
    return this.states.get(id) ?? this.read(id);
  }
  save(state) {
    persistTransfer(this.root, state);
    if (!TERMINAL.has(state.status) || state.cancelPending || state.abortPending) this.states.set(state.id, state);
    else this.states.delete(state.id);
  }
  summary(state) {
    return transferSummary(this.home, state);
  }
  list() {
    return readTransferHistory(this.home);
  }
  recordLegacy(transfer, remote, peer) {
    const entries = transfer.entries.map((entry) => ({
      kind: entry.kind,
      path: entry.path,
      size: entry.kind === "file" ? Buffer.byteLength(entry.data, "base64") : 0,
      offset: entry.kind === "file" ? Buffer.byteLength(entry.data, "base64") : 0,
      complete: true,
      ...entry.kind === "file" ? { sha256: entry.sha256 } : {}
    }));
    this.save({
      version: 1,
      id: transfer.id,
      direction: "receive",
      remote,
      peer,
      from: transfer.from,
      to: transfer.to,
      paths: [],
      cwd: "",
      entries,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      status: "completed",
      legacy: true,
      initialized: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }
  report(state, force = false) {
    if (this.closed) return;
    const now = Date.now();
    if (!force && now - (this.notified.get(state.id) ?? 0) < TRANSFER_PROGRESS_MS) return;
    this.notified.set(state.id, now);
    const progress = this.summary(state);
    this.log.info("file transfer progress", { ...progress });
    const recipient = state.direction === "send" ? state.from.name : state.to;
    const from = state.direction === "receive" ? { ...state.from, id: `${state.remote}/${state.from.id}`, name: `${state.peer.split("/")[0]}/${state.from.name}` } : { id: `files-${state.id}`, name: "files", agent: "other" };
    this.transport.notify({
      id: state.direction === "receive" && state.status === "completed" ? state.id : randomUUID4(),
      from,
      to: recipient,
      recipient,
      conversationId: TERMINAL.has(state.status) ? state.id : `${TRANSFER_PROGRESS_PREFIX}${state.id}`,
      replyTo: null,
      hop: 0,
      createdAt: now,
      readAt: null,
      body: `files: ${progress.percent}% \xB7 ${progress.bytes} / ${progress.totalBytes} bytes \xB7 ${state.status} \xB7 ${state.id}${progress.inbox ? ` \xB7 ${progress.inbox}` : ""}${state.error ? ` \xB7 ${state.error}` : ""}`
    });
    if (TERMINAL.has(state.status)) this.notified.delete(state.id);
  }
  ensureCapacity() {
    if (this.states.size >= MAX_ACTIVE_TRANSFERS) throw new Error("too many active file transfers");
  }
  start(remote, peer, to, paths, cwd, from, pull = false, id = randomUUID4(), legacy = false) {
    this.ensureCapacity();
    const state = {
      version: 1,
      id,
      direction: pull ? "receive" : "send",
      remote,
      peer,
      to,
      paths,
      cwd,
      from,
      status: "queued",
      entries: [],
      totalBytes: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...pull ? { pull: true } : {},
      ...legacy ? { legacy: true } : {}
    };
    this.save(state);
    this.report(state, true);
    setImmediate(() => this.resume());
    return { id, status: "queued" };
  }
  resume() {
    if (this.closed) return;
    for (const state of this.states.values()) {
      if (this.active.has(state.id) || !state.legacy && !this.transport.supports(state.remote)) continue;
      if (state.cancelPending || state.abortPending) {
        this.active.add(state.id);
        void this.rpc(state.remote, state.id, state.cancelPending ? { op: "cancel" } : { op: "abort", error: state.error ?? "transfer failed" }).then(() => {
          state.cancelPending = false;
          state.abortPending = false;
          this.save(state);
        }).catch(() => {
        }).finally(() => this.active.delete(state.id));
      } else if (!TERMINAL.has(state.status) && (state.direction === "send" || state.pull && !state.entries.length)) {
        this.active.add(state.id);
        void this.run(state).finally(() => this.active.delete(state.id));
      }
    }
  }
  disconnected(remote) {
    for (const [rid, pending] of this.pending) if (pending.remote === remote) {
      clearTimeout(pending.timer);
      this.pending.delete(rid);
      pending.reject(new Error("network link closed"));
    }
    for (const state of this.states.values()) if (state.remote === remote && !TERMINAL.has(state.status)) {
      state.status = "paused";
      this.save(state);
      this.report(state, true);
    }
  }
  rpc(remote, id, fields) {
    if (this.closed) return Promise.reject(new Error("transfer manager closed"));
    const rid = randomUUID4();
    return new Promise((resolve4, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error("file transfer request timed out"));
      }, TRANSFER_REQUEST_TIMEOUT_MS);
      this.pending.set(rid, { remote, id, resolve: resolve4, reject, timer });
      void Promise.resolve().then(() => this.transport.send(remote, { kind: "request", rid, id, ...fields })).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(error);
      });
    });
  }
  async handle(payload, remote, remoteName) {
    if (payload.kind === "heartbeat") {
      const heartbeat2 = external_exports.object({ id: external_exports.uuid(), rid: external_exports.uuid() }).parse(payload);
      const pending = this.pending.get(heartbeat2.rid);
      if (pending?.remote === remote && pending.id === heartbeat2.id) {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          this.pending.delete(heartbeat2.rid);
          pending.reject(new Error("file transfer request timed out"));
        }, TRANSFER_REQUEST_TIMEOUT_MS);
      }
      return;
    }
    if (payload.kind === "response") {
      const response = responseSchema.parse(payload);
      const pending = this.pending.get(response.rid);
      if (!pending || pending.remote !== remote || pending.id !== response.id) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.rid);
      if (response.error) pending.reject(new RemoteTransferError(response.error));
      else pending.resolve(response.data);
      return;
    }
    const request = fileStreamRequestSchema.parse(payload);
    let data = {};
    let error;
    let heartbeatSending = false;
    const heartbeat = setInterval(() => {
      if (this.closed || heartbeatSending) return;
      heartbeatSending = true;
      void Promise.resolve().then(() => this.transport.send(remote, { kind: "heartbeat", rid: request.rid, id: request.id })).catch(() => {
      }).finally(() => {
        heartbeatSending = false;
      });
    }, TRANSFER_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      data = await this.receive(request, remote, remoteName);
    } catch (err) {
      error = err.message.slice(0, MAX_ERROR_CHARS);
      this.log.warn("file transfer rejected", { id: request.id, remote, error });
      const state = this.get(request.id);
      if (state?.remote === remote && state.direction === "receive" && !TERMINAL.has(state.status) && /checksum|encoding mismatch|insufficient free disk|invalid initial|EACCES|ENOSPC|EEXIST|ENOENT|symlinks or junctions/.test(error)) {
        state.status = "failed";
        state.error = error;
        this.save(state);
        this.report(state, true);
      }
    } finally {
      clearInterval(heartbeat);
    }
    await this.transport.send(remote, { kind: "response", rid: request.rid, id: request.id, data, ...error ? { error } : {} });
  }
  validateEntries(entries) {
    const kinds = /* @__PURE__ */ new Map();
    let total = 0;
    for (const entry of entries) {
      const key = entry.path.toLowerCase();
      if (!safeTransferPath(entry.path) || kinds.has(key)) throw new Error("unsafe or duplicate transfer path");
      kinds.set(key, entry.kind);
      if (entry.kind === "directory" && entry.size !== 0) throw new Error("invalid directory size");
      total += entry.size;
      if (!Number.isSafeInteger(total) || total > (this.options.maxBytes ?? DEFAULT_MAX_STREAM_BYTES)) throw new Error("transfer exceeds size limit");
    }
    for (const key of kinds.keys()) {
      const parts = key.split("/");
      for (let i = 1; i < parts.length; i++) if (kinds.get(parts.slice(0, i).join("/")) !== "directory") throw new Error("missing directory or file used as parent");
    }
    if (Buffer.byteLength(JSON.stringify(entries.map(({ path, kind, size }) => ({ path, kind, size })))) > MAX_NETWORK_FRAME_BYTES / 2) throw new Error("transfer manifest exceeds network frame limit");
    return total;
  }
  async collect(state) {
    const entries = [];
    let total = 0;
    const walk = async (source, path) => {
      if (this.closed || state.status === "cancelled") throw new Error("transfer cancelled");
      if (!safeTransferPath(path) || path.split("/").length > MAX_TRANSFER_DEPTH || entries.length >= MAX_STREAM_ENTRIES) throw new Error("unsafe or too many transfer entries");
      assertTransferPath(source);
      const st = await lstat(source);
      if (st.isDirectory()) {
        entries.push({ kind: "directory", path, size: 0, offset: 0 });
        const dir = await opendir(source);
        const names = [];
        for await (const child of dir) {
          if (names.length + entries.length >= MAX_STREAM_ENTRIES) throw new Error("too many transfer entries");
          names.push(child.name);
        }
        for (const name2 of names.sort()) await walk(join6(source, name2), `${path}/${name2}`);
      } else if (st.isFile()) {
        total += st.size;
        if (total > (this.options.maxBytes ?? DEFAULT_MAX_STREAM_BYTES)) throw new Error("transfer exceeds size limit");
        entries.push({ kind: "file", path, size: st.size, offset: 0, source, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev });
      } else throw new Error("only regular files and directories can be transferred");
    };
    for (const path of state.paths) {
      const source = resolve2(state.cwd, path);
      await walk(source, basename2(source));
    }
    this.validateEntries(entries);
    return entries;
  }
  async source(state, entry) {
    if (state.fetched) allowedFetchPath(entry.source, state.cwd, this.options.fetchRoots ?? []);
    assertTransferPath(entry.source);
    const file = await open(entry.source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const st = await file.stat();
      if (!st.isFile() || st.size !== entry.size || st.mtimeMs !== entry.mtimeMs || st.ino !== entry.ino || st.dev !== entry.dev) throw new RemoteTransferError("source file changed since transfer started");
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  stopped(state) {
    return state.status === "cancelled" || state.status === "failed" || this.closed;
  }
  async run(state) {
    try {
      if (state.direction === "send" || state.pull) {
        const sender = this.transport.localPeer(state.from.name);
        if (!sender) throw new Error("file sender is not online");
        if (sender.agent !== state.from.agent) throw new RemoteTransferError("file sender agent changed");
        state.from = { id: sender.id, name: sender.name, agent: sender.agent };
      }
      if (state.fetched) for (const path of state.paths) allowedFetchPath(path, state.cwd, this.options.fetchRoots ?? []);
      if (state.legacy) {
        if (state.legacySent) throw new RemoteTransferError("legacy transfer interrupted; delivery may have occurred");
        state.status = "running";
        const transfer = { ...collectTransfer(state.paths, state.cwd, state.to, state.from), id: state.id };
        state.entries = transfer.entries.map((entry) => ({ kind: entry.kind, path: entry.path, size: entry.kind === "file" ? Buffer.byteLength(entry.data, "base64") : 0, offset: 0 }));
        state.totalBytes = this.validateEntries(state.entries);
        state.legacySent = true;
        this.save(state);
        const result = await this.transport.legacy(state.remote, transfer);
        if (this.stopped(state)) return;
        state.status = "completed";
        for (const entry of state.entries) {
          entry.offset = entry.size;
          entry.complete = true;
        }
        this.save(state);
        this.report(state, true);
        this.log.info("legacy file transfer complete", result);
        return;
      }
      if (state.pull && !state.entries.length) {
        await this.rpc(state.remote, state.id, { op: "fetch", from: state.from, source: state.to, paths: state.paths });
        if (!TERMINAL.has(state.status) && !state.entries.length) {
          state.status = "paused";
          this.save(state);
        }
        return;
      }
      if (!state.entries.length) {
        state.status = "preparing";
        this.save(state);
        state.entries = await this.collect(state);
        state.totalBytes = this.validateEntries(state.entries);
        this.save(state);
      }
      if (this.stopped(state)) return;
      const reply2 = await this.rpc(state.remote, state.id, { op: "offer", from: state.from, to: state.to, entries: state.entries.map(({ path, kind, size }) => ({ path, kind, size })) });
      if (this.stopped(state)) return;
      if (reply2.status === "completed") {
        state.status = "completed";
        for (const entry of state.entries) {
          entry.offset = entry.size;
          entry.complete = true;
        }
        this.save(state);
        this.report(state, true);
        return;
      }
      if (!reply2.offsets || reply2.offsets.length !== state.entries.length) throw new RemoteTransferError("invalid resume offsets");
      state.status = "running";
      delete state.error;
      this.save(state);
      this.report(state, true);
      for (let index = 0; index < state.entries.length; index++) {
        const entry = state.entries[index];
        if (entry.kind !== "file") continue;
        const offset = reply2.offsets[index];
        if (offset > entry.size || offset !== entry.size && offset % TRANSFER_CHUNK_BYTES !== 0) throw new RemoteTransferError("invalid resume offset");
        entry.offset = offset;
        const file = await this.source(state, entry);
        const hash = createHash3("sha256");
        const buffer = Buffer.alloc(TRANSFER_CHUNK_BYTES);
        try {
          for (let position = 0; position < entry.size; ) {
            if (this.stopped(state)) return;
            const length = Math.min(TRANSFER_CHUNK_BYTES, entry.size - position);
            const { bytesRead } = await file.read(buffer, 0, length, position);
            if (bytesRead !== length) throw new RemoteTransferError("source file changed while reading");
            const chunk = buffer.subarray(0, length);
            hash.update(chunk);
            if (position >= offset) {
              await this.rpc(state.remote, state.id, { op: "chunk", index, offset: position, data: chunk.toString("base64"), sha256: digest(chunk) });
              if (this.stopped(state)) return;
              entry.offset = position + length;
              this.save(state);
              this.report(state);
            }
            position += length;
          }
          const st = await file.stat();
          if (st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) throw new RemoteTransferError("source file changed while reading");
        } finally {
          await file.close();
        }
        entry.sha256 = hash.digest("hex");
        await this.rpc(state.remote, state.id, { op: "finish-file", index, sha256: entry.sha256 });
        if (this.stopped(state)) return;
        entry.complete = true;
        this.save(state);
      }
      await this.rpc(state.remote, state.id, { op: "finish" });
      if (!this.stopped(state)) {
        state.status = "completed";
        this.save(state);
        this.report(state, true);
      }
    } catch (error) {
      if (this.stopped(state)) return;
      state.status = state.legacy || !RETRYABLE_TRANSFER_ERROR.test(error.message) ? "failed" : "paused";
      state.error = error.message.slice(0, MAX_ERROR_CHARS);
      state.abortPending = state.status === "failed" && !state.legacy;
      this.save(state);
      this.report(state, true);
    }
  }
  part(state, index) {
    return join6(this.root, state.id, `${index}.part`);
  }
  verified(state, index) {
    return join6(this.root, state.id, `${index}.verified`);
  }
  target(state, entry) {
    return join6(this.home, "inbox", state.id, ...entry.path.split("/"));
  }
  async freeDisk(bytes) {
    const disk = await statfs(this.home, { bigint: true });
    const reserved = [...this.states.values()].filter((state) => state.direction === "receive" && !TERMINAL.has(state.status)).reduce((sum, state) => sum + BigInt(state.totalBytes) - BigInt(this.summary(state).bytes) + BigInt(Math.ceil(state.totalBytes / TRANSFER_CHUNK_BYTES)) * BigInt(SHA_RECORD_BYTES) + BigInt(MAX_NETWORK_FRAME_BYTES), 0n);
    if (disk.bavail * disk.bsize < BigInt(bytes + MIN_TRANSFER_FREE_BYTES) + reserved) throw new Error("insufficient free disk space for transfer");
  }
  async hashFile(path, state) {
    assertTransferPath(path);
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const hash = createHash3("sha256");
    const buffer = Buffer.alloc(TRANSFER_CHUNK_BYTES);
    try {
      for (; ; ) {
        if (this.closed || state && this.stopped(state)) throw new Error("transfer cancelled or manager closed");
        const { bytesRead } = await file.read(buffer);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await file.close();
    }
    return hash.digest("hex");
  }
  async recover(state, entry, index) {
    if (entry.kind !== "file") return;
    const target = this.target(state, entry);
    if (entry.complete || entry.sha256 && existsSync4(target)) {
      if (await this.hashFile(target, state) !== entry.sha256) throw new Error("completed file checksum mismatch");
      entry.complete = true;
      entry.offset = entry.size;
      const part = this.part(state, index);
      if (existsSync4(part)) {
        assertTransferPath(part);
        await unlink(part);
      }
      const verified2 = this.verified(state, index);
      if (existsSync4(verified2)) {
        assertTransferPath(verified2);
        await unlink(verified2);
      }
      return;
    }
    const verifiedPath = this.verified(state, index);
    if (entry.sha256 && existsSync4(verifiedPath)) {
      if (await this.hashFile(verifiedPath, state) !== entry.sha256) throw new Error("verified file checksum mismatch");
      assertTransferPath(dirname2(target));
      await link(verifiedPath, target);
      await unlink(verifiedPath);
      entry.complete = true;
      entry.offset = entry.size;
      return;
    }
    const path = this.part(state, index);
    assertTransferPath(path);
    assertTransferPath(`${path}.sha256`);
    const file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    let journal;
    const buffer = Buffer.alloc(TRANSFER_CHUNK_BYTES);
    const record = Buffer.alloc(SHA_RECORD_BYTES);
    let verified = 0;
    let chunks = 0;
    try {
      journal = await open(`${path}.sha256`, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      while (verified < entry.offset) {
        if (this.stopped(state)) throw new Error("transfer cancelled or manager closed");
        const length = Math.min(TRANSFER_CHUNK_BYTES, entry.size - verified);
        const a = await file.read(buffer, 0, length, verified);
        const b = await journal.read(record, 0, SHA_RECORD_BYTES, chunks * SHA_RECORD_BYTES);
        if (a.bytesRead !== length || b.bytesRead !== SHA_RECORD_BYTES || record.toString() !== `${digest(buffer.subarray(0, length))}
`) break;
        verified += length;
        chunks++;
      }
      await file.truncate(verified);
      await journal.truncate(chunks * SHA_RECORD_BYTES);
      await file.sync();
      await journal.sync();
      entry.offset = verified;
    } finally {
      try {
        await file.close();
      } finally {
        await journal?.close();
      }
    }
  }
  initialize(state) {
    const inbox = join6(this.home, "inbox");
    ensureTransferDirectory(inbox);
    const final = join6(inbox, state.id);
    const parts = join6(this.root, state.id);
    for (const dir of [final, parts]) {
      if (!existsSync4(dir)) mkdirSync4(dir, { mode: OWNER_DIR_MODE });
      assertTransferPath(dir);
      if (!lstatSync2(dir).isDirectory()) throw new Error("transfer directory is not a directory");
    }
    for (const entry of state.entries.filter((entry2) => entry2.kind === "directory").sort((a, b) => a.path.length - b.path.length)) {
      const dir = this.target(state, entry);
      assertTransferPath(dirname2(dir));
      if (!existsSync4(dir)) mkdirSync4(dir, { mode: OWNER_DIR_MODE });
      assertTransferPath(dir);
      if (!lstatSync2(dir).isDirectory()) throw new Error("transfer directory is not a directory");
    }
    for (let i = 0; i < state.entries.length; i++) if (state.entries[i].kind === "file") {
      for (const file of [this.part(state, i), `${this.part(state, i)}.sha256`]) {
        assertTransferPath(dirname2(file));
        if (!existsSync4(file)) writeFileSync3(file, "", { flag: "wx", mode: OWNER_FILE_MODE, flush: true });
        assertTransferPath(file);
        if (!lstatSync2(file).isFile() || lstatSync2(file).size !== 0) throw new Error("invalid initial partial file");
      }
    }
    state.initialized = true;
    this.save(state);
  }
  async receive(request, remote, remoteName) {
    let state = this.get(request.id);
    if (state && state.remote !== remote) throw new Error("transfer belongs to another paired instance");
    if (request.op === "abort") {
      if (!state) {
        state = {
          version: 1,
          id: request.id,
          direction: "receive",
          remote,
          peer: remoteName,
          from: { id: "files", name: "files", agent: "other" },
          to: "files",
          status: "failed",
          error: request.error,
          paths: [],
          cwd: "",
          entries: [],
          totalBytes: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        this.save(state);
        this.log.warn("remote file transfer failed", { id: state.id, remote, error: request.error });
      } else if (!TERMINAL.has(state.status)) {
        state.status = "failed";
        state.error = request.error;
        state.abortPending = false;
        this.save(state);
        this.report(state, true);
        for (const [rid, pending] of this.pending) if (pending.id === state.id) {
          clearTimeout(pending.timer);
          this.pending.delete(rid);
          pending.reject(new RemoteTransferError(request.error));
        }
      }
      return { status: state.status };
    }
    if (request.op === "cancel") {
      if (!state) {
        this.save({
          version: 1,
          id: request.id,
          direction: "receive",
          remote,
          peer: remoteName,
          from: { id: "files", name: "files", agent: "other" },
          to: "files",
          status: "cancelled",
          paths: [],
          cwd: "",
          entries: [],
          totalBytes: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
        return { status: "cancelled" };
      }
      await this.cancel(request.id, false);
      return { status: state.status };
    }
    if (state?.status === "cancelled" || state?.status === "failed") throw new Error(`transfer ${state.status}`);
    if (request.op === "fetch") {
      if (!this.transport.validSender(remote, request.from)) throw new Error("sender not advertised by paired instance");
      const source = this.transport.localPeer(request.source);
      if (!source) throw new Error("file source peer is not online");
      if (!this.options.fetchRoots?.length) throw new Error("fetch is disabled or path is outside allowed fetch roots");
      const paths = request.paths.map((path) => allowedFetchPath(path, source.cwd, this.options.fetchRoots));
      if (state && (state.direction !== "send" || state.to !== request.from.name || state.from.name !== request.source || JSON.stringify(state.paths) !== JSON.stringify(paths))) throw new Error("fetch request changed");
      if (!state) {
        this.start(remote, `${remoteName}/${request.from.name}`, request.from.name, paths, source.cwd, source, false, request.id);
        const fetched = this.get(request.id);
        fetched.fetched = true;
        this.save(fetched);
      }
      return { status: state?.status ?? "queued" };
    }
    if (request.op === "offer") {
      if (!this.transport.validSender(remote, request.from)) throw new Error("sender not advertised by paired instance");
      if (!this.transport.localPeer(request.to)) throw new Error("file recipient is not online");
      const entries = request.entries.map((entry) => ({ ...entry, offset: 0 }));
      const totalBytes = this.validateEntries(entries);
      if (state?.pull && !state.entries.length) {
        if (state.to !== request.from.name || state.from.name !== request.to) throw new Error("pull offer does not match request");
        state.from = request.from;
        state.to = request.to;
        state.pull = false;
      } else if (state && (state.direction !== "receive" || JSON.stringify(state.entries.map(({ path, kind, size }) => ({ path, kind, size }))) !== JSON.stringify(request.entries) || state.from.name !== request.from.name || state.from.agent !== request.from.agent || state.to !== request.to)) throw new Error("transfer manifest changed");
      if (state) state.from = request.from;
      if (this.receiving.has(request.id)) throw new Error("transfer operation already in progress");
      this.receiving.add(request.id);
      try {
        if (!state || !state.entries.length) {
          if (!state) this.ensureCapacity();
          const inbox = join6(this.home, "inbox");
          ensureTransferDirectory(inbox);
          if (existsSync4(join6(inbox, request.id)) || existsSync4(join6(this.root, request.id))) throw new Error("transfer destination already exists");
          const receiving = {
            version: 1,
            id: request.id,
            direction: "receive",
            remote,
            peer: `${remoteName}/${request.from.name}`,
            from: request.from,
            to: request.to,
            paths: [],
            cwd: "",
            status: "preparing",
            entries,
            totalBytes,
            createdAt: state?.createdAt ?? Date.now(),
            updatedAt: Date.now()
          };
          state = state ? Object.assign(state, receiving, { pull: false }) : receiving;
          this.save(state);
          await this.freeDisk(0);
          if (this.stopped(state)) throw new Error("transfer cancelled");
        }
        if (!state.initialized) this.initialize(state);
        else {
          for (let i = 0; i < state.entries.length; i++) await this.recover(state, state.entries[i], i);
          await this.freeDisk(0);
        }
        if (this.stopped(state)) throw new Error("transfer cancelled");
        if (state.status !== "completed") {
          state.status = "running";
          delete state.error;
        }
        this.save(state);
        this.report(state, true);
        return { offsets: state.entries.map((entry) => entry.offset), status: state.status };
      } finally {
        this.receiving.delete(request.id);
      }
    }
    if (!state || state.direction !== "receive") throw new Error("unknown receiving transfer");
    if (this.receiving.has(state.id)) throw new Error("transfer operation already in progress");
    this.receiving.add(state.id);
    try {
      if (request.op === "finish") {
        if (state.entries.some((entry2) => entry2.kind === "file" && !entry2.complete)) throw new Error("transfer has incomplete files");
        if (state.status !== "completed") {
          state.status = "completed";
          this.save(state);
          this.report(state, true);
        }
        return { status: state.status };
      }
      const entry = state.entries[request.index];
      if (!entry || entry.kind !== "file") throw new Error("invalid file index");
      if (request.op === "finish-file") {
        if (entry.offset !== entry.size) throw new Error("file is incomplete");
        if (entry.complete) {
          if (entry.sha256 !== request.sha256) throw new Error("file checksum mismatch");
          return {};
        }
        const part = this.part(state, request.index);
        if (await this.hashFile(part, state) !== request.sha256) throw new Error("file checksum mismatch");
        if (this.stopped(state)) throw new Error("transfer cancelled");
        entry.sha256 = request.sha256;
        this.save(state);
        const target = this.target(state, entry);
        assertTransferPath(dirname2(target));
        assertTransferPath(part);
        const verified = this.verified(state, request.index);
        if (existsSync4(verified)) throw new Error("verified file already exists");
        renameSync3(part, verified);
        await link(verified, target);
        await unlink(verified);
        entry.complete = true;
        this.save(state);
        return {};
      }
      if (entry.complete || request.offset !== entry.offset) throw new Error("chunk offset mismatch");
      const data = Buffer.from(request.data, "base64");
      if (!data.length || data.length !== Math.min(TRANSFER_CHUNK_BYTES, entry.size - entry.offset) || data.toString("base64") !== request.data || digest(data) !== request.sha256) throw new Error("chunk checksum or encoding mismatch");
      await this.freeDisk(0);
      if (this.stopped(state)) throw new Error("transfer cancelled or manager closed");
      const path = this.part(state, request.index);
      assertTransferPath(path);
      assertTransferPath(`${path}.sha256`);
      const file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      let journal;
      try {
        journal = await open(`${path}.sha256`, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        await writeAll(file, data, entry.offset);
        await file.sync();
        const record = Buffer.from(`${request.sha256}
`);
        await writeAll(journal, record, Math.floor(entry.offset / TRANSFER_CHUNK_BYTES) * SHA_RECORD_BYTES);
        await journal.sync();
      } finally {
        try {
          await file.close();
        } finally {
          await journal?.close();
        }
      }
      entry.offset += data.length;
      if (!this.stopped(state)) state.status = "running";
      this.save(state);
      this.report(state);
      return {};
    } finally {
      this.receiving.delete(state.id);
    }
  }
  async cancel(id, notifyRemote = true) {
    const state = this.get(external_exports.uuid().parse(id));
    if (!state) throw new Error("unknown transfer");
    if (state.status === "completed" || state.status === "failed") return { id, cancelled: false };
    if (state.legacySent) return { id, cancelled: false };
    state.status = "cancelled";
    state.cancelPending = notifyRemote && !state.legacy;
    this.save(state);
    this.report(state, true);
    for (const [rid, pending] of this.pending) if (pending.id === id) {
      clearTimeout(pending.timer);
      this.pending.delete(rid);
      pending.reject(new Error("transfer cancelled"));
    }
    if (notifyRemote) this.resume();
    return { id, cancelled: true };
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const state of this.states.values()) if (!TERMINAL.has(state.status)) {
      state.status = "paused";
      this.save(state);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("transfer manager closed"));
    }
    this.pending.clear();
  }
};

// src/network/link.ts
var MAX_METADATA_CHARS = 4096;
var MAX_ID_CHARS2 = 128;
var MAX_HOP_COUNT = 100;
var MAX_EXTENSION_HANDLERS = 8;
var textId = external_exports.string().min(1).max(MAX_ID_CHARS2);
var peerSchema = external_exports.object({
  id: textId,
  name: external_exports.string().regex(NETWORK_NAME_PATTERN),
  agent: external_exports.enum(AGENT_KINDS),
  cwd: external_exports.string().max(MAX_METADATA_CHARS),
  pid: external_exports.number().int().nonnegative(),
  agentPid: external_exports.number().int().nonnegative().nullable(),
  sessionId: external_exports.string().max(MAX_METADATA_CHARS).nullable(),
  startedAt: external_exports.number().nonnegative(),
  autoWake: external_exports.boolean(),
  wakeOnDirect: external_exports.boolean().optional(),
  wakeAvailable: external_exports.boolean().optional(),
  wakeMaxHops: external_exports.number().int().min(0).max(MAX_HOP_COUNT).optional(),
  activity: external_exports.enum(["busy", "idle"]).nullable().optional(),
  version: external_exports.string().max(MAX_ID_CHARS2).optional(),
  jobAgent: external_exports.enum(AGENT_KINDS).optional(),
  jobParent: external_exports.string().max(MAX_METADATA_CHARS).optional(),
  jobTitle: external_exports.string().max(MAX_METADATA_CHARS).optional(),
  parentJob: external_exports.string().max(MAX_METADATA_CHARS).optional(),
  rootSession: external_exports.string().max(MAX_METADATA_CHARS).optional(),
  rootName: external_exports.string().max(MAX_METADATA_CHARS).optional(),
  subagent: external_exports.boolean().optional(),
  title: external_exports.string().max(MAX_METADATA_CHARS).optional()
});
var peersSchema = external_exports.array(peerSchema).max(MAX_NETWORK_PEERS).refine((peers) => new Set(peers.map((p) => p.name)).size === peers.length && new Set(peers.map((p) => p.id)).size === peers.length);
var messageSchema = external_exports.object({
  id: external_exports.uuid(),
  from: external_exports.object({ id: textId, name: external_exports.string().regex(NETWORK_NAME_PATTERN), agent: external_exports.enum(AGENT_KINDS) }),
  to: external_exports.string().min(1).max(MAX_METADATA_CHARS),
  recipient: external_exports.string().regex(NETWORK_NAME_PATTERN),
  conversationId: textId,
  replyTo: textId.nullable(),
  hop: external_exports.number().int().min(0).max(MAX_HOP_COUNT),
  body: external_exports.string().min(1).max(MAX_BODY_CHARS),
  createdAt: external_exports.number().nonnegative(),
  readAt: external_exports.null()
});
var frameSchema = external_exports.discriminatedUnion("type", [
  publicIdentitySchema.extend({ type: external_exports.literal("hello"), v: external_exports.literal(NETWORK_VERSION), peers: peersSchema, echo: external_exports.boolean().optional(), receipts: external_exports.boolean().optional(), capabilities: external_exports.array(external_exports.string().min(1).max(MAX_ID_CHARS2)).max(MAX_EXTENSION_HANDLERS).optional() }),
  external_exports.object({ type: external_exports.literal("file-stream"), payload: external_exports.record(external_exports.string(), external_exports.unknown()) }),
  external_exports.object({ type: external_exports.literal("remote-job"), payload: external_exports.record(external_exports.string(), external_exports.unknown()) }),
  external_exports.object({ type: external_exports.literal("dashboard-read"), payload: external_exports.record(external_exports.string(), external_exports.unknown()) }),
  external_exports.object({ type: external_exports.literal("peers"), peers: peersSchema }),
  external_exports.object({ type: external_exports.literal("send"), rid: external_exports.uuid(), message: messageSchema }),
  external_exports.object({ type: external_exports.literal("echo"), rid: external_exports.uuid() }),
  external_exports.object({ type: external_exports.literal("receipt"), rid: external_exports.uuid(), id: external_exports.uuid(), sender: textId, recipient: external_exports.string().regex(NETWORK_NAME_PATTERN).optional() }),
  external_exports.object({ type: external_exports.literal("files"), rid: external_exports.uuid(), transfer: transferSchema }),
  external_exports.object({ type: external_exports.literal("result"), rid: external_exports.uuid(), delivered: external_exports.boolean().optional(), recipient: external_exports.string().regex(NETWORK_NAME_PATTERN).optional(), readAt: external_exports.number().nonnegative().nullable().optional(), transfer: transferResultSchema.optional(), error: external_exports.string().max(MAX_METADATA_CHARS).optional() })
]);
var Link = class {
  constructor(socket, service, key, expected) {
    this.socket = socket;
    this.service = service;
    this.key = key;
    this.expected = expected;
    socket.setKeepAlive(true, NETWORK_REFRESH_MS);
    this.deadline = setTimeout(() => this.fail(new Error("network hello timed out")), NETWORK_TIMEOUT_MS);
    void this.ready.catch(() => {
    });
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    });
    socket.on("error", (err) => this.fail(err));
    socket.on("close", () => {
      clearTimeout(this.deadline);
      this.readyReject(new Error("network link closed"));
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("network link closed"));
      }
      this.pending.clear();
      for (const reject of this.extensionWrites) reject(new Error("network link closed"));
      this.extensionWrites.clear();
      service.detach(this);
    });
    this.write({ type: "hello", v: NETWORK_VERSION, ...service.keys.identity, peers: service.localPeers(), echo: true, receipts: Boolean(service.supportsReceipts), capabilities: service.extensionCapabilities() });
  }
  socket;
  service;
  key;
  expected;
  remote = null;
  peers = [];
  echoSupported = false;
  heartbeatPending = false;
  receiptsSupported = false;
  capabilities = [];
  advertisedPeers = null;
  extensionHandlers = 0;
  buffer = Buffer.alloc(0);
  pending = /* @__PURE__ */ new Map();
  extensionWrites = /* @__PURE__ */ new Set();
  readyResolve;
  readyReject;
  ready = new Promise((resolve4, reject) => {
    this.readyResolve = resolve4;
    this.readyReject = reject;
  });
  deadline;
  processBuffer() {
    if (this.socket.destroyed) return;
    try {
      let nl;
      while (this.extensionHandlers < MAX_EXTENSION_HANDLERS && (nl = this.buffer.indexOf("\n")) >= 0) {
        if (nl > MAX_NETWORK_FRAME_BYTES) throw new Error("network frame too large");
        const line = this.buffer.subarray(0, nl);
        this.buffer = this.buffer.subarray(nl + 1);
        const frame = frameSchema.parse(JSON.parse(line.toString("utf8")));
        if (!this.remote) {
          if (frame.type !== "hello") throw new Error("network hello required");
          const expected = this.expected;
          if (expected && (frame.id !== expected.id || frame.name !== expected.name || frame.fingerprint !== expected.fingerprint)) throw new Error("paired identity changed");
          this.remote = expected ?? this.service.keys.accept(this.key, frame);
          this.peers = frame.peers;
          this.echoSupported = frame.echo === true;
          this.receiptsSupported = frame.receipts === true;
          this.capabilities = frame.capabilities ?? [];
          this.service.attach(this);
          clearTimeout(this.deadline);
          this.readyResolve();
        } else if (frame.type === "hello") throw new Error("duplicate network hello");
        else this.onFrame(frame);
      }
      if (this.buffer.length > MAX_NETWORK_FRAME_BYTES) throw new Error("network frame too large");
      if (this.extensionHandlers >= MAX_EXTENSION_HANDLERS) this.socket.pause();
      else this.socket.resume();
    } catch (error) {
      this.fail(error);
    }
  }
  write(frame) {
    const data = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(data) > MAX_NETWORK_FRAME_BYTES || this.socket.writableLength > MAX_NETWORK_FRAME_BYTES) throw new Error("network write limit reached");
    if (this.socket.destroyed) throw new Error("network link closed");
    this.socket.write(data);
  }
  supports(capability) {
    return this.capabilities.includes(capability);
  }
  /** Complete only after the stream has consumed this bounded record; callers await each write. */
  writeExtension(type, payload) {
    const data = JSON.stringify({ type, payload }) + "\n";
    if (Buffer.byteLength(data) > MAX_NETWORK_FRAME_BYTES || this.socket.writableLength > MAX_NETWORK_FRAME_BYTES || this.extensionWrites.size >= MAX_NETWORK_REQUESTS) return Promise.reject(new Error("network write limit reached"));
    if (this.socket.destroyed) return Promise.reject(new Error("network link closed"));
    return new Promise((resolve4, reject) => {
      const failed = (error) => {
        if (!this.extensionWrites.delete(failed)) return;
        this.fail(error);
        reject(new Error("network link closed", { cause: error }));
      };
      this.extensionWrites.add(failed);
      try {
        this.socket.write(data, (error) => {
          if (error) failed(error);
          else {
            this.extensionWrites.delete(failed);
            resolve4();
          }
        });
      } catch (error) {
        failed(error);
      }
    });
  }
  refresh() {
    if (!this.remote) return;
    const peers = this.service.localPeers(), signature = JSON.stringify(peers);
    if (this.echoSupported && signature === this.advertisedPeers) return;
    this.write({ type: "peers", peers });
    this.advertisedPeers = signature;
  }
  send(message) {
    return this.request({ type: "send", rid: randomUUID5(), message: messageSchema.parse(message) });
  }
  /** Detect a half-open link even when nobody sends work; activity never expires a peer. */
  heartbeat() {
    if (!this.remote || !this.echoSupported || this.heartbeatPending) return;
    this.heartbeatPending = true;
    void this.echo(this.service.timings.heartbeatTimeoutMs).catch((error) => this.fail(error)).finally(() => {
      this.heartbeatPending = false;
    });
  }
  receipt(id, sender, recipient, requireRecipient = false) {
    if (!this.receiptsSupported) return Promise.reject(new Error("Remote broker does not support read receipts. Update and reload its hosting sessions."));
    if (requireRecipient && !this.supports("recipient-receipts-v1")) return Promise.reject(new Error("Remote broker does not support per-recipient broadcast receipts. Update and reload its hosting sessions."));
    return this.request({ type: "receipt", rid: randomUUID5(), id, sender, recipient });
  }
  files(transfer) {
    return this.request({ type: "files", rid: randomUUID5(), transfer: transferSchema.parse(transfer) });
  }
  async echo(timeoutMs = NETWORK_TIMEOUT_MS) {
    if (!this.echoSupported) throw new Error("Remote broker does not support verification. Update and restart its hosting sessions.");
    const result = await this.request({ type: "echo", rid: randomUUID5() }, timeoutMs);
    if (result !== true) throw new Error("network echo was not acknowledged");
  }
  request(frame, timeoutMs = NETWORK_TIMEOUT_MS) {
    if (this.pending.size >= MAX_NETWORK_REQUESTS) return Promise.reject(new Error("too many network requests"));
    return new Promise((resolve4, reject) => {
      const rid = frame.rid;
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error("network send timed out; delivery may have occurred"));
      }, timeoutMs);
      this.pending.set(rid, { resolve: resolve4, reject, timer, kind: frame.type });
      try {
        if (frame.type === "send" || frame.type === "files") this.refresh();
        this.write(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(err);
      }
    });
  }
  onFrame(frame) {
    if (frame.type === "file-stream" || frame.type === "remote-job" || frame.type === "dashboard-read") {
      if (++this.extensionHandlers > MAX_EXTENSION_HANDLERS) throw new Error("too many extension handlers");
      void Promise.resolve().then(() => this.service.receiveExtension(frame.type, frame.payload, this.remote)).catch((error) => this.fail(error)).finally(() => {
        this.extensionHandlers--;
        this.processBuffer();
      });
      return;
    }
    if (frame.type === "peers") {
      this.peers = frame.peers;
      return;
    }
    if (frame.type === "result") {
      const pending = this.pending.get(frame.rid);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.rid);
      if (frame.error) pending.reject(new Error(frame.error));
      else if (pending.kind === "send" && frame.delivered !== void 0) pending.resolve({ delivered: frame.delivered, recipient: frame.recipient });
      else if (pending.kind === "echo" && frame.delivered !== void 0) pending.resolve(frame.delivered);
      else if (pending.kind === "receipt" && frame.readAt !== void 0) pending.resolve(frame.readAt);
      else if (pending.kind === "files" && frame.transfer) pending.resolve(frame.transfer);
      else pending.reject(new Error("invalid network result"));
      return;
    }
    if (frame.type === "echo") {
      this.write({ type: "result", rid: frame.rid, delivered: true });
      return;
    }
    try {
      if (frame.type === "receipt") {
        const readAt = this.service.readReceipt(frame.id, `${this.remote.id}/${frame.sender}`, frame.recipient);
        this.write({ type: "result", rid: frame.rid, readAt });
        return;
      }
      const from = frame.type === "send" ? frame.message.from : frame.transfer.from;
      const sender = this.peers.find((p) => p.id === from.id && p.name === from.name);
      if (!sender || (sender.jobAgent ?? sender.agent) !== from.agent) throw new Error("sender not advertised by paired instance");
      const remote = this.remote;
      if (frame.type === "files") {
        const result2 = this.service.receiveFiles(frame.transfer, `${remote.name}/${from.name}`, `${remote.id}/${from.id}`);
        this.write({ type: "result", rid: frame.rid, transfer: result2 });
        return;
      }
      const message = { ...frame.message, from: { ...frame.message.from, id: `${remote.id}/${frame.message.from.id}`, name: `${remote.name}/${frame.message.from.name}` } };
      const result = this.service.receive(message);
      this.refresh();
      this.write({ type: "result", rid: frame.rid, delivered: result.delivered, recipient: result.recipient });
    } catch (err) {
      this.write({ type: "result", rid: frame.rid, error: String(err.message).slice(0, MAX_METADATA_CHARS) });
    }
  }
  fail(error) {
    this.readyReject(error);
    this.socket.destroy();
  }
};
var NetworkService = class {
  constructor(home, cfg, broker, log, timings = {}) {
    this.home = home;
    this.cfg = cfg;
    this.broker = broker;
    this.log = log;
    this.timings = { refreshMs: timings.refreshMs ?? NETWORK_REFRESH_MS, heartbeatTimeoutMs: timings.heartbeatTimeoutMs ?? NETWORK_HEARTBEAT_TIMEOUT_MS };
    for (const value of Object.values(this.timings)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("network timings must be positive milliseconds");
    this.keys = new PairingStore(home, cfg.name);
    this.transfers = new TransferManager(home, {
      supports: (remote) => this.peerSupports(remote, FILE_STREAM_CAPABILITY),
      send: (remote, payload) => {
        if (payload.op === "offer" || payload.op === "fetch") this.instanceLink(remote).refresh();
        return this.sendExtension(remote, "file-stream", payload);
      },
      validSender: (remote, sender) => this.links.get(remote)?.peers.some((peer) => peer.id === sender.id && peer.name === sender.name && (peer.jobAgent ?? peer.agent) === sender.agent) ?? false,
      localPeer: (name2) => {
        const peer = this.broker.peers().find((peer2) => peer2.name === name2);
        return peer ? { id: peer.id, name: peer.name, agent: peer.jobAgent ?? peer.agent, cwd: peer.cwd } : void 0;
      },
      notify: (message) => {
        this.broker.receive(message);
      },
      legacy: (remote, transfer) => this.instanceLink(remote).files(transfer)
    }, log, { maxBytes: cfg.maxTransferBytes, fetchRoots: cfg.fetchRoots });
    this.registerExtension("file-stream", FILE_STREAM_CAPABILITY, (payload, remote) => this.transfers.handle(payload, remote.id, remote.name));
  }
  home;
  cfg;
  broker;
  log;
  timings;
  keys;
  transfers;
  server = null;
  sockets = /* @__PURE__ */ new Set();
  links = /* @__PURE__ */ new Map();
  connecting = /* @__PURE__ */ new Set();
  health = /* @__PURE__ */ new Map();
  discovery = null;
  timer = null;
  closed = false;
  extensions = /* @__PURE__ */ new Map();
  get port() {
    const address = this.server?.address();
    return address && typeof address !== "string" ? address.port : 0;
  }
  registerExtension(type, capability, handler) {
    if (this.server || this.extensions.has(type)) throw new Error("register extensions once before starting networking");
    this.extensions.set(type, { capability, handler });
  }
  extensionCapabilities() {
    return [...this.extensions.values()].map((extension) => extension.capability).concat(this.broker.recipientReceipts ? ["recipient-receipts-v1"] : []);
  }
  receiveExtension(type, payload, remote) {
    const extension = this.extensions.get(type);
    if (!extension) throw new Error("unsupported network extension");
    return extension.handler(payload, remote);
  }
  instanceLink(instance) {
    const link2 = [...this.links.values()].find((candidate) => candidate.remote.id === instance || candidate.remote.name === instance);
    if (!link2) throw new Error("paired instance is not connected");
    return link2;
  }
  peerSupports(instance, capability) {
    try {
      return this.instanceLink(instance).supports(capability);
    } catch {
      return false;
    }
  }
  async sendExtension(instance, type, payload) {
    const extension = this.extensions.get(type);
    const link2 = this.instanceLink(instance);
    if (!extension || !link2.supports(extension.capability)) return Promise.reject(new Error("remote broker does not support this extension"));
    if (type === "remote-job" && payload.kind === "request") link2.refresh();
    return link2.writeExtension(type, payload);
  }
  get supportsReceipts() {
    return Boolean(this.broker.receipt);
  }
  readReceipt(id, sender, recipient) {
    if (!this.broker.receipt) throw new Error("read receipts unavailable");
    return this.broker.receipt(id, sender, recipient);
  }
  async receipt(address, id, sender, requireRecipient = false) {
    const { link: link2, target } = this.target(address);
    return link2.receipt(id, sender, target, requireRecipient);
  }
  localPeers() {
    return peersSchema.parse(this.broker.peers());
  }
  receive(message) {
    return this.broker.receive(message);
  }
  async start() {
    if (!this.cfg.enabled) throw new Error("networking is disabled");
    if (this.server || this.closed) throw new Error("network service already started or closed");
    const acceptedKeys = /* @__PURE__ */ new WeakMap();
    const server = createServer({
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ciphers: TLS_CIPHER,
      handshakeTimeout: NETWORK_TIMEOUT_MS,
      pskCallback: (socket, identity) => {
        const key = this.keys.keyFor(identity);
        if (key) acceptedKeys.set(socket, key);
        return key ? Buffer.from(key, "hex") : randomBytes2(PAIRING_KEY_BYTES);
      }
    }, (socket) => {
      const key = acceptedKeys.get(socket);
      if (!key || socket.getProtocol() !== "TLSv1.3") return socket.destroy();
      try {
        new Link(socket, this, key);
      } catch (err) {
        socket.destroy();
        this.log.warn("network hello could not be sent", { message: err.message });
      }
    });
    this.server = server;
    server.maxConnections = MAX_NETWORK_LINKS;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    server.on("tlsClientError", () => this.log.debug("network TLS authentication failed"));
    server.on("error", (err) => this.log.warn("network listener error", { message: err.message }));
    try {
      await new Promise((resolve4, reject) => {
        server.once("error", reject);
        server.listen(this.cfg.port, this.cfg.bind, () => {
          server.off("error", reject);
          resolve4();
        });
      });
      if (this.cfg.discovery) {
        this.discovery = new NetworkDiscovery({ identity: this.keys.identity, port: this.port, onError: (err) => this.log.warn("network discovery error", { message: err.message }) });
        await this.discovery.start();
      }
      this.timer = setInterval(() => {
        for (const link2 of this.links.values()) {
          try {
            link2.refresh();
            link2.heartbeat();
          } catch (err) {
            link2.fail(err);
          }
        }
        for (const pair of this.keys.pairs()) if (pair.host && pair.port && !this.links.has(pair.id) && !this.connecting.has(pair.id)) void this.connectPair(pair).catch(() => {
        });
      }, this.timings.refreshMs);
      this.timer.unref();
      for (const pair of this.keys.pairs()) if (pair.host && pair.port) void this.connectPair(pair).catch(() => {
      });
    } catch (err) {
      await this.close();
      throw err;
    }
  }
  attach(link2) {
    const remote = link2.remote;
    if (this.closed) throw new Error("network service closed");
    const existing = this.links.get(remote.id);
    if (existing && existing !== link2) throw new Error("instance already connected");
    this.links.set(remote.id, link2);
    setImmediate(() => this.transfers.resume());
  }
  detach(link2) {
    if (link2.remote && this.links.get(link2.remote.id) === link2) {
      this.links.delete(link2.remote.id);
      this.transfers.disconnected(link2.remote.id);
    }
  }
  peers() {
    return [...this.links.values()].flatMap((link2) => link2.peers.map((p) => {
      const host = link2.remote.name;
      const qualify = (value, prefix = host) => value && !value.includes("/") ? `${prefix}/${value}` : value;
      return {
        ...p,
        agent: p.jobAgent ?? p.agent,
        host,
        id: `${link2.remote.id}/${p.id}`,
        name: `${host}/${p.name}`,
        jobParent: qualify(p.jobParent),
        parentJob: qualify(p.parentJob),
        rootName: qualify(p.rootName),
        rootSession: qualify(p.rootSession, link2.remote.id)
      };
    }));
  }
  status() {
    return { enabled: true, config: this.cfg, identity: this.keys.identity, port: this.port, discovered: this.discovery?.instances() ?? [], ...this.discovery ? { discoveryDiagnostics: this.discovery.diagnostics() } : {}, paired: this.keys.pairs().map(({ id, name: name2, fingerprint }) => ({ id, name: name2, fingerprint, connected: this.links.has(id), ...this.health.has(id) ? { health: this.health.get(id) } : {} })) };
  }
  async verify(id) {
    const link2 = this.links.get(id);
    if (!link2) throw new Error("paired instance is not connected");
    const start = performance.now();
    await link2.echo();
    const roundTripMs = Math.round(performance.now() - start);
    this.health.set(id, { lastVerifiedAt: Date.now(), roundTripMs });
    return { peers: this.peers().filter((p) => p.id.startsWith(`${id}/`)), roundTripMs };
  }
  async link(code, host, port) {
    const decoded = decodePairingCode(code);
    const pair = this.keys.validatePair(decoded, host, port);
    await this.connectPair(pair);
    try {
      this.keys.remember(decoded, host, port);
    } catch (err) {
      this.links.get(pair.id)?.socket.destroy();
      throw err;
    }
    return { id: decoded.id, name: decoded.name, fingerprint: decoded.fingerprint };
  }
  async connectPair(pair) {
    if (this.closed || this.links.has(pair.id) || this.connecting.has(pair.id)) throw new Error("instance already connected or connecting");
    this.connecting.add(pair.id);
    let socket = null;
    try {
      socket = connect({
        host: pair.host,
        port: pair.port,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        ciphers: TLS_CIPHER,
        // TLS-PSK has no certificate. The PSK is mandatory; certificate-based fallbacks are rejected below.
        rejectUnauthorized: false,
        checkServerIdentity: () => void 0,
        pskCallback: () => ({ identity: keyFingerprint(pair.key), psk: Buffer.from(pair.key, "hex") })
      });
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      const secured = socket;
      await new Promise((resolve4, reject) => {
        const timer = setTimeout(() => {
          secured.destroy();
          reject(new Error("network TLS handshake timed out"));
        }, NETWORK_TIMEOUT_MS);
        const onError = (err) => {
          clearTimeout(timer);
          reject(err);
        };
        secured.once("error", onError);
        secured.once("secureConnect", () => {
          clearTimeout(timer);
          secured.off("error", onError);
          resolve4();
        });
      });
      if (secured.getProtocol() !== "TLSv1.3" || Object.keys(secured.getPeerCertificate()).length) throw new Error("TLS-PSK required");
      await new Link(secured, this, pair.key, pair).ready;
    } catch (err) {
      socket?.destroy();
      throw err;
    } finally {
      this.connecting.delete(pair.id);
    }
  }
  unlink(id) {
    try {
      this.keys.remove(id);
      this.health.delete(id);
    } finally {
      this.links.get(id)?.socket.destroy();
    }
  }
  async send(message) {
    const { link: link2, target } = this.target(message.recipient);
    const result = await link2.send({ ...message, recipient: target });
    const actual = result.recipient ?? target;
    const recipient = `${link2.remote.name}/${actual}`;
    return { messages: [{ ...message, recipient }], deliveredTo: result.delivered ? [recipient] : [], queuedFor: result.delivered ? [] : [recipient], recipientStates: link2.peers.filter((p) => p.name === actual).map((p) => ({ name: recipient, activity: p.activity, autoWake: p.autoWake, wakeOnDirect: p.wakeOnDirect, wakeAvailable: p.wakeAvailable, wakeMaxHops: p.wakeMaxHops })) };
  }
  target(address) {
    const slash = address.indexOf("/");
    const host = address.slice(0, slash);
    const raw = address.slice(slash + 1);
    const link2 = [...this.links.values()].find((l) => l.remote.name === host || l.remote.id === host);
    const target = link2?.peers.find((p) => p.name === raw || p.id === raw)?.name ?? raw;
    if (!link2 || !NETWORK_NAME_PATTERN.test(target)) throw new BridgeError("unknown_target", "paired instance is not connected or target is invalid");
    return { link: link2, target };
  }
  async sendFiles(address, transfer) {
    const { link: link2, target } = this.target(address);
    return link2.files({ ...transfer, to: target });
  }
  startFiles(address, paths, cwd, from, pull = false) {
    const { link: link2, target } = this.target(address);
    if (!link2.peers.some((peer) => peer.name === target)) throw new Error("file recipient is not online");
    const streaming = link2.supports(FILE_STREAM_CAPABILITY);
    if (pull && !streaming) throw new Error("remote broker does not support fetch_files; update its hosting sessions");
    return this.transfers.start(link2.remote.id, `${link2.remote.name}/${target}`, target, paths, cwd, from, pull, void 0, !streaming);
  }
  fileTarget(address) {
    return this.target(address).target;
  }
  receiveFiles(transfer, name2, id) {
    if (!this.broker.peers().some((p) => p.name === transfer.to)) throw new Error("file recipient is not online");
    const bytes = transfer.entries.reduce((sum, entry) => sum + (entry.kind === "file" ? Buffer.byteLength(entry.data, "base64") : 0), 0);
    if (this.cfg.maxTransferBytes !== void 0 && bytes > this.cfg.maxTransferBytes) throw new Error("transfer exceeds size limit");
    const result = receiveTransfer(this.home, transfer);
    this.transfers.recordLegacy(transfer, id.split("/")[0], name2);
    this.log.info("legacy files received", { ...result, sender: name2 });
    this.broker.receive({ id: transfer.id, from: { ...transfer.from, name: name2, id }, to: transfer.to, recipient: transfer.to, conversationId: transfer.id, replyTo: null, hop: 0, body: `Received ${result.files} files (${result.bytes} bytes) in ${result.inbox}`, createdAt: Date.now(), readAt: null });
    return result;
  }
  async close() {
    this.closed = true;
    this.transfers.close();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.discovery?.close();
    this.discovery = null;
    for (const socket of this.sockets) socket.destroy();
    this.links.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve4) => server.close(() => resolve4()));
  }
};

// src/core/broker.ts
import { basename as basename3, dirname as dirname3 } from "node:path";

// src/network/remote-dashboard.ts
import { randomUUID as randomUUID6 } from "node:crypto";

// src/core/dashboard-read.ts
import { closeSync, openSync, readFileSync as readFileSync6, readSync, statSync as statSync3 } from "node:fs";
import { join as join7 } from "node:path";

// src/network/dashboard-protocol.ts
var DASHBOARD_CAPABILITY = "dashboard-read-v1";
var DASHBOARD_FRAME = "dashboard-read";
var DASHBOARD_TIMEOUT_MS = 1e4;
var DASHBOARD_RATE_LIMIT = 120;
var DASHBOARD_RATE_WINDOW_MS = 6e4;
var DASHBOARD_MAX_PENDING = 32;
var DASHBOARD_MAX_RESPONSE_BYTES = 15e5;
var name = /^[\w.-]{1,256}$/;
function isDashboardReadPath(path) {
  if (path === "/api/state" || path === "/api/runs" || path === "/api/job-outcomes") return true;
  const match = /^\/api\/(runs|sessions|jobs)\/([^/]+)(.*)$/.exec(path);
  if (!match) return false;
  let target;
  try {
    target = decodeURIComponent(match[2]);
  } catch {
    return false;
  }
  if (!name.test(target) || target === "." || target === "..") return false;
  const suffix = match[3];
  if (match[1] === "runs") return suffix === "" || suffix === "/chat";
  if (match[1] === "sessions" && suffix === "/chat") return true;
  if (suffix === "/subagents") return true;
  const child = /^\/subagents\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(suffix);
  return !!child;
}
var dashboardRequestSchema = external_exports.object({
  path: external_exports.string().max(600).refine(isDashboardReadPath),
  query: external_exports.object({ from: external_exports.string().max(256).optional(), before: external_exports.string().max(512).optional(), limit: external_exports.string().max(3).optional() }).strict().optional()
}).strict();
var dashboardWireSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("request"), rid: external_exports.uuid(), request: dashboardRequestSchema }).strict(),
  external_exports.object({ kind: external_exports.literal("response"), rid: external_exports.uuid(), result: external_exports.object({ status: external_exports.number().int().min(200).max(599), body: external_exports.unknown() }).strict() }).strict()
]);

// src/core/dashboard-read.ts
var TASK_PREVIEW_CHARS = 300;
var STALE_RUN_MS = 15e4;
var LEGACY_JOB_START_TOLERANCE_MS = 1e3;
var MAX_LOG_CHUNK = 128 * 1024;
async function finishedRunOutcomes(home, log, names) {
  const runs = listRuns(home);
  const jobs = readStore(join7(home, JOBS_FILE), log, true);
  const out = {};
  for (const run of runs) {
    if (names && !names.has(run.name)) continue;
    if (!run.job || run.status !== "done" && run.status !== "failed") continue;
    const stored = jobs.find((j) => j.name === run.job);
    const startedAt = run.jobStartedAt ?? run.startedAt;
    const latest = stored && (run.jobStartedAt !== void 0 ? stored.startedAt === startedAt : Math.abs(stored.startedAt - startedAt) < LEGACY_JOB_START_TOLERANCE_MS);
    const job = {
      id: stored?.id ?? run.job.replace(/^.*-(?:job|ask)-/, ""),
      name: run.job,
      owner: latest ? stored.owner : run.by,
      startedAt: run.jobStartedAt ?? (latest ? stored.startedAt : run.startedAt),
      status: run.status,
      worktree: stored?.worktree,
      remote: run.remote ?? stored?.remote
    };
    const next = runs.filter((r) => r.job === run.job && (r.jobStartedAt ?? r.startedAt) > startedAt).sort((a, b) => (a.jobStartedAt ?? a.startedAt) - (b.jobStartedAt ?? b.startedAt))[0];
    out[run.name] = await deriveJobOutcome(home, job, log, {
      branch: run.branch,
      baseBranch: run.baseBranch,
      repoRoot: run.repoRoot,
      branchHead: run.branchHead,
      before: next?.jobStartedAt ?? next?.startedAt
    });
  }
  return out;
}
function summarizeRun(file, text, mtimeMs, now, meta = {}) {
  const lines = text.split("\n").filter(Boolean);
  const finished = [...lines].reverse().find((l) => / finished after \d+s · /.test(l));
  const last = (finished ?? lines.at(-1) ?? "").replace(/^\d\d:\d\d:\d\d /, "");
  const status = finished ? / · done$/.test(finished) ? "done" : "failed" : now - mtimeMs > STALE_RUN_MS ? "interrupted" : "running";
  const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-([a-z]+)-/.exec(file);
  const startedAt = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Math.floor(mtimeMs);
  const header = (lines[0] ?? "").replace(/^\d\d:\d\d:\d\d /, "");
  const end = lines.findIndex((l) => l.trim() === "---");
  const task = lines.slice(1, end > 0 ? end : 1).map((l) => l.trim()).join(" ").slice(0, TASK_PREVIEW_CHARS);
  return {
    by: / by ([\w.-]+)/.exec(header)?.[1],
    workdir: / in (.+?), access /.exec(header)?.[1],
    continues: /, continues (\S+)/.exec(header)?.[1] ?? null,
    ...meta,
    ...status !== "running" ? { etaAt: void 0, etaReportedAt: void 0 } : {},
    name: file.replace(/\.log$/, ""),
    agent: m?.[7] ?? "agent",
    header,
    startedAt,
    updatedAt: mtimeMs,
    status,
    last,
    task
  };
}
function listRuns(home, now = Date.now()) {
  const runs = [];
  for (const log of readRunLogs(home)) {
    try {
      const signature = `${log.signature}:${JSON.stringify(log.meta)}`;
      let cached = runSummaries.get(log.file);
      if (cached?.signature !== signature) {
        cached = { signature, summary: summarizeRun(`${log.name}.log`, readFileSync6(log.file, "utf8"), log.updatedAt, log.updatedAt, log.meta) };
        runSummaries.delete(log.file);
        runSummaries.set(log.file, cached);
        if (runSummaries.size > 2048) runSummaries.delete(runSummaries.keys().next().value);
      }
      const stale = cached.summary.status === "running" && now - log.updatedAt > STALE_RUN_MS;
      runs.push({ ...structuredClone(cached.summary), ...stale ? { status: "interrupted", etaAt: void 0, etaReportedAt: void 0 } : {}, archived: log.archived, recovered: false, hasLog: true });
    } catch {
    }
  }
  const representedJobs = new Set(runs.map((run) => run.job));
  const representedSuffixes = /* @__PURE__ */ new Set();
  for (const run of runs) for (let at = run.name.indexOf("-"); at >= 0; at = run.name.indexOf("-", at + 1)) representedSuffixes.add(run.name.slice(at));
  for (const [name2, job] of readHistoryJobs(home)) {
    if (representedJobs.has(name2) || typeof job.id === "string" && representedSuffixes.has(`-${job.agent}-${job.id}`)) continue;
    const args = isRecord(job.args) ? job.args : {};
    const worktree = isRecord(job.worktree) ? job.worktree : null;
    const prompt = typeof job.prompt === "string" ? job.prompt : "";
    const owner = typeof job.owner === "string" ? job.owner : null;
    const sessionId = typeof job.sessionId === "string" ? job.sessionId : typeof job.threadId === "string" ? job.threadId : null;
    const startedAt = typeof job.startedAt === "number" && Number.isSafeInteger(job.startedAt) && job.startedAt >= 0 ? job.startedAt : 0;
    const finishedAt = typeof job.finishedAt === "number" && Number.isSafeInteger(job.finishedAt) ? job.finishedAt : void 0;
    runs.push({
      name: name2,
      job: name2,
      agent: typeof job.agent === "string" ? job.agent : "agent",
      model: typeof job.model === "string" ? job.model : null,
      title: typeof args.title === "string" ? args.title : typeof job.title === "string" ? job.title : void 0,
      by: owner ?? void 0,
      owner,
      session: sessionId,
      sessionId,
      prompt,
      task: prompt.slice(0, TASK_PREVIEW_CHARS),
      workdir: typeof job.workdir === "string" ? job.workdir : worktree?.cwd ?? (typeof args.cwd === "string" ? args.cwd : void 0),
      worktree,
      branch: worktree?.branch ?? (typeof job.branch === "string" ? job.branch : void 0),
      parentJob: typeof job.parentJob === "string" ? job.parentJob : void 0,
      rootSession: typeof job.rootSession === "string" ? job.rootSession : void 0,
      startedAt,
      finishedAt,
      updatedAt: finishedAt ?? startedAt,
      // A historical snapshot does not prove that an old process is still running.
      status: job.status === "done" || job.status === "failed" ? job.status : "interrupted",
      header: `Recovered ${name2}`,
      last: "Run log unavailable; conversation may be available in the CLI transcript.",
      recovered: true,
      hasLog: false
    });
  }
  const current = readHistoryJobs(home);
  for (const run of runs) {
    const job = run.job && current.get(run.job);
    if (job && Array.isArray(job.ownershipHistory) && job.ownershipHistory.length) {
      run.owner = typeof job.owner === "string" ? job.owner : run.owner;
      run.rootName = typeof job.rootName === "string" ? job.rootName : void 0;
      run.rootSession = typeof job.rootSession === "string" ? job.rootSession : void 0;
      run.parentJob = typeof job.parentJob === "string" ? job.parentJob : void 0;
    }
  }
  return pageRuns(runs, null, runs.length).runs;
}
var runSummaries = /* @__PURE__ */ new Map();
function readStoredJobs(home) {
  const out = /* @__PURE__ */ new Map();
  for (const j of readHistoryJobs(home).values()) {
    if (!j || typeof j !== "object") continue;
    const { name: name2, owner, args, remote } = j;
    if (typeof name2 !== "string") continue;
    const saved = args && typeof args === "object" ? args : {};
    out.set(name2, {
      owner: typeof owner === "string" && owner ? owner : null,
      ...typeof j.projectRoot === "string" ? { projectRoot: j.projectRoot } : {},
      next: Object.fromEntries(JOB_SETTING_KEYS.filter((key) => saved[key] !== void 0).map((key) => [key, saved[key]])),
      ...remote && typeof remote.host === "string" && typeof remote.name === "string" ? { remote } : {}
    });
  }
  return out;
}
function classifyPeers(peers, runs, home) {
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const worktrees = `${norm(join7(home, "worktrees"))}/`;
  const byWorkdir = /* @__PURE__ */ new Map();
  for (const run of runs) if (run.workdir && !byWorkdir.has(norm(run.workdir))) byWorkdir.set(norm(run.workdir), run);
  return peers.filter((p) => !isPluginCacheCwd(p.cwd)).map((p) => {
    const cwd = norm(p.cwd ?? "");
    const subagent = cwd.startsWith(worktrees);
    const run = subagent ? byWorkdir.get(cwd) : void 0;
    return { ...p, subagent: Boolean(p.jobAgent || p.subagent || subagent), parent: p.parentJob ?? p.jobParent ?? p.rootName ?? run?.by ?? null };
  });
}
var reply = (status, body) => ({ status, body });
async function readDashboard(ctx, request) {
  if (!dashboardRequestSchema.safeParse(request).success) return reply(400, { error: "invalid dashboard read request" });
  const url = new URL(request.path, "http://localhost");
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
  if (url.pathname === "/api/state") {
    const page = pageRuns(listRuns(ctx.home), null, DEFAULT_RUN_PAGE_SIZE);
    const names = new Set(page.runs.map((run) => run.job));
    const jobs = Object.fromEntries([...readStoredJobs(ctx.home)].filter(([name2]) => names.has(name2)).map(([name2, job]) => [name2, { next: job.next, ...job.remote ? { remote: job.remote } : {} }]));
    return reply(200, { runs: page.runs, runsNext: page.next, runsTotal: page.total, jobs });
  }
  if (url.pathname === "/api/job-outcomes") {
    const rawLimit = url.searchParams.get("limit") ?? String(DEFAULT_RUN_PAGE_SIZE);
    const limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RUN_PAGE_SIZE) return reply(400, { error: "invalid outcome page limit" });
    const before = url.searchParams.get("before");
    if (before !== null && !/^[\w.-]{1,256}$/.test(before)) return reply(400, { error: "invalid outcome cursor" });
    const select = (names2) => [...new Set(names2)].sort().filter((name2) => before === null || name2 > before).slice(0, limit);
    const stored = readStore(join7(ctx.home, JOBS_FILE), ctx.log, true).filter((j) => j.status === "done" || j.status === "failed");
    const runs = listRuns(ctx.home).filter((r) => r.job && (r.status === "done" || r.status === "failed"));
    const names = select([...stored.map((j) => j.name), ...runs.map((r) => r.name)]);
    const next = [...stored.map((j) => j.name), ...runs.map((r) => r.name)].some((name2) => names.length > 0 && name2 > names.at(-1)) ? names.at(-1) : null;
    const jobs = await listJobOutcomes(ctx.home, ctx.log, new Set(names));
    const groups = { needsReview: [], held: [], merged: [], discarded: [] };
    for (const [name2, job] of Object.entries(jobs)) {
      const state = job.outcome.merge.state;
      groups[state === "unmerged" ? "needsReview" : state].push(name2);
    }
    return reply(200, { contractVersion: JOB_OUTCOME_CONTRACT_VERSION, jobs, runs: await finishedRunOutcomes(ctx.home, ctx.log, new Set(names)), groups, next });
  }
  const sessionMatch = /^\/api\/sessions\/([^/]+)\/(chat|subagents)(?:\/([^/]+))?$/.exec(url.pathname);
  if (sessionMatch) {
    let name2, child;
    try {
      name2 = decodeURIComponent(sessionMatch[1]);
      child = sessionMatch[3] === void 0 ? void 0 : decodeURIComponent(sessionMatch[3]);
    } catch {
      return reply(404, { error: "no such local session" });
    }
    if (name2.includes("/") || name2.includes("\\") || child !== void 0 && !TRANSCRIPT_ID.test(child) || sessionMatch[2] === "chat" && child !== void 0) return reply(404, { error: "no such local session or subagent" });
    const peers = await ctx.peers();
    const peer = peers.find((p) => p.name === name2 && !p.name.includes("/") && !isPluginCacheCwd(p.cwd));
    if (!peer) return reply(404, { error: "no such local session" });
    if (!peer.sessionId) return reply(409, { error: "This session has no sessionId yet." });
    if (!TRANSCRIPT_ID.test(peer.sessionId) || !CODING_AGENTS.includes(peer.agent)) return reply(404, { error: "no transcript for this session" });
    if (sessionMatch[2] === "subagents" && child === void 0) return reply(200, { subagents: listNativeSubagents(peer, ctx.transcripts) });
    const from = url.searchParams.get("from") ?? "0";
    if (!validTranscriptCursor(from)) return reply(400, { error: "invalid transcript cursor" });
    const page = readTranscript(peer, from, child, ctx.transcripts);
    return page ? reply(200, page) : reply(404, { error: "no transcript for this session or subagent" });
  }
  if (url.pathname === "/api/runs") {
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? DEFAULT_RUN_PAGE_SIZE : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RUN_PAGE_SIZE) return reply(400, { error: `limit must be an integer from 1 to ${MAX_RUN_PAGE_SIZE}` });
    try {
      return reply(200, pageRuns(listRuns(ctx.home), url.searchParams.get("before"), limit));
    } catch {
      return reply(400, { error: "invalid run cursor" });
    }
  }
  const jobChildrenMatch = /^\/api\/jobs\/([\w.-]+)\/subagents(?:\/([^/]+))?$/.exec(url.pathname);
  if (jobChildrenMatch) {
    const name2 = jobChildrenMatch[1];
    let child;
    try {
      child = jobChildrenMatch[2] === void 0 ? void 0 : decodeURIComponent(jobChildrenMatch[2]);
    } catch {
      return reply(404, { error: "no such job or subagent" });
    }
    if (child !== void 0 && !TRANSCRIPT_ID.test(child)) return reply(404, { error: "no such job or subagent" });
    const job = readHistoryJobs(ctx.home).get(name2);
    const run = listRuns(ctx.home).find((r) => r.job === name2);
    if (!job && !run) return reply(404, { error: "no such job" });
    const agent = typeof job?.agent === "string" ? job.agent : run?.agent;
    const sessionId = typeof job?.sessionId === "string" ? job.sessionId : typeof job?.threadId === "string" ? job.threadId : run?.sessionId ?? run?.session;
    if (!sessionId) return reply(409, { error: "This job has no sessionId yet." });
    if (!TRANSCRIPT_ID.test(sessionId) || !CODING_AGENTS.includes(agent)) return reply(404, { error: "no transcript for this job" });
    const session = { agent, sessionId, cwd: typeof job?.workdir === "string" ? job.workdir : run?.workdir ?? "" };
    if (child === void 0) return reply(200, { subagents: listNativeSubagents(session, ctx.transcripts) });
    const from = url.searchParams.get("from") ?? "0";
    if (!validTranscriptCursor(from)) return reply(400, { error: "invalid transcript cursor" });
    const page = readTranscript(session, from, child, ctx.transcripts);
    return page ? reply(200, page) : reply(404, { error: "no transcript for this job or subagent" });
  }
  const runChatMatch = /^\/api\/runs\/([\w.-]+)\/chat$/.exec(url.pathname);
  if (runChatMatch) {
    const from = url.searchParams.get("from") ?? "0";
    if (!validTranscriptCursor(from)) return reply(400, { error: "invalid transcript cursor" });
    const run = listRuns(ctx.home).find((r) => r.name === runChatMatch[1] || r.job === runChatMatch[1]);
    if (!run) return reply(404, { error: "no such run" });
    const job = run.job ? readHistoryJobs(ctx.home).get(run.job) : void 0;
    const sessionId = run.sessionId ?? run.session ?? (typeof job?.sessionId === "string" ? job.sessionId : typeof job?.threadId === "string" ? job.threadId : null);
    if (!sessionId) return reply(409, { error: "This run has no sessionId yet." });
    if (!TRANSCRIPT_ID.test(sessionId) || !CODING_AGENTS.includes(run.agent)) return reply(404, { error: "no transcript for this run" });
    const page = readTranscript({ agent: run.agent, sessionId, cwd: run.workdir ?? "" }, from, void 0, ctx.transcripts);
    return page ? reply(200, page) : reply(404, { error: "no transcript for this run" });
  }
  const runMatch = /^\/api\/runs\/([\w.-]+)$/.exec(url.pathname);
  if (runMatch) {
    const log = readRunLogs(ctx.home).find((record) => record.name === runMatch[1]);
    if (!log) {
      const recovered = listRuns(ctx.home).find((run) => run.name === runMatch[1] && run.recovered);
      return recovered ? reply(200, { text: "", next: 0, size: 0, recovered: true, hasLog: false }) : reply(404, { error: "no such run" });
    }
    const rawFrom = url.searchParams.get("from") ?? "0";
    if (!/^\d+$/.test(rawFrom) || !Number.isSafeInteger(Number(rawFrom))) return reply(400, { error: "invalid log cursor" });
    const from = Number(rawFrom);
    const size = statSync3(log.file).size;
    const fd = openSync(log.file, "r");
    const buf = Buffer.alloc(Math.min(MAX_LOG_CHUNK + 1, Math.max(0, size - from)));
    try {
      readSync(fd, buf, 0, buf.length, from);
    } finally {
      closeSync(fd);
    }
    let end = Math.min(buf.length, MAX_LOG_CHUNK);
    while (end < buf.length && end > 0 && (buf[end] & 192) === 128) end--;
    return reply(200, { text: buf.subarray(0, end).toString("utf8"), next: Math.min(size, from + end), size });
  }
  return reply(404, { error: "not found" });
}

// src/network/remote-dashboard.ts
var dashboardError = (code, error, status = 503) => ({ status, body: { code, error } });
var RemoteDashboard = class {
  constructor(network, context) {
    this.network = network;
    this.context = context;
    network.registerExtension(DASHBOARD_FRAME, DASHBOARD_CAPABILITY, (payload, pair) => this.receive(payload, pair));
  }
  network;
  context;
  pending = /* @__PURE__ */ new Map();
  rates = /* @__PURE__ */ new Map();
  closed = false;
  async request(host, raw) {
    const parsed = dashboardRequestSchema.safeParse(raw);
    if (!parsed.success) return dashboardError("bad_request", "Invalid dashboard read request.", 400);
    const pair = this.network.status().paired.find((p) => p.id === host || p.name === host);
    if (this.closed || !pair?.connected) return dashboardError("remote_offline", "The paired PC is not connected.");
    if (!this.network.peerSupports(host, DASHBOARD_CAPABILITY)) return dashboardError("remote_update_needed", "Update and restart the paired PC's hosting sessions to read its dashboard.", 409);
    if (this.pending.size >= DASHBOARD_MAX_PENDING) return dashboardError("remote_busy", "Too many pending dashboard reads.", 429);
    const rid = randomUUID6();
    const response = new Promise((resolve4) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        resolve4(dashboardError("remote_timeout", "The paired dashboard read timed out.", 504));
      }, DASHBOARD_TIMEOUT_MS);
      this.pending.set(rid, { host: pair.id, resolve: resolve4, timer });
    });
    try {
      await this.network.sendExtension(host, DASHBOARD_FRAME, { kind: "request", rid, request: parsed.data });
    } catch {
      this.finish(rid, dashboardError("remote_offline", "The paired PC disconnected."));
    }
    return response;
  }
  finish(rid, result) {
    const pending = this.pending.get(rid);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(rid);
    pending.resolve(result);
  }
  async receive(payload, pair) {
    const parsed = dashboardWireSchema.safeParse(payload);
    if (!parsed.success) {
      if (payload.kind === "request" && external_exports.uuid().safeParse(payload.rid).success) {
        try {
          await this.network.sendExtension(pair.id, DASHBOARD_FRAME, { kind: "response", rid: payload.rid, result: dashboardError("bad_request", "Invalid dashboard read request.", 400) });
        } catch {
        }
      }
      return;
    }
    const frame = parsed.data;
    if (frame.kind === "response") {
      if (this.pending.get(frame.rid)?.host === pair.id) this.finish(frame.rid, frame.result);
      return;
    }
    const now = Date.now();
    let rate = this.rates.get(pair.id);
    if (!rate || now - rate.at >= DASHBOARD_RATE_WINDOW_MS) {
      rate = { at: now, count: 0 };
      this.rates.set(pair.id, rate);
    }
    let result;
    if (++rate.count > DASHBOARD_RATE_LIMIT) result = dashboardError("remote_rate_limited", "Dashboard read rate limit reached.", 429);
    else {
      try {
        result = await readDashboard(this.context, frame.request);
      } catch {
        result = dashboardError("remote_read_failed", "The paired dashboard could not read this record.", 500);
      }
    }
    if (Buffer.byteLength(JSON.stringify(result)) > DASHBOARD_MAX_RESPONSE_BYTES) result = dashboardError("remote_response_too_large", "This dashboard page is too large; request a smaller page.", 413);
    try {
      await this.network.sendExtension(pair.id, DASHBOARD_FRAME, { kind: "response", rid: frame.rid, result });
    } catch {
    }
  }
  close() {
    this.closed = true;
    for (const rid of this.pending.keys()) this.finish(rid, dashboardError("remote_offline", "Networking stopped."));
    this.rates.clear();
  }
};

// src/network/remote-jobs.ts
import { randomUUID as randomUUID7 } from "node:crypto";
import { existsSync as existsSync5, realpathSync, statSync as statSync4 } from "node:fs";
import { isAbsolute as isAbsolute2, join as join8 } from "node:path";
var REMOTE_JOBS_FILE = "remote-jobs.json";
function allowedRemoteDirectory(directory, roots) {
  if (!isAbsolute2(directory)) throw new Error("Remote cwd must be an absolute path on the paired PC.");
  const canonical = realpathSync.native(directory);
  if (!statSync4(canonical).isDirectory() || !roots.some((root) => isAbsolute2(root) && isInside(canonical, realpathSync.native(root)))) {
    throw new Error("Remote folder is outside network.remoteJobs.allowRoots.");
  }
  return canonical;
}
var RemoteJobs = class {
  constructor(network, home, log, control) {
    this.network = network;
    this.home = home;
    this.log = log;
    this.control = control;
    const cli = bundledCli();
    this.runners = cli ? new JobRunners({}, home, cli, log) : null;
    const stored = readJsonStore(join8(home, REMOTE_JOBS_FILE));
    if (isRecord(stored) && Array.isArray(stored.jobs)) for (const r of stored.jobs) {
      if (typeof r.pair !== "string" || typeof r.peer !== "string" || !r.job?.id || !r.args) continue;
      this.records.set(r.job.id, { ...r, job: { ...r.job, controller: new AbortController(), queue: [] } });
    }
    network.registerExtension(REMOTE_JOB_FRAME, REMOTE_JOB_CAPABILITY, (payload, pair) => this.receive(payload, pair));
  }
  network;
  home;
  log;
  control;
  records = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  rates = /* @__PURE__ */ new Map();
  feeds = /* @__PURE__ */ new Map();
  approvals = /* @__PURE__ */ new Map();
  publishingApprovals = /* @__PURE__ */ new Set();
  starting = /* @__PURE__ */ new Set();
  runners;
  closed = false;
  async request(host, peer, raw, supervisor = peer.id, localJobName) {
    const request = remoteJobRequestSchema.parse(raw);
    if (!this.network.peerSupports(host, REMOTE_JOB_CAPABILITY)) throw new Error("Remote broker update needed or paired PC disconnected: install remote-jobs-v1 support and restart its hosting sessions.");
    if (this.pending.size >= REMOTE_JOB_RATE_LIMIT) throw new Error("Too many pending remote job requests.");
    const rid = randomUUID7();
    const response = new Promise((resolve4, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error("Remote job request timed out; check the paired PC before retrying a spawn."));
      }, REMOTE_JOB_REQUEST_TIMEOUT_MS);
      this.pending.set(rid, { host, resolve: resolve4, reject, timer });
    });
    void response.catch(() => {
    });
    try {
      await this.network.sendExtension(host, REMOTE_JOB_FRAME, { kind: "request", rid, peer: { id: peer.id, name: peer.name, supervisor }, request });
      const snapshot = await response;
      await this.mirror(host, peer, request, snapshot, supervisor, localJobName);
      return snapshot;
    } catch (err) {
      const p = this.pending.get(rid);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(rid);
        p.reject(err);
      }
      throw err;
    }
  }
  async receive(payload, pair) {
    const parsed = remoteJobWireSchema.safeParse(payload);
    if (!parsed.success) {
      this.log.warn("invalid remote job frame", { host: pair.name });
      return;
    }
    const frame = parsed.data;
    if (frame.kind === "response") {
      const p = this.pending.get(frame.rid);
      if (!p || p.host !== pair.id && p.host !== pair.name) return;
      clearTimeout(p.timer);
      this.pending.delete(frame.rid);
      if (frame.error) p.reject(new Error(frame.error));
      else {
        const snapshot = remoteJobSnapshotSchema.safeParse(frame.value);
        if (snapshot.success) p.resolve(snapshot.data);
        else p.reject(new Error("Invalid remote job response."));
      }
      return;
    }
    try {
      const advertised = this.network.peers().find((p) => p.id === `${pair.id}/${frame.peer.id}` && p.name === `${pair.name}/${frame.peer.name}`);
      if (!advertised || advertised.jobAgent) throw new Error("Remote job requester is not an advertised supervisor session.");
      const cfg = loadConfig(this.home, "other", this.log, {});
      const policy = cfg.network.remoteJobs;
      if (!policy.enabled || !policy.allowPeers.includes(pair.name)) throw new Error("Remote jobs are disabled for this pair; enable network.remoteJobs and explicitly allow its instance name.");
      const now = Date.now();
      let rate = this.rates.get(pair.id);
      if (!rate || now - rate.at >= REMOTE_JOB_RATE_WINDOW_MS) {
        rate = { at: now, requests: 0, spawns: 0 };
        this.rates.set(pair.id, rate);
      }
      if (++rate.requests > REMOTE_JOB_RATE_LIMIT || frame.request.op === "spawn" && ++rate.spawns > REMOTE_JOB_SPAWN_LIMIT) throw new Error("Remote job rate limit reached; try again later.");
      if (frame.request.op === "spawn" && this.starting.has(frame.request.job)) throw new Error("Remote job is already starting.");
      if (frame.request.op === "spawn") this.starting.add(frame.request.job);
      let value;
      try {
        value = await this.handle(pair, frame.peer, frame.request);
      } finally {
        if (frame.request.op === "spawn") this.starting.delete(frame.request.job);
      }
      await this.network.sendExtension(pair.id, REMOTE_JOB_FRAME, { kind: "response", rid: frame.rid, value });
    } catch (err) {
      await this.network.sendExtension(pair.id, REMOTE_JOB_FRAME, { kind: "response", rid: frame.rid, error: String(err.message).slice(0, 4096) });
    }
  }
  async handle(pair, peer, request) {
    let record = this.records.get(request.job);
    if (record && (record.pair !== pair.id || record.peer !== peer.supervisor)) throw new Error("Remote job belongs to another supervisor.");
    if (request.op === "spawn") {
      const cfg = loadConfig(this.home, request.target, this.log, {});
      const policy = loadConfig(this.home, "other", this.log, {}).network.remoteJobs;
      if (!policy.agents.includes(request.target)) throw new Error("Remote agent is not allowed by network.remoteJobs.agents.");
      if (record && record.job.agent !== request.target) throw new Error("Cannot change a remote job's agent.");
      if (record && this.snapshot(record).alive) throw new Error("Remote job is already running.");
      if ([...this.records.values()].filter((r) => this.snapshot(r).alive).length + this.starting.size > cfg.maxJobs) throw new Error("Remote subagent limit reached.");
      if (!record && this.records.size >= MAX_REMOTE_JOBS) throw new Error("Remote job registry is full.");
      if (!record && request.args.session_id) throw new Error("Remote session continuation requires a job owned by this supervisor.");
      const settings = Object.fromEntries(JOB_SETTING_KEYS.filter((key) => key in request.args).map((key) => [key, request.args[key]]));
      if (Object.keys(settings).length) {
        const parsed = parseJobSettings(settings, request.target);
        if (typeof parsed === "string") throw new Error(parsed);
      }
      let args = { ...request.args, ...request.target === "codex" ? { native_subagents: request.args.native_subagents ?? cfg.codexSubagents } : {} };
      let cwd = allowedRemoteDirectory(args.cwd, policy.allowRoots);
      for (const directory of await gitDirsOutside(cwd, this.log) ?? []) allowedRemoteDirectory(directory, policy.allowRoots);
      let worktree = null;
      if (record) {
        const state = this.snapshot(record).state;
        if (!state?.sessionId) throw new Error("Remote job has no session to continue.");
        cwd = allowedRemoteDirectory(state.workdir ?? cwd, policy.allowRoots);
        worktree = state.worktree ?? null;
        args = resumeArgs(args, record.job.name, args.prompt, state.sessionId, cwd, worktree, { ...args });
      } else if (args.worktree) {
        const repo = allowedRemoteDirectory(await git(["rev-parse", "--show-toplevel"], cwd, this.log), policy.allowRoots);
        if (existsSync5(join8(repo, "worktrees"))) allowedRemoteDirectory(join8(repo, "worktrees"), policy.allowRoots);
        worktree = await createWorktree({ cwd, home: repo, jobId: request.job, log: this.log });
        cwd = allowedRemoteDirectory(worktree.cwd, policy.allowRoots);
        args = { ...args, cwd, worktree: false, _worktree: worktree };
      }
      const owner = `${pair.name}/${peer.name}`;
      const job = {
        id: request.job,
        name: `${request.target}-job-${request.job}`,
        agent: request.target,
        model: args.model ?? null,
        prompt: args.prompt,
        args: { ...args },
        owner,
        supervisor: `${pair.id}/${peer.supervisor}`,
        startedAt: Date.now(),
        controller: new AbortController(),
        queue: [],
        status: "running",
        progress: null,
        sessionId: args.session_id ?? null,
        workdir: cwd,
        worktree
      };
      const previous = this.records.get(request.job);
      record = { pair: pair.id, peer: peer.supervisor, owner, job, args: { ...args, cwd, _job: job.name } };
      this.records.set(job.id, record);
      try {
        if (this.closed) throw new Error("Remote broker closed while the job was starting.");
        const host = this.runners?.start(job, { target: request.target, args: record.args, base: record.args, owner, byAgent: "other", cwd, cfg });
        if (!host) throw new Error("Remote job runner is unavailable; update the remote broker's bundled CLI.");
        job.host = host;
      } catch (err) {
        if (previous) this.records.set(job.id, previous);
        else this.records.delete(job.id);
        throw err;
      }
      this.persist();
      this.log.info("remote job started", { host: pair.name, owner, job: job.name, cwd });
    } else {
      if (!record) throw new Error("Unknown remote job.");
      if (request.op === "control") {
        if (request.control.type === "settings") {
          const settings = parseJobSettings(request.control.settings, record.job.agent);
          if (typeof settings === "string") throw new Error(settings);
        }
        await this.control({ owner: record.owner, name: record.job.name, id: record.job.id }, request.control);
        this.log.info("remote job control", { job: record.job.name, control: request.control.type, host: pair.name });
      } else if (request.op === "approval") {
        if (!listPendingApprovals(this.home).some((a) => a.id === request.id && a.job === record.job.name && a.owner === record.owner)) throw new Error("Remote approval expired or belongs to another job.");
        const outcome = await answerPendingApproval(this.home, request.id, { decision: request.decision, reason: request.reason });
        if (outcome !== "answered") throw new Error(`Remote approval ${outcome}.`);
      }
    }
    return this.snapshot(record);
  }
  snapshot(record) {
    const state = readRunnerState(this.home, record.job.id);
    const alive = this.runners?.alive(record.job, state) ?? Boolean(state && state.status === "running");
    return { state, alive, approvals: listPendingApprovals(this.home).filter((a) => a.job === record.job.name && a.owner === record.owner) };
  }
  persist() {
    writeJsonStore(join8(this.home, REMOTE_JOBS_FILE), { jobs: [...this.records.values()].map((r) => {
      const { controller, queue, ...job } = r.job;
      return { ...r, job };
    }) }, readJsonStore(join8(this.home, REMOTE_JOBS_FILE)));
  }
  async mirror(host, peer, request, snapshot, supervisor, localJobName) {
    const owner = peer.name;
    const key = `${host}/${request.job}`;
    if (request.op === "spawn") {
      this.feeds.get(key)?.end("interrupted");
      this.feeds.set(key, startRunFeed({
        home: this.home,
        name: `${request.target}-${request.job}`,
        header: `${request.target} on ${host}, by ${owner}
${request.args.prompt}
---`,
        meta: { by: owner, job: localJobName ?? `${request.target}-job-${request.job}`, title: request.args.title, remote: { host, name: `${request.target}-job-${request.job}` }, model: request.args.model, effort: request.args.effort, access: request.args.access ?? (request.args.worktree ? "edit" : "default"), workdir: request.args.cwd }
      }));
      this.log.info("requested remote job", { host, job: request.job, owner });
    }
    const state = snapshot.state;
    if (!this.feeds.has(key) && state?.status === "running") {
      this.feeds.set(key, startRunFeed({
        home: this.home,
        name: state.peer,
        header: `Reattached remote job on ${host}, by ${owner}`,
        meta: { by: owner, job: localJobName ?? state.peer, remote: { host, name: state.peer } }
      }));
    }
    const feed = this.feeds.get(key);
    if (state) {
      feed?.meta({ session: state.sessionId, workdir: state.workdir ?? void 0, model: state.model, percent: state.percent, progressNote: state.progressNote, etaAt: state.etaAt, etaReportedAt: state.etaReportedAt });
      if (state.progress) feed?.report(state.progress);
      if (state.status !== "running") {
        feed?.end(state.status, state.report);
        this.feeds.delete(key);
      }
    }
    const active = new Set(snapshot.approvals.map((a) => `${key}/${a.id}`));
    for (const [id, close] of this.approvals) if (id.startsWith(`${key}/`) && !active.has(id)) {
      close();
      this.approvals.delete(id);
    }
    for (const approval of snapshot.approvals) {
      const id = `${key}/${approval.id}`;
      if (this.approvals.has(id) || this.publishingApprovals.has(id)) continue;
      this.publishingApprovals.add(id);
      try {
        const close = await publishApproval(this.home, { ...approval, owner, job: `${host}/${approval.job}` }, async (body) => {
          if (Date.now() >= approval.deadline) return false;
          try {
            await this.request(host, peer, { op: "approval", job: request.job, id: approval.id, decision: body.startsWith("allow") ? "allow" : "deny", reason: body.includes(":") ? body.slice(body.indexOf(":") + 1).trim() : void 0 }, supervisor);
            return true;
          } catch {
            return false;
          }
        });
        if (this.closed) close();
        else this.approvals.set(id, close);
      } finally {
        this.publishingApprovals.delete(id);
      }
    }
  }
  close() {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Remote jobs link closed."));
    }
    this.pending.clear();
    for (const close of this.approvals.values()) close();
    this.approvals.clear();
    for (const feed of this.feeds.values()) feed.end("interrupted");
    this.feeds.clear();
  }
};

// src/core/broker.ts
var PEER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var PENDING_DEFAULT_LIMIT = 50;
var DEDUPE_KEEP_MS = 30 * 60 * 1e3;
var DEDUPE_MAX = 5e3;
var PENDING_MAX_LIMIT = 500;
var NAME_SUFFIX_LIMIT = 100;
var MAX_FILE_ADDRESS_CHARS = 256;
var MAX_FILE_PATH_CHARS = 1024;
var SIBLING_STATUSES = /* @__PURE__ */ new Set(["running", "done", "failed", "interrupted"]);
var MAX_INFLIGHT_PER_CONNECTION = 128;
var PAUSE_INFLIGHT_PER_CONNECTION = 32;
var MAX_CONNECTION_BUFFER_BYTES = 4 * MAX_FRAME_BYTES;
var UNAUTHENTICATED_OPS = /* @__PURE__ */ new Set(["hello", "auth", "ping"]);
var Broker = class {
  constructor(pipePath, store, log, token, now = Date.now, jobsPath, networking) {
    this.pipePath = pipePath;
    this.store = store;
    this.log = log;
    this.token = token;
    this.now = now;
    this.jobsPath = jobsPath;
    this.networking = networking;
    this.groups = new ProjectGroups(jobsPath ? dirname3(jobsPath) : void 0);
    this.handlers = {
      projectMain: (c, a) => {
        const args = external_exports.object({ to: external_exports.string().min(1) }).strict().parse(a);
        return this.switchProjectMain(c.peer, this.connByName(args.to)?.peer ?? void 0);
      },
      projectJobs: (c) => this.storedJobs().filter((j) => this.groups.canControl(this.requirePeer(c), j, this.localPeers())),
      coordinatorAvailability: (c, a) => {
        const args = external_exports.object({ name: external_exports.string().optional(), unavailable: external_exports.boolean() }).strict().parse(a);
        if (!c.peer && !args.name) throw new BridgeError("bad_request", "A coordinator name is required.");
        const target = args.name ? this.connByName(args.name) : c;
        if (!target?.peer || target.peer.jobAgent || target.peer.subagent) throw new BridgeError("bad_request", "A live local master is required.");
        if (c.peer && target !== c) throw new BridgeError("unauthorized", "A session can only change its own availability.");
        return this.onUpdatePeer(target, { unavailable: args.unavailable });
      },
      handoffSubagents: (c, a) => {
        const parsed = handoffSchema.safeParse(a);
        if (!parsed.success) throw new BridgeError("bad_request", "Invalid handoff arguments.");
        const source = this.requirePeer(c);
        if (parsed.data.to.includes("/")) throw new BridgeError("bad_request", "Paired-PC handoff is not supported; choose an exact live local session name.");
        const target = this.connByName(parsed.data.to)?.peer;
        if (!target) throw new BridgeError("unknown_target", "The target must be an exact live local session name.");
        if (!this.jobsPath) throw new BridgeError("bad_request", "The job registry is unavailable.");
        if (parsed.data.switch_project_main && (parsed.data.jobs !== "all" || !this.projectPeer(source).projectGroup || this.projectPeer(source).projectGroup !== this.projectPeer(target).projectGroup)) {
          throw new BridgeError("unauthorized", "Switching the project main requires all jobs and a target in the same project group.");
        }
        const receipt = commitHandoff(this.jobsPath, source, target, parsed.data, { canControl: (job) => this.groups.canControl(source, job, this.localPeers()) });
        if (parsed.data.switch_project_main) this.switchProjectMain(source, target);
        this.jobsSnapshot = null;
        this.jobsForDispatch = null;
        this.applyHandoffs();
        for (const conn of this.conns) if (conn.peer) this.emit(conn, "jobs_changed", { withdrawn: conn.peer.name === source.name ? receipt.jobs.map((j) => j.id) : [] });
        return receipt;
      },
      jobAuthority: (c, a) => {
        const peer = this.requirePeer(c), job = this.jobForControl(peer, a.job);
        if (!job || !this.groups.canControl(peer, job, this.localPeers())) return null;
        return job;
      },
      jobRecipient: (c, a) => {
        const peer = this.requirePeer(c), job = this.jobForControl(peer, a.job);
        if (!job || !this.groups.canControl(peer, job, this.localPeers())) throw new BridgeError("unauthorized", "Only a master can inspect the job recipient.");
        return this.jobRecipient(job);
      },
      inlineJobControl: async (c, a) => {
        const peer = this.requirePeer(c), job = this.jobForControl(peer, a.job);
        if (!job || !this.groups.canControl(peer, job, this.localPeers())) throw new BridgeError("unauthorized", "Only the current supervisor can control this job.");
        if (!a.control || !["message", "title", "settings", "effort", "cancel"].includes(a.control.type)) throw new BridgeError("bad_request", "Invalid inline control.");
        if (job.host && job.status === "running") {
          await this.onSend(c, { to: String(job.name), body: JSON.stringify(a.control), conversationId: `${CONTROL_CONVERSATION_PREFIX}${job.id}` });
          return { sent: true };
        }
        const executor = typeof (job.executionOwner ?? job.owner) === "string" ? this.connByName(String(job.executionOwner ?? job.owner)) : void 0;
        if (job.status !== "running") {
          const recipient = this.jobRecipient(job);
          const primary = this.connByName(recipient);
          if (!primary) throw new BridgeError("unknown_target", "No job master is currently connected.");
          this.emit(primary, "shared_job_control", a);
          return { sent: true };
        }
        if (!executor) throw new BridgeError("unknown_target", "The inline job's executor is offline.");
        this.emit(executor, "inline_job_control", a);
        return { sent: true };
      },
      inlineJobReport: async (c, m) => {
        const peer = this.requirePeer(c);
        await this.store.retryWrite(() => {
          const job = this.storedJobs().find((j) => `job:${j.id}` === m.from?.id);
          if (!job || job.executionOwner !== peer.name && job.owner !== peer.name && job.rootName !== peer.name || typeof job.owner !== "string" || typeof m.body !== "string" || m.body.length > MAX_BODY_CHARS) throw new BridgeError("unauthorized", "Invalid inline job delivery.");
          const recipient = this.jobRecipient(job);
          const message = { ...m, to: recipient, recipient, conversationId: this.jobConversation(job, recipient, m.conversationId) };
          if (this.store.insertJobDelivery(message)) {
            const target = this.connByName(recipient);
            if (target && !target.peer?.unavailable) this.emit(target, "message", message);
          }
        });
        return { saved: true };
      },
      auth: (c, a) => {
        this.checkAuth(a.protocol, a.token);
        c.authed = true;
        return { brokerPid: process.pid };
      },
      hello: async (c, a) => {
        const result = this.onHello(c, a);
        const job = this.storedJobs().find((j) => `job:${j.id}` === c.peer?.id);
        if (job?.ownershipHistory) this.refreshJobPeer(job);
        void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) }));
        this.store.history.rememberPeer(c.peer);
        return result;
      },
      send: (c, a) => this.onSend(c, a),
      decide: (c, a) => this.onDecide(c, a),
      decisions: (c, a) => this.onDecisions(c, a),
      searchHistory: (_, a) => {
        const parsed = historySearchSchema.safeParse(a);
        if (!parsed.success) throw new BridgeError("bad_request", "Invalid history query or filters.");
        return this.store.history.search(parsed.data);
      },
      getConversation: (_, a) => readConversation(this.store.history.database, conversationPageSchema.parse(a)),
      reindexHistory: (_, a) => {
        const args = external_exports.object({ reset: external_exports.boolean().optional() }).strict().parse(a);
        if (this.historyBackground) return this.historyBackground.tick(args.reset);
        if (args.reset) this.store.history.reset();
        return this.store.history.tick();
      },
      peers: () => this.livePeers(),
      brokerLoad: () => ({ connectedJobs: [...this.conns].filter((conn) => conn.peer?.jobAgent).length, testedJobs: BROKER_TESTED_JOB_LOAD }),
      dashboardPeers: () => this.dashboardPeers().concat(this.network?.peers() ?? []),
      dashboardRead: (_, a) => this.remoteDashboard?.request(a.host, a.request) ?? dashboardError("remote_offline", "Networking is unavailable."),
      siblings: (c) => this.siblingPeers(c),
      sendSibling: (c, a) => this.onSendSibling(c, a),
      messageReceipt: (c, a) => this.messageReceipt(c, a.id),
      ack: async (c, a) => ({ acked: await this.store.retryWrite(() => this.store.markRead(this.requirePeer(c).name, a.ids ?? [], this.now())) }),
      pending: (c, a) => this.pendingMail(this.requirePeer(c).name, Math.min(Math.max(1, a.limit ?? PENDING_DEFAULT_LIMIT), PENDING_MAX_LIMIT)),
      updatePeer: (c, a) => {
        const peer = this.onUpdatePeer(c, a);
        const job = this.storedJobs().find((j) => `job:${j.id}` === peer.id);
        if (job?.ownershipHistory) this.refreshJobPeer(job);
        this.store.history.rememberPeer(peer);
        return peer;
      },
      claimMail: (c, a) => this.onClaimMail(c, a),
      ping: () => ({ brokerPid: process.pid, protocol: PROTOCOL_VERSION }),
      networkStatus: () => this.network?.status() ?? { enabled: false, config: this.networking?.config, discovered: [], paired: [] },
      remoteJob: async (c, a) => {
        const peer = this.requirePeer(c);
        if (peer.jobAgent) throw new BridgeError("bad_request", "Only supervisor sessions can request remote jobs.");
        if (!this.remoteJobs) throw new BridgeError("bad_request", "Remote broker update needed or networking unavailable.");
        const saved = this.storedJobs().find((job) => job.id === a.request.job && job.owner === peer.name);
        const supervisor = typeof saved?.supervisor === "string" ? saved.supervisor : peer.sessionId ?? peer.id;
        const snapshot = await this.remoteJobs.request(a.host, peer, a.request, supervisor, typeof saved?.name === "string" ? saved.name : void 0);
        const progress = snapshot.state?.progress;
        const key = `${a.host}/${a.request.job}`;
        if (progress && this.remoteProgress.get(key) !== progress) {
          this.remoteProgress.set(key, progress);
          const pair = this.requireNetwork().status().paired.find((p) => p.id === a.host || p.name === a.host);
          const name2 = snapshot.state.peer;
          this.receiveRemote({
            id: randomUUID8(),
            from: { id: `${pair?.id ?? a.host}/job:${a.request.job}`, name: `${pair?.name ?? a.host}/${name2}`, agent: "other" },
            to: peer.name,
            recipient: peer.name,
            body: progress,
            conversationId: `job-${a.request.job}:note`,
            replyTo: null,
            hop: 0,
            createdAt: this.now(),
            readAt: null
          });
        }
        return snapshot;
      },
      networkConfigure: (_, a) => {
        const change = this.networkChange.then(() => this.configureNetwork(a));
        this.networkChange = change.catch(() => {
        });
        return change;
      },
      networkVerify: (_, a) => this.requireNetwork().verify(external_exports.uuid().parse(a.id)),
      networkPair: () => this.requireNetwork().keys.inviteWithExpiry(),
      networkLink: async (_, a) => {
        try {
          const args = external_exports.object({ code: external_exports.string().min(1).max(MAX_PAIRING_CODE_CHARS), host: external_exports.string().min(1).max(MAX_NETWORK_HOST_CHARS), port: external_exports.number().int().min(1).max(MAX_PORT) }).parse(a);
          return await this.requireNetwork().link(args.code, args.host, args.port);
        } catch {
          throw new BridgeError("bad_request", "Pairing failed. Check the address, code expiry, unique names and existing pairings.");
        }
      },
      networkUnlink: (_, a) => {
        const id = external_exports.uuid().parse(a.id);
        const network = this.requireNetwork();
        const removed = network.status().paired.some((p) => p.id === id);
        network.unlink(id);
        return { removed };
      },
      sendFiles: (c, a) => this.onSendFiles(c, a),
      fetchFiles: (c, a) => {
        const sender = this.requirePeer(c);
        const args = external_exports.object({ from: external_exports.string().min(1).max(MAX_FILE_ADDRESS_CHARS), paths: external_exports.array(external_exports.string().min(1).max(MAX_FILE_PATH_CHARS)).min(1).max(MAX_STREAM_ENTRIES) }).parse(a);
        return this.requireNetwork().startFiles(args.from, args.paths, sender.cwd, { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent }, true);
      },
      transfers: () => ({ transfers: this.network?.transfers.list() ?? (this.networking ? readTransferHistory(this.networking.home) : []) }),
      cancelTransfer: (_, a) => {
        const id = external_exports.uuid().parse(a.id);
        if (this.network) return this.network.transfers.cancel(id);
        if (!this.networking) throw new Error("transfer inbox home is unavailable");
        return cancelStoredTransfer(this.networking.home, id);
      }
    };
  }
  pipePath;
  store;
  log;
  token;
  now;
  jobsPath;
  networking;
  groups;
  /** Live role selection, recomputed after broker restart; no durable ownership is rewritten. */
  projectMains = /* @__PURE__ */ new Map();
  server = null;
  conns = /* @__PURE__ */ new Set();
  historyBackground = null;
  purgeTimer = null;
  pendingJobMailRoute = null;
  pendingJobMailRouteAgain = false;
  pendingJobMailRetry = null;
  closing = false;
  network = null;
  remoteJobs = null;
  remoteDashboard = null;
  remoteProgress = /* @__PURE__ */ new Map();
  networkChange = Promise.resolve();
  handlers;
  jobsSnapshot = null;
  jobsForDispatch = null;
  recoveredJobs = /* @__PURE__ */ new Map();
  /** Bind the endpoint. Rejects with the socket error (EADDRINUSE when another broker owns it). */
  listen() {
    return new Promise((resolve4, reject) => {
      const server = createServer2((socket) => this.accept(socket));
      const onError = (err) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = async () => {
        server.removeListener("error", onError);
        server.on("error", (err) => this.log.error("broker server error", { err }));
        this.server = server;
        this.applyHandoffs();
        this.purgeTimer = setInterval(() => this.purge(), PURGE_INTERVAL_MS);
        this.purgeTimer.unref();
        if (this.store.file !== ":memory:") this.historyBackground = new HistoryBackground(this.store.file, this.log);
        this.purge();
        this.log.info("broker listening", { pipe: this.pipePath });
        if (this.networking) this.networking.config = readNetworkConfig(this.networking.home, this.networking.config);
        if (this.networking?.config.enabled) {
          try {
            this.network = new NetworkService(this.networking.home, this.networking.config, {
              peers: () => this.dashboardPeers(),
              receive: (message) => this.receiveRemote(message),
              receipt: (id, sender, recipient) => this.remoteReceipt(id, sender, recipient),
              recipientReceipts: true
            }, this.log);
            this.installRemoteJobs(this.network);
            await this.network.start();
          } catch (err) {
            this.remoteDashboard?.close();
            this.remoteDashboard = null;
            this.remoteJobs?.close();
            this.remoteJobs = null;
            await this.network?.close();
            this.network = null;
            this.log.warn("networking could not start; local broker remains available", { message: err.message });
          }
        }
        resolve4();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.pipePath);
    });
  }
  async close() {
    this.closing = true;
    if (this.pendingJobMailRetry) clearTimeout(this.pendingJobMailRetry);
    this.pendingJobMailRetry = null;
    await this.historyBackground?.close();
    this.historyBackground = null;
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    await this.networkChange;
    this.remoteDashboard?.close();
    this.remoteDashboard = null;
    this.remoteJobs?.close();
    this.remoteJobs = null;
    await this.network?.close();
    this.network = null;
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((r) => server.close(() => r()));
    await this.pendingJobMailRoute?.catch((err) => this.log.warn("pending mail route stopped", { err: String(err) }));
    this.store.close();
    this.log.info("broker closed");
  }
  /** Serialize listener changes and let the elected broker remain the sole network writer. */
  async configureNetwork(value) {
    if (!this.networking) throw new BridgeError("bad_request", "Restart all agent-bridge hosting sessions to load this wizard-capable broker.");
    const config = writeNetworkConfig(this.networking.home, value);
    this.remoteDashboard?.close();
    this.remoteDashboard = null;
    this.remoteJobs?.close();
    this.remoteJobs = null;
    await this.network?.close();
    this.network = null;
    this.networking.config = config;
    if (config.enabled) {
      const service = new NetworkService(this.networking.home, config, {
        peers: () => this.dashboardPeers(),
        receive: (message) => this.receiveRemote(message),
        receipt: (id, sender, recipient) => this.remoteReceipt(id, sender, recipient),
        recipientReceipts: true
      }, this.log);
      this.installRemoteJobs(service);
      try {
        await service.start();
        this.network = service;
      } catch (err) {
        await service.close();
        throw err;
      }
    }
    return this.network?.status() ?? { enabled: false, config, discovered: [], paired: [] };
  }
  installRemoteJobs(service) {
    this.remoteDashboard = new RemoteDashboard(service, { home: this.networking.home, log: this.log, peers: () => this.dashboardPeers() });
    this.remoteJobs = new RemoteJobs(service, this.networking.home, this.log, async (record, control) => {
      this.receiveRemote({
        id: randomUUID8(),
        from: { id: record.owner, name: record.owner, agent: "other" },
        to: record.name,
        recipient: record.name,
        conversationId: `${CONTROL_CONVERSATION_PREFIX}${record.id}`,
        replyTo: null,
        hop: 0,
        body: JSON.stringify(control),
        createdAt: this.now(),
        readAt: null
      });
    });
  }
  purge() {
    try {
      const ttl = retentionLimit("AGENT_BRIDGE_MESSAGE_TTL_MS", MESSAGE_TTL_MS);
      if (ttl) this.store.purgeOlderThan(this.now() - ttl);
    } catch (err) {
      this.log.warn("purge failed", { err });
    }
  }
  accept(socket) {
    const conn = { socket, peer: null, authed: false, inFlight: 0 };
    this.conns.add(conn);
    socket.setEncoding("utf8");
    const decoder = new FrameDecoder(MAX_FRAME_BYTES);
    this.log.debug("connection accepted");
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this.log.warn("dropping connection after undecodable frame", { err });
        socket.destroy();
        return;
      }
      for (const f of frames) {
        if (f.t === "req") {
          if (++conn.inFlight > MAX_INFLIGHT_PER_CONNECTION) {
            this.log.warn("closing overloaded client connection", { peer: conn.peer?.name });
            socket.destroy();
            break;
          }
          if (conn.inFlight >= PAUSE_INFLIGHT_PER_CONNECTION) socket.pause();
          void this.dispatch(conn, f).catch((err) => {
            this.log.warn("client request transport failed", { err: String(err) });
            socket.destroy();
          }).finally(() => {
            conn.inFlight--;
            if (conn.inFlight < PAUSE_INFLIGHT_PER_CONNECTION && !socket.destroyed) socket.resume();
          });
        } else this.log.debug("ignoring non-request frame from client", { t: f.t });
      }
    });
    socket.on("error", (err) => this.log.debug("connection error", { err: err.message }));
    socket.on("close", () => {
      this.conns.delete(conn);
      if (conn.peer) {
        void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) }));
        this.log.info("peer left", { name: conn.peer.name, agent: conn.peer.agent });
        if (!conn.peer.jobAgent) this.broadcastEvent("peer_left", conn.peer, conn);
      }
    });
  }
  async dispatch(conn, frame) {
    const handler = this.handlers[frame.op];
    try {
      if (!handler) throw new BridgeError("bad_request", `unknown op: ${String(frame.op)}`);
      if (!conn.authed && !UNAUTHENTICATED_OPS.has(frame.op)) throw new BridgeError("unauthorized", "authenticate first");
      this.log.debug("request", { op: frame.op, peer: conn.peer?.name });
      const result = await handler(conn, frame.args ?? {});
      this.write(conn, { t: "res", id: frame.id, ok: true, result });
    } catch (err) {
      const be = err instanceof BridgeError ? err : new BridgeError("internal", String(err?.message ?? err));
      if (be.code === "internal") this.log.error("request failed", { op: frame.op, err });
      else this.log.debug("request rejected", { op: frame.op, code: be.code, message: be.message });
      this.write(conn, { t: "res", id: frame.id, ok: false, error: be.toPayload() });
    }
  }
  write(conn, frame) {
    if (conn.socket.destroyed) return false;
    try {
      const data = encodeFrame(frame);
      if (conn.socket.writableLength + Buffer.byteLength(data) > MAX_CONNECTION_BUFFER_BYTES) {
        this.log.warn("closing slow client connection; unread mail remains stored", { peer: conn.peer?.name });
        conn.socket.destroy();
        return false;
      }
      return conn.socket.write(data);
    } catch (err) {
      this.log.warn("client write failed; unread mail remains stored", { err: String(err) });
      conn.socket.destroy();
      return false;
    }
  }
  /** Deferred replay is outside dispatch: storage faults must not become uncaught exceptions.
   * Honour stream backpressure so a large retained inbox is not repeatedly disconnected on replay.
   */
  replayMail(conn, peer, before) {
    setImmediate(() => {
      if (conn.socket.destroyed || conn.peer !== peer) return;
      try {
        before?.();
        const mail = this.unreadMail(peer.name, PENDING_MAX_LIMIT);
        let at = 0;
        const pump = () => {
          if (conn.socket.destroyed || conn.peer !== peer) return;
          while (at < mail.length) {
            const m = mail[at++];
            if (peer.unavailable && m.from.id.startsWith("job:") && !m.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX)) continue;
            if (!this.write(conn, { t: "evt", ev: "message", data: m })) {
              if (!conn.socket.destroyed) conn.socket.once("drain", pump);
              return;
            }
          }
        };
        pump();
      } catch (err) {
        this.log.warn("mail replay deferred after storage failure", { peer: peer.name, err: String(err) });
      }
    });
  }
  emit(conn, ev, data) {
    const frame = { t: "evt", ev, data };
    this.write(conn, frame);
  }
  broadcastEvent(ev, data, except) {
    for (const c of this.conns) if (c !== except && c.peer) this.emit(c, ev, data);
  }
  requirePeer(conn) {
    if (!conn.peer) throw new BridgeError("not_registered", "send hello first");
    return conn.peer;
  }
  /** Local sessions and paired remote peers; local job runners stay hidden (see job-host.ts). */
  livePeers() {
    return this.localPeers().filter((p) => !p.jobAgent).map((p) => this.projectPeer(p)).concat(this.network?.peers() ?? []).filter((p) => !isPluginCacheCwd(p.cwd));
  }
  localPeers() {
    return [...this.conns].flatMap((c) => c.peer ? [c.peer] : []);
  }
  projectPeer(peer) {
    const decorated = this.groups.decorate(peer), key = decorated.projectGroup;
    if (!key || peer.jobAgent || peer.subagent) return decorated;
    const members = this.localPeers().filter((p) => !p.jobAgent && !p.subagent && this.groups.decorate(p).projectGroup === key).sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name));
    let main = this.projectMains.get(key);
    if (!members.some((p) => p.name === main)) {
      main = members[0]?.name;
      if (main) this.projectMains.set(key, main);
    }
    return { ...decorated, projectMain: main === peer.name, projectAddress: `project:${basename3(decorated.projectRoot)}` };
  }
  switchProjectMain(source, target) {
    if (!target || target.jobAgent || target.subagent || target.host) throw new BridgeError("bad_request", "Choose a live local project master.");
    const peer = this.projectPeer(target);
    if (!peer.projectGroup || source && (source.jobAgent || this.projectPeer(source).projectGroup !== peer.projectGroup)) throw new BridgeError("unauthorized", "Only a master of this project may switch its main session.");
    this.projectMains.set(peer.projectGroup, peer.name);
    return this.projectPeer(target);
  }
  sameJobFamily(a, b, jobs = this.storedJobs()) {
    if (this.jobSupervisor(a, jobs) !== this.jobSupervisor(b, jobs)) return false;
    const left = jobs.find((j) => `job:${j.id}` === a.id), right = jobs.find((j) => `job:${j.id}` === b.id);
    const l = left && this.groups.jobRoot(left, this.localPeers()), r = right && this.groups.jobRoot(right, this.localPeers());
    return !(l && r) || this.groups.root(l) === this.groups.root(r);
  }
  sharedJobs(a, b, jobs = this.storedJobs()) {
    const left = jobs.find((j) => `job:${j.id}` === a.id), right = jobs.find((j) => `job:${j.id}` === b.id);
    if (!left || !right || !this.groups.shareable(left) || !this.groups.shareable(right)) return false;
    const peers = this.localPeers(), l = this.groups.jobRoot(left, peers), r = this.groups.jobRoot(right, peers);
    return Boolean(l && r && this.groups.same(l, r));
  }
  /** Project local runner lineage from durable jobs; do not alter broker routing identities. */
  dashboardPeers() {
    const jobs = this.storedJobs();
    return [...this.conns].flatMap((c) => {
      const peer = c.peer;
      if (!peer) return [];
      const job = jobs.find((j) => j.name === peer.name || `job:${j.id}` === peer.id);
      const field = (key) => typeof job?.[key] === "string" ? job[key] : void 0;
      return [{
        ...this.projectPeer(peer),
        agent: peer.jobAgent ?? peer.agent,
        parentJob: field("parentJob") ?? peer.parentJob,
        rootSession: field("rootSession") ?? peer.rootSession ?? peer.jobOwner,
        rootName: field("rootName") ?? peer.rootName ?? peer.jobParent,
        title: peer.jobTitle,
        subagent: Boolean(peer.jobAgent)
      }];
    });
  }
  connByName(name2) {
    for (const c of this.conns) if (c.peer?.name === name2) return c;
    return void 0;
  }
  /** Replay every effect after the registry commit, including a crash between stores. */
  applyHandoffs() {
    if (!this.jobsPath) return;
    const records = this.storedJobs();
    for (const receipt of handoffJournal(this.jobsPath)) {
      const current = receipt.jobs.map((j) => records.find((r) => r.id === j.id)).filter(isRecord);
      for (const job of current) {
        const old = receipt.jobs.find((j) => j.id === job.id);
        const budget = new RootConcurrency(dirname3(this.jobsPath), String(job.rootSession));
        try {
          budget.moveJobs([old.name]);
        } finally {
          budget.close();
        }
        this.refreshJobPeer(job);
      }
      const body = `Inherited subagents from ${receipt.from}:
` + receipt.jobs.map((j) => `- ${j.name}: ${j.title} (${j.status})`).join("\n") + (receipt.note ? `

Handoff note: ${receipt.note}` : "") + "\n\nYou are their supervisor. Use message_subagent or cancel_subagent to control them.";
      for (const [recipient, text, suffix] of [[receipt.to, body, "inherited"], [receipt.from, `Handed off ${receipt.jobs.length} subagent(s) to ${receipt.to}.`, "confirmed"]]) {
        const m = {
          id: `${receipt.id}-${suffix}`,
          from: { id: "handoff", name: "agent-bridge", agent: "other" },
          to: recipient,
          recipient,
          body: text,
          conversationId: `handoff-${receipt.id}`,
          hop: 0,
          replyTo: null,
          createdAt: receipt.at,
          readAt: null
        };
        if (this.store.insertOnce(m)) {
          const conn = this.connByName(recipient);
          if (conn) this.emit(conn, "message", m);
        }
      }
    }
    void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) }));
  }
  routePendingJobMail() {
    if (this.closing) return Promise.resolve();
    this.pendingJobMailRouteAgain = true;
    this.pendingJobMailRoute ??= this.reroutePendingJobMail().catch((err) => {
      if (isSqliteBusy(err) && !this.closing && !this.pendingJobMailRetry) {
        this.pendingJobMailRetry = setTimeout(() => {
          this.pendingJobMailRetry = null;
          void this.routePendingJobMail().catch((error) => this.log.warn("pending job mail retry deferred", { err: String(error) }));
        }, 1e3);
        this.pendingJobMailRetry.unref();
      }
      throw err;
    }).finally(() => {
      this.pendingJobMailRoute = null;
    });
    return this.pendingJobMailRoute;
  }
  async reroutePendingJobMail() {
    do {
      this.pendingJobMailRouteAgain = false;
      let processed = 0;
      let pending = this.store.pendingJobSenders();
      for (const snapshot of this.storedJobs()) {
        if (++processed % 16 === 0) {
          await new Promise((resolve4) => setImmediate(resolve4));
          pending = this.store.pendingJobSenders();
        }
        if (snapshot.remote || !primaryFor(snapshot)) continue;
        if ((!Array.isArray(snapshot.deliveryHistory) || !snapshot.deliveryHistory.length) && !pending.has(`job:${snapshot.id}`)) continue;
        await this.store.retryWrite(() => {
          if (this.closing) return;
          const job = this.storedJobs().find((record) => record.id === snapshot.id);
          if (!job || job.remote || !primaryFor(job)) return;
          if ((!Array.isArray(job.deliveryHistory) || !job.deliveryHistory.length) && !this.store.pendingJobRecipients(String(job.id)).length) return;
          const recipient = this.jobRecipient(job), target = this.connByName(recipient);
          if (Array.isArray(job.deliveryHistory)) for (const envelope of job.deliveryHistory) {
            if (!isRecord(envelope) || !isRecord(envelope.from) || envelope.from.id !== `job:${job.id}` || typeof envelope.id !== "string" || typeof envelope.body !== "string") continue;
            const message = { ...envelope, to: recipient, recipient, conversationId: this.jobConversation(job, recipient, String(envelope.conversationId)) };
            const inserted = this.store.insertJobDelivery(message);
            const names = /* @__PURE__ */ new Set([recipient, envelope.to, envelope.recipient, ...mastersFor(job)]);
            const consumed = this.jobsPath && [...names].some((name2) => typeof name2 === "string" && new ReadJournal(dirname3(this.jobsPath)).read(`name:${name2}`).includes(message.id));
            if (consumed) this.store.markRead(recipient, [message.id], this.now());
            else if (inserted && target && !target.peer?.unavailable) this.emit(target, "message", message);
          }
          if (!target || target.peer?.unavailable) return;
          for (const from of this.store.pendingJobRecipients(String(job.id))) {
            if (this.jobsPath) this.store.markRead(from, new ReadJournal(dirname3(this.jobsPath)).read(`name:${from}`), this.now());
            const moved = this.store.handoffMail(from, recipient, String(job.id), this.now(), recipient !== job.parentJob && recipient !== primaryFor(job));
            const previous = this.connByName(from);
            if (previous && moved.length) this.emit(previous, "mail_retracted", { ids: moved.map((m) => m.id) });
            for (const m of moved) this.emit(target, "message", m);
          }
        });
      }
    } while (this.pendingJobMailRouteAgain && !this.closing);
  }
  jobRecipient(job) {
    if (typeof job.parentJob === "string" && this.connByName(job.parentJob)?.peer?.jobAgent) return job.parentJob;
    return chooseJobRecipient(job, this.localPeers(), this.groups.members(job, this.localPeers()));
  }
  jobConversation(job, recipient, conversationId) {
    if (recipient === job.parentJob || recipient === primaryFor(job) || isQuietMessage({ conversationId })) return conversationId;
    return conversationId.replace(/:note$/, "") + (conversationId.endsWith(":fallback") ? "" : ":fallback");
  }
  refreshJobPeer(job) {
    const peer = this.connByName(String(job.name))?.peer;
    if (!peer?.jobAgent) return;
    peer.jobParent = String(job.owner);
    peer.jobOwner = String(job.supervisor);
    peer.rootSession = String(job.rootSession);
    peer.rootName = String(job.rootName);
    peer.parentJob = typeof job.parentJob === "string" ? job.parentJob : void 0;
    if (isRecord(job.args) && Array.isArray(job.args.send_to)) peer.jobSendTo = job.args.send_to;
  }
  siblingConns(conn) {
    const peer = this.requirePeer(conn);
    if (!peer.jobAgent || !peer.jobOwner) throw new BridgeError("bad_request", "not a linked job");
    const jobs = this.storedJobs();
    const supervisor = this.jobSupervisor(peer, jobs);
    return [...this.conns].filter((c) => c !== conn && c.peer?.jobAgent && (this.sameJobFamily(peer, c.peer, jobs) || this.sharedJobs(peer, c.peer, jobs) || peer.jobSendTo?.includes(c.peer.name)));
  }
  jobForControl(peer, ref) {
    const known = this.storedJobs().find((j) => j.name === ref || j.id === ref);
    if (known?.remote || isRecord(known?.host) && Date.now() - Number(known.host.startedAt) < 3e4) return known;
    if (known?.status === "running" && !known.host && this.connByName(String(known.executionOwner ?? known.owner))) return known;
    const recovered = this.jobsPath ? recoverJobRecord(dirname3(this.jobsPath), ref) : void 0;
    if (!recovered || !this.groups.canControl(peer, recovered, this.localPeers())) return known;
    this.recoveredJobs.set(recovered.id, recovered);
    this.jobsSnapshot = null;
    this.jobsForDispatch = null;
    return recovered;
  }
  storedJobs() {
    if (!this.jobsPath) return [];
    if (this.jobsForDispatch) return this.jobsForDispatch;
    try {
      const active = readJsonSnapshot(this.jobsPath), archive = readArchivedJobSnapshot(this.jobsPath);
      if (this.jobsSnapshot?.active === active && this.jobsSnapshot.archive === archive.signature) {
        this.jobsForDispatch = this.jobsSnapshot.records;
        queueMicrotask(() => {
          this.jobsForDispatch = null;
        });
        return this.jobsForDispatch;
      }
      const data = active.value;
      const jobs = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : [];
      const merged = /* @__PURE__ */ new Map();
      for (const [id, job] of this.recoveredJobs) merged.set(id, job);
      for (const job of [...archive.jobs, ...jobs.filter(isRecord)]) {
        if (typeof job.id === "string") {
          merged.set(job.id, job);
          this.recoveredJobs.delete(job.id);
        }
      }
      const records = [...merged.values()];
      this.jobsSnapshot = { active, archive: archive.signature, records };
      this.jobsForDispatch = records;
      queueMicrotask(() => {
        this.jobsForDispatch = null;
      });
      return records;
    } catch {
      return [];
    }
  }
  /** A restored legacy runner may still advertise its old owner name until its next turn. */
  jobSupervisor(peer, jobs = this.storedJobs()) {
    const job = jobs.find((j) => `job:${j.id}` === peer.id);
    return typeof job?.supervisor === "string" ? job.supervisor : peer.jobOwner;
  }
  storedSiblings(peer) {
    if (!this.jobsPath || !peer.jobOwner) return [];
    try {
      const records = this.storedJobs();
      const supervisor = this.jobSupervisor(peer, records);
      return records.flatMap((j) => j && (this.sameJobFamily(peer, { id: `job:${j.id}`, jobOwner: String(j.supervisor) }, records) || this.sharedJobs(peer, { id: `job:${j.id}` }, records) || peer.jobSendTo?.includes(String(j.name))) && typeof j.id === "string" && typeof j.name === "string" && j.name !== peer.name && `job:${j.id}` !== peer.id && AGENT_KINDS.includes(j.agent) && SIBLING_STATUSES.has(j.status) ? [{ id: `job:${j.id}`, name: j.name, title: isRecord(j.args) && typeof j.args.title === "string" ? j.args.title : "", agent: j.agent, status: j.status, ...typeof j.finishedAt === "number" ? { finishedAt: j.finishedAt } : {}, report: typeof j.report === "string" ? j.report : null }] : []);
    } catch {
      return [];
    }
  }
  siblingPeers(conn) {
    const live = this.siblingConns(conn);
    const stored = this.storedSiblings(this.requirePeer(conn));
    const peers = new Map(stored.map(({ id, report, ...s }) => [s.name, s]));
    for (const c of live) {
      const p = c.peer;
      const previous = stored.find((s) => s.id === p.id);
      if (previous) peers.delete(previous.name);
      peers.set(p.name, {
        name: p.name,
        title: p.jobTitle ?? "",
        agent: p.jobAgent,
        status: previous?.status ?? "running",
        ...previous?.finishedAt !== void 0 ? { finishedAt: previous.finishedAt } : {}
      });
    }
    return [...peers.values()];
  }
  async onSendSibling(conn, args) {
    const sender = this.requirePeer(conn);
    const dedupeKey = args.dedupeKey ? `${SIBLING_CONVERSATION_PREFIX}${args.dedupeKey}` : void 0;
    const key = dedupeKey ? `${sender.id}:${dedupeKey}` : null;
    const seen = key ? this.sentByKey.get(key) : void 0;
    if (seen) return seen.result;
    const target = this.siblingConns(conn).find((c) => c.peer.name === args.to);
    const stored = this.storedSiblings(sender).find((s) => s.name === args.to);
    if (!target && !stored) {
      if (!isJobSendTarget(args.to) || !sender.jobSendTo?.includes(args.to) || args.to.includes("-job-") || args.to.includes("-ask-") || this.connByName(args.to)?.peer?.jobAgent) {
        throw new BridgeError("unknown_target", "no sibling with that job name or explicit send_to grant");
      }
      if (args.replyTo) {
        const parent2 = this.store.byId(args.replyTo);
        const own = this.storedJobs().find((j) => `job:${j.id}` === sender.id);
        const ownerNames = /* @__PURE__ */ new Set([sender.name, sender.jobParent, own?.owner]);
        if (!parent2 || !(parent2.from.name === args.to && ownerNames.has(parent2.recipient) || parent2.from.id === sender.id && parent2.recipient === args.to)) {
          throw new BridgeError("bad_request", "reply_to must refer to a message exchanged with the granted session or supervisor");
        }
      }
      return this.onSend(conn, { ...args, dedupeKey });
    }
    const targetId = target?.peer.id ?? stored.id;
    const parent = args.replyTo ? this.store.byId(args.replyTo) : null;
    if (args.replyTo && (!parent || !parent.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX) || !(parent.from.id === targetId && parent.recipient === sender.name || parent.from.id === sender.id && parent.recipient === args.to))) {
      throw new BridgeError("bad_request", "reply_to must refer to a message exchanged with this sibling");
    }
    if (!Number.isInteger(args.maxHops) || args.maxHops < 1 || (parent ? parent.hop + 1 : 0) >= args.maxHops) {
      if (typeof args.body !== "string" || !args.body.trim() || args.body.length > MAX_BODY_CHARS) {
        throw new BridgeError("bad_request", "invalid sibling message body");
      }
      const id = randomUUID8();
      const notice = {
        id,
        from: { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent },
        to: sender.jobParent ?? sender.name,
        recipient: sender.name,
        conversationId: `sibling-drop-${id}`,
        replyTo: parent?.id ?? null,
        hop: 0,
        body: `Sibling delivery blocked: ${sender.name} to ${args.to} reached the ${args.maxHops}-message hop limit. The target did not receive this message. Stop this thread and resolve remaining work with the supervisor.

Undelivered text:
${args.body}`,
        createdAt: this.now(),
        readAt: null
      };
      await this.store.retryWrite(() => this.store.insert(notice));
      this.emit(conn, "message", notice);
      if (sender.jobParent && sender.jobParent !== sender.name) {
        const copy = { ...notice, recipient: sender.jobParent };
        await this.store.retryWrite(() => this.store.insert(copy));
        const supervisor = this.connByName(sender.jobParent);
        if (supervisor) this.emit(supervisor, "message", copy);
      }
      throw new BridgeError("bad_request", `sibling conversation reached its ${args.maxHops}-message hop limit; message was not delivered. Durable notice ${id} saved for sender and supervisor, including the undelivered text`);
    }
    const conversationId = parent?.conversationId ?? `${SIBLING_CONVERSATION_PREFIX}${randomUUID8()}`;
    const result = await this.onSend(conn, { ...args, dedupeKey, conversationId });
    const message = result.messages[0];
    const recipientOwner = target?.peer?.jobParent ?? this.storedJobs().find((j) => j.name === args.to)?.owner;
    const observers = new Set([sender.jobParent, recipientOwner].filter((owner) => typeof owner === "string"));
    for (const owner of observers) {
      const note = {
        ...message,
        id: randomUUID8(),
        recipient: owner,
        conversationId: `${conversationId}${SIBLING_NOTE_SUFFIX}`,
        body: `Sibling message to ${message.recipient}:

${message.body}`
      };
      await this.store.retryWrite(() => this.store.insert(note));
      const supervisor = this.connByName(owner);
      if (supervisor) this.emit(supervisor, "message", note);
    }
    if (stored && stored.status !== "running") {
      result.finishedRecipient = {
        name: stored.name,
        status: stored.status,
        report: stored.report,
        ...stored.finishedAt !== void 0 ? { finishedAt: stored.finishedAt } : {}
      };
    }
    return result;
  }
  uniqueName(requested) {
    if (!this.connByName(requested)) return requested;
    for (let i = 2; i < NAME_SUFFIX_LIMIT; i++) {
      const candidate = `${requested}-${i}`;
      if (!this.connByName(candidate)) return candidate;
    }
    return `${requested}-${randomUUID8().slice(0, 8)}`;
  }
  onDecide(conn, value) {
    const peer = this.requirePeer(conn);
    const parsed = external_exports.object({
      topic: external_exports.string().trim().min(1).max(MAX_DECISION_TOPIC_CHARS),
      text: external_exports.string().trim().min(1).max(MAX_DECISION_TEXT_CHARS),
      scope: decisionScopeSchema.optional(),
      sourceMessageId: external_exports.string().min(1).optional()
    }).strict().safeParse(value);
    if (!parsed.success) throw new BridgeError("bad_request", "Invalid decision topic, text or scope.");
    if (parsed.data.sourceMessageId && !this.store.byId(parsed.data.sourceMessageId)) throw new BridgeError("bad_request", "Source message does not exist.");
    const decision = this.store.decisions.record({ ...parsed.data, scope: parsed.data.scope ?? { project: peer.cwd } }, { id: peer.id, name: peer.name, agent: peer.agent }, this.now());
    const deliveredTo = [];
    for (const c of this.conns) {
      if (!c.peer || c.peer.jobAgent || !decisionApplies(decision, c.peer)) continue;
      const message = this.queueDecision(decision, c.peer);
      if (message) {
        this.emit(c, "message", message);
        deliveredTo.push(c.peer.name);
      }
    }
    return { decision, deliveredTo };
  }
  onDecisions(conn, value) {
    const parsed = external_exports.object({
      query: external_exports.string().max(MAX_DECISION_TEXT_CHARS).optional(),
      scope: decisionScopeSchema.optional(),
      history: external_exports.boolean().optional(),
      topic: external_exports.string().max(MAX_DECISION_TOPIC_CHARS).optional(),
      session: external_exports.string().optional()
    }).strict().safeParse(value);
    if (!parsed.success) throw new BridgeError("bad_request", "Invalid decisions query or scope.");
    const scope = parsed.data.scope ?? (conn.peer ? { project: conn.peer.cwd } : void 0);
    return this.store.decisions.list({ ...parsed.data, scope }, conn.peer ?? void 0);
  }
  decisionSessionKey(peer) {
    return `${peer.agent}:${peer.sessionId ?? peer.id}`;
  }
  queueDecision(decision, peer) {
    const message = {
      id: randomUUID8(),
      from: decision.author,
      to: peer.name,
      recipient: peer.name,
      conversationId: `decision-${decision.id}`,
      replyTo: decision.sourceMessageId,
      hop: DECISION_MESSAGE_HOP,
      body: `Pinned owner decision: ${decision.topic}

${decision.text}

Call decisions to look up current decisions or their history.`,
      createdAt: this.now(),
      readAt: null
    };
    return this.store.decisions.enqueue(decision, this.decisionSessionKey(peer), message, () => this.store.insert(message)) ? message : null;
  }
  queueCurrentDecisions(peer) {
    if (peer.jobAgent || !peer.sessionId) return [];
    return this.store.decisions.list().filter((d) => decisionApplies(d, peer)).flatMap((d) => {
      const message = this.queueDecision(d, peer);
      return message ? [message] : [];
    });
  }
  checkAuth(protocol, token) {
    if (protocol !== PROTOCOL_VERSION) {
      throw new BridgeError("protocol_mismatch", `broker speaks protocol ${PROTOCOL_VERSION}, client ${protocol}`, {
        brokerProtocol: PROTOCOL_VERSION
      });
    }
    if (typeof token !== "string" || !tokensEqual(token, this.token)) {
      this.log.warn("rejected connection with a wrong or missing token");
      throw new BridgeError("unauthorized", "wrong agent-bridge token");
    }
  }
  onHello(conn, args) {
    this.checkAuth(args.protocol, args.token);
    conn.authed = true;
    const p = args.peer;
    if (!p || !PEER_NAME_PATTERN.test(p.name ?? "") || !AGENT_KINDS.includes(p.agent)) {
      throw new BridgeError("bad_request", "invalid peer info");
    }
    if (conn.peer) throw new BridgeError("bad_request", "already registered");
    if (isPluginCacheCwd(String(p.cwd ?? ""))) throw new BridgeError("bad_request", "Plugin-cache processes cannot register as sessions.");
    const name2 = this.uniqueName(p.name);
    const peer = {
      id: String(p.id),
      name: name2,
      agent: p.agent,
      cwd: String(p.cwd ?? ""),
      pid: Number(p.pid),
      agentPid: p.agentPid ?? null,
      agentStartedAt: typeof p.agentStartedAt === "string" && p.agentStartedAt.length <= 128 ? p.agentStartedAt : null,
      sessionId: p.sessionId ?? null,
      startedAt: Number(p.startedAt) || this.now(),
      autoWake: Boolean(p.autoWake),
      wakeOnDirect: Boolean(p.wakeOnDirect),
      wakeAvailable: Boolean(p.wakeAvailable),
      wakeMaxHops: typeof p.wakeMaxHops === "number" ? p.wakeMaxHops : void 0,
      activity: p.activity === "busy" || p.activity === "idle" ? p.activity : null,
      unavailable: p.unavailable === true,
      version: typeof p.version === "string" ? p.version.slice(0, 32) : void 0,
      ...validStoreCapabilities(p.storeCapabilities) ? { storeCapabilities: p.storeCapabilities } : {},
      ...p.jobAgent && AGENT_KINDS.includes(p.jobAgent) ? { jobAgent: p.jobAgent } : {},
      ...p.jobAgent && typeof p.jobOwner === "string" && p.jobOwner ? {
        parentJob: typeof p.parentJob === "string" ? p.parentJob : void 0,
        rootSession: typeof p.rootSession === "string" ? p.rootSession : void 0,
        rootName: typeof p.rootName === "string" ? p.rootName : void 0,
        jobOwner: p.jobOwner,
        jobParent: typeof p.jobParent === "string" ? p.jobParent : void 0,
        jobTitle: typeof p.jobTitle === "string" ? p.jobTitle : void 0,
        jobSendTo: Array.isArray(p.jobSendTo) ? p.jobSendTo.filter(isJobSendTarget).slice(0, MAX_JOB_SEND_TARGETS) : []
      } : {}
    };
    if (!peer.sessionId) peer.sessionId = this.store.recoverSession(peer);
    this.store.rememberSession(peer, this.now());
    conn.peer = peer;
    if (this.jobsPath) recordStorePeer(dirname3(this.jobsPath), peer);
    this.replaceStale(conn, peer);
    this.restoreNames(conn, peer, { reclaim: true, replay: false });
    this.expireStaleQueue(peer.name);
    let claimed = 0;
    if (!peer.jobAgent) {
      this.expireStaleQueue(agentQueueKey(peer.agent));
      claimed = this.store.claim(agentQueueKey(peer.agent), peer.name);
    }
    this.log.info("peer joined", { name: name2, agent: peer.agent, jobAgent: peer.jobAgent, cwd: peer.cwd, claimed });
    if (!peer.jobAgent) this.broadcastEvent("peer_joined", peer, conn);
    this.replayMail(conn, peer, () => {
      this.queueCurrentDecisions(peer);
    });
    return { brokerPid: process.pid, name: peer.name, sessionId: peer.sessionId, peers: this.livePeers().filter((x) => x.id !== peer.id) };
  }
  /**
   * Mail sent to a "-N" stand-in of this peer's name (a reload ran the session under it briefly) moves to the
   * peer. Only names of that form, and only while no one holds them: another session's mail stays its own.
   */
  onClaimMail(conn, args) {
    const peer = this.requirePeer(conn);
    const base2 = peer.name.replace(/-\d+$/, "");
    let moved = 0;
    for (const name2 of new Set(args.names ?? [])) {
      const standIn = name2 !== peer.name && (name2 === base2 || name2.startsWith(`${base2}-`) && /^\d+$/.test(name2.slice(base2.length + 1)));
      if (!standIn || this.connByName(name2)) continue;
      moved += this.store.claim(name2, peer.name);
    }
    if (moved) {
      this.log.info("mail of a stand-in name moved to its session", { to: peer.name, moved });
      this.replayMail(conn, peer);
    }
    return { moved };
  }
  onUpdatePeer(conn, args) {
    if (typeof args.cwd === "string" && isPluginCacheCwd(args.cwd)) throw new BridgeError("bad_request", "Plugin-cache processes cannot register as sessions.");
    const peer = this.requirePeer(conn);
    if (args.unavailable !== void 0) {
      if (peer.jobAgent || typeof args.unavailable !== "boolean") throw new BridgeError("bad_request", "Only masters can change availability.");
      peer.unavailable = args.unavailable;
      void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) }));
      if (!peer.unavailable) this.replayMail(conn, peer);
    }
    if (peer.jobOwner) {
      if (typeof args.jobParent === "string") peer.jobParent = args.jobParent;
      if (typeof args.jobTitle === "string") peer.jobTitle = args.jobTitle;
    }
    if (args.sessionId !== void 0) {
      const previousKey = this.decisionSessionKey(peer);
      peer.sessionId = args.sessionId;
      this.store.decisions.linkSession(previousKey, this.decisionSessionKey(peer));
      if (peer.sessionId) this.replaceStale(conn, peer);
    }
    if (args.autoWake !== void 0) peer.autoWake = Boolean(args.autoWake);
    if (args.wakeOnDirect !== void 0) peer.wakeOnDirect = Boolean(args.wakeOnDirect);
    if (args.wakeAvailable !== void 0) peer.wakeAvailable = Boolean(args.wakeAvailable);
    if (typeof args.wakeMaxHops === "number") peer.wakeMaxHops = args.wakeMaxHops;
    if (typeof args.cwd === "string" && args.cwd) peer.cwd = args.cwd;
    if (args.activity === "busy" || args.activity === "idle") peer.activity = args.activity;
    if (typeof args.name === "string" && args.name !== peer.name) {
      if (!PEER_NAME_PATTERN.test(args.name)) throw new BridgeError("bad_request", "invalid peer name");
      const old = peer.name;
      this.store.rememberName(peer, this.now());
      peer.name = this.uniqueName(args.name);
      this.log.info("peer renamed", { from: old, to: peer.name });
      this.expireStaleQueue(peer.name);
      setImmediate(() => {
        for (const m of this.unreadMail(peer.name, PENDING_MAX_LIMIT)) this.emit(conn, "message", m);
      });
    }
    this.log.debug("peer updated", { name: peer.name, sessionId: peer.sessionId, autoWake: peer.autoWake, cwd: peer.cwd });
    this.store.rememberSession(peer, this.now());
    this.store.rememberName(peer, this.now());
    this.restoreNames(conn, peer, { reclaim: args.sessionId !== void 0, replay: true });
    for (const message of this.queueCurrentDecisions(peer)) this.emit(conn, "message", message);
    return peer;
  }
  /**
   * One agent session, two servers: Claude Code's /reload-plugins (or a restart of the MCP server) starts a new
   * agent-bridge server while the old one may still be connected. The old one would keep the name and receive
   * mail the session no longer sees. So the newest server of a session wins: the old connection is told it was
   * replaced (it stops instead of reconnecting) and the new one takes over its name and waiting mail.
   */
  replaceStale(conn, peer) {
    for (const c of [...this.conns]) {
      const old = c.peer;
      if (c === conn || !old || old.agent !== peer.agent) continue;
      const sameSession = peer.sessionId && old.sessionId === peer.sessionId;
      const identity = registrationIdentity(peer);
      const sameProcess = (old.pid !== peer.pid || old.id === peer.id) && identity && identity === registrationIdentity(old) && (!old.sessionId || !peer.sessionId || old.sessionId === peer.sessionId);
      if (!sameSession && !sameProcess) continue;
      this.store.rememberName(old, this.now());
      this.log.info("session connected again from a new server; replacing the old connection", { name: old.name, by: peer.name, sessionId: peer.sessionId });
      this.emit(c, "replaced", { by: peer.name });
      this.conns.delete(c);
      c.peer = null;
      this.broadcastEvent("peer_left", old, c);
      c.socket.end();
      if (peer.name !== old.name && !this.connByName(old.name)) {
        const oldName = old.name;
        if (peer.name.startsWith(`${oldName}-`) && /^\d+$/.test(peer.name.slice(oldName.length + 1))) peer.name = oldName;
        this.replayMail(conn, peer, () => {
          this.store.claim(oldName, peer.name);
        });
      }
    }
  }
  restoreNames(conn, peer, options) {
    const names = this.store.namesFor(peer);
    const previous = peer.name;
    if (options.reclaim) {
      const base2 = peer.name.replace(/-\d+$/, "");
      const original = names.find((name2) => name2.replace(/-\d+$/, "") === base2 && (name2 === peer.name || !this.connByName(name2)));
      if (original) peer.name = original;
    }
    let moved = 0;
    for (const name2 of names) {
      if (name2 === peer.name || this.connByName(name2)) continue;
      moved += this.store.claim(name2, peer.name);
    }
    this.store.rememberName(peer, this.now());
    if (options.replay && (moved || previous !== peer.name)) this.replayMail(conn, peer);
  }
  /** Exact registrations win; an unoccupied retained alias must identify one live session. */
  recipientConn(name2) {
    const exact = this.connByName(name2);
    if (exact) return exact;
    const matches = [...this.conns].filter((c) => c.peer && this.store.namesFor(c.peer).includes(name2));
    return matches.length === 1 ? matches[0] : void 0;
  }
  /**
   * Before a peer takes over queued mail. Names are derived from the project folder and reused by every
   * later session there, so a name alone does not identify the session that mail was meant for. Mail that
   * waited longer than QUEUED_MAIL_MAX_AGE_MS most likely belongs to a session that is gone; recent mail
   * still reaches a session that restarted or reconnected after a broker hand-over.
   */
  expireStaleQueue(key) {
    try {
      const maxAge = retentionLimit("AGENT_BRIDGE_QUEUED_MAIL_MAX_AGE_MS", QUEUED_MAIL_MAX_AGE_MS);
      if (maxAge) this.store.expireQueued(key, this.now() - maxAge);
    } catch (err) {
      this.log.warn("expiring queued mail failed", { key, err });
    }
  }
  /** Turns a sender-supplied target into live connections and/or offline queue keys. */
  resolveTargets(to, sender) {
    const all = [...this.conns].filter((c) => c.peer && c.peer.id !== sender.id);
    const others = all.filter((c) => !c.peer.jobAgent);
    if (to.startsWith("project:")) {
      const members = this.localPeers().filter((p) => !p.jobAgent && !p.subagent).map((p) => this.projectPeer(p)).filter((p) => p.projectAddress === to);
      const keys = new Set(members.map((p) => p.projectGroup));
      if (keys.size !== 1) throw new BridgeError(keys.size > 1 ? "ambiguous_target" : "unknown_target", "Use a unique live local project address from peers.");
      const target = members.filter((p) => !p.unavailable).sort((a, b) => Number(Boolean(b.projectMain)) - Number(Boolean(a.projectMain)) || a.startedAt - b.startedAt || a.name.localeCompare(b.name))[0];
      if (!target) throw new BridgeError("unknown_target", "No project master is available; use an exact session name to queue mail.");
      return { live: [this.connByName(target.name)], queued: [] };
    }
    if (to === BROADCAST) {
      if (sender.jobAgent) throw new BridgeError("unauthorized", "job runners cannot broadcast to independent sessions");
      const ownNames = /* @__PURE__ */ new Set([sender.name, ...this.store.namesFor(sender)]);
      const queued = this.store.broadcastNames().filter((name2) => !ownNames.has(name2) && !this.recipientConn(name2));
      if (others.length === 0 && queued.length === 0 && !this.network?.peers().some((p) => !p.jobAgent)) {
        throw new BridgeError("unknown_target", "no other known sessions; send to an exact name to create an offline queue");
      }
      return { live: others, queued };
    }
    const recipient = this.recipientConn(to);
    const exact = all.find((c) => c.peer.id === to || c === recipient);
    if (exact) return { live: [exact], queued: [] };
    if (recipient?.peer?.id === sender.id || to === sender.name || to === sender.id) throw new BridgeError("bad_request", "cannot send a message to yourself");
    if (AGENT_KINDS.includes(to)) {
      const ofKind = others.filter((c) => c.peer.agent === to);
      if (ofKind.length === 1) return { live: ofKind, queued: [] };
      if (ofKind.length > 1) {
        throw new BridgeError("ambiguous_target", `several ${to} peers are online`, {
          candidates: ofKind.map((c) => c.peer.name)
        });
      }
      return { live: [], queued: [agentQueueKey(to)] };
    }
    if (!PEER_NAME_PATTERN.test(to)) throw new BridgeError("unknown_target", `invalid target: ${to}`);
    return { live: [], queued: [to] };
  }
  /** Results of recent sends by dedupe key (see SendArgs.dedupeKey), so a retry is not sent twice. */
  sentByKey = /* @__PURE__ */ new Map();
  sendingByKey = /* @__PURE__ */ new Map();
  async onSend(conn, args) {
    const sender = this.requirePeer(conn);
    const key = typeof args.dedupeKey === "string" && args.dedupeKey ? `${sender.id}:${args.dedupeKey}` : null;
    const seen = key ? this.sentByKey.get(key) : void 0;
    if (seen) return seen.result;
    const inFlight = key ? this.sendingByKey.get(key) : void 0;
    if (inFlight) return inFlight;
    const sending = this.routeSend(conn, sender, args);
    if (key) this.sendingByKey.set(key, sending);
    let result;
    try {
      result = await sending;
    } finally {
      if (key) this.sendingByKey.delete(key);
    }
    if (key) {
      const now = this.now();
      this.sentByKey.set(key, { at: now, result });
      for (const [k, v] of this.sentByKey) {
        if (now - v.at < DEDUPE_KEEP_MS && this.sentByKey.size <= DEDUPE_MAX) break;
        this.sentByKey.delete(k);
      }
    }
    return result;
  }
  /** Reverse permissions use the current durable record, not stale runner registration. */
  replyRestriction(sender, name2) {
    const jobs = this.storedJobs(), peer = this.connByName(name2)?.peer;
    const stored = jobs.find((j) => j.name === name2);
    if (!stored && !peer?.jobAgent) return null;
    const job = stored ?? {
      id: peer.id.replace(/^job:/, ""),
      name: name2,
      owner: peer.jobParent,
      supervisor: peer.jobOwner,
      rootName: peer.rootName,
      parentJob: peer.parentJob,
      workdir: peer.cwd,
      args: { send_to: peer.jobSendTo }
    };
    const recipient = { ...peer, id: `job:${job.id}`, name: name2, jobOwner: typeof job.supervisor === "string" ? job.supervisor : peer?.jobOwner };
    const grants = isRecord(job.args) && Array.isArray(job.args.send_to) ? job.args.send_to : [];
    if (sender.name === name2 || grants.includes(sender.name) || this.groups.canControl(sender, job, this.localPeers()) || sender.jobAgent && (this.sameJobFamily(recipient, sender, jobs) || this.sharedJobs(recipient, sender, jobs))) return null;
    return { name: name2, supervisor: this.jobRecipient(job) || peer?.jobParent || "the project's main session" };
  }
  async routeSend(conn, sender, args) {
    const body = typeof args.body === "string" ? args.body : "";
    if (!body.trim()) throw new BridgeError("bad_request", "message body is empty");
    if (body.length > MAX_BODY_CHARS) throw new BridgeError("too_large", `message body exceeds ${MAX_BODY_CHARS} characters`);
    let to = String(args.to ?? "").trim();
    if (!to) throw new BridgeError("bad_request", "missing target");
    const own = sender.jobAgent ? this.storedJobs().find((j) => `job:${j.id}` === sender.id) : void 0;
    const supervisorMail = Boolean(own && (to === sender.jobParent || mastersFor(own).includes(to)));
    if (own) {
      if (to === sender.jobParent || mastersFor(own).includes(to)) to = this.jobRecipient(own);
      else if (Array.isArray(own.ownershipHistory) && own.ownershipHistory.some((h) => isRecord(h) && h.fromRootName === to)) to = String(own.rootName);
      this.refreshJobPeer(own);
    }
    const controlled = this.storedJobs().find((j) => j.name === to);
    if (args.conversationId?.startsWith(CONTROL_CONVERSATION_PREFIX) && controlled && !this.groups.canControl(sender, controlled, this.localPeers())) {
      throw new BridgeError("unauthorized", "Only the current supervisor can control this job runner.");
    }
    let conversationId = args.conversationId?.trim() || "";
    let hop = 0;
    const replyTo = args.replyTo?.trim() || null;
    if (replyTo) {
      const parent = this.store.byId(replyTo);
      if (parent) {
        hop = parent.hop + 1;
        conversationId ||= parent.conversationId;
      } else {
        this.log.debug("replyTo refers to an unknown message", { replyTo });
      }
    }
    conversationId ||= randomUUID8();
    if (own && (to === own.rootName || to === own.owner || this.groups.members(own, this.localPeers()).some((p) => p.name === to) || mastersFor(own).includes(to))) conversationId = this.jobConversation(own, to, conversationId);
    const id = sender.jobAgent && args.dedupeKey?.startsWith(COMPLETION_DEDUPE_PREFIX) ? completionMessageId(sender.id, args.dedupeKey.slice(COMPLETION_DEDUPE_PREFIX.length)) : randomUUID8();
    const createdAt = this.now();
    const base2 = {
      id,
      // A job runner speaks for its job: from the subagent's agent, like a job run inside the session's server.
      from: { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent },
      to,
      conversationId,
      replyTo,
      hop,
      body,
      createdAt,
      readAt: null
    };
    if (to.includes("/")) {
      const result2 = await this.requireNetwork().send({ ...base2, recipient: to });
      for (const message of result2.messages) await this.store.retryWrite(() => this.store.insert(message));
      return result2;
    }
    const remoteTargets = to === BROADCAST ? this.network?.peers().filter((p) => !p.jobAgent).map((p) => p.name) ?? [] : [];
    let { live, queued } = this.resolveTargets(to, sender);
    if (own && to === this.jobRecipient(own)) {
      for (let i = live.length - 1; i >= 0; i--) {
        if (live[i].peer?.unavailable) queued.push(live.splice(i, 1)[0].peer.name);
      }
    }
    if (conversationId.startsWith(SIBLING_CONVERSATION_PREFIX) && (queued.some((name2) => !sender.jobAgent || !this.storedSiblings(sender).some((s) => s.name === name2)) || live.some((c) => c.peer.jobAgent && (!sender.jobAgent || !sender.jobOwner || !this.sameJobFamily(sender, c.peer) && !this.sharedJobs(sender, c.peer) && !sender.jobSendTo?.includes(c.peer.name))))) {
      throw new BridgeError("unauthorized", "sibling chat requires the same supervisor or an explicit send_to job grant");
    }
    let replyRestrictions = conversationId.startsWith(CONTROL_CONVERSATION_PREFIX) ? [] : [...live.map((c) => c.peer.name), ...queued].flatMap((name2) => {
      const restriction = this.replyRestriction(sender, name2);
      return restriction ? [restriction] : [];
    });
    const envelope = (recipient) => {
      const restriction = replyRestrictions.find((r) => r.name === recipient);
      return { ...base2, recipient, body: restriction ? base2.body + `

[agent-bridge routing hint: this sender can't receive your direct reply; answer via your supervisor ${restriction.supervisor} if needed.]` : base2.body };
    };
    const messages = [];
    let inserted = true;
    if (supervisorMail) {
      await this.store.retryWrite(() => {
        const current = this.storedJobs().find((job) => `job:${job.id}` === sender.id);
        if (!current) throw new BridgeError("unauthorized", "Job ownership is unavailable.");
        this.refreshJobPeer(current);
        to = this.jobRecipient(current);
        ({ live, queued } = this.resolveTargets(to, sender));
        for (let i = live.length - 1; i >= 0; i--) {
          if (live[i].peer?.unavailable) queued.push(live.splice(i, 1)[0].peer.name);
        }
        const recipient = live[0]?.peer.name ?? queued[0];
        const restriction = this.replyRestriction(sender, recipient);
        replyRestrictions = restriction ? [restriction] : [];
        const message = { ...envelope(recipient), to, conversationId: this.jobConversation(current, to, base2.conversationId) };
        inserted = this.store.insertJobDelivery(message);
        messages.splice(0, messages.length, message);
      });
    } else {
      for (const c of live) messages.push(envelope(c.peer.name));
      for (const key of queued) messages.push(envelope(key));
      for (const m of messages) await this.store.retryWrite(() => this.store.insert(m));
    }
    if (inserted) live.forEach((c, i) => this.emit(c, "message", messages[i]));
    this.log.info("message routed", {
      id,
      from: sender.name,
      to,
      hop,
      deliveredTo: live.map((c) => c.peer.name),
      queuedFor: queued
    });
    const result = { messages, deliveredTo: live.map((c) => c.peer.name), queuedFor: queued, recipientStates: live.map((c) => ({ name: c.peer.name, activity: c.peer.activity, autoWake: c.peer.autoWake, wakeOnDirect: c.peer.wakeOnDirect, wakeAvailable: c.peer.wakeAvailable, wakeMaxHops: c.peer.wakeMaxHops })) };
    if (replyRestrictions.length) result.replyRestrictions = replyRestrictions;
    for (const recipient of remoteTargets) {
      try {
        const remote = await this.requireNetwork().send({ ...base2, recipient });
        for (const message of remote.messages) await this.store.retryWrite(() => this.store.insert(message));
        result.messages.push(...remote.messages);
        result.deliveredTo.push(...remote.deliveredTo);
        result.queuedFor.push(...remote.queuedFor);
        result.recipientStates.push(...remote.recipientStates ?? []);
      } catch (err) {
        const message = { ...base2, recipient };
        await this.store.retryWrite(() => this.store.insert(message));
        result.messages.push(message);
        (result.failedFor ??= []).push({ name: recipient, reason: err.message });
        this.log.warn("broadcast recipient delivery failed", { id, recipient, err: String(err) });
      }
    }
    return result;
  }
  /** A pending response is one frame, unlike streamed replay events. Bound it by bytes as well as rows. */
  pendingMail(recipient, limit) {
    const result = [];
    let bytes = 1024;
    for (const message of this.unreadMail(recipient, limit)) {
      const size = Buffer.byteLength(JSON.stringify(message)) + 1;
      if (bytes + size > MAX_FRAME_BYTES) break;
      result.push(message);
      bytes += size;
    }
    return result;
  }
  unreadMail(recipient, limit) {
    const messages = this.store.unread(recipient, limit);
    if (!this.jobsPath) return messages;
    const noteSenders = new Set(messages.filter((m) => !isQuietMessage(m) && m.conversationId.endsWith(SIBLING_NOTE_SUFFIX)).map((m) => m.from.id));
    if (!noteSenders.size) return messages;
    const finished = new Set(this.storedJobs().filter((j) => noteSenders.has(`job:${j.id}`) && j.status && j.status !== "running" && (!primaryFor(j) || !j.projectRoot && !j.deliveryHistory && !j.ownershipHistory && !this.groups.jobRoot(j, this.localPeers()))).map((j) => `job:${j.id}`));
    const obsolete = messages.filter((m) => !isQuietMessage(m) && m.conversationId.endsWith(SIBLING_NOTE_SUFFIX) && finished.has(m.from.id));
    this.store.markRead(recipient, obsolete.map((m) => m.id), this.now());
    return messages.filter((m) => !obsolete.includes(m));
  }
  remoteReceipt(id, sender, recipient) {
    const message = this.store.byId(id);
    if (!message || message.from.id !== sender) throw new BridgeError("unauthorized", "receipt is only available to the sender");
    const receipts = this.store.receipts(id);
    const receipt = recipient ? receipts.find((r) => r.recipient === recipient) : receipts[0];
    const addressedAlias = recipient && message.to !== BROADCAST && message.to.split("/").at(-1) === recipient;
    return (receipt ?? (addressedAlias ? receipts.find((r) => r.recipient === message.recipient) : void 0))?.readAt ?? null;
  }
  async messageReceipt(conn, id) {
    const sender = this.requirePeer(conn);
    const message = this.store.byId(external_exports.uuid().parse(id));
    if (!message || message.from.name !== sender.name) throw new BridgeError("unauthorized", "receipt is only available to the sender");
    const receipts = this.store.receipts(id);
    return Promise.all(receipts.map(async (r) => r.recipient.includes("/") ? { ...r, readAt: await this.requireNetwork().receipt(
      r.recipient,
      id,
      message.from.id,
      receipts.filter((other) => other.recipient.startsWith(`${r.recipient.split("/")[0]}/`)).length > 1
    ) } : r));
  }
  requireNetwork() {
    if (!this.network) throw new BridgeError("bad_request", "networking is disabled or unavailable; enable it and restart the broker");
    return this.network;
  }
  async onSendFiles(conn, args) {
    const sender = this.requirePeer(conn);
    const parsed = external_exports.object({ to: external_exports.string().min(1).max(MAX_FILE_ADDRESS_CHARS), paths: external_exports.array(external_exports.string().min(1).max(MAX_FILE_PATH_CHARS)).min(1).max(MAX_STREAM_ENTRIES) }).parse(args);
    const remote = parsed.to.includes("/");
    if (remote) return this.requireNetwork().startFiles(parsed.to, parsed.paths, sender.cwd, { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent });
    const target = parsed.to;
    const transfer = collectTransfer(parsed.paths, sender.cwd, target, { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent });
    if (!this.connByName(target)) throw new BridgeError("unknown_target", "file recipient must be online");
    const home = this.networking?.home;
    if (!home) throw new BridgeError("bad_request", "file inbox home is unavailable");
    const result = receiveTransfer(home, transfer);
    this.receiveRemote({ id: transfer.id, from: transfer.from, to: target, recipient: target, conversationId: transfer.id, replyTo: null, hop: 0, body: `Received ${result.files} files (${result.bytes} bytes) in ${result.inbox}`, createdAt: this.now(), readAt: null });
    return result;
  }
  receiveRemote(message) {
    const target = this.recipientConn(message.recipient);
    if (target?.peer) message = { ...message, recipient: target.peer.name };
    const existing = this.store.byId(message.id);
    if (existing) {
      const broadcastCopy = existing.to === BROADCAST && message.to === BROADCAST;
      if (existing.from.id !== message.from.id || !broadcastCopy && existing.recipient !== message.recipient || existing.to !== message.to || existing.body !== message.body || existing.conversationId !== message.conversationId || existing.replyTo !== message.replyTo || existing.hop !== message.hop) throw new BridgeError("bad_request", "message id already used");
      if (this.store.receipts(message.id).some((r) => r.recipient === message.recipient)) return { delivered: Boolean(target), recipient: message.recipient };
    }
    this.store.insert(message);
    if (target) this.emit(target, "message", message);
    return { delivered: Boolean(target), recipient: message.recipient };
  }
};

// src/core/process-identity.ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
var exec = promisify(execFile);
var parentIdentity;
function parentProcessIdentity() {
  return parentIdentity ??= processIdentity(process.ppid);
}
async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return start ? `${boot.trim()}:${start}` : null;
    }
    const { stdout } = process.platform === "win32" ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: 5e3 }) : await exec("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5e3, env: { ...process.env, LC_ALL: "C" } });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// src/core/job-control.ts
import { randomUUID as randomUUID9 } from "node:crypto";
var DASHBOARD_JOB_CONVERSATION = "jobctl-dashboard";
var CONTROL_TIMEOUT_MS = 1e4;
var JobControlError = class extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
  reason;
};
async function controlDashboardJob(node, owner, job, command) {
  if (!(await node.peers()).some((p) => p.name === owner)) throw new JobControlError("The owning session is not connected. Reopen it to continue this subagent.", "offline");
  const requestId = randomUUID9();
  let receive;
  let timer;
  const reply2 = new Promise((resolve4, reject) => {
    receive = (m) => {
      if (m.from.name !== owner) return;
      try {
        const result = JSON.parse(m.body);
        if (result.type === "result" && result.requestId === requestId && typeof result.text === "string" && typeof result.outcome === "string" && typeof result.isError === "boolean") resolve4(result);
      } catch {
      }
    };
    node.on("job_control", receive);
    timer = setTimeout(() => reject(new JobControlError("The owning session did not confirm delivery. Check its chat before sending again.", "timeout")), CONTROL_TIMEOUT_MS);
  });
  reply2.catch(() => {
  });
  try {
    await node.send({ to: owner, body: JSON.stringify({ ...command, requestId, job }), conversationId: DASHBOARD_JOB_CONVERSATION }, { quiet: true });
    return await reply2;
  } finally {
    clearTimeout(timer);
    node.off("job_control", receive);
  }
}

// src/core/node.ts
var QUESTION_ID_MEMORY = 2e3;
var jitter = () => ELECTION_RETRY_MIN_MS + Math.floor(Math.random() * (ELECTION_RETRY_MAX_MS - ELECTION_RETRY_MIN_MS));
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function errCode(err) {
  return String(err?.code ?? "");
}
var BridgeNode = class extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.id = opts.id ?? randomUUID10();
    this.currentName = opts.name;
    this.currentCwd = opts.cwd;
    this.autoWake = opts.autoWake;
    this.log = opts.log.child("node");
    if (opts.dbPath !== ":memory:") recordStorePeer(dirname4(opts.dbPath), { pid: process.pid, name: opts.name, version: APP_VERSION, storeCapabilities: { json: JSON_STORE_VERSION, sqlite: SQLITE_STORE_VERSION } });
    this.readJournal = new ReadJournal(dirname4(opts.dbPath));
    this.restoreReadState(`name:${this.currentName}`);
  }
  opts;
  id;
  client = null;
  broker = null;
  stopping = false;
  /** The bridge gave this session to another server of it (see reclaim). */
  replaced = false;
  electing = null;
  reconnectTimer = null;
  reconnectDelay = RECONNECT_BACKOFF_MIN_MS;
  currentName;
  inbox = /* @__PURE__ */ new Map();
  readIds = /* @__PURE__ */ new Set();
  readJournal;
  unflushedAcks = /* @__PURE__ */ new Set();
  pendingAcks = /* @__PURE__ */ new Set();
  pendingRefreshTimer = null;
  refreshingPending = null;
  ackFlushScheduled = false;
  sessionId = null;
  autoWake;
  wakeOnDirect = false;
  wakeAvailable = false;
  wakeMaxHops = DEFAULT_MAX_HOPS;
  currentCwd;
  lastSent = 0;
  /** Ids of messages this peer sent as new questions (not replies); replies to them are awaited. */
  asked = /* @__PURE__ */ new Set();
  notificationMatch = () => false;
  notificationConsumed = () => {
  };
  activity = null;
  unavailable = false;
  log;
  get name() {
    return this.currentName;
  }
  get isBroker() {
    return this.broker !== null;
  }
  get isConnected() {
    return this.client !== null && !this.client.isClosed;
  }
  get autoWakeEnabled() {
    return this.autoWake;
  }
  async start() {
    await this.ensureConnected();
  }
  /** Take over unread mail sent to "-N" stand-in names of this session (see the broker's claimMail). */
  async claimMail(names) {
    if (!names.length || !this.isConnected) return 0;
    return (await this.client.request("claimMail", { names })).moved;
  }
  get wasReplaced() {
    return this.replaced;
  }
  /**
   * The session still calls this server (hooks, tools) after the bridge replaced it: Claude Code can start a
   * stale server of an older plugin version next to the current one on /reload-plugins, and whichever connects
   * last wins. The server the session really uses takes its place back; the stale one, never called, stays out.
   */
  async reclaim() {
    if (!this.replaced) return;
    this.replaced = false;
    this.stopping = false;
    this.log.info("the session still uses this server: taking its place back on the bridge");
    await this.ensureConnected();
    this.emit("reclaimed");
  }
  async stop(closeBroker = true) {
    this.stopping = true;
    this.emit("stopped");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pendingRefreshTimer) clearTimeout(this.pendingRefreshTimer);
    this.pendingRefreshTimer = null;
    this.client?.close();
    this.client = null;
    if (closeBroker) {
      if (this.broker) await this.broker.close();
      this.broker = null;
    }
    this.log.info("bridge node stopped");
  }
  /**
   * Connects (electing a broker if needed). Concurrent callers share one attempt. When it fails, the
   * node keeps retrying in the background (see scheduleReconnect) instead of staying disconnected.
   */
  ensureConnected() {
    if (isPluginCacheCwd(this.currentCwd)) return Promise.reject(new BridgeError("bad_request", "Project directory is still a plugin cache; waiting for the host's project directory."));
    if (this.isConnected) return Promise.resolve();
    this.electing ??= this.elect().catch((err) => {
      this.scheduleReconnect(this.nextBackoff());
      throw err;
    }).finally(() => {
      this.electing = null;
    });
    return this.electing;
  }
  /** Doubling delay for background retries, capped; reset once connected. */
  nextBackoff() {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_BACKOFF_MAX_MS);
    return delay;
  }
  /**
   * Retry the election later until connected or stopped. Also after "unauthorized" / "protocol_mismatch":
   * the incompatible broker may exit (e.g. after an update) and this node then takes over.
   */
  scheduleReconnect(delayMs) {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping || this.isConnected) return;
      this.ensureConnected().catch((err) => this.log.warn("re-election failed; retrying with backoff", { err: err.message }));
    }, delayMs);
    this.reconnectTimer.unref();
  }
  async elect() {
    for (let attempt = 1; attempt <= ELECTION_MAX_ATTEMPTS && !this.stopping; attempt++) {
      try {
        const client = await BridgeClient.connect(this.opts.pipePath, this.log.child("client"));
        await this.adopt(client);
        return;
      } catch (err) {
        if (err instanceof BridgeError && (err.code === "unauthorized" || err.code === "protocol_mismatch")) {
          this.log.error("broker refused this peer", { code: err.code, message: err.message });
          throw err;
        }
        const code = errCode(err);
        this.log.debug("connect attempt failed", { attempt, code, message: err.message });
        if (code !== "ENOENT" && code !== "ECONNREFUSED") {
          await sleep(jitter());
          continue;
        }
      }
      if (this.opts.canHostBroker !== false && await this.tryBecomeBroker()) continue;
      await sleep(jitter());
    }
    throw new Error(`could not connect to or start the agent-bridge broker at ${this.opts.pipePath}`);
  }
  async tryBecomeBroker() {
    if (this.broker) return true;
    let store;
    try {
      store = new MessageStore(this.opts.dbPath, this.log.child("store"));
    } catch (err) {
      if (["EBUSY", "SQLITE_BUSY", "STORE_UPGRADE_DEFERRED"].includes(errCode(err)) || /database is locked/.test(String(err.message))) {
        this.log.info("another session is preparing the store; retrying broker election", { db: this.opts.dbPath });
        return false;
      }
      this.log.error("cannot open message store", { err, db: this.opts.dbPath });
      throw err;
    }
    const broker = new Broker(this.opts.pipePath, store, this.log.child("broker"), this.opts.token, Date.now, join9(dirname4(this.opts.dbPath), JOBS_FILE), this.opts.network);
    try {
      await broker.listen();
      this.broker = broker;
      this.log.info("became broker", { pipe: this.opts.pipePath });
      return true;
    } catch (err) {
      store.close();
      const code = errCode(err);
      if (code === "EADDRINUSE" && (this.opts.platform ?? process.platform) !== "win32") {
        try {
          await BridgeClient.connect(this.opts.pipePath, this.log).then((c) => c.close());
          return false;
        } catch (probeErr) {
          if (errCode(probeErr) === "ECONNREFUSED") {
            this.log.warn("removing stale broker socket", { pipe: this.opts.pipePath });
            try {
              unlinkSync(this.opts.pipePath);
            } catch {
            }
          }
        }
      } else {
        this.log.debug("could not become broker", { code });
      }
      return false;
    }
  }
  async adopt(client) {
    client.on("event", (ev, data) => this.onEvent(ev, data));
    try {
      await client.request("auth", { protocol: PROTOCOL_VERSION, token: this.opts.token });
      if (this.opts.dbPath !== ":memory:") for (const peer of await client.request("peers", {})) recordStorePeer(dirname4(this.opts.dbPath), peer);
    } catch (error) {
      client.close();
      throw error;
    }
    const agentStartedAt = this.opts.jobAgent ? null : await parentProcessIdentity();
    const args = this.helloArgs();
    const hello = await client.request("hello", { ...args, peer: { ...args.peer, agentStartedAt } }).catch((err) => {
      client.close();
      throw err;
    });
    this.afterHello(client, hello);
  }
  helloArgs() {
    return {
      protocol: PROTOCOL_VERSION,
      token: this.opts.token,
      peer: {
        id: this.id,
        name: this.currentName,
        agent: this.opts.agent,
        cwd: this.currentCwd,
        pid: process.pid,
        agentPid: process.ppid ?? null,
        sessionId: this.sessionId,
        startedAt: Date.now(),
        autoWake: this.autoWake,
        wakeOnDirect: this.wakeOnDirect,
        wakeAvailable: this.wakeAvailable,
        wakeMaxHops: this.wakeMaxHops,
        activity: this.activity,
        unavailable: this.unavailable,
        version: APP_VERSION,
        storeCapabilities: { json: JSON_STORE_VERSION, sqlite: SQLITE_STORE_VERSION },
        ...this.opts.jobAgent ? { jobAgent: this.opts.jobAgent } : {},
        ...this.opts.jobOwner ? { jobOwner: this.opts.jobOwner, jobParent: this.opts.jobParent, parentJob: this.opts.parentJob, rootSession: this.opts.rootSession, rootName: this.opts.rootName, jobTitle: this.opts.jobTitle, jobSendTo: this.opts.jobSendTo } : {}
      }
    };
  }
  afterHello(client, hello) {
    this.client = client;
    this.currentName = hello.name;
    if (!this.sessionId && hello.sessionId) {
      this.sessionId = hello.sessionId;
      this.restoreReadState(`session:${this.sessionId}`);
    }
    this.restoreReadState(`name:${this.currentName}`);
    this.reconnectDelay = RECONNECT_BACKOFF_MIN_MS;
    client.once("close", () => this.onClose(client));
    if (this.unflushedAcks.size > 0) {
      this.acknowledge([...this.unflushedAcks]);
    }
    this.log.info("connected to broker", { name: hello.name, brokerPid: hello.brokerPid, isBroker: this.isBroker });
    this.emit("connected", { name: hello.name, isBroker: this.isBroker });
    this.schedulePendingRefresh();
  }
  onClose(client) {
    if (this.client !== client) return;
    this.client = null;
    if (this.stopping) return;
    this.log.warn("lost connection to broker; re-electing");
    this.emit("disconnected");
    this.scheduleReconnect(jitter());
  }
  onEvent(ev, data) {
    if (ev === "mail_retracted") {
      for (const id of data.ids) this.inbox.delete(id);
    } else if (ev === "shared_job_control") {
      this.emit("shared_job_control", data);
    } else if (ev === "jobs_changed") {
      const ids = new Set(data.withdrawn.map((id) => `job:${id}`));
      for (const [id, m] of this.inbox) if (ids.has(m.from.id)) this.inbox.delete(id);
      this.emit("jobs_changed");
    } else if (ev === "inline_job_control") {
      this.emit("inline_job_control", data);
    } else if (ev === "message") {
      const m = data;
      if (this.readIds.has(m.id)) {
        this.acknowledge([m.id]);
        return;
      }
      if (this.inbox.has(m.id)) return;
      this.inbox.set(m.id, m);
      if (m.conversationId === DASHBOARD_JOB_CONVERSATION) {
        this.markRead([m.id]);
        this.emit("job_control", m);
        return;
      }
      this.log.debug("message received", { id: m.id, from: m.from.name, hop: m.hop });
      this.emit("message", m);
    } else if (ev === "peer_joined" || ev === "peer_left") {
      if (ev === "peer_joined" && this.opts.dbPath !== ":memory:") recordStorePeer(dirname4(this.opts.dbPath), data);
      this.emit(ev, data);
    } else if (ev === "replaced") {
      this.log.info("replaced by a newer server of this session; leaving the bridge", { by: data?.by });
      this.replaced = true;
      void this.stop(false).catch((err) => this.log.warn("could not retire replaced connection", { err: String(err) }));
      this.emit("replaced");
    }
  }
  async withClient(fn) {
    await this.ensureConnected();
    return fn(this.client);
  }
  /** quiet: not part of a conversation of this agent (no listen window, replies are not awaited), e.g. control messages to a job runner. */
  send(args, opts = {}) {
    return this.withClient(async (c) => {
      const res = await this.sendRequest(c, "send", { ...args, dedupeKey: args.dedupeKey || randomUUID10() });
      if (opts.quiet) return res;
      this.lastSent = Date.now();
      if (!args.replyTo) for (const m of res.messages) this.asked.add(m.id);
      if (this.asked.size > QUESTION_ID_MEMORY) this.asked.delete(this.asked.values().next().value);
      return res;
    });
  }
  /** A late send response can be recovered from the same broker without sending twice. */
  async sendRequest(client, op, args) {
    try {
      return await client.request(op, args);
    } catch (err) {
      if (err.message !== `broker request timed out: ${op}`) throw err;
      try {
        return await client.request(op, args);
      } catch (retryError) {
        throw new Error(`Delivery is unconfirmed after a timed-out ${op}. Check inbox/history before resending. ${retryError.message}`, { cause: retryError });
      }
    }
  }
  /** A reply to a question this peer asked (so the answer should reach the agent even when it is idle). */
  isAwaitedReply(m) {
    return m.replyTo !== null && this.asked.has(m.replyTo);
  }
  /** When this peer last sent a message (0 = never); marks it as taking part in a conversation. */
  get lastSentAt() {
    return this.lastSent;
  }
  messageReceipt(id) {
    return this.withClient((c) => c.request("messageReceipt", { id }));
  }
  peers() {
    return this.withClient((c) => c.request("peers", {})).then((peers) => peers.filter((p) => !isPluginCacheCwd(p.cwd)));
  }
  brokerLoad() {
    return this.withClient((c) => c.request("brokerLoad", {}));
  }
  projectJobs() {
    return this.withClient((c) => c.request("projectJobs", {}));
  }
  jobRecipient(job) {
    return this.withClient((c) => c.request("jobRecipient", { job }));
  }
  async setUnavailable(unavailable) {
    const peer = await this.withClient((c) => c.request("coordinatorAvailability", { unavailable }));
    this.unavailable = unavailable;
    return peer;
  }
  setProjectMain(to) {
    return this.withClient((c) => c.request("projectMain", { to }));
  }
  async handoffSubagents(args) {
    return this.withClient(async (c) => {
      for (const m of this.unread()) if (m.from.id.startsWith("job:")) {
        const job = await c.request("jobAuthority", { job: m.from.name });
        if (job && (job.owner === this.name || job.rootName === this.name)) await c.request("inlineJobReport", m);
      }
      return c.request("handoffSubagents", args);
    });
  }
  jobAuthority(job) {
    return this.withClient((c) => c.request("jobAuthority", { job }));
  }
  controlInlineJob(job, control) {
    return this.withClient((c) => c.request("inlineJobControl", { job, control }));
  }
  reportInlineJob(message) {
    return this.withClient((c) => c.request("inlineJobReport", message));
  }
  decide(args) {
    return this.withClient((c) => c.request("decide", args));
  }
  getConversation(args) {
    return this.withClient((c) => c.request("getConversation", args));
  }
  searchHistory(args) {
    return this.withClient((c) => c.request("searchHistory", args));
  }
  reindexHistory(reset = false) {
    return this.withClient((c) => c.request("reindexHistory", { reset }));
  }
  decisions(args = {}) {
    return this.withClient((c) => c.request("decisions", args));
  }
  siblings() {
    return this.withClient((c) => c.request("siblings", {}));
  }
  sendSibling(args, maxHops) {
    return this.withClient((c) => this.sendRequest(c, "sendSibling", { ...args, maxHops, dedupeKey: args.dedupeKey || randomUUID10() }));
  }
  async updateJob(patch) {
    Object.assign(this.opts, patch);
    if (this.isConnected) await this.client.request("updatePeer", patch);
  }
  networkStatus() {
    return this.withClient((c) => c.request("networkStatus", {}));
  }
  remoteJob(host, request) {
    return this.withClient((c) => c.request("remoteJob", { host, request }, REMOTE_JOB_LOCAL_TIMEOUT_MS)).catch((err) => {
      if (/unknown op.*remoteJob/.test(err.message)) throw new BridgeError("bad_request", "Local broker update needed: restart its hosting sessions to enable remote jobs.");
      throw err;
    });
  }
  sendFiles(to, paths) {
    return this.withClient((c) => c.request("sendFiles", { to, paths }));
  }
  fetchFiles(from, paths) {
    return this.withClient((c) => c.request("fetchFiles", { from, paths }));
  }
  cancelTransfer(id) {
    return this.withClient((c) => c.request("cancelTransfer", { id }));
  }
  /** Locally buffered unread messages, oldest first. */
  unread() {
    return [...this.inbox.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  /** A replay is bounded to 500 rows. Active hooks refill after receipts so the tail cannot strand. */
  refreshPending() {
    this.refreshingPending ??= this.readPending().finally(() => {
      this.refreshingPending = null;
    });
    return this.refreshingPending;
  }
  async readPending() {
    if (!this.isConnected) return;
    await Promise.all(this.pendingAcks);
    if (this.unflushedAcks.size) {
      const ids = [...this.unflushedAcks];
      await this.client.request("ack", { ids });
      ids.forEach((id) => this.unflushedAcks.delete(id));
    }
    const messages = await this.client.request("pending", { limit: 500 });
    for (const m of messages) this.onEvent("message", m);
  }
  /** Refill channel/wake consumers too; active hooks are not required to drain a large inbox. */
  schedulePendingRefresh(delayMs = 100) {
    if (this.stopping || this.pendingRefreshTimer) return;
    this.pendingRefreshTimer = setTimeout(() => {
      this.pendingRefreshTimer = null;
      if (!this.isConnected || this.stopping) return;
      void this.refreshPending().catch((err) => {
        this.log.warn("pending recovery deferred", { err: String(err) });
        this.schedulePendingRefresh(1e3);
      });
    }, delayMs);
    this.pendingRefreshTimer.unref();
  }
  /** Look up a message by id: one we still hold, or remembered as read. */
  hasSeen(id) {
    return this.inbox.has(id) || this.readIds.has(id);
  }
  get(id) {
    return this.inbox.get(id);
  }
  /**
   * Put a message into this peer's own inbox without going through the broker, e.g. the result of a
   * background subagent. It is handled exactly like a peer message (hooks, wait_for_message, channel).
   */
  deliverLocal(m) {
    try {
      recordLocalResult(dirname4(this.opts.dbPath), m);
    } catch (err) {
      this.log.warn("could not retain local result receipt", { id: m.id, err: String(err) });
    }
    this.onEvent("message", m);
  }
  /** Mark messages consumed locally and on the broker. */
  markRead(ids) {
    const real = ids.filter((id) => this.inbox.has(id));
    if (!real.length) return;
    this.readJournal.append(`name:${this.currentName}`, real);
    if (this.sessionId) this.readJournal.append(`session:${this.sessionId}`, real);
    const messages = real.map((id) => this.inbox.get(id));
    for (const id of real) {
      this.inbox.delete(id);
      this.readIds.add(id);
    }
    this.acknowledge(real);
    try {
      this.notificationConsumed(messages);
    } catch (err) {
      this.log.warn("could not archive completed notification wait", { err: String(err) });
    }
  }
  setNotificationWaitHandlers(matches, consumed) {
    this.notificationMatch = matches;
    this.notificationConsumed = consumed;
  }
  isNotificationAwaited(m) {
    return this.notificationMatch(m);
  }
  notificationWaitsChanged() {
    this.emit("notification_waits_changed");
  }
  restoreReadState(identity) {
    for (const id of this.readJournal.read(identity)) this.readIds.add(id);
    const consumed = [...this.inbox.keys()].filter((id) => this.readIds.has(id));
    consumed.forEach((id) => this.inbox.delete(id));
    this.acknowledge(consumed);
  }
  acknowledge(ids) {
    if (!ids.length) return;
    ids.forEach((id) => this.unflushedAcks.add(id));
    if (!this.isConnected || this.ackFlushScheduled) return;
    this.ackFlushScheduled = true;
    setImmediate(() => {
      this.ackFlushScheduled = false;
      if (!this.isConnected || !this.unflushedAcks.size) return;
      const batch = [...this.unflushedAcks].slice(0, 500);
      batch.forEach((id) => this.unflushedAcks.delete(id));
      const pending = this.client.request("ack", { ids: batch }).catch((err) => {
        this.log.warn("ack failed; retained for pending recovery", { err: err.message });
        batch.forEach((id) => this.unflushedAcks.add(id));
      });
      this.pendingAcks.add(pending);
      void pending.finally(() => {
        this.pendingAcks.delete(pending);
        this.schedulePendingRefresh();
      });
      if (this.unflushedAcks.size) this.acknowledge([...this.unflushedAcks]);
    });
  }
  /** Resolves with the next unread message (possibly one already waiting), or null on timeout. */
  waitForMessage(timeoutMs, predicate = () => true, signal) {
    if (signal?.aborted) return Promise.resolve(null);
    const existing = this.unread().find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve4) => {
      const done = (m) => {
        clearTimeout(timer);
        this.off("message", onMessage);
        this.off("notification_waits_changed", onChanged);
        this.off("replaced", onAbort);
        this.off("stopped", onAbort);
        signal?.removeEventListener("abort", onAbort);
        resolve4(m);
      };
      const onMessage = (m) => {
        if (predicate(m)) done(m);
      };
      const onAbort = () => done(null);
      const onChanged = () => {
        const m = this.unread().find(predicate);
        if (m) done(m);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      this.on("message", onMessage);
      this.on("notification_waits_changed", onChanged);
      this.once("replaced", onAbort);
      this.once("stopped", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  async setSessionId(sessionId) {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    if (this.isConnected) this.currentName = (await this.client.request("updatePeer", { sessionId })).name;
    if (sessionId) this.restoreReadState(`session:${sessionId}`);
    this.notificationWaitsChanged();
  }
  /** Report busy/idle to the broker so peers can see who is free. Only changes are sent. */
  setActivity(state) {
    if (state === this.activity) return;
    this.activity = state;
    if (this.isConnected) {
      this.client.request("updatePeer", { activity: state }).catch((err) => this.log.debug("activity update failed", { err: err.message }));
    }
  }
  async setWakePolicy(wakeOnDirect, wakeAvailable, wakeMaxHops = DEFAULT_MAX_HOPS) {
    this.wakeOnDirect = wakeOnDirect;
    this.wakeAvailable = wakeAvailable;
    this.wakeMaxHops = wakeMaxHops;
    if (this.isConnected) await this.client.request("updatePeer", { wakeOnDirect, wakeAvailable, wakeMaxHops });
  }
  async setAutoWake(enabled) {
    this.autoWake = enabled;
    if (this.isConnected) await this.client.request("updatePeer", { autoWake: enabled });
  }
  get currentSessionId() {
    return this.sessionId;
  }
  get cwd() {
    return this.currentCwd;
  }
  /**
   * Record the real project directory once the host tells us (hook input carries it). When a new
   * name is given, the peer is renamed as well.
   */
  async relocate(cwd, name2) {
    if (cwd === this.currentCwd && (!name2 || name2 === this.currentName)) return;
    this.currentCwd = cwd;
    if (name2) this.currentName = name2;
    this.log.info("peer relocated", { cwd, name: this.currentName });
    if (this.isConnected) {
      const peer = await this.client.request("updatePeer", { cwd, ...name2 ? { name: name2 } : {} });
      this.currentName = peer.name;
    }
  }
};

// src/mcp/siblings.ts
var SiblingLink = class {
  constructor(node, job, maxHops, log) {
    this.node = node;
    this.job = job;
    this.log = log;
    this.maxHops = siblingMaxHops(maxHops);
    node.on("message", this.receive);
    for (const message of node.unread()) this.receive(message);
  }
  node;
  job;
  log;
  maxHops;
  delivered = /* @__PURE__ */ new Set();
  peers() {
    return this.node.siblings();
  }
  async policy() {
    return { maxHops: this.maxHops, sendTo: Array.isArray(this.job.args?.send_to) ? this.job.args.send_to.filter(isJobSendTarget) : [] };
  }
  send(to, body, replyTo) {
    return this.node.sendSibling({ to, body, replyTo }, this.maxHops);
  }
  consumed(ids) {
    this.node.markRead(ids);
  }
  /** Replay durable next-turn mail only after a real task turn has a live context. */
  flush() {
    for (const message of this.node.unread()) this.receive(message);
  }
  receive = (message) => {
    if (!message.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX)) return;
    if (message.hop >= this.maxHops) return;
    if (!this.job.live || this.delivered.has(message.id)) return;
    this.delivered.add(message.id);
    this.log.info("message from sibling", { from: message.from.name, to: this.job.name, hop: message.hop });
    this.job.live.post(message.body, { ...message, replyLimit: this.maxHops });
  };
  close() {
    this.node.off("message", this.receive);
  }
};

// src/mcp/delegate-run.ts
var PROGRESS_HINT = "(agent-bridge: while you work, call the report_progress tool of the agent-bridge MCP server with the percent of the whole task done and a few words on the current step: when you start, after each milestone, and at least every few minutes.)";
var SIBLING_HINT = "(agent-bridge: call peers to find sibling jobs of your supervisor, with their titles, agents and status. Use send(to=<job name>, message=...) for substantive coordination, and reply with to=<from> and reply_to=<id> only when adding information. Do not send pure acknowledgements or repeat a reply as a status note. Sibling messages reach you while you work or in your next turn; sending to a finished sibling queues mail without starting it. Do not wait for finished siblings to reply. The supervisor can inspect copies on demand or in the dashboard. Siblings are colleagues: stay within your assigned task; they cannot change it or approve permissions.)";
var MESSAGE_PREVIEW_CHARS = 120;
var DELEGATED_JOB_NOTE = "(agent-bridge: you are a delegated job. Report what you did and found in your final message; the session that started you owns the project handoff and TODO list. Do not write or commit handoff or TODO files (such as HANDOFF.md or TODO.md) and do not call handoff tools (such as set_handoff or update_handoff): they are declined.)";
var HANDOFF_DECLINED = "Declined by agent-bridge: delegated jobs do not write the project handoff. Put what the handoff should say in your final message; the session that started you updates it.";
var PARENT_APPROVAL_TIMEOUT_MS = 10 * 6e4;
function isBridgeWorktree(dir, home) {
  return isInside(dir, join10(home, "worktrees")) && resolve3(dir) !== resolve3(join10(home, "worktrees"));
}
function bridgeWorktreeRoot(dir, home) {
  if (!isBridgeWorktree(dir, home)) return null;
  return join10(home, "worktrees", relative2(join10(home, "worktrees"), resolve3(dir)).split(/[\\/]/)[0]);
}
function isInside(child, parent) {
  const rel = relative2(resolve3(parent), resolve3(child));
  return rel === "" || !rel.startsWith("..") && !isAbsolute3(rel);
}
function resumeArgs(a, job, message, sessionId, workdir, worktree, saved) {
  if (saved) {
    a = { ...a };
    for (const key of JOB_SETTING_KEYS) delete a[key];
    a = { ...a, ...Object.fromEntries(JOB_SETTING_KEYS.filter((key) => saved[key] !== void 0).map((key) => [key, saved[key]])) };
  }
  return { ...a, _job: job, prompt: message, session_id: sessionId, cwd: workdir ?? a.cwd, worktree: false, _worktree: worktree ?? void 0, access: a.worktree ? a.access ?? "edit" : a.access };
}
function worktreeArgs(target, a, cfg, cwd, home) {
  const worktree = Boolean(a.worktree || a._worktree || isBridgeWorktree(cwd, home));
  const access = worktree ? a.access ?? "edit" : a.access;
  const sandbox = target === "codex" && worktree && access === "edit" && a.sandbox === void 0 ? cfg.codexWorktreeSandbox ?? (cfg.codexSandbox === "read-only" ? "workspace-write" : cfg.codexSandbox) : a.sandbox;
  return { ...a, access, ...sandbox !== void 0 ? { sandbox } : {} };
}
async function runDelegate(rc, target, a, signal, onProgress, background, job) {
  checkDepth(rc.cfg.maxDelegateDepth);
  if (!job?.rootSession) return runWithWorktreeLease(rc, target, a, signal, onProgress, background, job);
  const budget = new RootConcurrency(rc.home, job.rootSession);
  const owner = { id: `${job.name}-${randomUUID11()}`, pid: process.pid };
  let timer;
  try {
    if (!job.parentJob) budget.ensureLimit(rc.cfg.maxJobs);
    if (!budget.acquire(owner)) throw new Error("The top session's subagent concurrency limit is reached.");
    timer = setInterval(() => {
      try {
        budget.renew(owner);
      } catch (err) {
        rc.log.warn("could not renew root concurrency lease", { err: String(err) });
      }
    }, SLOT_RENEW_MS);
    timer.unref();
    return await runWithWorktreeLease(rc, target, a, signal, onProgress, background, job);
  } finally {
    clearInterval(timer);
    budget.release(owner);
    budget.close();
  }
}
async function runWithWorktreeLease(rc, target, a, signal, onProgress, background, job) {
  const wt = a._worktree ?? (a.worktree ? await createWorktree({ cwd: a.cwd || rc.cwd(), home: rc.home, jobId: randomUUID11().slice(0, 8), log: rc.log }) : null);
  const root = wt?.path ?? bridgeWorktreeRoot(a.cwd || rc.cwd(), rc.home);
  if (!root) return runDelegateInner(rc, target, a, signal, onProgress, background, job);
  const release = worktreeLease(rc.home, { path: root });
  try {
    if (wt) {
      if (!a._worktree) await recordWorktreeOrigin(rc.home, wt, rc.log);
      else await prepareWorktreeContinuation(rc.home, wt, rc.log);
    } else {
      assertPhysicalPath(root);
      invalidateWorktreePathProof(rc.home, root);
    }
    return await runDelegateInner(rc, target, wt ? { ...a, _worktree: wt } : a, signal, onProgress, background, job);
  } finally {
    release();
  }
}
async function runDelegateInner(rc, target, a, signal, onProgress, background, job) {
  const { cfg, log } = rc;
  const profile = DELEGATION_TARGETS[target];
  const defaultModel = profile.defaultModel(cfg);
  const dlog = log.child("delegate");
  const cwd = a.cwd || rc.cwd();
  a = worktreeArgs(target, a, cfg, cwd, rc.home);
  const access = a.access;
  const wt = a._worktree ?? (a.worktree ? await createWorktree({ cwd, home: rc.home, jobId: randomUUID11().slice(0, 8), log: dlog }) : null);
  const workdir = wt?.cwd ?? cwd;
  const linkRoot = wt?.path ?? bridgeWorktreeRoot(workdir, rc.home);
  const watchChanges = !wt && (access === "edit" || access === "ask" && target === "codex");
  const before = watchChanges ? await gitChangeSnapshot(workdir, dlog) : null;
  let relay = null;
  let wiring;
  const asked = [];
  let relayCalls = 0;
  const codexHash = target === "codex" ? codexPermissionHookHash() : null;
  const journalPermission = async (request, decide) => {
    const id = randomUUID11();
    const context = { kind: "approval", agent: target, project: workdir, job: job?.name ?? a._job, session: job?.sessionId ?? void 0 };
    await appendContextEvent(rc.home, { ...context, payload: { id, stage: "request", request } });
    const decision = await decide();
    await appendContextEvent(rc.home, { ...context, payload: { id, stage: "decision", decision } });
    return decision;
  };
  const askUser = rc.askUser ? async (r) => {
    if (!job) return rc.askUser(r);
    if (rc.jobs && (job.ownershipHistory?.length && job.owner !== rc.me() || rc.jobs.recipient && await rc.jobs.recipient(job) !== rc.me())) {
      const answer = await rc.jobs.askParent(job, `${r.tool}: ${r.detail}`, PARENT_APPROVAL_TIMEOUT_MS, r);
      return answer.allow ? { allow: true } : { allow: false, message: answer.reason };
    }
    const decision = await waitForApproval(
      job,
      `${r.tool}: ${r.detail}`,
      PARENT_APPROVAL_TIMEOUT_MS,
      (body) => rc.jobs?.fromSubagent(job, body, null),
      dlog,
      rc.home,
      r,
      () => rc.askUser(r)
    );
    return decision.allow ? { allow: true } : { allow: false, message: decision.reason.replace(/^deny:\s*/, "") };
  } : void 0;
  try {
    if (access === "ask" && askUser) {
      const decide = async (r) => journalPermission(r, async () => {
        relayCalls++;
        const d = await askUser(r);
        asked.push(`${d.allow ? "allowed" : "denied"}: ${r.tool} ${r.detail.slice(0, 80)}`);
        return d;
      });
      relay = new PermissionRelay(decide, dlog);
      await relay.start();
      wiring = { onPermission: decide, env: relay.childEnv(), codexHookTrusted: codexPermissionHookTrusted(rc.home) };
    }
  } catch (err) {
    await relay?.stop();
    throw err;
  }
  const forwarding = access === "ask" && supportsAsk(target, wiring);
  const me = rc.me();
  const allowedServers = job ? job.allowedServers ??= /* @__PURE__ */ new Set() : /* @__PURE__ */ new Set();
  const autoApprove = [...cfg.autoApproveTools, ...access === "read" ? DESK_READ_PATTERNS : [], ...a.allow_tools ?? []];
  const approve = async (r) => journalPermission(r, async () => {
    if (isHandoffToolCall(r)) {
      asked.push(`declined (handoff tool): ${r.tool} ${r.detail.slice(0, 80)}`);
      return { allow: false, message: HANDOFF_DECLINED };
    }
    if (!r.automaticReview && r.tool.startsWith("mcp:") && allowedServers.has(r.tool)) return { allow: true };
    if (!r.automaticReview && (isOwnServerCall(r) || isAutoApproved(r, autoApprove))) return { allow: true };
    let d;
    if (wiring) d = await wiring.onPermission(r);
    else if (job && (!job.foreground || job.parentJob || job.ownershipHistory?.length) && rc.jobs) {
      const hint = approvalHint(r);
      const a2 = await rc.jobs.askParent(job, `${r.tool.replace(/^mcp:/, "MCP server ")}: ${r.detail}${hint}`, PARENT_APPROVAL_TIMEOUT_MS, r);
      d = a2.allow ? { allow: true } : { allow: false, message: `Denied by supervisor ${me}: ${a2.reason || "no reason supplied"}` };
      asked.push(`${d.allow ? "allowed" : "denied"} by ${me}: ${r.tool} ${r.detail.slice(0, 80)}`);
    } else if (askUser) {
      relayCalls++;
      d = await askUser(r);
      asked.push(`${d.allow ? "allowed" : "denied"}: ${r.tool} ${r.detail.slice(0, 80)}`);
    } else d = r.tool.startsWith("mcp:") && access === "edit" ? { allow: true } : { allow: false, message: "No one to ask in this session." };
    if (d.allow && !r.automaticReview && r.tool.startsWith("mcp:")) allowedServers.add(r.tool);
    return d;
  });
  let feed;
  try {
    feed = startRunFeed({
      home: rc.home,
      name: `${target}-${randomUUID11().slice(0, 8)}`,
      header: `${target}${a.model ? ` (${a.model}${a.effort ? `, effort ${a.effort}` : ""})` : a.effort ? ` (effort ${a.effort})` : ""} in ${workdir}, access ${access ?? "default"}, by ${me}${a.session_id ? `, continues ${a.session_id}` : ""}
${a.prompt}
---`,
      forward: onProgress,
      meta: {
        metadataVersion: DELEGATION_METADATA_VERSION,
        bridgeVersion: APP_VERSION,
        parentJob: job?.parentJob,
        rootSession: job?.rootSession,
        by: me,
        byAgent: rc.agent,
        byCwd: rc.cwd(),
        job: a._job,
        // The job's current title (message_subagent can name or rename a job after it started).
        title: typeof job?.args?.title === "string" && job.args.title || a.title?.trim() || void 0,
        model: a.model ?? defaultModel ?? null,
        effort: a.effort ?? cfg.effort[target] ?? defaultEffort(target, a.model ?? defaultModel ?? null),
        access: access ?? "default",
        permission: profile.permission(cfg, { ...a, access }),
        workdir,
        ...wt ? { branch: wt.branch, baseBranch: wt.baseBranch, repoRoot: wt.repoRoot } : {},
        jobStartedAt: job?.startedAt,
        continues: a.session_id ?? null
      }
    });
  } catch (err) {
    await relay?.stop();
    throw err;
  }
  let link2 = null;
  let siblingLink = null;
  let jobNode = null;
  const liveDeliveries = /* @__PURE__ */ new Set();
  let steering = null;
  if (job && rc.jobs) {
    const jobs = rc.jobs;
    jobNode = rc.jobNode ?? new BridgeNode({
      pipePath: resolvePipePath(rc.home),
      token: loadOrCreateToken(rc.home),
      dbPath: resolveDbPath(rc.home),
      agent: "other",
      jobAgent: job.agent,
      id: `job:${job.id}`,
      name: job.name,
      cwd: workdir,
      jobOwner: job.supervisor ?? job.owner ?? me,
      jobParent: me,
      jobTitle: a.title,
      jobSendTo: a.send_to,
      autoWake: false,
      canHostBroker: false,
      log: dlog
    });
    siblingLink = new SiblingLink(jobNode, job, cfg.maxHops, dlog);
    void jobNode.start().catch((err) => dlog.warn("sibling bridge unavailable; retrying", { err: err.message }));
    const l = new ParentLink(
      me,
      (body, replyTo) => {
        feed.report(`answer to ${me}: ${body.split("\n")[0].slice(0, 120)}`, `answer to ${me}: ${body}`);
        jobs.fromSubagent(job, body, replyTo);
      },
      dlog,
      (percent, note, eta) => {
        job.percent = percent;
        job.progressNote = note;
        if (eta) Object.assign(job, eta);
        jobs.persist?.();
        feed.meta({ percent, progressNote: note, progressAt: Date.now(), ...eta ?? {} });
        feed.report(`progress ${percent}%${note ? `: ${note}` : ""}`);
      },
      siblingLink,
      (body) => jobs.escalateApproval ? jobs.escalateApproval(job, body) : Promise.reject(new Error("approval escalation unavailable"))
    );
    try {
      await l.start();
      link2 = l;
      job.live = {
        post: (m, sibling) => {
          const from = sibling?.from.name ?? me;
          const message = sibling ? formatSiblingMessages([sibling], siblingLink?.maxHops) : m;
          feed.report(`message from ${from}: ${m.split("\n")[0].slice(0, MESSAGE_PREVIEW_CHARS)}`, `message from ${from}: ${m}`);
          if (!steering) return void l.post(message, sibling);
          const s = steering;
          const delivery = s.send(message, Boolean(sibling)).then(
            (ok) => {
              if (!ok) l.post(message, sibling);
              else if (sibling) siblingLink?.consumed([sibling.id]);
            },
            () => {
              l.post(message, sibling);
            }
          );
          liveDeliveries.add(delivery);
          void delivery.finally(() => liveDeliveries.delete(delivery));
        }
      };
      siblingLink.flush();
    } catch (err) {
      dlog.warn("live link unavailable; messages to this subagent wait until it finishes", { err: err.message });
    }
  }
  const writableRoots = access === "edit" || a.sandbox === "workspace-write" ? await gitDirsOutside(workdir, dlog) : void 0;
  if (writableRoots?.length) dlog.info("extra writable folders for the subagent", { workdir, writableRoots });
  if (job) job.retitle = (title) => {
    feed.meta({ title });
    void jobNode?.updateJob({ jobTitle: title }).catch(() => {
    });
    void steering?.rename?.(title).catch((err) => dlog.warn("could not rename the Codex thread", { err: err.message }));
  };
  const slotOwner = { id: `${a._job ?? target}-${randomUUID11()}`, pid: process.pid };
  let slots = null;
  let slotTimer;
  let res;
  try {
    if (Object.keys(cfg.resourceSlots).length) {
      slots = new ResourceSlots(rc.home);
      slotTimer = setInterval(() => {
        try {
          slots?.renew(slotOwner);
        } catch (err) {
          dlog.warn("could not renew resource slots", { err: err.message });
        }
      }, SLOT_RENEW_MS);
      slotTimer.unref();
    }
    res = await retryTransient(
      {
        // With a live link the subagent can report how far it is (report_progress; shown in the dashboard).
        // A new session learns once that it reports back and leaves the handoff alone.
        prompt: [a.prompt, a.session_id ? null : DELEGATED_JOB_NOTE, linkRoot ? WORKTREE_LINK_HINT : null, link2 ? PROGRESS_HINT : null, link2 ? SIBLING_HINT : null, resourceSlotHint(cfg.resourceSlots, bundledCli())].filter(Boolean).join("\n\n"),
        title: typeof job?.args?.title === "string" && job.args.title || a.title,
        cwd: workdir,
        sessionId: a.session_id ?? null,
        timeoutSec: a.timeout_sec ?? (background ? MAX_JOB_TIMEOUT_SEC : DEFAULT_DELEGATE_TIMEOUT_SEC),
        maxDelegateDepth: cfg.maxDelegateDepth,
        model: a.model ?? defaultModel,
        effort: a.effort ?? cfg.effort[target] ?? null,
        // What it really runs (a CLI default or an alias resolved), for the dashboard.
        onInfo: (info) => feed.meta({ ...info.model ? { model: info.model } : {}, ...info.permission ? { permission: info.permission } : {}, effort: info.effort ?? a.effort ?? cfg.effort[target] ?? defaultEffort(target, info.model ?? null) }),
        log: dlog,
        signal,
        onProgress: feed.report,
        extraEnv: {
          ...link2?.childEnv(),
          [ENV.home]: rc.home,
          [ENV.maxDelegateDepth]: String(cfg.maxDelegateDepth),
          ...job ? { [PARENT_JOB_ENV]: job.name, [ROOT_SESSION_ENV]: job.rootSession ?? job.supervisor ?? me, [ROOT_NAME_ENV]: job.rootName ?? me } : {},
          ...slots ? { [SLOT_OWNER_ENV]: slotOwner.id, [SLOT_PID_ENV]: String(slotOwner.pid) } : {}
        },
        writableRoots,
        onSession: (id) => {
          feed.meta({ session: id });
          if (job) rc.jobs?.note(job, { sessionId: id, workdir, worktree: wt });
        },
        approve,
        onDenied: (message) => {
          link2?.post(message);
        },
        // Someone answers approve's questions: the user ("ask" relay or a dialog) or, for a background
        // subagent, the parent agent. Else targets keep their own behavior (Claude and opencode).
        canApprove: Boolean(wiring) || Boolean(job && (!job.foreground || job.parentJob) && rc.jobs) || Boolean(rc.askUser && rc.userCanAnswer?.()),
        live: job ? {
          from: me,
          onSteering: (s) => {
            steering = s;
            const title = job.args?.title;
            if (s && typeof title === "string" && title !== a.title) job.retitle?.(title);
          },
          onAnswer: (answer) => {
            feed.report(`answer to ${me}: ${answer.split("\n")[0].slice(0, 120)}`, `answer to ${me}: ${answer}`);
            rc.jobs?.fromSubagent(job, answer, null, true);
          }
        } : void 0
      },
      (req) => profile.run(cfg, req, { ...a, access, relay: wiring })
    );
    feed.meta({ session: res.sessionId });
    feed.end(res.isError ? "failed" : "done", res.text);
    if (!res.isError && res.text.trim()) link2?.reportCompleted();
  } catch (err) {
    if (err instanceof DelegateError && err.sessionId) feed.meta({ session: err.sessionId });
    if (wt) {
      const branch = await git([...trustArgs(wt.path), "branch", "--show-current"], wt.path, dlog).catch(() => wt.branch);
      const branchHead = await git([...trustArgs(wt.path), "rev-parse", "HEAD"], wt.path, dlog).catch(() => void 0);
      feed.meta({ branch: branch || wt.branch, branchHead });
    }
    feed.end(`failed: ${err?.message ?? err}`);
    if (wt && err instanceof Error) err.message += `

Its worktree (with any partial work) is ${wt.path} on branch ${wt.branch}.`;
    if (linkRoot && err instanceof Error) {
      try {
        const warning = worktreeLinkWarning(scanWorktreeLinks(linkRoot));
        if (warning) err.message += `

${warning}`;
      } catch (scanError) {
        err.message += `
WARNING: worktree link inspection failed: ${scanError.message}`;
      }
    }
    throw err;
  } finally {
    if (job) denyPendingApprovals(job);
    clearInterval(slotTimer);
    if (slots) {
      try {
        slots.release(slotOwner);
      } catch (err) {
        dlog.warn("could not release resource slots; leases will expire", { err: err.message });
      } finally {
        slots.close();
      }
    }
    siblingLink?.close();
    if (jobNode && !rc.jobNode) await jobNode.stop();
    await Promise.allSettled(liveDeliveries);
    await relay?.stop();
    if (job) job.retitle = null;
    if (job && link2) {
      job.live = null;
      job.queue.unshift(...await link2.close());
    }
  }
  const notes = [`Step-by-step log: ${feed.logPath}`];
  if (target === "codex") {
    const mappingNote = codexPathReport(codexDriveMappings(`${cwd}
${a.prompt}`));
    if (mappingNote) notes.push(mappingNote);
  }
  let linkedWorktreeRoot = false;
  if (linkRoot) {
    try {
      const scan = scanWorktreeLinks(linkRoot);
      linkedWorktreeRoot = scan.externalLinks.some((link3) => link3.path === resolve3(linkRoot));
      const warning = worktreeLinkWarning(scan);
      if (warning) notes.push(warning);
    } catch (err) {
      notes.push(`WARNING: worktree link inspection failed: ${err.message}`);
    }
  }
  if (access !== "ask" && asked.length) notes.push(`Approval requests forwarded:
${asked.join("\n")}`);
  if (access === "ask") {
    notes.push(
      forwarding ? asked.length ? `Permission requests forwarded to the user:
${asked.join("\n")}` : "No permission requests were needed." : t("ask.unsupported", { agent: target })
    );
  }
  const usage = formatUsage(res.details);
  if (usage) notes.push(usage);
  if (wt && linkedWorktreeRoot) {
    notes.push("Auto-commit skipped: the worktree root is an external link. Restore worktree isolation before running git or cleanup through it.");
  } else if (wt) {
    try {
      const message = subagentCommitMessage({ answer: res.text, task: a.prompt, job: a._job, agent: target, model: a.model ?? defaultModel });
      const outcome = await finishWorktree(wt, message, dlog);
      wt.branch = outcome.branch;
      wt.branchHead = await git([...trustArgs(wt.repoRoot, wt.path), "rev-parse", "HEAD"], wt.path, dlog);
      feed.meta({ branch: wt.branch, branchHead: wt.branchHead });
      notes.push(worktreeReport(wt, outcome));
    } catch (err) {
      notes.push(`Could not commit the changes in worktree ${wt.path} (branch ${wt.branch}): ${err.message}`);
    }
  } else if (before) {
    const after = await gitChangeSnapshot(workdir, dlog);
    const changed = after ? changedFiles(before, after) : [];
    if (access === "ask" && target === "codex" && forwarding && codexHash) {
      if (relayCalls > 0) recordCodexHookObservation(rc.home, codexHash, "verified");
      else if (changed.length) {
        recordCodexHookObservation(rc.home, codexHash, "failed");
        log.warn("codex changed files without the permission hook asking; forwarding disabled for this hook version", { changed });
        notes.push(t("ask.hookBypassed", { files: changed.join(", ") }));
      }
    }
    if (access === "edit" || changed.length) notes.push(changed.length ? `Files changed in your working copy:
${changed.join("\n")}` : "No files changed.");
    const warning = handoffWarning(changed);
    if (warning) notes.push(warning);
  }
  return { ...res, workdir, worktree: wt ?? void 0, text: notes.length ? `${res.text}

---
${notes.join("\n\n")}` : res.text };
}

export {
  handoffSchema,
  MAX_STREAM_ENTRIES,
  ProjectGroups,
  DASHBOARD_TIMEOUT_MS,
  isDashboardReadPath,
  dashboardRequestSchema,
  listRuns,
  readStoredJobs,
  classifyPeers,
  readDashboard,
  dashboardError,
  defaultEffort,
  isBridgeWorktree,
  isInside,
  resumeArgs,
  runDelegate,
  DASHBOARD_JOB_CONVERSATION,
  JobControlError,
  controlDashboardJob,
  BridgeNode
};
