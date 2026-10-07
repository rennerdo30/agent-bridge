import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  REMOTE_JOB_LOCAL_TIMEOUT_MS,
  ReadJournal,
  recordLocalResult
} from "./chunk-5QC4IROA.mjs";
import {
  BridgeClient
} from "./chunk-OJOD5JQS.mjs";
import {
  SQLITE_STORE_VERSION
} from "./chunk-RQUYBZWF.mjs";
import {
  BridgeError
} from "./chunk-SOPZATYP.mjs";
import {
  isPluginCacheCwd
} from "./chunk-VNX2WF5E.mjs";
import {
  JSON_STORE_VERSION,
  recordStorePeer
} from "./chunk-TPCM6ZR4.mjs";
import {
  APP_VERSION,
  DEFAULT_MAX_HOPS,
  ELECTION_MAX_ATTEMPTS,
  ELECTION_RETRY_MAX_MS,
  ELECTION_RETRY_MIN_MS,
  JOBS_FILE,
  PROTOCOL_VERSION,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_MIN_MS
} from "./chunk-6PRX5EOQ.mjs";

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

// src/core/node.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

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
    if (opts.dbPath !== ":memory:") recordStorePeer(dirname(opts.dbPath), { pid: process.pid, name: opts.name, version: APP_VERSION, storeCapabilities: { json: JSON_STORE_VERSION, sqlite: SQLITE_STORE_VERSION } });
    this.readJournal = new ReadJournal(dirname(opts.dbPath));
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
    const [{ Broker }, { MessageStore }] = await Promise.all([import("./broker-EZBPHHR4.mjs"), import("./store-GRPGTM7J.mjs")]);
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
    const broker = new Broker(this.opts.pipePath, store, this.log.child("broker"), this.opts.token, Date.now, join(dirname(this.opts.dbPath), JOBS_FILE), this.opts.network);
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
      if (this.opts.dbPath !== ":memory:") for (const peer of await client.request("peers", {})) recordStorePeer(dirname(this.opts.dbPath), peer);
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
  /** quiet: not part of a conversation of this agent (no listen window, replies are not awaited), e.g. control messages to a job runner. */
  send(args, opts = {}) {
    return this.withClient(async (c) => {
      const res = await this.sendRequest(c, "send", { ...args, dedupeKey: args.dedupeKey || randomUUID2() });
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
    return this.withClient((c) => this.sendRequest(c, "sendSibling", { ...args, maxHops, dedupeKey: args.dedupeKey || randomUUID2() }));
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
      recordLocalResult(dirname(this.opts.dbPath), m);
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
  }
};

export {
  DASHBOARD_JOB_CONVERSATION,
  JobControlError,
  controlDashboardJob,
  BridgeNode
};
