import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Broker } from "./broker.js";
import { isPluginCacheCwd } from "./session-visibility.js";
import { BridgeClient } from "./client.js";
import {
  ELECTION_MAX_ATTEMPTS,
  ELECTION_RETRY_MAX_MS,
  APP_VERSION,
  DEFAULT_MAX_HOPS,
  ELECTION_RETRY_MIN_MS,
  JOBS_FILE,
  PROTOCOL_VERSION,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_MIN_MS,
} from "./constants.js";
import type { Logger } from "./logger.js";
import { BridgeError, isQuietMessage, type AgentKind, type BridgeMessage, type PeerActivity, type PeerInfo, type SendArgs, type SendResult, type SiblingPeer } from "./protocol.js";
import { ReadJournal } from "./read-journal.js";
import { recordLocalResult } from "./local-result-receipts.js";
import { MessageStore, SQLITE_STORE_VERSION } from "./store.js";
import { JSON_STORE_VERSION } from "./json-store.js";
import { recordStorePeer } from "./store-compatibility.js";
import { parentProcessIdentity } from "./process-identity.js";
import { DASHBOARD_JOB_CONVERSATION } from "./job-control.js";
import type { NetworkConfig } from "../network/config.js";
import type { NetworkStatus } from "../network/link.js";
import type { TransferResult } from "../network/files.js";
import type { RemoteJobRequest } from "../network/remote-job-protocol.js";
import { REMOTE_JOB_LOCAL_TIMEOUT_MS } from "../network/remote-job-protocol.js";
import type { RemoteJobSnapshot } from "../network/remote-jobs.js";
import type { HistorySearch, HistoryResult } from "./history.js";
import type { TransferStarted } from "../network/transfers.js";
import type { DecideArgs, DecisionsArgs, OwnerDecision } from "./decisions.js";

export interface BridgeNodeOptions {
  pipePath: string;
  /** Shared secret (see token.ts). */
  token: string;
  dbPath: string;
  agent: AgentKind;
  name: string;
  cwd: string;
  autoWake: boolean;
  log: Logger;
  platform?: NodeJS.Platform;
  /** Fixed peer id (a job runner's "job:<id>"); default: a new random one. */
  id?: string;
  /** A job runner: the agent of the subagent it runs. The broker keeps such peers out of listings and agent-kind routing. */
  jobAgent?: AgentKind;
  jobOwner?: string;
  jobParent?: string;
  parentJob?: string;
  rootSession?: string;
  rootName?: string;
  jobTitle?: string;
  jobSendTo?: string[];
  /** false: only connect to a broker, never become one (a short-lived job runner would take the bridge down with it). */
  canHostBroker?: boolean;
  network?: { home: string; config: NetworkConfig };
}

export interface BridgeNodeEvents {
  jobs_changed: [];
  shared_job_control: [{ job: string; control: import("../mcp/jobs.js").RunnerControl }];
  inline_job_control: [{ job: string; control: import("../mcp/jobs.js").RunnerControl }];
  message: [BridgeMessage];
  notification_waits_changed: [];
  job_control: [BridgeMessage];
  peer_joined: [PeerInfo];
  peer_left: [PeerInfo];
  connected: [{ name: string; isBroker: boolean }];
  disconnected: [];
}

/** Bound the in-memory set of questions whose replies can wake this session. */
const QUESTION_ID_MEMORY = 2_000;

const jitter = () => ELECTION_RETRY_MIN_MS + Math.floor(Math.random() * (ELECTION_RETRY_MAX_MS - ELECTION_RETRY_MIN_MS));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errCode(err: unknown): string {
  return String((err as NodeJS.ErrnoException)?.code ?? "");
}

/**
 * One agent's presence on the bridge. It connects to the broker, or becomes the broker when none
 * is running, and re-elects transparently when the broker process goes away.
 */
export class BridgeNode extends EventEmitter<BridgeNodeEvents> {
  readonly id: string;
  private client: BridgeClient | null = null;
  private broker: Broker | null = null;
  private stopping = false;
  /** The bridge gave this session to another server of it (see reclaim). */
  private replaced = false;
  private electing: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_BACKOFF_MIN_MS;
  private currentName: string;
  private readonly inbox = new Map<string, BridgeMessage>();
  private readonly readIds = new Set<string>();
  private readonly readJournal: ReadJournal;
  private readonly unflushedAcks = new Set<string>();
  private sessionId: string | null = null;
  private autoWake: boolean;
  private wakeOnDirect = false;
  private wakeAvailable = false;
  private wakeMaxHops = DEFAULT_MAX_HOPS;
  private currentCwd: string;
  private lastSent = 0;
  /** Ids of messages this peer sent as new questions (not replies); replies to them are awaited. */
  private readonly asked = new Set<string>();
  private notificationMatch: (m: BridgeMessage) => boolean = () => false;
  private notificationConsumed: (messages: BridgeMessage[]) => void = () => {};
  private activity: PeerActivity | null = null;
  private unavailable = false;
  private readonly log: Logger;

  constructor(private readonly opts: BridgeNodeOptions) {
    super();
    this.id = opts.id ?? randomUUID();
    this.currentName = opts.name;
    this.currentCwd = opts.cwd;
    this.autoWake = opts.autoWake;
    this.log = opts.log.child("node");
    if (opts.dbPath !== ":memory:") recordStorePeer(dirname(opts.dbPath), { pid: process.pid, name: opts.name, version: APP_VERSION, storeCapabilities: { json: JSON_STORE_VERSION, sqlite: SQLITE_STORE_VERSION } });
    this.readJournal = new ReadJournal(dirname(opts.dbPath));
    this.restoreReadState(`name:${this.currentName}`);
  }

  get name(): string {
    return this.currentName;
  }
  get isBroker(): boolean {
    return this.broker !== null;
  }
  get isConnected(): boolean {
    return this.client !== null && !this.client.isClosed;
  }
  get autoWakeEnabled(): boolean {
    return this.autoWake;
  }

  async start(): Promise<void> {
    await this.ensureConnected();
  }

  /** Take over unread mail sent to "-N" stand-in names of this session (see the broker's claimMail). */
  async claimMail(names: string[]): Promise<number> {
    if (!names.length || !this.isConnected) return 0;
    return (await this.client!.request("claimMail", { names })).moved;
  }

  get wasReplaced(): boolean {
    return this.replaced;
  }

  /**
   * The session still calls this server (hooks, tools) after the bridge replaced it: Claude Code can start a
   * stale server of an older plugin version next to the current one on /reload-plugins, and whichever connects
   * last wins. The server the session really uses takes its place back; the stale one, never called, stays out.
   */
  async reclaim(): Promise<void> {
    if (!this.replaced) return;
    this.replaced = false;
    this.stopping = false;
    this.log.info("the session still uses this server: taking its place back on the bridge");
    await this.ensureConnected();
    this.emit("reclaimed");
  }

  async stop(closeBroker = true): Promise<void> {
    this.stopping = true;
    this.emit("stopped");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
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
  ensureConnected(): Promise<void> {
    if (isPluginCacheCwd(this.currentCwd)) return Promise.reject(new BridgeError("bad_request", "Project directory is still a plugin cache; waiting for the host's project directory."));
    if (this.isConnected) return Promise.resolve();
    this.electing ??= this.elect()
      .catch((err) => {
        this.scheduleReconnect(this.nextBackoff());
        throw err;
      })
      .finally(() => {
        this.electing = null;
      });
    return this.electing;
  }

  /** Doubling delay for background retries, capped; reset once connected. */
  private nextBackoff(): number {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_BACKOFF_MAX_MS);
    return delay;
  }

  /**
   * Retry the election later until connected or stopped. Also after "unauthorized" / "protocol_mismatch":
   * the incompatible broker may exit (e.g. after an update) and this node then takes over.
   */
  private scheduleReconnect(delayMs: number): void {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping || this.isConnected) return;
      this.ensureConnected().catch((err) => this.log.warn("re-election failed; retrying with backoff", { err: (err as Error).message }));
    }, delayMs);
    this.reconnectTimer.unref();
  }

  private async elect(): Promise<void> {
    for (let attempt = 1; attempt <= ELECTION_MAX_ATTEMPTS && !this.stopping; attempt++) {
      try {
        const client = await BridgeClient.connect(this.opts.pipePath, this.log.child("client"));
        await this.adopt(client);
        return;
      } catch (err) {
        if (err instanceof BridgeError && (err.code === "unauthorized" || err.code === "protocol_mismatch")) {
          // Retrying cannot help: the running broker is another agent-bridge version or uses another token.
          this.log.error("broker refused this peer", { code: err.code, message: err.message });
          throw err;
        }
        const code = errCode(err);
        this.log.debug("connect attempt failed", { attempt, code, message: (err as Error).message });
        if (code !== "ENOENT" && code !== "ECONNREFUSED") {
          await sleep(jitter());
          continue;
        }
      }
      // Nobody is listening: try to become the broker.
      if (this.opts.canHostBroker !== false && (await this.tryBecomeBroker())) continue; // next loop iteration connects to ourselves
      await sleep(jitter());
    }
    throw new Error(`could not connect to or start the agent-bridge broker at ${this.opts.pipePath}`);
  }

  private async tryBecomeBroker(): Promise<boolean> {
    if (this.broker) return true;
    let store: MessageStore;
    try {
      store = new MessageStore(this.opts.dbPath, this.log.child("store"));
    } catch (err) {
      if (["EBUSY", "SQLITE_BUSY", "STORE_UPGRADE_DEFERRED"].includes(errCode(err)) || /database is locked/.test(String((err as Error).message))) {
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
        // A Unix socket file can outlive its process. If connecting failed, the file is stale.
        try {
          await BridgeClient.connect(this.opts.pipePath, this.log).then((c) => c.close());
          return false; // someone is alive after all
        } catch (probeErr) {
          if (errCode(probeErr) === "ECONNREFUSED") {
            this.log.warn("removing stale broker socket", { pipe: this.opts.pipePath });
            try {
              unlinkSync(this.opts.pipePath);
            } catch {
              // Another node may have removed it first.
            }
          }
        }
      } else {
        this.log.debug("could not become broker", { code });
      }
      return false;
    }
  }

  private async adopt(client: BridgeClient): Promise<void> {
    client.on("event", (ev, data) => this.onEvent(ev, data));
    // Read presence before hello can trigger writes in a newer broker.
    try {
      await client.request("auth", { protocol: PROTOCOL_VERSION, token: this.opts.token });
      if (this.opts.dbPath !== ":memory:") for (const peer of await client.request("peers", {})) recordStorePeer(dirname(this.opts.dbPath), peer);
    } catch (error) { client.close(); throw error; }
    const agentStartedAt = this.opts.jobAgent ? null : await parentProcessIdentity();
    const args = this.helloArgs();
    const hello = await client.request("hello", { ...args, peer: { ...args.peer, agentStartedAt } }).catch((err) => {
      client.close();
      throw err;
    });
    this.afterHello(client, hello);
  }

  private helloArgs() {
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
        ...(this.opts.jobAgent ? { jobAgent: this.opts.jobAgent } : {}),
        ...(this.opts.jobOwner ? { jobOwner: this.opts.jobOwner, jobParent: this.opts.jobParent, parentJob: this.opts.parentJob, rootSession: this.opts.rootSession, rootName: this.opts.rootName, jobTitle: this.opts.jobTitle, jobSendTo: this.opts.jobSendTo } : {}),
      },
    };
  }

  private afterHello(client: BridgeClient, hello: { name: string; brokerPid: number; sessionId?: string | null }): void {
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
      const ids = [...this.unflushedAcks];
      this.unflushedAcks.clear();
      client.request("ack", { ids }).catch((err) => {
        this.log.warn("flushing acks failed", { err: (err as Error).message });
        ids.forEach((id) => this.unflushedAcks.add(id));
      });
    }
    this.log.info("connected to broker", { name: hello.name, brokerPid: hello.brokerPid, isBroker: this.isBroker });
    this.emit("connected", { name: hello.name, isBroker: this.isBroker });
  }

  private onClose(client: BridgeClient): void {
    if (this.client !== client) return;
    this.client = null;
    if (this.stopping) return;
    this.log.warn("lost connection to broker; re-electing");
    this.emit("disconnected");
    this.scheduleReconnect(jitter());
  }

  private onEvent(ev: string, data: unknown): void {
    if (ev === "mail_retracted") {
      for (const id of (data as { ids: string[] }).ids) this.inbox.delete(id);
    } else if (ev === "shared_job_control") {
      this.emit("shared_job_control", data as BridgeNodeEvents["shared_job_control"][0]);
    } else if (ev === "jobs_changed") {
      const ids = new Set((data as { withdrawn: string[] }).withdrawn.map((id) => `job:${id}`));
      for (const [id, m] of this.inbox) if (ids.has(m.from.id)) this.inbox.delete(id);
      this.emit("jobs_changed");
    } else if (ev === "inline_job_control") {
      this.emit("inline_job_control", data as BridgeNodeEvents["inline_job_control"][0]);
    } else if (ev === "message") {
      const m = data as BridgeMessage;
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
      if (ev === "peer_joined" && this.opts.dbPath !== ":memory:") recordStorePeer(dirname(this.opts.dbPath), data as PeerInfo);
      this.emit(ev, data as PeerInfo);
    } else if (ev === "replaced") {
      // A newer server of this same session took over (e.g. /reload-plugins): stay away instead of rejoining.
      this.log.info("replaced by a newer server of this session; leaving the bridge", { by: (data as { by?: string })?.by });
      this.replaced = true;
      // Retiring this session's connection must not evict every other session. The process still
      // owns the elected listener until actual shutdown; reclaim can reconnect to that listener.
      void this.stop(false).catch((err) => this.log.warn("could not retire replaced connection", { err: String(err) }));
      this.emit("replaced");
    }
  }

  private async withClient<T>(fn: (c: BridgeClient) => Promise<T>): Promise<T> {
    await this.ensureConnected();
    return fn(this.client!);
  }

  /** quiet: not part of a conversation of this agent (no listen window, replies are not awaited), e.g. control messages to a job runner. */
  send(args: SendArgs, opts: { quiet?: boolean } = {}): Promise<SendResult> {
    return this.withClient(async (c) => {
      const res = await c.request("send", args);
      if (opts.quiet) return res;
      this.lastSent = Date.now();
      if (!args.replyTo) for (const m of res.messages) this.asked.add(m.id);
      if (this.asked.size > QUESTION_ID_MEMORY) this.asked.delete(this.asked.values().next().value!);
      return res;
    });
  }

  /** A reply to a question this peer asked (so the answer should reach the agent even when it is idle). */
  isAwaitedReply(m: BridgeMessage): boolean {
    return m.replyTo !== null && this.asked.has(m.replyTo);
  }

  /** When this peer last sent a message (0 = never); marks it as taking part in a conversation. */
  get lastSentAt(): number {
    return this.lastSent;
  }

  messageReceipt(id: string) {
    return this.withClient((c) => c.request("messageReceipt", { id }));
  }

  peers(): Promise<PeerInfo[]> {
    return this.withClient((c) => c.request("peers", {})).then((peers) => peers.filter((p) => !isPluginCacheCwd(p.cwd)));
  }

  projectJobs(): Promise<Record<string, unknown>[]> { return this.withClient((c) => c.request("projectJobs", {})); }
  jobRecipient(job: string): Promise<string> { return this.withClient((c) => c.request("jobRecipient", { job })); }
  async setUnavailable(unavailable: boolean): Promise<PeerInfo> {
    const peer = await this.withClient((c) => c.request("coordinatorAvailability", { unavailable }));
    this.unavailable = unavailable;
    return peer;
  }
  setProjectMain(to: string): Promise<PeerInfo> { return this.withClient((c) => c.request("projectMain", { to })); }
  async handoffSubagents(args: import("./job-handoff.js").HandoffArgs): Promise<import("./job-handoff.js").HandoffReceipt> {
    // Inline results used to bypass the broker. Retain their unread envelopes before transferring.
    return this.withClient(async (c) => {
      for (const m of this.unread()) if (m.from.id.startsWith("job:")) {
        const job = await c.request("jobAuthority", { job: m.from.name });
        if (job && (job.owner === this.name || job.rootName === this.name)) await c.request("inlineJobReport", m);
      }
      return c.request("handoffSubagents", args);
    });
  }

  jobAuthority(job: string): Promise<import("../mcp/jobs.js").Job | null> {
    return this.withClient((c) => c.request("jobAuthority", { job }));
  }

  controlInlineJob(job: string, control: import("../mcp/jobs.js").RunnerControl): Promise<unknown> {
    return this.withClient((c) => c.request("inlineJobControl", { job, control }));
  }

  reportInlineJob(message: BridgeMessage): Promise<unknown> {
    return this.withClient((c) => c.request("inlineJobReport", message));
  }

  decide(args: DecideArgs): Promise<{ decision: OwnerDecision; deliveredTo: string[] }> {
    return this.withClient((c) => c.request("decide", args));
  }

  searchHistory(args: HistorySearch): Promise<HistoryResult> {
    return this.withClient((c) => c.request("searchHistory", args));
  }

  reindexHistory(reset = false): Promise<{ work: number; discovering: boolean }> {
    return this.withClient((c) => c.request("reindexHistory", { reset }));
  }

  decisions(args: DecisionsArgs = {}): Promise<OwnerDecision[]> {
    return this.withClient((c) => c.request("decisions", args));
  }

  siblings(): Promise<SiblingPeer[]> {
    return this.withClient((c) => c.request("siblings", {}));
  }

  sendSibling(args: SendArgs, maxHops: number): Promise<SendResult> {
    return this.withClient((c) => c.request("sendSibling", { ...args, maxHops }));
  }

  async updateJob(patch: { jobParent?: string; jobTitle?: string }): Promise<void> {
    Object.assign(this.opts, patch);
    if (this.isConnected) await this.client!.request("updatePeer", patch);
  }

  networkStatus(): Promise<NetworkStatus> {
    return this.withClient((c) => c.request("networkStatus", {}));
  }

  remoteJob(host: string, request: RemoteJobRequest): Promise<RemoteJobSnapshot> {
    return this.withClient((c) => c.request("remoteJob", { host, request }, REMOTE_JOB_LOCAL_TIMEOUT_MS)).catch((err) => {
      if (/unknown op.*remoteJob/.test((err as Error).message)) throw new BridgeError("bad_request", "Local broker update needed: restart its hosting sessions to enable remote jobs.");
      throw err;
    });
  }

  sendFiles(to: string, paths: string[]): Promise<TransferResult | TransferStarted> {
    return this.withClient((c) => c.request("sendFiles", { to, paths }));
  }

  fetchFiles(from: string, paths: string[]): Promise<TransferStarted> {
    return this.withClient((c) => c.request("fetchFiles", { from, paths }));
  }

  cancelTransfer(id: string): Promise<{ id: string; cancelled: boolean }> {
    return this.withClient((c) => c.request("cancelTransfer", { id }));
  }

  /** Locally buffered unread messages, oldest first. */
  unread(): BridgeMessage[] {
    return [...this.inbox.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Look up a message by id: one we still hold, or remembered as read. */
  hasSeen(id: string): boolean {
    return this.inbox.has(id) || this.readIds.has(id);
  }

  get(id: string): BridgeMessage | undefined {
    return this.inbox.get(id);
  }

  /**
   * Put a message into this peer's own inbox without going through the broker, e.g. the result of a
   * background subagent. It is handled exactly like a peer message (hooks, wait_for_message, channel).
   */
  deliverLocal(m: BridgeMessage): void {
    try { recordLocalResult(dirname(this.opts.dbPath), m); }
    catch (err) { this.log.warn("could not retain local result receipt", { id: m.id, err: String(err) }); }
    this.onEvent("message", m);
  }

  /** Mark messages consumed locally and on the broker. */
  markRead(ids: string[]): void {
    const real = ids.filter((id) => this.inbox.has(id));
    if (!real.length) return;
    this.readJournal.append(`name:${this.currentName}`, real);
    if (this.sessionId) this.readJournal.append(`session:${this.sessionId}`, real);
    const messages = real.map((id) => this.inbox.get(id)!);
    for (const id of real) {
      this.inbox.delete(id);
      this.readIds.add(id);
    }
    this.acknowledge(real);
    // Complete notification waits only after the durable delivery receipt, never on arrival or hand-out.
    try { this.notificationConsumed(messages); }
    catch (err) { this.log.warn("could not archive completed notification wait", { err: String(err) }); }
  }

  setNotificationWaitHandlers(matches: (m: BridgeMessage) => boolean, consumed: (messages: BridgeMessage[]) => void): void {
    this.notificationMatch = matches;
    this.notificationConsumed = consumed;
  }

  isNotificationAwaited(m: BridgeMessage): boolean { return this.notificationMatch(m); }
  notificationWaitsChanged(): void { this.emit("notification_waits_changed"); }

  private restoreReadState(identity: string): void {
    for (const id of this.readJournal.read(identity)) this.readIds.add(id);
    const consumed = [...this.inbox.keys()].filter((id) => this.readIds.has(id));
    consumed.forEach((id) => this.inbox.delete(id));
    this.acknowledge(consumed);
  }

  private acknowledge(ids: string[]): void {
    if (!ids.length) return;
    if (!this.isConnected) {
      ids.forEach((id) => this.unflushedAcks.add(id));
      return;
    }
    this.client!.request("ack", { ids }).catch((err) => {
      this.log.warn("ack failed; will retry after reconnect", { err: (err as Error).message });
      ids.forEach((id) => this.unflushedAcks.add(id));
    });
  }

  /** Resolves with the next unread message (possibly one already waiting), or null on timeout. */
  waitForMessage(timeoutMs: number, predicate: (m: BridgeMessage) => boolean = () => true, signal?: AbortSignal): Promise<BridgeMessage | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const existing = this.unread().find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const done = (m: BridgeMessage | null) => {
        clearTimeout(timer);
        this.off("message", onMessage);
        this.off("notification_waits_changed", onChanged);
        this.off("replaced", onAbort);
        this.off("stopped", onAbort);
        signal?.removeEventListener("abort", onAbort);
        resolve(m);
      };
      const onMessage = (m: BridgeMessage) => {
        if (predicate(m)) done(m);
      };
      const onAbort = () => done(null);
      const onChanged = () => { const m = this.unread().find(predicate); if (m) done(m); };
      const timer = setTimeout(() => done(null), timeoutMs);
      this.on("message", onMessage);
      this.on("notification_waits_changed", onChanged);
      this.once("replaced", onAbort);
      this.once("stopped", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async setSessionId(sessionId: string | null): Promise<void> {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    // The broker may hand us the name of an older server of this session that we replace.
    if (this.isConnected) this.currentName = (await this.client!.request("updatePeer", { sessionId })).name;
    if (sessionId) this.restoreReadState(`session:${sessionId}`);
    this.notificationWaitsChanged();
  }

  /** Report busy/idle to the broker so peers can see who is free. Only changes are sent. */
  setActivity(state: PeerActivity): void {
    if (state === this.activity) return;
    this.activity = state;
    if (this.isConnected) {
      this.client!.request("updatePeer", { activity: state }).catch((err) => this.log.debug("activity update failed", { err: (err as Error).message }));
    }
  }

  async setWakePolicy(wakeOnDirect: boolean, wakeAvailable: boolean, wakeMaxHops = DEFAULT_MAX_HOPS): Promise<void> {
    this.wakeOnDirect = wakeOnDirect;
    this.wakeAvailable = wakeAvailable;
    this.wakeMaxHops = wakeMaxHops;
    if (this.isConnected) await this.client!.request("updatePeer", { wakeOnDirect, wakeAvailable, wakeMaxHops });
  }

  async setAutoWake(enabled: boolean): Promise<void> {
    this.autoWake = enabled;
    if (this.isConnected) await this.client!.request("updatePeer", { autoWake: enabled });
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get cwd(): string {
    return this.currentCwd;
  }

  /**
   * Record the real project directory once the host tells us (hook input carries it). When a new
   * name is given, the peer is renamed as well.
   */
  async relocate(cwd: string, name?: string): Promise<void> {
    if (cwd === this.currentCwd && (!name || name === this.currentName)) return;
    this.currentCwd = cwd;
    if (name) this.currentName = name;
    this.log.info("peer relocated", { cwd, name: this.currentName });
    if (this.isConnected) {
      const peer = await this.client!.request("updatePeer", { cwd, ...(name ? { name } : {}) });
      this.currentName = peer.name;
    }
  }
}
