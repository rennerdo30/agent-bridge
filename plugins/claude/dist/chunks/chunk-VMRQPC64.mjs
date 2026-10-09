import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  BridgeClient,
  brokerConnectionClosedError
} from "./chunk-QFQU7TGT.mjs";
import {
  SQLITE_STORE_VERSION
} from "./chunk-RQUYBZWF.mjs";
import {
  ReadJournal,
  recordLocalResult
} from "./chunk-XIO6SPAJ.mjs";
import {
  COMPLETION_DEDUPE_PREFIX,
  completionMessageId
} from "./chunk-JTZGNEMM.mjs";
import {
  CLAUDE_PERMISSION_MODES,
  CODEX_APPROVALS_REVIEWERS,
  CODEX_SANDBOXES,
  MODEL_NAME_PATTERN,
  NETWORK_NAME_PATTERN
} from "./chunk-MTPVESBQ.mjs";
import {
  BridgeError,
  CODING_AGENTS,
  isUnsupportedOperation
} from "./chunk-4QXHCXBU.mjs";
import {
  isPluginCacheCwd
} from "./chunk-JNVJDIQM.mjs";
import {
  external_exports
} from "./chunk-FDMEMG4Z.mjs";
import {
  JSON_STORE_VERSION,
  existingMetadataDb,
  recordStorePeer,
  refreshStorePeerIdentities,
  retainMetadataReader
} from "./chunk-JQ2ZLG74.mjs";
import {
  parentProcessIdentity
} from "./chunk-4EDVJNL7.mjs";
import {
  APP_VERSION,
  CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_HOPS,
  ELECTION_MAX_ATTEMPTS,
  ELECTION_RETRY_MAX_MS,
  ELECTION_RETRY_MIN_MS,
  JOBS_FILE,
  MAX_BODY_CHARS,
  MAX_CODEX_SUBAGENTS,
  MAX_JOB_TIMEOUT_SEC,
  PROTOCOL_VERSION,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_MIN_MS
} from "./chunk-7EOIPV3B.mjs";

// src/core/node.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// src/core/request-retry.ts
function transientRequestError(error) {
  return error instanceof Error && /broker request timed out:|database is (?:locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message);
}
async function retryRequest(operation, request) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (!transientRequestError(error)) throw error;
      if (attempt === 2) throw new BridgeError(
        "timeout",
        `${operation} unavailable after bounded retries; retry later. ${String(error)}`,
        { operation, retryLater: true, attempts: 3 }
      );
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}

// src/core/node.ts
import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

// src/core/job-control.ts
import { randomUUID } from "node:crypto";
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
  const requestId = randomUUID();
  let receive;
  let timer;
  const reply = new Promise((resolve, reject) => {
    receive = (m) => {
      if (m.from.name !== owner) return;
      try {
        const result = JSON.parse(m.body);
        if (result.type === "result" && result.requestId === requestId && typeof result.text === "string" && typeof result.outcome === "string" && typeof result.isError === "boolean") resolve(result);
      } catch {
      }
    };
    node.on("job_control", receive);
    timer = setTimeout(() => reject(new JobControlError("The owning session did not confirm delivery. Check its chat before sending again.", "timeout")), CONTROL_TIMEOUT_MS);
  });
  reply.catch(() => {
  });
  try {
    await node.send({ to: owner, body: JSON.stringify({ ...command, requestId, job }), conversationId: DASHBOARD_JOB_CONVERSATION }, { quiet: true });
    return await reply;
  } finally {
    clearTimeout(timer);
    node.off("job_control", receive);
  }
}

// src/network/remote-job-protocol.ts
var REMOTE_JOB_CAPABILITY = "remote-jobs-v1";
var REMOTE_JOB_CANCELLED_CAPABILITY = "remote-jobs-cancelled-v1";
var REMOTE_JOB_FRAME = "remote-job";
var REMOTE_JOB_POLL_MS = 2e3;
var REMOTE_JOB_REQUEST_TIMEOUT_MS = 3e4;
var REMOTE_JOB_LOCAL_TIMEOUT_MS = REMOTE_JOB_REQUEST_TIMEOUT_MS + 5e3;
var REMOTE_JOB_RATE_WINDOW_MS = 6e4;
var REMOTE_JOB_RATE_LIMIT = 600;
var REMOTE_JOB_SPAWN_LIMIT = 10;
var MAX_REMOTE_JOBS = 200;
var MAX_PATH_CHARS = 4096;
var MAX_TITLE_CHARS = 120;
var remoteSpawnArgsSchema = external_exports.object({
  prompt: external_exports.string().min(1).max(MAX_BODY_CHARS),
  title: external_exports.string().min(1).max(MAX_TITLE_CHARS),
  cwd: external_exports.string().min(1).max(MAX_PATH_CHARS),
  model: external_exports.string().regex(MODEL_NAME_PATTERN).optional(),
  effort: external_exports.string().regex(/^[A-Za-z0-9_-]{1,20}$/).optional(),
  session_id: external_exports.string().min(1).max(MAX_PATH_CHARS).optional(),
  timeout_sec: external_exports.number().int().min(10).max(MAX_JOB_TIMEOUT_SEC).optional(),
  access: external_exports.enum(["read", "ask", "edit"]).optional(),
  worktree: external_exports.boolean().optional(),
  allow_tools: external_exports.array(external_exports.string().min(1).max(200)).max(50).optional(),
  notes: external_exports.enum(["none", "milestones", "blockers"]).optional(),
  sandbox: external_exports.enum(CODEX_SANDBOXES).optional(),
  permission_mode: external_exports.enum(CLAUDE_PERMISSION_MODES).optional(),
  auto_approve: external_exports.boolean().optional(),
  native_subagents: external_exports.number().int().min(0).max(MAX_CODEX_SUBAGENTS).optional(),
  approvals_reviewer: external_exports.enum(CODEX_APPROVALS_REVIEWERS).optional()
}).strict();
var settingsSchema = external_exports.record(external_exports.string(), external_exports.unknown());
var remoteControlSchema = external_exports.discriminatedUnion("type", [
  external_exports.object({ type: external_exports.literal("message"), body: external_exports.string().min(1).max(MAX_BODY_CHARS), cid: external_exports.uuid() }).strict(),
  external_exports.object({ type: external_exports.literal("cancel") }).strict(),
  external_exports.object({ type: external_exports.literal("attach") }).strict(),
  external_exports.object({ type: external_exports.literal("title"), title: external_exports.string().min(1).max(MAX_TITLE_CHARS) }).strict(),
  external_exports.object({ type: external_exports.literal("effort"), effort: external_exports.string().regex(/^[A-Za-z0-9_-]{1,20}$/) }).strict(),
  external_exports.object({ type: external_exports.literal("settings"), settings: settingsSchema }).strict()
]);
var remoteJobRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("spawn"), job: external_exports.string().regex(/^[0-9a-f]{8}$/), target: external_exports.enum(CODING_AGENTS), args: remoteSpawnArgsSchema }).strict(),
  external_exports.object({ op: external_exports.literal("state"), job: external_exports.string().regex(/^[0-9a-f]{8}$/) }).strict(),
  external_exports.object({ op: external_exports.literal("control"), job: external_exports.string().regex(/^[0-9a-f]{8}$/), control: remoteControlSchema }).strict(),
  external_exports.object({ op: external_exports.literal("approval"), job: external_exports.string().regex(/^[0-9a-f]{8}$/), id: external_exports.uuid(), decision: external_exports.enum(["allow", "deny"]), reason: external_exports.string().max(4e3).optional() }).strict()
]);
function remoteSnapshotForPeer(snapshot, supportsCancelled) {
  if (!snapshot.state || snapshot.state.status !== "cancelled" || supportsCancelled) return snapshot;
  return { ...snapshot, state: { ...snapshot.state, status: "failed", report: snapshot.state.report ? snapshot.state.report.replace(/^(Subagent .+) cancelled after /, "$1 failed after ") + "\n\nCause: cancelled (legacy paired broker status compatibility)." : "Cancelled (legacy paired broker status compatibility)." } };
}
var worktreeSchema = external_exports.object({ repoRoot: external_exports.string(), path: external_exports.string(), cwd: external_exports.string(), branch: external_exports.string(), base: external_exports.string(), baseBranch: external_exports.string().nullable().optional() });
var remoteJobSnapshotSchema = external_exports.object({
  alive: external_exports.boolean(),
  state: external_exports.object({
    pid: external_exports.number().int().nonnegative(),
    peer: external_exports.string().regex(NETWORK_NAME_PATTERN),
    status: external_exports.enum(["running", "done", "failed", "cancelled"]),
    updatedAt: external_exports.number().nonnegative(),
    model: external_exports.string().nullable().optional(),
    sessionId: external_exports.string().nullable().optional(),
    workdir: external_exports.string().nullable().optional(),
    worktree: worktreeSchema.nullable().optional(),
    progress: external_exports.string().nullable().optional(),
    percent: external_exports.number().min(0).max(100).optional(),
    progressNote: external_exports.string().optional(),
    etaAt: external_exports.number().finite().nonnegative().optional(),
    etaReportedAt: external_exports.number().finite().nonnegative().optional(),
    asking: external_exports.boolean().optional(),
    live: external_exports.boolean().optional(),
    seen: external_exports.array(external_exports.string()).optional(),
    report: external_exports.string().optional(),
    delivered: external_exports.boolean().optional(),
    finishedAt: external_exports.number().optional()
  }).nullable(),
  approvals: external_exports.array(external_exports.object({ id: external_exports.uuid(), owner: external_exports.string(), job: external_exports.string(), agent: external_exports.string(), tool: external_exports.string(), command: external_exports.string(), reason: external_exports.string(), askedAt: external_exports.number(), deadline: external_exports.number() })).max(50)
});
var remoteJobWireSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("request"), rid: external_exports.uuid(), peer: external_exports.object({ id: external_exports.string().min(1).max(MAX_PATH_CHARS), name: external_exports.string().regex(NETWORK_NAME_PATTERN), supervisor: external_exports.string().min(1).max(MAX_PATH_CHARS) }).strict(), request: remoteJobRequestSchema }).strict(),
  external_exports.object({ kind: external_exports.literal("response"), rid: external_exports.uuid(), value: external_exports.unknown().optional(), error: external_exports.string().max(MAX_PATH_CHARS).optional() }).strict()
]);

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
    this.id = opts.id ?? randomUUID2();
    this.currentName = opts.name;
    this.currentCwd = opts.cwd;
    this.autoWake = opts.autoWake;
    this.log = opts.log.child("node");
    if (opts.dbPath !== ":memory:") this.recordStorePresence();
    if (opts.dbPath !== ":memory:") this.releaseMetadata = retainMetadataReader(dirname(opts.dbPath));
    this.readJournal = new ReadJournal(opts.dbPath === ":memory:" ? ":memory:" : dirname(opts.dbPath), this.log);
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
  releaseMetadata;
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
  presenceTimer = null;
  /**
   * Publish this process's store capabilities. A deferred metadata store (an older reader, or this
   * process's identity not yet verifiable for the fail-closed migration lease) must never stop the
   * node from starting: the record then stays in its pre-AB-208 file, and this retries with backoff
   * until the store opens and holds the row.
   */
  recordStorePresence(delay = 1e3) {
    const home = dirname(this.opts.dbPath);
    let error;
    try {
      recordStorePeer(home, { pid: process.pid, name: this.currentName, version: APP_VERSION, storeCapabilities: { json: JSON_STORE_VERSION, sqlite: SQLITE_STORE_VERSION, jobArchive: 1 } });
    } catch (err) {
      error = err;
    }
    let open = false;
    try {
      open = Boolean(existingMetadataDb(home));
    } catch {
    }
    if (open && !error) return;
    if (error && delay === 1e3) this.log.warn("store presence deferred; retrying in the background", { err: String(error.message ?? error) });
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      if (!this.stopping) this.recordStorePresence(Math.min(6e4, delay * 2));
    }, delay);
    this.presenceTimer.unref();
  }
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
    if (!this.releaseMetadata && this.opts.dbPath !== ":memory:") this.releaseMetadata = retainMetadataReader(dirname(this.opts.dbPath));
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
    const electing = this.electing;
    if (electing) {
      await electing.catch(() => {
      });
      this.client?.close();
      this.client = null;
      const late = this.broker;
      if (closeBroker && late) {
        await late.close();
        this.broker = null;
      }
    }
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    this.log.info("bridge node stopped");
    this.releaseMetadata?.();
    this.releaseMetadata = void 0;
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
        if (code === "EUNSAFESOCKETDIR") throw err;
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
    if (this.stopping) return false;
    const [{ Broker }, { MessageStore }] = await Promise.all([import("./broker-JXB6KLJM.mjs"), import("./store-ZH7RUTJO.mjs")]);
    let store;
    try {
      if (this.opts.dbPath !== ":memory:") void refreshStorePeerIdentities(dirname(this.opts.dbPath)).catch((error) => this.log.debug("store reader identity refresh deferred", { err: String(error) }));
      store = new MessageStore(this.opts.dbPath, this.log.child("store"));
    } catch (err) {
      if (["EBUSY", "SQLITE_BUSY", "STORE_UPGRADE_DEFERRED"].includes(errCode(err)) || /database is locked/.test(String(err.message))) {
        this.log.info("another session is preparing the store; retrying broker election", { db: this.opts.dbPath });
        return false;
      }
      this.log.error("cannot open message store", { err, db: this.opts.dbPath });
      throw err;
    }
    const broker = new Broker(this.opts.pipePath, store, this.log.child("broker"), this.opts.token, Date.now, join(dirname(this.opts.dbPath), JOBS_FILE), this.opts.network);
    try {
      await broker.listen();
      if (this.stopping) {
        await broker.close();
        return false;
      }
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
    let brokerVersion;
    try {
      await client.request("auth", { protocol: PROTOCOL_VERSION, token: this.opts.token });
      brokerVersion = (await client.request("ping", {})).brokerVersion;
      if (this.opts.dbPath !== ":memory:") for (const peer of await client.request("peers", {})) recordStorePeer(dirname(this.opts.dbPath), peer);
    } catch (error) {
      client.close();
      throw error;
    }
    const agentStartedAt = this.opts.jobAgent ? null : await parentProcessIdentity();
    const args = this.helloArgs();
    const hello = await client.request("hello", { ...args, peer: {
      ...args.peer,
      agentStartedAt,
      storeCapabilities: brokerVersion === APP_VERSION ? args.peer.storeCapabilities : void 0
    } }).catch((err) => {
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
        storeCapabilities: { json: JSON_STORE_VERSION, sqlite: SQLITE_STORE_VERSION, jobArchive: 1 },
        ...this.opts.jobAgent ? { jobAgent: this.opts.jobAgent } : {},
        ...this.opts.jobOwner ? { jobOwner: this.opts.jobOwner, jobParent: this.opts.jobParent, parentJob: this.opts.parentJob, rootSession: this.opts.rootSession, rootName: this.opts.rootName, jobTitle: this.opts.jobTitle, jobSendTo: this.opts.jobSendTo } : {}
      }
    };
  }
  afterHello(client, hello) {
    if (this.stopping) {
      client.close();
      return;
    }
    this.client = client;
    this.currentName = hello.name;
    this.recordOwnStorePeer();
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
    this.scheduleReconnect(this.opts.canHostBroker === false ? jitter() : 0);
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
      if (ev === "peer_joined" && this.opts.dbPath !== ":memory:") recordStorePeer(dirname(this.opts.dbPath), data);
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
  /** A read may cross listener retirement; retry only that actual closed socket once. */
  async withReadClient(fn, signal) {
    const cancelled = new AbortController();
    const stopped = () => cancelled.abort(new Error("bridge node stopped"));
    const aborted = () => cancelled.abort(signal?.reason);
    this.on("stopped", stopped);
    signal?.addEventListener("abort", aborted, { once: true });
    if (this.stopping) stopped();
    if (signal?.aborted) aborted();
    const wait = (pending) => new Promise((resolve, reject) => {
      const abort = () => {
        cancelled.signal.removeEventListener("abort", abort);
        reject(cancelled.signal.reason);
      };
      cancelled.signal.addEventListener("abort", abort, { once: true });
      pending.then((value) => {
        cancelled.signal.removeEventListener("abort", abort);
        resolve(value);
      }, (error) => {
        cancelled.signal.removeEventListener("abort", abort);
        reject(error);
      });
      if (cancelled.signal.aborted) abort();
    });
    let usedClient = null;
    const invoke = async (timeoutMs) => {
      cancelled.signal.throwIfAborted();
      const before = this.client;
      await this.ensureConnected();
      cancelled.signal.throwIfAborted();
      usedClient = this.client ?? before;
      if (!usedClient || usedClient.isClosed) throw brokerConnectionClosedError();
      return fn(usedClient, timeoutMs);
    };
    try {
      try {
        return await wait(invoke());
      } catch (error) {
        if (cancelled.signal.aborted || this.stopping || errCode(error) !== "BROKER_CONNECTION_CLOSED" || !usedClient?.isClosed) throw error;
      }
      const timer = setTimeout(() => cancelled.abort(Object.assign(new Error("broker read reconnect timed out"), { code: "ETIMEDOUT" })), CONNECT_TIMEOUT_MS);
      try {
        return await wait(invoke(CONNECT_TIMEOUT_MS));
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.off("stopped", stopped);
      signal?.removeEventListener("abort", aborted);
    }
  }
  /** quiet: not part of a conversation of this agent (no listen window, replies are not awaited), e.g. control messages to a job runner. */
  send(args, opts = {}) {
    const request = { ...args, dedupeKey: args.dedupeKey || randomUUID2() };
    const messageId = args.messageId ?? (args.dedupeKey?.startsWith(COMPLETION_DEDUPE_PREFIX) && this.opts.jobAgent ? completionMessageId(this.id, args.dedupeKey.slice(COMPLETION_DEDUPE_PREFIX.length)) : args.dedupeKey ? completionMessageId(`send:${this.name}`, args.dedupeKey) : randomUUID2());
    let submitted = false;
    return this.withClient(async (c) => {
      if (args.ifNoNewerThan) {
        await Promise.all([...this.pendingAcks]);
        while (this.unflushedAcks.size) {
          const ids = [...this.unflushedAcks].slice(0, 500);
          await c.request("ack", { ids });
          ids.forEach((id) => this.unflushedAcks.delete(id));
        }
      }
      submitted = true;
      const res = args.dedupeKey?.startsWith(COMPLETION_DEDUPE_PREFIX) && !args.messageId ? await this.sendRequest(c, "send", request) : await this.trackedSend(c, { ...request, messageId }, Boolean(args.messageId));
      if (opts.quiet) return res;
      this.lastSent = Date.now();
      if (!args.replyTo) for (const m of res.messages) this.asked.add(m.id);
      if (this.asked.size > QUESTION_ID_MEMORY) this.asked.delete(this.asked.values().next().value);
      return res;
    }).catch((error) => {
      if (submitted) throw error;
      throw new BridgeError(
        error instanceof BridgeError ? error.code : "internal",
        `This send attempt was not submitted; message ${messageId} storage state is unknown: ${error.message}. Query send_status or retry send with message_id="${messageId}".`,
        { ...error instanceof BridgeError ? error.details : {}, messageId, state: "unknown", submitted: false }
      );
    });
  }
  sendState(id) {
    return this.withClient((c) => c.request("sendState", { id }));
  }
  async trackedSend(client, args, explicitId) {
    try {
      return await client.request("trackedSend", args);
    } catch (error) {
      if (isUnsupportedOperation(error, "trackedSend")) {
        if (explicitId || args.ifNoNewerThan) throw error;
        const { messageId: _unused, ...legacy } = args;
        return this.sendRequest(client, "send", legacy);
      }
      if (!transientRequestError(error)) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError("internal", `Storage cannot be confirmed for message ${args.messageId}; storage state is unknown: ${error.message}. Query send_status(message_id="${args.messageId}") or retry send with the same message_id.`, { messageId: args.messageId, state: "unknown" });
      }
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return await client.request("trackedSend", args);
      } catch (retryError) {
        if (retryError instanceof BridgeError && retryError.code !== "internal" && retryError.code !== "timeout") throw retryError;
        try {
          const state = await client.request("sendState", { id: args.messageId });
          if (state.message) {
            const message = state.message;
            if (!(message.body === args.body || message.body.startsWith(args.body + "\n\n[agent-bridge routing hint:")) || !this.opts.jobAgent && message.to !== args.to.trim() || message.replyTo !== (args.replyTo?.trim() || null) || args.conversationId && message.conversationId !== args.conversationId.trim() && !(this.opts.jobAgent && message.conversationId === args.conversationId.trim() + ":fallback")) {
              throw new BridgeError("bad_request", "Message id already stored with different content.", { messageId: state.id, state: "stored" });
            }
            return {
              messages: [message],
              deliveredTo: [],
              queuedFor: [],
              storage: { id: state.id, state: "stored", recovered: true, receipts: state.receipts }
            };
          }
          throw new BridgeError("timeout", `Message ${state.id} storage state is unknown; this local broker reports ${state.state} as of ${new Date(state.checkedAt).toISOString()}. An outstanding or remote request can still store it. Query send_status(message_id="${state.id}") or retry send with the same message_id.`, { messageId: state.id, state: "unknown", localState: state.state });
        } catch (lookupError) {
          if (lookupError instanceof BridgeError && lookupError.details?.messageId) throw lookupError;
          throw new BridgeError("timeout", `Storage cannot be confirmed for message ${args.messageId}; storage state is unknown: broker lookup unavailable. Query send_status(message_id="${args.messageId}") or retry send with the same message_id; use a new id only for a new message.`, { messageId: args.messageId, state: "unknown", cause: String(retryError) });
        }
      }
    }
  }
  /** A late send response can be recovered from the same broker without sending twice. */
  async sendRequest(client, op, args) {
    try {
      return await client.request(op, args);
    } catch (err) {
      if (err.message !== `broker request timed out: ${op}`) {
        if (err instanceof BridgeError && err.code !== "internal" && err.code !== "timeout") throw err;
        throw new BridgeError(err instanceof BridgeError ? err.code : "internal", `Message storage state is unknown after ${op}: ${err.message}. This legacy operation has no durable send_status identity; check inbox/history before resending.`, { ...err instanceof BridgeError ? err.details : {}, state: "unknown", dedupeKey: args.dedupeKey });
      }
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return await client.request(op, args);
      } catch (retryError) {
        throw new BridgeError("timeout", `Message storage state is unknown after a timed-out ${op}. This legacy operation has no durable send_status identity; check inbox/history before resending. ${retryError.message}`, { state: "unknown", dedupeKey: args.dedupeKey });
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
  peers(signal) {
    return this.withReadClient((c, timeoutMs) => c.request("peers", {}, timeoutMs), signal).then((peers) => peers.filter((p) => !isPluginCacheCwd(p.cwd)));
  }
  health() {
    const started = performance.now();
    return this.withClient((c) => c.request("health", {})).then((health) => ({ ...health, roundTripMs: performance.now() - started }));
  }
  brokerLoad() {
    return this.withClient((c) => c.request("brokerLoad", {}));
  }
  projectJobs() {
    return this.withClient((c) => c.request("projectJobs", {}));
  }
  jobRecipient(job) {
    return retryRequest("jobRecipient (read only; no control submitted)", () => this.withClient((c) => c.request("jobRecipient", { job })));
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
    return retryRequest("jobAuthority (read only; no control submitted)", () => this.withClient((c) => c.request("jobAuthority", { job })));
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
  askOwner(args) {
    return this.withClient((c) => c.request("askOwner", args));
  }
  dismissOwner(args) {
    return this.withClient((c) => c.request("dismissOwner", args));
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
    let submitted = false;
    return this.withClient((c) => {
      submitted = true;
      return this.sendRequest(c, "sendSibling", { ...args, maxHops, dedupeKey: args.dedupeKey || randomUUID2() });
    }).catch((error) => {
      if (submitted) throw error;
      throw new BridgeError(error instanceof BridgeError ? error.code : "internal", `This sibling send attempt was not submitted; message storage state is unknown: ${error.message}. Check inbox/history for previous attempts before resending.`, { state: "unknown", submitted: false });
    });
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
      if (this.opts.dbPath !== ":memory:") recordLocalResult(dirname(this.opts.dbPath), m);
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
    return new Promise((resolve) => {
      const done = (m) => {
        clearTimeout(timer);
        this.off("message", onMessage);
        this.off("notification_waits_changed", onChanged);
        this.off("replaced", onAbort);
        this.off("stopped", onAbort);
        signal?.removeEventListener("abort", onAbort);
        resolve(m);
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
    this.recordOwnStorePeer();
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
  async relocate(cwd, name) {
    if (cwd === this.currentCwd && (!name || name === this.currentName)) return;
    this.currentCwd = cwd;
    if (name) this.currentName = name;
    this.log.info("peer relocated", { cwd, name: this.currentName });
    if (this.isConnected) {
      const peer = await this.client.request("updatePeer", { cwd, ...name ? { name } : {} });
      this.currentName = peer.name;
    }
    this.recordOwnStorePeer();
  }
  recordOwnStorePeer() {
    if (this.opts.dbPath !== ":memory:") recordStorePeer(dirname(this.opts.dbPath), { pid: process.pid, name: this.currentName, version: APP_VERSION, storeCapabilities: { json: JSON_STORE_VERSION, sqlite: SQLITE_STORE_VERSION, jobArchive: 1 } }, { authoritative: true });
  }
};

export {
  REMOTE_JOB_CAPABILITY,
  REMOTE_JOB_CANCELLED_CAPABILITY,
  REMOTE_JOB_FRAME,
  REMOTE_JOB_POLL_MS,
  REMOTE_JOB_REQUEST_TIMEOUT_MS,
  REMOTE_JOB_RATE_WINDOW_MS,
  REMOTE_JOB_RATE_LIMIT,
  REMOTE_JOB_SPAWN_LIMIT,
  MAX_REMOTE_JOBS,
  remoteSpawnArgsSchema,
  remoteJobRequestSchema,
  remoteSnapshotForPeer,
  remoteJobSnapshotSchema,
  remoteJobWireSchema,
  DASHBOARD_JOB_CONVERSATION,
  JobControlError,
  controlDashboardJob,
  BridgeNode
};
