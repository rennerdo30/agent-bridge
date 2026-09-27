import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import { Broker } from "./broker.js";
import { BridgeClient } from "./client.js";
import {
  ELECTION_MAX_ATTEMPTS,
  ELECTION_RETRY_MAX_MS,
  ELECTION_RETRY_MIN_MS,
  PROTOCOL_VERSION,
} from "./constants.js";
import type { Logger } from "./logger.js";
import type { AgentKind, BridgeMessage, PeerInfo, SendArgs, SendResult } from "./protocol.js";
import { MessageStore } from "./store.js";

export interface BridgeNodeOptions {
  pipePath: string;
  dbPath: string;
  agent: AgentKind;
  name: string;
  cwd: string;
  autoWake: boolean;
  log: Logger;
  platform?: NodeJS.Platform;
}

export interface BridgeNodeEvents {
  message: [BridgeMessage];
  peer_joined: [PeerInfo];
  peer_left: [PeerInfo];
  connected: [{ name: string; isBroker: boolean }];
  disconnected: [];
}

/** Remember ids of messages we already consumed so a backlog redelivery after reconnect is ignored. */
const READ_ID_MEMORY = 2_000;

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
  readonly id = randomUUID();
  private client: BridgeClient | null = null;
  private broker: Broker | null = null;
  private stopping = false;
  private electing: Promise<void> | null = null;
  private currentName: string;
  private readonly inbox = new Map<string, BridgeMessage>();
  private readonly readIds = new Set<string>();
  private readonly unflushedAcks = new Set<string>();
  private sessionId: string | null = null;
  private autoWake: boolean;
  private currentCwd: string;
  private readonly log: Logger;

  constructor(private readonly opts: BridgeNodeOptions) {
    super();
    this.currentName = opts.name;
    this.currentCwd = opts.cwd;
    this.autoWake = opts.autoWake;
    this.log = opts.log.child("node");
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

  async stop(): Promise<void> {
    this.stopping = true;
    this.client?.close();
    this.client = null;
    if (this.broker) await this.broker.close();
    this.broker = null;
    this.log.info("bridge node stopped");
  }

  /** Connects (electing a broker if needed). Concurrent callers share one attempt. */
  ensureConnected(): Promise<void> {
    if (this.isConnected) return Promise.resolve();
    this.electing ??= this.elect().finally(() => {
      this.electing = null;
    });
    return this.electing;
  }

  private async elect(): Promise<void> {
    for (let attempt = 1; attempt <= ELECTION_MAX_ATTEMPTS && !this.stopping; attempt++) {
      try {
        const client = await BridgeClient.connect(this.opts.pipePath, this.log.child("client"));
        await this.adopt(client);
        return;
      } catch (err) {
        const code = errCode(err);
        this.log.debug("connect attempt failed", { attempt, code, message: (err as Error).message });
        if (code !== "ENOENT" && code !== "ECONNREFUSED") {
          await sleep(jitter());
          continue;
        }
      }
      // Nobody is listening: try to become the broker.
      if (await this.tryBecomeBroker()) continue; // next loop iteration connects to ourselves
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
      this.log.error("cannot open message store", { err, db: this.opts.dbPath });
      throw err;
    }
    const broker = new Broker(this.opts.pipePath, store, this.log.child("broker"));
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
    const hello = await client.request("hello", {
      protocol: PROTOCOL_VERSION,
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
      },
    });
    this.client = client;
    this.currentName = hello.name;
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
    setTimeout(() => {
      this.ensureConnected().catch((err) => this.log.error("re-election failed", { err: (err as Error).message }));
    }, jitter()).unref();
  }

  private onEvent(ev: string, data: unknown): void {
    if (ev === "message") {
      const m = data as BridgeMessage;
      if (this.readIds.has(m.id) || this.inbox.has(m.id)) return;
      this.inbox.set(m.id, m);
      this.log.debug("message received", { id: m.id, from: m.from.name, hop: m.hop });
      this.emit("message", m);
    } else if (ev === "peer_joined" || ev === "peer_left") {
      this.emit(ev, data as PeerInfo);
    }
  }

  private async withClient<T>(fn: (c: BridgeClient) => Promise<T>): Promise<T> {
    await this.ensureConnected();
    return fn(this.client!);
  }

  send(args: SendArgs): Promise<SendResult> {
    return this.withClient((c) => c.request("send", args));
  }

  peers(): Promise<PeerInfo[]> {
    return this.withClient((c) => c.request("peers", {}));
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

  /** Mark messages consumed locally and on the broker. */
  markRead(ids: string[]): void {
    const real = ids.filter((id) => this.inbox.delete(id));
    for (const id of real) {
      this.readIds.add(id);
      if (this.readIds.size > READ_ID_MEMORY) this.readIds.delete(this.readIds.values().next().value!);
    }
    if (real.length === 0) return;
    if (!this.isConnected) {
      real.forEach((id) => this.unflushedAcks.add(id));
      return;
    }
    this.client!.request("ack", { ids: real }).catch((err) => {
      this.log.warn("ack failed; will retry after reconnect", { err: (err as Error).message });
      real.forEach((id) => this.unflushedAcks.add(id));
    });
  }

  /** Resolves with the next unread message (possibly one already waiting), or null on timeout. */
  waitForMessage(timeoutMs: number, predicate: (m: BridgeMessage) => boolean = () => true, signal?: AbortSignal): Promise<BridgeMessage | null> {
    const existing = this.unread().find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const done = (m: BridgeMessage | null) => {
        clearTimeout(timer);
        this.off("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
        resolve(m);
      };
      const onMessage = (m: BridgeMessage) => {
        if (predicate(m)) done(m);
      };
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), timeoutMs);
      this.on("message", onMessage);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async setSessionId(sessionId: string | null): Promise<void> {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    if (this.isConnected) await this.client!.request("updatePeer", { sessionId });
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
