import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
  MAX_BODY_CHARS,
  MAX_FRAME_BYTES,
  MESSAGE_TTL_MS,
  PROTOCOL_VERSION,
  PURGE_INTERVAL_MS,
  QUEUED_MAIL_MAX_AGE_MS,
} from "./constants.js";
import type { Logger } from "./logger.js";
import {
  AGENT_KINDS,
  BROADCAST,
  BridgeError,
  encodeFrame,
  FrameDecoder,
  SIBLING_CONVERSATION_PREFIX,
  SIBLING_NOTE_SUFFIX,
  type AgentKind,
  type BridgeMessage,
  type EventFrame,
  type EventMap,
  type EventName,
  type Op,
  type PeerInfo,
  type RequestFrame,
  type RequestMap,
  type SiblingPeer,
} from "./protocol.js";
import { agentQueueKey, MessageStore } from "./store.js";
import { tokensEqual } from "./token.js";
import { retentionLimit } from "./json-store.js";
import { NetworkService, type NetworkStatus } from "../network/link.js";
import { writeNetworkConfig, type NetworkConfig } from "../network/config.js";
import { z } from "zod";
import { collectTransfer, MAX_TRANSFER_ENTRIES, receiveTransfer, type TransferResult } from "../network/files.js";
import { MAX_NETWORK_HOST_CHARS, MAX_PAIRING_CODE_CHARS, MAX_PORT } from "../network/constants.js";
import { DECISION_MESSAGE_HOP, MAX_DECISION_TEXT_CHARS, MAX_DECISION_TOPIC_CHARS, decisionApplies, decisionScopeSchema, type OwnerDecision } from "./decisions.js";

/** Peer names double as offline queue keys, so keep them simple and unambiguous. */
export const PEER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PENDING_DEFAULT_LIMIT = 50;
/** How long, and how many, send dedupe keys are remembered (retries come within minutes). */
const DEDUPE_KEEP_MS = 30 * 60 * 1000;
const DEDUPE_MAX = 5_000;
const PENDING_MAX_LIMIT = 500;
const NAME_SUFFIX_LIMIT = 100;
const SIBLING_STATUSES = new Set<SiblingPeer["status"]>(["running", "done", "failed", "interrupted"]);

type StoredSibling = SiblingPeer & { id: string };

interface Conn {
  socket: Socket;
  peer: PeerInfo | null;
  /** Presented the right token (via hello or auth). */
  authed: boolean;
}

/** Operations allowed before a connection has authenticated. */
const UNAUTHENTICATED_OPS = new Set<string>(["hello", "auth", "ping"]);

type Handler<O extends Op> = (conn: Conn, args: RequestMap[O][0]) => RequestMap[O][1] | Promise<RequestMap[O][1]>;

/**
 * The broker routes messages between peers. Exactly one process per endpoint runs it: whichever
 * agent-bridge MCP server bound the pipe first. It persists every message so peers that are offline,
 * or a broker hand-over, lose nothing.
 */
export class Broker {
  private server: Server | null = null;
  private readonly conns = new Set<Conn>();
  private purgeTimer: NodeJS.Timeout | null = null;
  private network: NetworkService | null = null;
  private networkChange: Promise<unknown> = Promise.resolve();
  private readonly handlers: { [O in Op]: Handler<O> };

  constructor(
    private readonly pipePath: string,
    private readonly store: MessageStore,
    private readonly log: Logger,
    private readonly token: string,
    private readonly now: () => number = Date.now,
    /** The supervisor's job registry, for siblings whose peers are not connected between turns. */
    private readonly jobsPath?: string,
    private readonly networking?: { home: string; config: NetworkConfig },
  ) {
    this.handlers = {
      auth: (c, a) => {
        this.checkAuth(a.protocol, a.token);
        c.authed = true;
        return { brokerPid: process.pid };
      },
      hello: (c, a) => this.onHello(c, a),
      send: (c, a) => this.onSend(c, a),
      decide: (c, a) => this.onDecide(c, a),
      decisions: (c, a) => this.onDecisions(c, a),
      peers: () => this.livePeers(),
      siblings: (c) => this.siblingPeers(c),
      sendSibling: (c, a) => this.onSendSibling(c, a),
      ack: (c, a) => ({ acked: this.store.markRead(this.requirePeer(c).name, a.ids ?? [], this.now()) }),
      pending: (c, a) =>
        this.store.unread(this.requirePeer(c).name, Math.min(Math.max(1, a.limit ?? PENDING_DEFAULT_LIMIT), PENDING_MAX_LIMIT)),
      updatePeer: (c, a) => this.onUpdatePeer(c, a),
      claimMail: (c, a) => this.onClaimMail(c, a),
      ping: () => ({ brokerPid: process.pid, protocol: PROTOCOL_VERSION }),
      networkStatus: () => this.network?.status() ?? { enabled: false, config: this.networking?.config, discovered: [], paired: [] },
      networkConfigure: (_, a) => {
        const change = this.networkChange.then(() => this.configureNetwork(a));
        this.networkChange = change.catch(() => {});
        return change;
      },
      networkVerify: (_, a) => this.requireNetwork().verify(z.uuid().parse(a.id)),
      networkPair: () => this.requireNetwork().keys.inviteWithExpiry(),
      networkLink: async (_, a) => {
        try {
          const args = z.object({ code: z.string().min(1).max(MAX_PAIRING_CODE_CHARS), host: z.string().min(1).max(MAX_NETWORK_HOST_CHARS), port: z.number().int().min(1).max(MAX_PORT) }).parse(a);
          return await this.requireNetwork().link(args.code, args.host, args.port);
        } catch { throw new BridgeError("bad_request", "Pairing failed. Check the address, code expiry, unique names and existing pairings."); }
      },
      networkUnlink: (_, a) => {
        const id = z.uuid().parse(a.id);
        const network = this.requireNetwork();
        const removed = network.status().paired.some((p) => p.id === id);
        network.unlink(id);
        return { removed };
      },
      sendFiles: (c, a) => this.onSendFiles(c, a),
    };
  }

  /** Bind the endpoint. Rejects with the socket error (EADDRINUSE when another broker owns it). */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket));
      const onError = (err: Error) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = async () => {
        server.removeListener("error", onError);
        server.on("error", (err) => this.log.error("broker server error", { err }));
        this.server = server;
        this.purgeTimer = setInterval(() => this.purge(), PURGE_INTERVAL_MS);
        this.purgeTimer.unref();
        this.purge();
        this.log.info("broker listening", { pipe: this.pipePath });
        if (this.networking?.config.enabled) {
          try {
            this.network = new NetworkService(this.networking.home, this.networking.config, {
              peers: () => [...this.conns].flatMap((c) => c.peer ? [c.peer] : []),
              receive: (message) => this.receiveRemote(message),
            }, this.log);
            await this.network.start();
          } catch (err) {
            this.network = null;
            this.log.warn("networking could not start; local broker remains available", { message: (err as Error).message });
          }
        }
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.pipePath);
    });
  }

  async close(): Promise<void> {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    await this.networkChange;
    await this.network?.close();
    this.network = null;
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    this.store.close();
    this.log.info("broker closed");
  }

  /** Serialize listener changes and let the elected broker remain the sole network writer. */
  private async configureNetwork(value: NetworkConfig): Promise<NetworkStatus> {
    if (!this.networking) throw new BridgeError("bad_request", "Restart all agent-bridge hosting sessions to load this wizard-capable broker.");
    const config = writeNetworkConfig(this.networking.home, value);
    await this.network?.close();
    this.network = null;
    this.networking.config = config;
    if (config.enabled) {
      const service = new NetworkService(this.networking.home, config, {
        peers: () => [...this.conns].flatMap((c) => c.peer ? [c.peer] : []),
        receive: (message) => this.receiveRemote(message),
      }, this.log);
      try { await service.start(); this.network = service; }
      catch (err) { await service.close(); throw err; }
    }
    return this.network?.status() ?? { enabled: false, config, discovered: [], paired: [] };
  }

  private purge(): void {
    try {
      const ttl = retentionLimit("AGENT_BRIDGE_MESSAGE_TTL_MS", MESSAGE_TTL_MS);
      if (ttl) this.store.purgeOlderThan(this.now() - ttl);
    } catch (err) {
      this.log.warn("purge failed", { err });
    }
  }

  private accept(socket: Socket): void {
    const conn: Conn = { socket, peer: null, authed: false };
    this.conns.add(conn);
    socket.setEncoding("utf8");
    const decoder = new FrameDecoder(MAX_FRAME_BYTES);
    this.log.debug("connection accepted");

    socket.on("data", (chunk: string) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this.log.warn("dropping connection after undecodable frame", { err });
        socket.destroy();
        return;
      }
      for (const f of frames) {
        if (f.t === "req") void this.dispatch(conn, f);
        else this.log.debug("ignoring non-request frame from client", { t: f.t });
      }
    });
    socket.on("error", (err) => this.log.debug("connection error", { err: err.message }));
    socket.on("close", () => {
      this.conns.delete(conn);
      if (conn.peer) {
        this.log.info("peer left", { name: conn.peer.name, agent: conn.peer.agent });
        if (!conn.peer.jobAgent) this.broadcastEvent("peer_left", conn.peer, conn);
      }
    });
  }

  private async dispatch(conn: Conn, frame: RequestFrame): Promise<void> {
    const handler = this.handlers[frame.op] as Handler<Op> | undefined;
    try {
      if (!handler) throw new BridgeError("bad_request", `unknown op: ${String(frame.op)}`);
      if (!conn.authed && !UNAUTHENTICATED_OPS.has(frame.op)) throw new BridgeError("unauthorized", "authenticate first");
      this.log.debug("request", { op: frame.op, peer: conn.peer?.name });
      const result = await handler(conn, (frame.args ?? {}) as never);
      this.write(conn, { t: "res", id: frame.id, ok: true, result });
    } catch (err) {
      const be = err instanceof BridgeError ? err : new BridgeError("internal", String((err as Error)?.message ?? err));
      if (be.code === "internal") this.log.error("request failed", { op: frame.op, err });
      else this.log.debug("request rejected", { op: frame.op, code: be.code, message: be.message });
      this.write(conn, { t: "res", id: frame.id, ok: false, error: be.toPayload() });
    }
  }

  private write(conn: Conn, frame: Parameters<typeof encodeFrame>[0]): void {
    if (!conn.socket.destroyed) conn.socket.write(encodeFrame(frame));
  }

  private emit<E extends EventName>(conn: Conn, ev: E, data: EventMap[E]): void {
    const frame: EventFrame<E> = { t: "evt", ev, data };
    this.write(conn, frame as EventFrame);
  }

  private broadcastEvent<E extends EventName>(ev: E, data: EventMap[E], except: Conn): void {
    for (const c of this.conns) if (c !== except && c.peer) this.emit(c, ev, data);
  }

  private requirePeer(conn: Conn): PeerInfo {
    if (!conn.peer) throw new BridgeError("not_registered", "send hello first");
    return conn.peer;
  }

  /** Local sessions and paired remote peers; local job runners stay hidden (see job-host.ts). */
  private livePeers(): PeerInfo[] {
    return [...this.conns].flatMap((c) => (c.peer && !c.peer.jobAgent ? [c.peer] : [])).concat(this.network?.peers() ?? []);
  }

  private connByName(name: string): Conn | undefined {
    for (const c of this.conns) if (c.peer?.name === name) return c;
    return undefined;
  }

  private siblingConns(conn: Conn): Conn[] {
    const peer = this.requirePeer(conn);
    if (!peer.jobAgent || !peer.jobOwner) throw new BridgeError("bad_request", "not a linked job");
    return [...this.conns].filter((c) => c !== conn && c.peer?.jobAgent && c.peer.jobOwner === peer.jobOwner);
  }

  private storedSiblings(peer: PeerInfo): StoredSibling[] {
    if (!this.jobsPath || !peer.jobOwner) return [];
    try {
      const records = JSON.parse(readFileSync(this.jobsPath, "utf8")) as unknown;
      if (!Array.isArray(records)) return [];
      return records.flatMap((j) => j && j.supervisor === peer.jobOwner && typeof j.id === "string" &&
        typeof j.name === "string" && j.name !== peer.name && `job:${j.id}` !== peer.id && AGENT_KINDS.includes(j.agent) && SIBLING_STATUSES.has(j.status)
        ? [{ id: `job:${j.id}`, name: j.name, title: typeof j.args?.title === "string" ? j.args.title : "", agent: j.agent, status: j.status }]
        : []);
    } catch {
      return [];
    }
  }

  private siblingPeers(conn: Conn): SiblingPeer[] {
    const live = this.siblingConns(conn);
    const stored = this.storedSiblings(this.requirePeer(conn));
    const peers = new Map(stored.map(({ id, ...s }) => [s.name, s]));
    for (const c of live) {
      const p = c.peer!;
      const previous = stored.find((s) => s.id === p.id);
      if (previous) peers.delete(previous.name);
      peers.set(p.name, { name: p.name, title: p.jobTitle ?? "", agent: p.jobAgent!, status: "running" });
    }
    return [...peers.values()];
  }

  private async onSendSibling(conn: Conn, args: RequestMap["sendSibling"][0]): Promise<RequestMap["sendSibling"][1]> {
    const sender = this.requirePeer(conn);
    const dedupeKey = args.dedupeKey ? `${SIBLING_CONVERSATION_PREFIX}${args.dedupeKey}` : undefined;
    const key = dedupeKey ? `${sender.id}:${dedupeKey}` : null;
    const seen = key ? this.sentByKey.get(key) : undefined;
    if (seen) return seen.result;
    const target = this.siblingConns(conn).find((c) => c.peer!.name === args.to);
    const stored = this.storedSiblings(sender).find((s) => s.name === args.to);
    if (!target && !stored) throw new BridgeError("unknown_target", "no sibling with that job name");
    const targetId = target?.peer!.id ?? stored!.id;
    const parent = args.replyTo ? this.store.byId(args.replyTo) : null;
    if (args.replyTo && (!parent || !parent.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX) ||
        !((parent.from.id === targetId && parent.recipient === sender.name) ||
          (parent.from.id === sender.id && parent.recipient === args.to)))) {
      throw new BridgeError("bad_request", "reply_to must refer to a message exchanged with this sibling");
    }
    if (!Number.isInteger(args.maxHops) || args.maxHops < 1 || (parent ? parent.hop + 1 : 0) >= args.maxHops) {
      throw new BridgeError("bad_request", "sibling conversation reached the hop limit");
    }
    const conversationId = parent?.conversationId ?? `${SIBLING_CONVERSATION_PREFIX}${randomUUID()}`;
    const result = await this.onSend(conn, { ...args, dedupeKey, conversationId });
    const message = result.messages[0]!;
    if (sender.jobParent) {
      const note = { ...message, id: randomUUID(), recipient: sender.jobParent,
        conversationId: `${conversationId}${SIBLING_NOTE_SUFFIX}`, body: `Sibling message to ${message.recipient}:\n\n${message.body}` };
      this.store.insert(note);
      const supervisor = this.connByName(sender.jobParent);
      if (supervisor) this.emit(supervisor, "message", note);
    }
    return result;
  }

  private uniqueName(requested: string): string {
    if (!this.connByName(requested)) return requested;
    for (let i = 2; i < NAME_SUFFIX_LIMIT; i++) {
      const candidate = `${requested}-${i}`;
      if (!this.connByName(candidate)) return candidate;
    }
    return `${requested}-${randomUUID().slice(0, 8)}`;
  }

  private onDecide(conn: Conn, value: RequestMap["decide"][0]): RequestMap["decide"][1] {
    const peer = this.requirePeer(conn);
    const parsed = z.object({
      topic: z.string().trim().min(1).max(MAX_DECISION_TOPIC_CHARS),
      text: z.string().trim().min(1).max(MAX_DECISION_TEXT_CHARS),
      scope: decisionScopeSchema.optional(), sourceMessageId: z.string().min(1).optional(),
    }).strict().safeParse(value);
    if (!parsed.success) throw new BridgeError("bad_request", "Invalid decision topic, text or scope.");
    if (parsed.data.sourceMessageId && !this.store.byId(parsed.data.sourceMessageId)) throw new BridgeError("bad_request", "Source message does not exist.");
    const decision = this.store.decisions.record({ ...parsed.data, scope: parsed.data.scope ?? { project: peer.cwd } }, { id: peer.id, name: peer.name, agent: peer.agent }, this.now());
    const deliveredTo: string[] = [];
    for (const c of this.conns) {
      if (!c.peer || c.peer.jobAgent || !decisionApplies(decision, c.peer)) continue;
      const message = this.queueDecision(decision, c.peer);
      if (message) { this.emit(c, "message", message); deliveredTo.push(c.peer.name); }
    }
    return { decision, deliveredTo };
  }

  private onDecisions(conn: Conn, value: RequestMap["decisions"][0]): RequestMap["decisions"][1] {
    const parsed = z.object({
      query: z.string().max(MAX_DECISION_TEXT_CHARS).optional(), scope: decisionScopeSchema.optional(),
      history: z.boolean().optional(), topic: z.string().max(MAX_DECISION_TOPIC_CHARS).optional(), session: z.string().optional(),
    }).strict().safeParse(value);
    if (!parsed.success) throw new BridgeError("bad_request", "Invalid decisions query or scope.");
    const scope = parsed.data.scope ?? (conn.peer ? { project: conn.peer.cwd } : undefined);
    return this.store.decisions.list({ ...parsed.data, scope }, conn.peer ?? undefined);
  }

  private decisionSessionKey(peer: PeerInfo): string {
    return `${peer.agent}:${peer.sessionId ?? peer.id}`;
  }

  private queueDecision(decision: OwnerDecision, peer: PeerInfo): BridgeMessage | null {
    const message: BridgeMessage = {
      id: randomUUID(), from: decision.author, to: peer.name, recipient: peer.name,
      conversationId: `decision-${decision.id}`, replyTo: decision.sourceMessageId, hop: DECISION_MESSAGE_HOP,
      body: `Pinned owner decision: ${decision.topic}\n\n${decision.text}\n\nCall decisions to look up current decisions or their history.`,
      createdAt: this.now(), readAt: null,
    };
    return this.store.decisions.enqueue(decision, this.decisionSessionKey(peer), message, () => this.store.insert(message)) ? message : null;
  }

  private queueCurrentDecisions(peer: PeerInfo): BridgeMessage[] {
    // Hello may precede the hook that identifies this session. Waiting for that identity avoids
    // sending a second copy on reload before its previous receipt can be found.
    if (peer.jobAgent || !peer.sessionId) return [];
    return this.store.decisions.list().filter((d) => decisionApplies(d, peer)).flatMap((d) => {
      const message = this.queueDecision(d, peer);
      return message ? [message] : [];
    });
  }

  private checkAuth(protocol: number, token: unknown): void {
    if (protocol !== PROTOCOL_VERSION) {
      throw new BridgeError("protocol_mismatch", `broker speaks protocol ${PROTOCOL_VERSION}, client ${protocol}`, {
        brokerProtocol: PROTOCOL_VERSION,
      });
    }
    if (typeof token !== "string" || !tokensEqual(token, this.token)) {
      this.log.warn("rejected connection with a wrong or missing token");
      throw new BridgeError("unauthorized", "wrong agent-bridge token");
    }
  }

  private onHello(conn: Conn, args: RequestMap["hello"][0]): RequestMap["hello"][1] {
    this.checkAuth(args.protocol, args.token);
    conn.authed = true;
    const p = args.peer;
    if (!p || !PEER_NAME_PATTERN.test(p.name ?? "") || !AGENT_KINDS.includes(p.agent)) {
      throw new BridgeError("bad_request", "invalid peer info");
    }
    if (conn.peer) throw new BridgeError("bad_request", "already registered");
    const name = this.uniqueName(p.name);
    const peer: PeerInfo = {
      id: String(p.id),
      name,
      agent: p.agent,
      cwd: String(p.cwd ?? ""),
      pid: Number(p.pid),
      agentPid: p.agentPid ?? null,
      sessionId: p.sessionId ?? null,
      startedAt: Number(p.startedAt) || this.now(),
      autoWake: Boolean(p.autoWake),
      activity: p.activity === "busy" || p.activity === "idle" ? p.activity : null,
      version: typeof p.version === "string" ? p.version.slice(0, 32) : undefined,
      ...(p.jobAgent && AGENT_KINDS.includes(p.jobAgent) ? { jobAgent: p.jobAgent } : {}),
      ...(p.jobAgent && typeof p.jobOwner === "string" && p.jobOwner ? {
        jobOwner: p.jobOwner, jobParent: typeof p.jobParent === "string" ? p.jobParent : undefined,
        jobTitle: typeof p.jobTitle === "string" ? p.jobTitle : undefined,
      } : {}),
    };
    conn.peer = peer;
    if (peer.sessionId) this.replaceStale(conn, peer);
    this.expireStaleQueue(peer.name);
    // A job runner is no session of its agent kind: it never takes mail waiting for "any <agent>".
    let claimed = 0;
    if (!peer.jobAgent) {
      this.expireStaleQueue(agentQueueKey(peer.agent));
      claimed = this.store.claim(agentQueueKey(peer.agent), peer.name);
    }
    this.log.info("peer joined", { name, agent: peer.agent, jobAgent: peer.jobAgent, cwd: peer.cwd, claimed });
    if (!peer.jobAgent) this.broadcastEvent("peer_joined", peer, conn);
    // Deliver the backlog right after the hello response has been written.
    setImmediate(() => {
      this.queueCurrentDecisions(peer);
      for (const m of this.store.unread(peer.name, PENDING_MAX_LIMIT)) this.emit(conn, "message", m);
    });
    return { brokerPid: process.pid, name: peer.name, peers: this.livePeers().filter((x) => x.id !== peer.id) };
  }

  /**
   * Mail sent to a "-N" stand-in of this peer's name (a reload ran the session under it briefly) moves to the
   * peer. Only names of that form, and only while no one holds them: another session's mail stays its own.
   */
  private onClaimMail(conn: Conn, args: RequestMap["claimMail"][0]): { moved: number } {
    const peer = this.requirePeer(conn);
    const base = peer.name.replace(/-\d+$/, "");
    let moved = 0;
    for (const name of new Set(args.names ?? [])) {
      const standIn = name !== peer.name && (name === base || (name.startsWith(`${base}-`) && /^\d+$/.test(name.slice(base.length + 1))));
      if (!standIn || this.connByName(name)) continue;
      moved += this.store.claim(name, peer.name);
    }
    if (moved) {
      this.log.info("mail of a stand-in name moved to its session", { to: peer.name, moved });
      setImmediate(() => {
        for (const m of this.store.unread(peer.name, PENDING_MAX_LIMIT)) this.emit(conn, "message", m);
      });
    }
    return { moved };
  }

  private onUpdatePeer(conn: Conn, args: RequestMap["updatePeer"][0]): PeerInfo {
    const peer = this.requirePeer(conn);
    if (peer.jobOwner) {
      if (typeof args.jobParent === "string") peer.jobParent = args.jobParent;
      if (typeof args.jobTitle === "string") peer.jobTitle = args.jobTitle;
    }
    if (args.sessionId !== undefined) {
      const previousKey = this.decisionSessionKey(peer);
      peer.sessionId = args.sessionId;
      this.store.decisions.linkSession(previousKey, this.decisionSessionKey(peer));
      if (peer.sessionId) this.replaceStale(conn, peer);
    }
    if (args.autoWake !== undefined) peer.autoWake = Boolean(args.autoWake);
    if (typeof args.cwd === "string" && args.cwd) peer.cwd = args.cwd;
    if (args.activity === "busy" || args.activity === "idle") peer.activity = args.activity;
    if (typeof args.name === "string" && args.name !== peer.name) {
      if (!PEER_NAME_PATTERN.test(args.name)) throw new BridgeError("bad_request", "invalid peer name");
      const old = peer.name;
      peer.name = this.uniqueName(args.name);
      this.log.info("peer renamed", { from: old, to: peer.name });
      this.expireStaleQueue(peer.name);
      // Mail that was waiting under the new name is now ours.
      setImmediate(() => {
        for (const m of this.store.unread(peer.name, PENDING_MAX_LIMIT)) this.emit(conn, "message", m);
      });
    }
    this.log.debug("peer updated", { name: peer.name, sessionId: peer.sessionId, autoWake: peer.autoWake, cwd: peer.cwd });
    for (const message of this.queueCurrentDecisions(peer)) this.emit(conn, "message", message);
    return peer;
  }

  /**
   * One agent session, two servers: Claude Code's /reload-plugins (or a restart of the MCP server) starts a new
   * agent-bridge server while the old one may still be connected. The old one would keep the name and receive
   * mail the session no longer sees. So the newest server of a session wins: the old connection is told it was
   * replaced (it stops instead of reconnecting) and the new one takes over its name and waiting mail.
   */
  private replaceStale(conn: Conn, peer: PeerInfo): void {
    for (const c of [...this.conns]) {
      const old = c.peer;
      if (c === conn || !old || old.agent !== peer.agent || old.sessionId !== peer.sessionId) continue;
      this.log.info("session connected again from a new server; replacing the old connection", { name: old.name, by: peer.name, sessionId: peer.sessionId });
      this.emit(c, "replaced", { by: peer.name });
      this.conns.delete(c);
      c.peer = null;
      this.broadcastEvent("peer_left", old, c);
      c.socket.end();
      if (peer.name !== old.name && !this.connByName(old.name)) {
        // Keep the session's usual name: take the old one's only when ours is a "-N" stand-in for it (the usual
        // reload). A leftover server can also be the one holding "-N"; then the new server keeps its own name.
        const oldName = old.name;
        if (peer.name.startsWith(`${oldName}-`) && /^\d+$/.test(peer.name.slice(oldName.length + 1))) peer.name = oldName;
        // Either way, mail that waited under the old name is the session's.
        setImmediate(() => {
          for (const name of new Set([oldName, peer.name])) for (const m of this.store.unread(name, PENDING_MAX_LIMIT)) this.emit(conn, "message", m);
        });
      }
    }
  }

  /**
   * Before a peer takes over queued mail. Names are derived from the project folder and reused by every
   * later session there, so a name alone does not identify the session that mail was meant for. Mail that
   * waited longer than QUEUED_MAIL_MAX_AGE_MS most likely belongs to a session that is gone; recent mail
   * still reaches a session that restarted or reconnected after a broker hand-over.
   */
  private expireStaleQueue(key: string): void {
    try {
      const maxAge = retentionLimit("AGENT_BRIDGE_QUEUED_MAIL_MAX_AGE_MS", QUEUED_MAIL_MAX_AGE_MS);
      if (maxAge) this.store.expireQueued(key, this.now() - maxAge);
    } catch (err) {
      this.log.warn("expiring queued mail failed", { key, err });
    }
  }

  /** Turns a sender-supplied target into live connections and/or offline queue keys. */
  private resolveTargets(to: string, sender: PeerInfo): { live: Conn[]; queued: string[] } {
    const all = [...this.conns].filter((c) => c.peer && c.peer.id !== sender.id);
    // Broadcasts and agent kinds address sessions; job runners only get mail sent to them by name.
    const others = all.filter((c) => !c.peer!.jobAgent);
    if (to === BROADCAST) {
      if (others.length === 0) throw new BridgeError("unknown_target", "no other peers are online");
      return { live: others, queued: [] };
    }
    const exact = all.find((c) => c.peer!.id === to || c.peer!.name === to);
    if (exact) return { live: [exact], queued: [] };
    if (to === sender.name || to === sender.id) throw new BridgeError("bad_request", "cannot send a message to yourself");
    if ((AGENT_KINDS as readonly string[]).includes(to)) {
      const ofKind = others.filter((c) => c.peer!.agent === (to as AgentKind));
      if (ofKind.length === 1) return { live: ofKind, queued: [] };
      if (ofKind.length > 1) {
        throw new BridgeError("ambiguous_target", `several ${to} peers are online`, {
          candidates: ofKind.map((c) => c.peer!.name),
        });
      }
      return { live: [], queued: [agentQueueKey(to as AgentKind)] };
    }
    if (!PEER_NAME_PATTERN.test(to)) throw new BridgeError("unknown_target", `invalid target: ${to}`);
    return { live: [], queued: [to] };
  }

  /** Results of recent sends by dedupe key (see SendArgs.dedupeKey), so a retry is not sent twice. */
  private readonly sentByKey = new Map<string, { at: number; result: RequestMap["send"][1] }>();
  private readonly sendingByKey = new Map<string, Promise<RequestMap["send"][1]>>();

  private async onSend(conn: Conn, args: RequestMap["send"][0]): Promise<RequestMap["send"][1]> {
    const sender = this.requirePeer(conn);
    const key = typeof args.dedupeKey === "string" && args.dedupeKey ? `${sender.id}:${args.dedupeKey}` : null;
    const seen = key ? this.sentByKey.get(key) : undefined;
    if (seen) return seen.result;
    const inFlight = key ? this.sendingByKey.get(key) : undefined;
    if (inFlight) return inFlight;
    const sending = this.routeSend(conn, sender, args);
    if (key) this.sendingByKey.set(key, sending);
    let result: RequestMap["send"][1];
    try { result = await sending; }
    finally { if (key) this.sendingByKey.delete(key); }
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

  private async routeSend(conn: Conn, sender: PeerInfo, args: RequestMap["send"][0]): Promise<RequestMap["send"][1]> {
    const body = typeof args.body === "string" ? args.body : "";
    if (!body.trim()) throw new BridgeError("bad_request", "message body is empty");
    if (body.length > MAX_BODY_CHARS) throw new BridgeError("too_large", `message body exceeds ${MAX_BODY_CHARS} characters`);
    const to = String(args.to ?? "").trim();
    if (!to) throw new BridgeError("bad_request", "missing target");

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
    conversationId ||= randomUUID();

    const id = randomUUID();
    const createdAt = this.now();
    const base = {
      id,
      // A job runner speaks for its job: from the subagent's agent, like a job run inside the session's server.
      from: { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent },
      to,
      conversationId,
      replyTo,
      hop,
      body,
      createdAt,
      readAt: null,
    };
    if (to.includes("/")) {
      const result = await this.requireNetwork().send({ ...base, recipient: to });
      for (const message of result.messages) this.store.insert(message);
      return result;
    }
    const { live, queued } = this.resolveTargets(to, sender);
    if (conversationId.startsWith(SIBLING_CONVERSATION_PREFIX) &&
        (queued.some((name) => !sender.jobAgent || !this.storedSiblings(sender).some((s) => s.name === name)) ||
          live.some((c) => c.peer!.jobAgent && (!sender.jobAgent || !sender.jobOwner || c.peer!.jobOwner !== sender.jobOwner)))) {
      throw new BridgeError("unauthorized", "sibling chat is restricted to jobs of the same supervisor");
    }
    const messages: BridgeMessage[] = [];
    for (const c of live) messages.push({ ...base, recipient: c.peer!.name });
    for (const key of queued) messages.push({ ...base, recipient: key });
    for (const m of messages) this.store.insert(m);
    live.forEach((c, i) => this.emit(c, "message", messages[i]!));

    this.log.info("message routed", {
      id,
      from: sender.name,
      to,
      hop,
      deliveredTo: live.map((c) => c.peer!.name),
      queuedFor: queued,
    });
    return { messages, deliveredTo: live.map((c) => c.peer!.name), queuedFor: queued };
  }

  private requireNetwork(): NetworkService {
    if (!this.network) throw new BridgeError("bad_request", "networking is disabled or unavailable; enable it and restart the broker");
    return this.network;
  }

  private async onSendFiles(conn: Conn, args: RequestMap["sendFiles"][0]): Promise<TransferResult> {
    const sender = this.requirePeer(conn);
    const parsed = z.object({ to: z.string().min(1), paths: z.array(z.string().min(1)).min(1).max(MAX_TRANSFER_ENTRIES) }).parse(args);
    const remote = parsed.to.includes("/");
    const target = remote ? this.requireNetwork().fileTarget(parsed.to) : parsed.to;
    const transfer = collectTransfer(parsed.paths, sender.cwd, target, { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent });
    if (remote) return this.requireNetwork().sendFiles(parsed.to, transfer);
    if (!this.connByName(target)) throw new BridgeError("unknown_target", "file recipient must be online");
    const home = this.networking?.home;
    if (!home) throw new BridgeError("bad_request", "file inbox home is unavailable");
    const result = receiveTransfer(home, transfer);
    this.receiveRemote({ id: transfer.id, from: transfer.from, to: target, recipient: target, conversationId: transfer.id, replyTo: null, hop: 0, body: `Received ${result.files} files (${result.bytes} bytes) in ${result.inbox}`, createdAt: this.now(), readAt: null });
    return result;
  }

  private receiveRemote(message: BridgeMessage): { delivered: boolean } {
    const target = this.connByName(message.recipient);
    const existing = this.store.byId(message.id);
    if (existing) {
      if (existing.from.id !== message.from.id || existing.recipient !== message.recipient || existing.body !== message.body || existing.conversationId !== message.conversationId || existing.replyTo !== message.replyTo || existing.hop !== message.hop) throw new BridgeError("bad_request", "message id already used");
      return { delivered: Boolean(target) };
    }
    this.store.insert(message);
    if (target) this.emit(target, "message", message);
    return { delivered: Boolean(target) };
  }
}
