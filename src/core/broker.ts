import { randomUUID } from "node:crypto";
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
  type AgentKind,
  type BridgeMessage,
  type EventFrame,
  type EventMap,
  type EventName,
  type Op,
  type PeerInfo,
  type RequestFrame,
  type RequestMap,
} from "./protocol.js";
import { agentQueueKey, MessageStore } from "./store.js";
import { tokensEqual } from "./token.js";

/** Peer names double as offline queue keys, so keep them simple and unambiguous. */
export const PEER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PENDING_DEFAULT_LIMIT = 50;
const PENDING_MAX_LIMIT = 500;
const NAME_SUFFIX_LIMIT = 100;

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
  private readonly handlers: { [O in Op]: Handler<O> };

  constructor(
    private readonly pipePath: string,
    private readonly store: MessageStore,
    private readonly log: Logger,
    private readonly token: string,
    private readonly now: () => number = Date.now,
  ) {
    this.handlers = {
      auth: (c, a) => {
        this.checkAuth(a.protocol, a.token);
        c.authed = true;
        return { brokerPid: process.pid };
      },
      hello: (c, a) => this.onHello(c, a),
      send: (c, a) => this.onSend(c, a),
      peers: () => this.livePeers(),
      ack: (c, a) => ({ acked: this.store.markRead(this.requirePeer(c).name, a.ids ?? [], this.now()) }),
      pending: (c, a) =>
        this.store.unread(this.requirePeer(c).name, Math.min(Math.max(1, a.limit ?? PENDING_DEFAULT_LIMIT), PENDING_MAX_LIMIT)),
      updatePeer: (c, a) => this.onUpdatePeer(c, a),
      ping: () => ({ brokerPid: process.pid, protocol: PROTOCOL_VERSION }),
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
      const onListening = () => {
        server.removeListener("error", onError);
        server.on("error", (err) => this.log.error("broker server error", { err }));
        this.server = server;
        this.purgeTimer = setInterval(() => this.purge(), PURGE_INTERVAL_MS);
        this.purgeTimer.unref();
        this.purge();
        this.log.info("broker listening", { pipe: this.pipePath });
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.pipePath);
    });
  }

  async close(): Promise<void> {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    this.store.close();
    this.log.info("broker closed");
  }

  private purge(): void {
    try {
      this.store.purgeOlderThan(this.now() - MESSAGE_TTL_MS);
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

  /** Sessions, without job runners (they are reached by name only; see job-host.ts). */
  private livePeers(): PeerInfo[] {
    return [...this.conns].flatMap((c) => (c.peer && !c.peer.jobAgent ? [c.peer] : []));
  }

  private connByName(name: string): Conn | undefined {
    for (const c of this.conns) if (c.peer?.name === name) return c;
    return undefined;
  }

  private uniqueName(requested: string): string {
    if (!this.connByName(requested)) return requested;
    for (let i = 2; i < NAME_SUFFIX_LIMIT; i++) {
      const candidate = `${requested}-${i}`;
      if (!this.connByName(candidate)) return candidate;
    }
    return `${requested}-${randomUUID().slice(0, 8)}`;
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
      for (const m of this.store.unread(peer.name, PENDING_MAX_LIMIT)) this.emit(conn, "message", m);
    });
    return { brokerPid: process.pid, name: peer.name, peers: this.livePeers().filter((x) => x.id !== peer.id) };
  }

  private onUpdatePeer(conn: Conn, args: RequestMap["updatePeer"][0]): PeerInfo {
    const peer = this.requirePeer(conn);
    if (args.sessionId !== undefined) {
      peer.sessionId = args.sessionId;
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
        peer.name = old.name;
        setImmediate(() => {
          for (const m of this.store.unread(peer.name, PENDING_MAX_LIMIT)) this.emit(conn, "message", m);
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
      this.store.expireQueued(key, this.now() - QUEUED_MAIL_MAX_AGE_MS);
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

  private onSend(conn: Conn, args: RequestMap["send"][0]): RequestMap["send"][1] {
    const sender = this.requirePeer(conn);
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

    const { live, queued } = this.resolveTargets(to, sender);
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
}
