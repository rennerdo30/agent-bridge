import { randomUUID } from "node:crypto";
import { retryRequest, transientRequestError } from "./request-retry.js";
import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Broker } from "./broker.js";
import { isPluginCacheCwd } from "./session-visibility.js";
import { BridgeClient, brokerConnectionClosedError } from "./client.js";
import {
  ELECTION_MAX_ATTEMPTS,
  ELECTION_RETRY_MAX_MS,
  CONNECT_TIMEOUT_MS,
  APP_VERSION,
  DEFAULT_MAX_HOPS,
  ELECTION_RETRY_MIN_MS,
  JOBS_FILE,
  PROTOCOL_VERSION,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_MIN_MS,
} from "./constants.js";
import type { Logger } from "./logger.js";
import { BridgeError, isQuietMessage, isUnsupportedOperation, type AgentKind, type BridgeMessage, type PeerActivity, type PeerInfo, type RequestMap, type SendArgs, type SendResult, type SiblingPeer } from "./protocol.js";
import { completionMessageId, COMPLETION_DEDUPE_PREFIX } from "./completion.js";
import { ReadJournal } from "./read-journal.js";
import { existingMetadataDb, retainMetadataReader } from "./metadata-db.js";
import { recordLocalResult } from "./local-result-receipts.js";
import type { MessageStore } from "./store.js";
import { SQLITE_STORE_VERSION } from "./store-version.js";
import { JSON_STORE_VERSION } from "./json-store.js";
import { recordStorePeer, refreshStorePeerIdentities } from "./store-compatibility.js";
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
  private releaseMetadata: (() => void) | undefined;
  private readonly unflushedAcks = new Set<string>();
  private readonly pendingAcks = new Set<Promise<unknown>>();
  private pendingRefreshTimer: NodeJS.Timeout | null = null;
  private refreshingPending: Promise<void> | null = null;
  private ackFlushScheduled = false;
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
  private presenceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: BridgeNodeOptions) {
    super();
    this.id = opts.id ?? randomUUID();
    this.currentName = opts.name;
    this.currentCwd = opts.cwd;
    this.autoWake = opts.autoWake;
    this.log = opts.log.child("node");
    if (opts.dbPath !== ":memory:") this.recordStorePresence();
    if (opts.dbPath !== ":memory:") this.releaseMetadata = retainMetadataReader(dirname(opts.dbPath));
    this.readJournal = new ReadJournal(opts.dbPath === ":memory:" ? ":memory:" : dirname(opts.dbPath), this.log);
    this.restoreReadState(`name:${this.currentName}`);
  }

  /**
   * Publish this process's store capabilities. A deferred metadata store (an older reader, or this
   * process's identity not yet verifiable for the fail-closed migration lease) must never stop the
   * node from starting: the record then stays in its pre-AB-208 file, and this retries with backoff
   * until the store opens and holds the row.
   */
  private recordStorePresence(delay = 1_000): void {
    const home = dirname(this.opts.dbPath);
    let error: unknown;
    try { recordStorePeer(home, { pid: process.pid, name: this.currentName, version: APP_VERSION, storeCapabilities: { json: JSON_STORE_VERSION, sqlite: SQLITE_STORE_VERSION, jobArchive: 1 } }); }
    catch (err) { error = err; }
    let open = false;
    try { open = Boolean(existingMetadataDb(home)); } catch { /* Not open yet. */ }
    if (open && !error) return;
    if (error && delay === 1_000) this.log.warn("store presence deferred; retrying in the background", { err: String((error as Error).message ?? error) });
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => { this.presenceTimer = null; if (!this.stopping) this.recordStorePresence(Math.min(60_000, delay * 2)); }, delay);
    this.presenceTimer.unref();
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
    if (!this.releaseMetadata && this.opts.dbPath !== ":memory:") this.releaseMetadata = retainMetadataReader(dirname(this.opts.dbPath));
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
    if (this.pendingRefreshTimer) clearTimeout(this.pendingRefreshTimer);
    this.pendingRefreshTimer = null;
    this.client?.close();
    this.client = null;
    if (closeBroker) {
      if (this.broker) await this.broker.close();
      this.broker = null;
    }
    // An election that was already past its stopping check may still finish now. Wait for it, so a broker it
    // started (listener, bridge.db, archive.db and history.db handles) is closed here instead of outliving stop().
    const electing = this.electing;
    if (electing) {
      await electing.catch(() => {});
      (this.client as BridgeClient | null)?.close();
      this.client = null;
      const late = this.broker as Broker | null;
      if (closeBroker && late) { await late.close(); this.broker = null; }
    }
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    this.log.info("bridge node stopped");
    this.releaseMetadata?.(); this.releaseMetadata = undefined;
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
        // Another user's short-socket directory stays unsafe however often we retry.
        if (code === "EUNSAFESOCKETDIR") throw err;
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
    if (this.stopping) return false;
    const [{ Broker }, { MessageStore }] = await Promise.all([import("./broker.js"), import("./store.js")]);
    let store: MessageStore;
    try {
      // Unverified living readers conservatively defer upgrades; process
      // discovery must not delay hosting their existing compatible schema.
      if (this.opts.dbPath !== ":memory:") void refreshStorePeerIdentities(dirname(this.opts.dbPath)).catch(error => this.log.debug("store reader identity refresh deferred", { err: String(error) }));
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
      if (this.stopping) {
        // stop() ran while this node was opening the store or listening: never keep a broker nobody will close.
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
    let brokerVersion: string | undefined;
    // Read presence before hello can trigger writes in a newer broker.
    try {
      await client.request("auth", { protocol: PROTOCOL_VERSION, token: this.opts.token });
      brokerVersion = (await client.request("ping", {})).brokerVersion;
      if (this.opts.dbPath !== ":memory:") for (const peer of await client.request("peers", {})) recordStorePeer(dirname(this.opts.dbPath), peer);
    } catch (error) { client.close(); throw error; }
    const agentStartedAt = this.opts.jobAgent ? null : await parentProcessIdentity();
    const args = this.helloArgs();
    // Older brokers publish hello capabilities directly to their observers,
    // which then rewrite each foreign PID record using their legacy shape.
    // Our own explicit record already protects upgrades before registration.
    const hello = await client.request("hello", { ...args, peer: { ...args.peer, agentStartedAt,
      storeCapabilities: brokerVersion === APP_VERSION ? args.peer.storeCapabilities : undefined } }).catch((err) => {
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
        storeCapabilities: { json: JSON_STORE_VERSION, sqlite: SQLITE_STORE_VERSION, jobArchive: 1 },
        ...(this.opts.jobAgent ? { jobAgent: this.opts.jobAgent } : {}),
        ...(this.opts.jobOwner ? { jobOwner: this.opts.jobOwner, jobParent: this.opts.jobParent, parentJob: this.opts.parentJob, rootSession: this.opts.rootSession, rootName: this.opts.rootName, jobTitle: this.opts.jobTitle, jobSendTo: this.opts.jobSendTo } : {}),
      },
    };
  }

  private afterHello(client: BridgeClient, hello: { name: string; brokerPid: number; sessionId?: string | null }): void {
    if (this.stopping) { client.close(); return; }
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

  private onClose(client: BridgeClient): void {
    if (this.client !== client) return;
    this.client = null;
    if (this.stopping) return;
    this.log.warn("lost connection to broker; re-electing");
    this.emit("disconnected");
    // Established hosts must replace a lost listener immediately. Legacy job
    // runners already add their own reconnect jitter; delaying the eligible
    // host as well compounds the outage. Contending hosts still back off in
    // elect() when another process wins or holds the store migration lock.
    this.scheduleReconnect(this.opts.canHostBroker === false ? jitter() : 0);
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

  /** A read may cross listener retirement; retry only that actual closed socket once. */
  private async withReadClient<T>(fn: (c: BridgeClient, timeoutMs?: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const cancelled = new AbortController();
    const stopped = () => cancelled.abort(new Error("bridge node stopped"));
    const aborted = () => cancelled.abort(signal?.reason);
    this.on("stopped", stopped);
    signal?.addEventListener("abort", aborted, { once: true });
    if (this.stopping) stopped();
    if (signal?.aborted) aborted();
    const wait = (pending: Promise<T>) => new Promise<T>((resolve, reject) => {
      const abort = () => { cancelled.signal.removeEventListener("abort", abort); reject(cancelled.signal.reason); };
      cancelled.signal.addEventListener("abort", abort, { once: true });
      pending.then(value => { cancelled.signal.removeEventListener("abort", abort); resolve(value); }, error => { cancelled.signal.removeEventListener("abort", abort); reject(error); });
      if (cancelled.signal.aborted) abort();
    });
    let usedClient: BridgeClient | null = null;
    const invoke = async (timeoutMs?: number) => {
      cancelled.signal.throwIfAborted();
      const before = this.client;
      await this.ensureConnected();
      cancelled.signal.throwIfAborted();
      usedClient = this.client ?? before;
      if (!usedClient || usedClient.isClosed) throw brokerConnectionClosedError();
      return fn(usedClient, timeoutMs);
    };
    try {
      try { return await wait(invoke()); }
      catch (error) {
        if (cancelled.signal.aborted || this.stopping || errCode(error) !== "BROKER_CONNECTION_CLOSED" || !(usedClient as BridgeClient | null)?.isClosed) throw error;
      }
      const timer = setTimeout(() => cancelled.abort(Object.assign(new Error("broker read reconnect timed out"), { code: "ETIMEDOUT" })), CONNECT_TIMEOUT_MS);
      try { return await wait(invoke(CONNECT_TIMEOUT_MS)); }
      finally { clearTimeout(timer); }
    } finally {
      this.off("stopped", stopped);
      signal?.removeEventListener("abort", aborted);
    }
  }

  /** quiet: not part of a conversation of this agent (no listen window, replies are not awaited), e.g. control messages to a job runner. */
  send(args: SendArgs, opts: { quiet?: boolean } = {}): Promise<SendResult> {
    const request = { ...args, dedupeKey: args.dedupeKey || randomUUID() };
    const messageId = args.messageId ?? (args.dedupeKey?.startsWith(COMPLETION_DEDUPE_PREFIX) && this.opts.jobAgent
      ? completionMessageId(this.id, args.dedupeKey.slice(COMPLETION_DEDUPE_PREFIX.length))
      : args.dedupeKey ? completionMessageId(`send:${this.name}`, args.dedupeKey) : randomUUID());
    let submitted = false;
    return this.withClient(async (c) => {
      if (args.ifNoNewerThan) {
        // inbox marks consumed locally before its batched ack. A guarded reply must observe
        // those acknowledgements, otherwise it can reject the mail the caller just reviewed.
        await Promise.all([...this.pendingAcks]);
        while (this.unflushedAcks.size) {
          const ids = [...this.unflushedAcks].slice(0, 500);
          await c.request("ack", { ids });
          ids.forEach(id => this.unflushedAcks.delete(id));
        }
      }
      submitted = true;
      const res = args.dedupeKey?.startsWith(COMPLETION_DEDUPE_PREFIX) && !args.messageId
        ? await this.sendRequest(c, "send", request)
        : await this.trackedSend(c, { ...request, messageId }, Boolean(args.messageId));
      if (opts.quiet) return res;
      this.lastSent = Date.now();
      if (!args.replyTo) for (const m of res.messages) this.asked.add(m.id);
      if (this.asked.size > QUESTION_ID_MEMORY) this.asked.delete(this.asked.values().next().value!);
      return res;
    }).catch((error) => {
      if (submitted) throw error;
      // Connection/guarded-ack failure precedes submission. A caller-supplied
      // identity may nevertheless refer to a previously stored attempt.
      throw new BridgeError(error instanceof BridgeError ? error.code : "internal",
        `This send attempt was not submitted; message ${messageId} storage state is unknown: ${(error as Error).message}. Query send_status or retry send with message_id="${messageId}".`,
        { ...(error instanceof BridgeError ? error.details : {}), messageId, state: "unknown", submitted: false });
    });
  }

  sendState(id: string): Promise<RequestMap["sendState"][1]> {
    return this.withClient(c => c.request("sendState", { id }));
  }

  private async trackedSend(client: BridgeClient, args: RequestMap["trackedSend"][0], explicitId: boolean): Promise<SendResult> {
    try { return await client.request("trackedSend", args); }
    catch (error) {
      if (isUnsupportedOperation(error, "trackedSend")) {
        if (explicitId || args.ifNoNewerThan) throw error;
        // An explicit refusal proves nothing was applied. Legacy sends retain their own dedupe key.
        const { messageId: _unused, ...legacy } = args;
        return this.sendRequest(client, "send", legacy);
      }
      if (!transientRequestError(error)) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError("internal", `Storage cannot be confirmed for message ${args.messageId}; storage state is unknown: ${(error as Error).message}. Query send_status(message_id="${args.messageId}") or retry send with the same message_id.`, { messageId: args.messageId, state: "unknown" });
      }
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        return await client.request("trackedSend", args);
      }
      catch (retryError) {
        if (retryError instanceof BridgeError && retryError.code !== "internal" && retryError.code !== "timeout") throw retryError;
        try {
          const state = await client.request("sendState", { id: args.messageId });
          if (state.message) {
            const message = state.message;
            if (!(message.body === args.body || message.body.startsWith(args.body + "\n\n[agent-bridge routing hint:")) ||
                !this.opts.jobAgent && message.to !== args.to.trim() || message.replyTo !== (args.replyTo?.trim() || null) ||
                args.conversationId && message.conversationId !== args.conversationId.trim() &&
                !(this.opts.jobAgent && message.conversationId === args.conversationId.trim() + ":fallback")) {
              throw new BridgeError("bad_request", "Message id already stored with different content.", { messageId: state.id, state: "stored" });
            }
            return { messages: [message], deliveredTo: [], queuedFor: [],
              storage: { id: state.id, state: "stored", recovered: true, receipts: state.receipts } };
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
  private async sendRequest<O extends "send" | "sendSibling" | "guardedSend">(client: BridgeClient, op: O, args: RequestMap[O][0]): Promise<SendResult> {
    try { return await client.request(op, args); }
    catch (err) {
      if ((err as Error).message !== `broker request timed out: ${op}`) {
        if (err instanceof BridgeError && err.code !== "internal" && err.code !== "timeout") throw err;
        throw new BridgeError(err instanceof BridgeError ? err.code : "internal", `Message storage state is unknown after ${op}: ${(err as Error).message}. This legacy operation has no durable send_status identity; check inbox/history before resending.`, { ...(err instanceof BridgeError ? err.details : {}), state: "unknown", dedupeKey: args.dedupeKey });
      }
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        return await client.request(op, args);
      }
      catch (retryError) {
        throw new BridgeError("timeout", `Message storage state is unknown after a timed-out ${op}. This legacy operation has no durable send_status identity; check inbox/history before resending. ${(retryError as Error).message}`, { state: "unknown", dedupeKey: args.dedupeKey });
      }
    }
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

  peers(signal?: AbortSignal): Promise<PeerInfo[]> {
    return this.withReadClient((c, timeoutMs) => c.request("peers", {}, timeoutMs), signal).then((peers) => peers.filter((p) => !isPluginCacheCwd(p.cwd)));
  }

  health(): Promise<import("./health.js").BrokerHealth> {
    const started = performance.now();
    return this.withClient(c => c.request("health", {})).then(health => ({ ...health, roundTripMs: performance.now() - started }));
  }

  brokerLoad() {
    return this.withClient((c) => c.request("brokerLoad", {}));
  }

  projectJobs(): Promise<Record<string, unknown>[]> { return this.withClient((c) => c.request("projectJobs", {})); }
  jobRecipient(job: string): Promise<string> { return retryRequest("jobRecipient (read only; no control submitted)", () => this.withClient((c) => c.request("jobRecipient", { job }))); }
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
    return retryRequest("jobAuthority (read only; no control submitted)", () => this.withClient((c) => c.request("jobAuthority", { job })));
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

  askOwner(args: import("./owner-questions.js").AskOwnerArgs): Promise<RequestMap["askOwner"][1]> {
    return this.withClient(c => c.request("askOwner", args));
  }

  dismissOwner(args: RequestMap["dismissOwner"][0]): Promise<RequestMap["dismissOwner"][1]> {
    return this.withClient(c => c.request("dismissOwner", args));
  }

  getConversation(args: import("./conversations.js").ConversationRequest): Promise<import("./conversations.js").ConversationPage> {
    return this.withClient((c) => c.request("getConversation", args));
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
    let submitted = false;
    return this.withClient((c) => {
      submitted = true;
      return this.sendRequest(c, "sendSibling", { ...args, maxHops, dedupeKey: args.dedupeKey || randomUUID() });
    }).catch(error => {
      if (submitted) throw error;
      throw new BridgeError(error instanceof BridgeError ? error.code : "internal", `This sibling send attempt was not submitted; message storage state is unknown: ${(error as Error).message}. Check inbox/history for previous attempts before resending.`, { state: "unknown", submitted: false });
    });
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

  /** A replay is bounded to 500 rows. Active hooks refill after receipts so the tail cannot strand. */
  refreshPending(): Promise<void> {
    this.refreshingPending ??= this.readPending().finally(() => { this.refreshingPending = null; });
    return this.refreshingPending;
  }

  private async readPending(): Promise<void> {
    if (!this.isConnected) return;
    await Promise.all(this.pendingAcks);
    if (this.unflushedAcks.size) {
      const ids = [...this.unflushedAcks];
      await this.client!.request("ack", { ids });
      ids.forEach((id) => this.unflushedAcks.delete(id));
    }
    const messages = await this.client!.request("pending", { limit: 500 });
    for (const m of messages) this.onEvent("message", m);
  }

  /** Refill channel/wake consumers too; active hooks are not required to drain a large inbox. */
  private schedulePendingRefresh(delayMs = 100): void {
    if (this.stopping || this.pendingRefreshTimer) return;
    this.pendingRefreshTimer = setTimeout(() => {
      this.pendingRefreshTimer = null;
      if (!this.isConnected || this.stopping) return;
      void this.refreshPending().catch((err) => {
        this.log.warn("pending recovery deferred", { err: String(err) });
        this.schedulePendingRefresh(1_000);
      });
    }, delayMs);
    this.pendingRefreshTimer.unref();
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
    try { if (this.opts.dbPath !== ":memory:") recordLocalResult(dirname(this.opts.dbPath), m); }
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
    ids.forEach((id) => this.unflushedAcks.add(id));
    if (!this.isConnected || this.ackFlushScheduled) return;
    // A channel can consume hundreds of replayed messages in one stream chunk. One ack per
    // message would exceed the broker's per-connection request cap and interrupt its own drain.
    this.ackFlushScheduled = true;
    setImmediate(() => {
      this.ackFlushScheduled = false;
      if (!this.isConnected || !this.unflushedAcks.size) return;
      const batch = [...this.unflushedAcks].slice(0, 500);
      batch.forEach((id) => this.unflushedAcks.delete(id));
      const pending = this.client!.request("ack", { ids: batch }).catch((err) => {
        this.log.warn("ack failed; retained for pending recovery", { err: (err as Error).message });
        batch.forEach((id) => this.unflushedAcks.add(id));
      });
      this.pendingAcks.add(pending);
      void pending.finally(() => { this.pendingAcks.delete(pending); this.schedulePendingRefresh(); });
      if (this.unflushedAcks.size) this.acknowledge([...this.unflushedAcks]);
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
    this.recordOwnStorePeer();
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
    this.recordOwnStorePeer();
  }

  private recordOwnStorePeer(): void {
    if (this.opts.dbPath !== ":memory:") recordStorePeer(dirname(this.opts.dbPath), { pid: process.pid, name: this.currentName, version: APP_VERSION, storeCapabilities: { json: JSON_STORE_VERSION, sqlite: SQLITE_STORE_VERSION, jobArchive: 1 } }, { authoritative: true });
  }
}
