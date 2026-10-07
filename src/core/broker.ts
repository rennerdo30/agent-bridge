import { ReadJournal } from "./read-journal.js";
import { HISTORY_TICK_MS, historySearchSchema } from "./history.js";
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
  SIBLING_CONVERSATION_PREFIX,
  SIBLING_NOTE_SUFFIX,
  isQuietMessage,
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
import { agentQueueKey, MessageStore, registrationIdentity } from "./store.js";
import { tokensEqual } from "./token.js";
import { commitHandoff, handoffJournal, handoffSchema, } from "./job-handoff.js";
import { canControlJob, mastersFor, chooseJobRecipient, primaryFor } from "./job-ownership.js";
import { RootConcurrency } from "./root-concurrency.js";
import { isRecord, retentionLimit } from "./json-store.js";
import { readArchivedJobSnapshot } from "./job-archive.js";
import { readJsonSnapshot, type JsonSnapshot } from "./file-cache.js";
import { completionMessageId, COMPLETION_DEDUPE_PREFIX } from "./completion.js";
import { isJobSendTarget, MAX_JOB_SEND_TARGETS } from "./job-messaging.js";
import { NetworkService, type NetworkStatus } from "../network/link.js";
import { readNetworkConfig, writeNetworkConfig, type NetworkConfig } from "../network/config.js";
import { z } from "zod";
import { basename, dirname } from "node:path";
import { ProjectGroups } from "./project-groups.js";
import { collectTransfer, receiveTransfer, type TransferResult } from "../network/files.js";
import { cancelStoredTransfer, MAX_STREAM_ENTRIES, readTransferHistory, type TransferStarted } from "../network/transfers.js";
import { MAX_NETWORK_HOST_CHARS, MAX_PAIRING_CODE_CHARS, MAX_PORT } from "../network/constants.js";
import { RemoteDashboard, dashboardError } from "../network/remote-dashboard.js";
import { RemoteJobs } from "../network/remote-jobs.js";
import { CONTROL_CONVERSATION_PREFIX } from "../mcp/job-host.js";
import { DECISION_MESSAGE_HOP, MAX_DECISION_TEXT_CHARS, MAX_DECISION_TOPIC_CHARS, decisionApplies, decisionScopeSchema, type OwnerDecision } from "./decisions.js";

/** Peer names double as offline queue keys, so keep them simple and unambiguous. */
export const PEER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PENDING_DEFAULT_LIMIT = 50;
/** How long, and how many, send dedupe keys are remembered (retries come within minutes). */
const DEDUPE_KEEP_MS = 30 * 60 * 1000;
const DEDUPE_MAX = 5_000;
const PENDING_MAX_LIMIT = 500;
const NAME_SUFFIX_LIMIT = 100;
const MAX_FILE_ADDRESS_CHARS = 256;
const MAX_FILE_PATH_CHARS = 1_024;
const SIBLING_STATUSES = new Set<SiblingPeer["status"]>(["running", "done", "failed", "interrupted"]);
const MAX_INFLIGHT_PER_CONNECTION = 128;
const PAUSE_INFLIGHT_PER_CONNECTION = 32;
const MAX_CONNECTION_BUFFER_BYTES = 4 * MAX_FRAME_BYTES;

type StoredSibling = SiblingPeer & { id: string; report: string | null };

interface Conn {
  socket: Socket;
  peer: PeerInfo | null;
  /** Presented the right token (via hello or auth). */
  authed: boolean;
  inFlight: number;
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
  private readonly groups: ProjectGroups;
  /** Live role selection, recomputed after broker restart; no durable ownership is rewritten. */
  private readonly projectMains = new Map<string, string>();
  private server: Server | null = null;
  private readonly conns = new Set<Conn>();
  private historyTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  private network: NetworkService | null = null;
  private remoteJobs: RemoteJobs | null = null;
  private remoteDashboard: RemoteDashboard | null = null;
  private readonly remoteProgress = new Map<string, string>();
  private networkChange: Promise<unknown> = Promise.resolve();
  private readonly handlers: { [O in Op]: Handler<O> };
  private jobsSnapshot: { active: JsonSnapshot; archive: string; records: Record<string, unknown>[] } | null = null;
  private jobsForDispatch: Record<string, unknown>[] | null = null;

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
    this.groups = new ProjectGroups(jobsPath ? dirname(jobsPath) : undefined);
    this.handlers = {
      projectMain: (c, a) => {
        const args = z.object({ to: z.string().min(1) }).strict().parse(a);
        return this.switchProjectMain(c.peer, this.connByName(args.to)?.peer ?? undefined);
      },
      projectJobs: (c) => this.storedJobs().filter((j) => this.groups.canControl(this.requirePeer(c), j, this.localPeers())),
      coordinatorAvailability: (c, a) => {
        const args = z.object({ name: z.string().optional(), unavailable: z.boolean() }).strict().parse(a);
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
        if (parsed.data.switch_project_main && ((parsed.data.jobs !== "all") || !this.projectPeer(source).projectGroup || this.projectPeer(source).projectGroup !== this.projectPeer(target).projectGroup)) {
          throw new BridgeError("unauthorized", "Switching the project main requires all jobs and a target in the same project group.");
        }
        const receipt = commitHandoff(this.jobsPath, source, target, parsed.data, { canControl: (job) => this.groups.canControl(source, job as unknown as Record<string, unknown>, this.localPeers()) });
        if (parsed.data.switch_project_main) this.switchProjectMain(source, target);
        this.jobsSnapshot = null; this.jobsForDispatch = null;
        this.applyHandoffs();
        for (const conn of this.conns) if (conn.peer) this.emit(conn, "jobs_changed", { withdrawn: conn.peer.name === source.name ? receipt.jobs.map((j) => j.id) : [] });
        return receipt;
      },
      jobAuthority: (c, a) => {
        const peer = this.requirePeer(c), job = this.storedJobs().find((j) => j.name === a.job);
        if (!job || !this.groups.canControl(peer, job, this.localPeers())) return null;
        return job as unknown as import("../mcp/jobs.js").Job;
      },
      jobRecipient: (c, a) => {
        const peer = this.requirePeer(c), job = this.storedJobs().find((j) => j.name === a.job);
        if (!job || !this.groups.canControl(peer, job, this.localPeers())) throw new BridgeError("unauthorized", "Only a master can inspect the job recipient.");
        return this.jobRecipient(job);
      },
      inlineJobControl: async (c, a) => {
        const peer = this.requirePeer(c), job = this.storedJobs().find((j) => j.name === a.job);
        if (!job || !this.groups.canControl(peer, job, this.localPeers())) throw new BridgeError("unauthorized", "Only the current supervisor can control this job.");
        if (!a.control || !["message", "title", "settings", "effort", "cancel"].includes(a.control.type)) throw new BridgeError("bad_request", "Invalid inline control.");
        if (job.host && job.status === "running") {
          await this.onSend(c, { to: String(job.name), body: JSON.stringify(a.control), conversationId: `${CONTROL_CONVERSATION_PREFIX}${job.id}` });
          return { sent: true };
        }
        const executor = typeof (job.executionOwner ?? job.owner) === "string" ? this.connByName(String(job.executionOwner ?? job.owner)) : undefined;
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
      inlineJobReport: (c, m) => {
        const peer = this.requirePeer(c), job = this.storedJobs().find((j) => `job:${j.id}` === m.from?.id);
        if (!job || (job.executionOwner !== peer.name && job.owner !== peer.name && job.rootName !== peer.name) || typeof job.owner !== "string" || typeof m.body !== "string" || m.body.length > MAX_BODY_CHARS) throw new BridgeError("unauthorized", "Invalid inline job delivery.");
        const recipient = this.jobRecipient(job);
        const message = { ...m, to: recipient, recipient, conversationId: this.jobConversation(job, recipient, m.conversationId) };
        if (this.store.insertJobDelivery(message)) {
          const target = this.connByName(recipient);
          if (target && !target.peer?.unavailable) this.emit(target, "message", message);
        }
        return { saved: true };
      },
      auth: (c, a) => {
        this.checkAuth(a.protocol, a.token);
        c.authed = true;
        return { brokerPid: process.pid };
      },
      hello: (c, a) => { const result = this.onHello(c, a); const job = this.storedJobs().find((j) => `job:${j.id}` === c.peer?.id); if (job?.ownershipHistory) this.refreshJobPeer(job); this.routePendingJobMail(); this.store.history.rememberPeer(c.peer!); return result; },
      send: (c, a) => this.onSend(c, a),
      decide: (c, a) => this.onDecide(c, a),
      decisions: (c, a) => this.onDecisions(c, a),
      searchHistory: (_, a) => {
        const parsed = historySearchSchema.safeParse(a);
        if (!parsed.success) throw new BridgeError("bad_request", "Invalid history query or filters.");
        return this.store.history.search(parsed.data);
      },
      reindexHistory: (_, a) => {
        const args = z.object({ reset: z.boolean().optional() }).strict().parse(a);
        if (args.reset) this.store.history.reset();
        return this.store.history.tick();
      },
      peers: () => this.livePeers(),
      dashboardPeers: () => this.dashboardPeers().concat(this.network?.peers() ?? []),
      dashboardRead: (_, a) => this.remoteDashboard?.request(a.host, a.request) ?? dashboardError("remote_offline", "Networking is unavailable."),
      siblings: (c) => this.siblingPeers(c),
      sendSibling: (c, a) => this.onSendSibling(c, a),
      messageReceipt: (c, a) => this.messageReceipt(c, a.id),
      ack: (c, a) => ({ acked: this.store.markRead(this.requirePeer(c).name, a.ids ?? [], this.now()) }),
      pending: (c, a) =>
        this.unreadMail(this.requirePeer(c).name, Math.min(Math.max(1, a.limit ?? PENDING_DEFAULT_LIMIT), PENDING_MAX_LIMIT)),
      updatePeer: (c, a) => { const peer = this.onUpdatePeer(c, a); const job = this.storedJobs().find((j) => `job:${j.id}` === peer.id); if (job?.ownershipHistory) this.refreshJobPeer(job); this.store.history.rememberPeer(peer); return peer; },
      claimMail: (c, a) => this.onClaimMail(c, a),
      ping: () => ({ brokerPid: process.pid, protocol: PROTOCOL_VERSION }),
      networkStatus: () => this.network?.status() ?? { enabled: false, config: this.networking?.config, discovered: [], paired: [] },
      remoteJob: async (c, a) => {
        const peer = this.requirePeer(c);
        if (peer.jobAgent) throw new BridgeError("bad_request", "Only supervisor sessions can request remote jobs.");
        if (!this.remoteJobs) throw new BridgeError("bad_request", "Remote broker update needed or networking unavailable.");
        const saved = this.storedJobs().find((job) => job.id === a.request.job && job.owner === peer.name);
        const supervisor = typeof saved?.supervisor === "string" ? saved.supervisor : peer.sessionId ?? peer.id;
        const snapshot = await this.remoteJobs.request(a.host, peer, a.request, supervisor, typeof saved?.name === "string" ? saved.name : undefined);
        const progress = snapshot.state?.progress;
        const key = `${a.host}/${a.request.job}`;
        if (progress && this.remoteProgress.get(key) !== progress) {
          this.remoteProgress.set(key, progress);
          const pair = this.requireNetwork().status().paired.find((p) => p.id === a.host || p.name === a.host);
          const name = snapshot.state!.peer;
          this.receiveRemote({ id: randomUUID(), from: { id: `${pair?.id ?? a.host}/job:${a.request.job}`, name: `${pair?.name ?? a.host}/${name}`, agent: "other" },
            to: peer.name, recipient: peer.name, body: progress, conversationId: `job-${a.request.job}:note`, replyTo: null, hop: 0, createdAt: this.now(), readAt: null });
        }
        return snapshot;
      },
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
      fetchFiles: (c, a) => {
        const sender = this.requirePeer(c);
        const args = z.object({ from: z.string().min(1).max(MAX_FILE_ADDRESS_CHARS), paths: z.array(z.string().min(1).max(MAX_FILE_PATH_CHARS)).min(1).max(MAX_STREAM_ENTRIES) }).parse(a);
        return this.requireNetwork().startFiles(args.from, args.paths, sender.cwd, { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent }, true);
      },
      transfers: () => ({ transfers: this.network?.transfers.list() ?? (this.networking ? readTransferHistory(this.networking.home) : []) }),
      cancelTransfer: (_, a) => {
        const id = z.uuid().parse(a.id);
        if (this.network) return this.network.transfers.cancel(id);
        if (!this.networking) throw new Error("transfer inbox home is unavailable");
        return cancelStoredTransfer(this.networking.home, id);
      },
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
        this.applyHandoffs();
        this.purgeTimer = setInterval(() => this.purge(), PURGE_INTERVAL_MS);
        this.purgeTimer.unref();
        this.historyTimer = setInterval(() => {
          try { this.store.history.tick(); } catch (err) { this.log.warn("history indexing failed", { err: String(err) }); }
        }, HISTORY_TICK_MS);
        this.historyTimer.unref();
        this.purge();
        this.log.info("broker listening", { pipe: this.pipePath });
        // Another broker may have enabled or changed pairing since this session started.
        if (this.networking) this.networking.config = readNetworkConfig(this.networking.home, this.networking.config);
        if (this.networking?.config.enabled) {
          try {
            this.network = new NetworkService(this.networking.home, this.networking.config, {
              peers: () => this.dashboardPeers(),
              receive: (message) => this.receiveRemote(message),
        receipt: (id, sender, recipient) => this.remoteReceipt(id, sender, recipient),
        recipientReceipts: true,
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
    if (this.historyTimer) clearInterval(this.historyTimer);
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
    if (server) await new Promise<void>((r) => server.close(() => r()));
    this.store.close();
    this.log.info("broker closed");
  }

  /** Serialize listener changes and let the elected broker remain the sole network writer. */
  private async configureNetwork(value: NetworkConfig): Promise<NetworkStatus> {
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
        recipientReceipts: true,
      }, this.log);
      this.installRemoteJobs(service);
      try { await service.start(); this.network = service; }
      catch (err) { await service.close(); throw err; }
    }
    return this.network?.status() ?? { enabled: false, config, discovered: [], paired: [] };
  }

  private installRemoteJobs(service: NetworkService): void {
    this.remoteDashboard = new RemoteDashboard(service, { home: this.networking!.home, log: this.log, peers: () => this.dashboardPeers() });
    this.remoteJobs = new RemoteJobs(service, this.networking!.home, this.log, async (record, control) => {
      this.receiveRemote({ id: randomUUID(), from: { id: record.owner, name: record.owner, agent: "other" },
        to: record.name, recipient: record.name, conversationId: `${CONTROL_CONVERSATION_PREFIX}${record.id}`,
        replyTo: null, hop: 0, body: JSON.stringify(control), createdAt: this.now(), readAt: null });
    });
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
    const conn: Conn = { socket, peer: null, authed: false, inFlight: 0 };
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
        }
        else this.log.debug("ignoring non-request frame from client", { t: f.t });
      }
    });
    socket.on("error", (err) => this.log.debug("connection error", { err: err.message }));
    socket.on("close", () => {
      this.conns.delete(conn);
      try { this.routePendingJobMail(); } catch (err) { this.log.warn("pending job reroute deferred", { err: String(err) }); }
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

  private write(conn: Conn, frame: Parameters<typeof encodeFrame>[0]): boolean {
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
  private replayMail(conn: Conn, peer: PeerInfo, before?: () => void): void {
    setImmediate(() => {
      if (conn.socket.destroyed || conn.peer !== peer) return;
      try {
        before?.();
        const mail = this.unreadMail(peer.name, PENDING_MAX_LIMIT);
        let at = 0;
        const pump = () => {
          if (conn.socket.destroyed || conn.peer !== peer) return;
          while (at < mail.length) {
            const m = mail[at++]!;
            if (!this.write(conn, { t: "evt", ev: "message", data: m })) {
              if (!conn.socket.destroyed) conn.socket.once("drain", pump);
              return;
            }
          }
        };
        pump();
      } catch (err) { this.log.warn("mail replay deferred after storage failure", { peer: peer.name, err: String(err) }); }
    });
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
    return this.localPeers().filter((p) => !p.jobAgent).map((p) => this.projectPeer(p)).concat(this.network?.peers() ?? []);
  }

  private localPeers(): PeerInfo[] { return [...this.conns].flatMap((c) => c.peer ? [c.peer] : []); }

  private projectPeer(peer: PeerInfo): PeerInfo {
    const decorated = this.groups.decorate(peer), key = decorated.projectGroup;
    if (!key || peer.jobAgent || peer.subagent) return decorated;
    const members = this.localPeers().filter((p) => !p.jobAgent && !p.subagent && this.groups.decorate(p).projectGroup === key)
      .sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name));
    let main = this.projectMains.get(key);
    if (!members.some((p) => p.name === main)) { main = members[0]?.name; if (main) this.projectMains.set(key, main); }
    return { ...decorated, projectMain: main === peer.name, projectAddress: `project:${basename(decorated.projectRoot!)}` };
  }

  private switchProjectMain(source: PeerInfo | null | undefined, target: PeerInfo | undefined): PeerInfo {
    if (!target || target.jobAgent || target.subagent || target.host) throw new BridgeError("bad_request", "Choose a live local project master.");
    const peer = this.projectPeer(target);
    if (!peer.projectGroup || source && (source.jobAgent || this.projectPeer(source).projectGroup !== peer.projectGroup)) throw new BridgeError("unauthorized", "Only a master of this project may switch its main session.");
    this.projectMains.set(peer.projectGroup, peer.name);
    return this.projectPeer(target);
  }

  private sameJobFamily(a: PeerInfo, b: PeerInfo, jobs = this.storedJobs()): boolean {
    if (this.jobSupervisor(a, jobs) !== this.jobSupervisor(b, jobs)) return false;
    const left = jobs.find((j) => `job:${j.id}` === a.id), right = jobs.find((j) => `job:${j.id}` === b.id);
    const l = left && this.groups.jobRoot(left, this.localPeers()), r = right && this.groups.jobRoot(right, this.localPeers());
    return !(l && r) || this.groups.root(l) === this.groups.root(r);
  }

  private sharedJobs(a: PeerInfo, b: PeerInfo, jobs = this.storedJobs()): boolean {
    const left = jobs.find((j) => `job:${j.id}` === a.id), right = jobs.find((j) => `job:${j.id}` === b.id);
    if (!left || !right || !this.groups.shareable(left) || !this.groups.shareable(right)) return false;
    const peers = this.localPeers(), l = this.groups.jobRoot(left, peers), r = this.groups.jobRoot(right, peers);
    return Boolean(l && r && this.groups.same(l, r));
  }

  /** Project local runner lineage from durable jobs; do not alter broker routing identities. */
  private dashboardPeers(): PeerInfo[] {
    const jobs = this.storedJobs();
    return [...this.conns].flatMap((c) => {
      const peer = c.peer;
      if (!peer) return [];
      const job = jobs.find((j) => j.name === peer.name || `job:${j.id}` === peer.id);
      const field = (key: string): string | undefined => typeof job?.[key] === "string" ? job[key] as string : undefined;
      return [{ ...this.projectPeer(peer), agent: peer.jobAgent ?? peer.agent, parentJob: field("parentJob") ?? peer.parentJob, rootSession: field("rootSession") ?? peer.rootSession ?? peer.jobOwner,
        rootName: field("rootName") ?? peer.rootName ?? peer.jobParent, title: peer.jobTitle, subagent: Boolean(peer.jobAgent) }];
    });
  }

  private connByName(name: string): Conn | undefined {
    for (const c of this.conns) if (c.peer?.name === name) return c;
    return undefined;
  }

  /** Replay every effect after the registry commit, including a crash between stores. */
  private applyHandoffs(): void {
    if (!this.jobsPath) return;
    const records = this.storedJobs();
    for (const receipt of handoffJournal(this.jobsPath)) {
      const current = receipt.jobs.map((j) => records.find((r) => r.id === j.id)).filter(isRecord);
      for (const job of current) {
        const old = receipt.jobs.find((j) => j.id === job.id)!;
        const budget = new RootConcurrency(dirname(this.jobsPath), String(job.rootSession));
        try { budget.moveJobs([old.name]); } finally { budget.close(); }
        this.refreshJobPeer(job);
      }
      const body = `Inherited subagents from ${receipt.from}:\n` + receipt.jobs.map((j) => `- ${j.name}: ${j.title} (${j.status})`).join("\n") +
        (receipt.note ? `\n\nHandoff note: ${receipt.note}` : "") + "\n\nYou are their supervisor. Use message_subagent or cancel_subagent to control them.";
      for (const [recipient, text, suffix] of [[receipt.to, body, "inherited"], [receipt.from, `Handed off ${receipt.jobs.length} subagent(s) to ${receipt.to}.`, "confirmed"]]) {
        const m: BridgeMessage = { id: `${receipt.id}-${suffix}`, from: { id: "handoff", name: "agent-bridge", agent: "other" },
          to: recipient!, recipient: recipient!, body: text!, conversationId: `handoff-${receipt.id}`, hop: 0, replyTo: null, createdAt: receipt.at, readAt: null };
        if (this.store.insertOnce(m)) { const conn = this.connByName(recipient!); if (conn) this.emit(conn, "message", m); }
      }
    }
    this.routePendingJobMail();
  }

  routePendingJobMail(): void {
    for (const job of this.storedJobs()) {
      if (job.remote || !primaryFor(job)) continue;
      const recipient = this.jobRecipient(job), target = this.connByName(recipient);
      if (Array.isArray(job.deliveryHistory)) for (const envelope of job.deliveryHistory) {
        if (!isRecord(envelope) || !isRecord(envelope.from) || envelope.from.id !== `job:${job.id}` || typeof envelope.id !== "string" || typeof envelope.body !== "string") continue;
        const message = { ...envelope, to: recipient, recipient, conversationId: this.jobConversation(job, recipient, String(envelope.conversationId)) } as unknown as BridgeMessage;
        if (this.store.insertJobDelivery(message)) {
          const names = new Set([recipient, envelope.to, envelope.recipient, ...mastersFor(job)]);
          const consumed = this.jobsPath && [...names].some((name) => typeof name === "string" &&
            new ReadJournal(dirname(this.jobsPath!)).read(`name:${name}`).includes(message.id));
          if (consumed) this.store.markRead(recipient, [message.id], this.now());
            else if (target && !target.peer?.unavailable) this.emit(target, "message", message);
        }
      }
      if (!target || target.peer?.unavailable) continue;
      for (const from of this.store.pendingJobRecipients(String(job.id))) {
        if (this.jobsPath) this.store.markRead(from, new ReadJournal(dirname(this.jobsPath)).read(`name:${from}`), this.now());
        const moved = this.store.handoffMail(from, recipient, String(job.id), this.now(), recipient !== job.parentJob && recipient !== primaryFor(job));
        const previous = this.connByName(from);
        if (previous && moved.length) this.emit(previous, "mail_retracted", { ids: moved.map((m) => m.id) });
        for (const m of moved) this.emit(target, "message", m);
      }
    }
  }

  private jobRecipient(job: Record<string, unknown>): string {
    if (typeof job.parentJob === "string" && this.connByName(job.parentJob)?.peer?.jobAgent) return job.parentJob;
    return chooseJobRecipient(job, this.localPeers(), this.groups.members(job, this.localPeers()));
  }

  private jobConversation(job: Record<string, unknown>, recipient: string, conversationId: string): string {
    if (recipient === job.parentJob || recipient === primaryFor(job) || isQuietMessage({ conversationId })) return conversationId;
    return conversationId.replace(/:note$/, "") + (conversationId.endsWith(":fallback") ? "" : ":fallback");
  }

  private refreshJobPeer(job: Record<string, unknown>): void {
    const peer = this.connByName(String(job.name))?.peer;
    if (!peer?.jobAgent) return;
    peer.jobParent = String(job.owner); peer.jobOwner = String(job.supervisor);
    peer.rootSession = String(job.rootSession); peer.rootName = String(job.rootName);
    peer.parentJob = typeof job.parentJob === "string" ? job.parentJob : undefined;
    if (isRecord(job.args) && Array.isArray(job.args.send_to)) peer.jobSendTo = job.args.send_to as string[];
  }

  private siblingConns(conn: Conn): Conn[] {
    const peer = this.requirePeer(conn);
    if (!peer.jobAgent || !peer.jobOwner) throw new BridgeError("bad_request", "not a linked job");
    const jobs = this.storedJobs();
    const supervisor = this.jobSupervisor(peer, jobs);
    return [...this.conns].filter((c) => c !== conn && c.peer?.jobAgent && (this.sameJobFamily(peer, c.peer, jobs) || this.sharedJobs(peer, c.peer, jobs) || peer.jobSendTo?.includes(c.peer.name)));
  }

  private storedJobs(): Record<string, unknown>[] {
    if (!this.jobsPath) return [];
    // Sibling routing consults the registry several times in one synchronous dispatch batch.
    // Share that snapshot until the next microtask, without a timer-based stale window.
    if (this.jobsForDispatch) return this.jobsForDispatch;
    try {
      const active = readJsonSnapshot(this.jobsPath), archive = readArchivedJobSnapshot(this.jobsPath);
      if (this.jobsSnapshot?.active === active && this.jobsSnapshot.archive === archive.signature) {
        this.jobsForDispatch = this.jobsSnapshot.records;
        queueMicrotask(() => { this.jobsForDispatch = null; });
        return this.jobsForDispatch;
      }
      const data = active.value;
      const jobs = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : [];
      const merged = new Map<string, Record<string, unknown>>();
      for (const job of [...archive.jobs, ...jobs.filter(isRecord)]) {
        if (typeof job.id === "string") merged.set(job.id, job);
      }
      const records = [...merged.values()];
      this.jobsSnapshot = { active, archive: archive.signature, records };
      this.jobsForDispatch = records;
      queueMicrotask(() => { this.jobsForDispatch = null; });
      return records;
    } catch {
      return [];
    }
  }

  /** A restored legacy runner may still advertise its old owner name until its next turn. */
  private jobSupervisor(peer: PeerInfo, jobs = this.storedJobs()): string | undefined {
    const job = jobs.find((j) => `job:${j.id}` === peer.id);
    return typeof job?.supervisor === "string" ? job.supervisor : peer.jobOwner;
  }

  private storedSiblings(peer: PeerInfo): StoredSibling[] {
    if (!this.jobsPath || !peer.jobOwner) return [];
    try {
      const records = this.storedJobs();
      const supervisor = this.jobSupervisor(peer, records);
      return records.flatMap((j) => j && (this.sameJobFamily(peer, { id: `job:${j.id}`, jobOwner: String(j.supervisor) } as PeerInfo, records) || this.sharedJobs(peer, { id: `job:${j.id}` } as PeerInfo, records) || peer.jobSendTo?.includes(String(j.name))) && typeof j.id === "string" &&
        typeof j.name === "string" && j.name !== peer.name && `job:${j.id}` !== peer.id &&
        AGENT_KINDS.includes(j.agent as AgentKind) && SIBLING_STATUSES.has(j.status as SiblingPeer["status"])
        ? [{ id: `job:${j.id}`, name: j.name, title: isRecord(j.args) && typeof j.args.title === "string" ? j.args.title : "", agent: j.agent as AgentKind, status: j.status as SiblingPeer["status"], ...(typeof j.finishedAt === "number" ? { finishedAt: j.finishedAt } : {}), report: typeof j.report === "string" ? j.report : null }]
        : []);
    } catch {
      return [];
    }
  }

  private siblingPeers(conn: Conn): SiblingPeer[] {
    const live = this.siblingConns(conn);
    const stored = this.storedSiblings(this.requirePeer(conn));
    const peers = new Map(stored.map(({ id, report, ...s }) => [s.name, s]));
    for (const c of live) {
      const p = c.peer!;
      const previous = stored.find((s) => s.id === p.id);
      if (previous) peers.delete(previous.name);
      peers.set(p.name, { name: p.name, title: p.jobTitle ?? "", agent: p.jobAgent!, status: previous?.status ?? "running",
        ...(previous?.finishedAt !== undefined ? { finishedAt: previous.finishedAt } : {}) });
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
    if (!target && !stored) {
      if (!isJobSendTarget(args.to) || !sender.jobSendTo?.includes(args.to) || args.to.includes("-job-") || args.to.includes("-ask-") || this.connByName(args.to)?.peer?.jobAgent) {
        throw new BridgeError("unknown_target", "no sibling with that job name or explicit send_to grant");
      }
      if (args.replyTo) {
        const parent = this.store.byId(args.replyTo);
        const own = this.storedJobs().find((j) => `job:${j.id}` === sender.id);
        const ownerNames = new Set([sender.name, sender.jobParent, own?.owner]);
        if (!parent || !((parent.from.name === args.to && ownerNames.has(parent.recipient)) ||
            (parent.from.id === sender.id && parent.recipient === args.to))) {
          throw new BridgeError("bad_request", "reply_to must refer to a message exchanged with the granted session or supervisor");
        }
      }
      return this.onSend(conn, { ...args, dedupeKey });
    }
    const targetId = target?.peer!.id ?? stored!.id;
    const parent = args.replyTo ? this.store.byId(args.replyTo) : null;
    if (args.replyTo && (!parent || !parent.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX) ||
        !((parent.from.id === targetId && parent.recipient === sender.name) ||
          (parent.from.id === sender.id && parent.recipient === args.to)))) {
      throw new BridgeError("bad_request", "reply_to must refer to a message exchanged with this sibling");
    }
    if (!Number.isInteger(args.maxHops) || args.maxHops < 1 || (parent ? parent.hop + 1 : 0) >= args.maxHops) {
      if (typeof args.body !== "string" || !args.body.trim() || args.body.length > MAX_BODY_CHARS) {
        throw new BridgeError("bad_request", "invalid sibling message body");
      }
      const id = randomUUID();
      const notice: BridgeMessage = {
        id, from: { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent },
        to: sender.jobParent ?? sender.name, recipient: sender.name,
        conversationId: `sibling-drop-${id}`, replyTo: parent?.id ?? null, hop: 0,
        body: `Sibling delivery blocked: ${sender.name} to ${args.to} reached the ${args.maxHops}-message hop limit. The target did not receive this message. Stop this thread and resolve remaining work with the supervisor.\n\nUndelivered text:\n${args.body}`,
        createdAt: this.now(), readAt: null,
      };
      // Persist both notices before surfacing the error. The original text remains inspectable.
      this.store.insert(notice);
      this.emit(conn, "message", notice);
      if (sender.jobParent && sender.jobParent !== sender.name) {
        const copy = { ...notice, recipient: sender.jobParent };
        this.store.insert(copy);
        const supervisor = this.connByName(sender.jobParent);
        if (supervisor) this.emit(supervisor, "message", copy);
      }
      throw new BridgeError("bad_request", `sibling conversation reached its ${args.maxHops}-message hop limit; message was not delivered. Durable notice ${id} saved for sender and supervisor, including the undelivered text`);
    }
    const conversationId = parent?.conversationId ?? `${SIBLING_CONVERSATION_PREFIX}${randomUUID()}`;
    const result = await this.onSend(conn, { ...args, dedupeKey, conversationId });
    const message = result.messages[0]!;
    const recipientOwner = target?.peer?.jobParent ?? this.storedJobs().find((j) => j.name === args.to)?.owner;
    const observers = new Set([sender.jobParent, recipientOwner].filter((owner): owner is string => typeof owner === "string"));
    for (const owner of observers) {
      const note = { ...message, id: randomUUID(), recipient: owner,
        conversationId: `${conversationId}${SIBLING_NOTE_SUFFIX}`, body: `Sibling message to ${message.recipient}:\n\n${message.body}` };
      this.store.insert(note);
      const supervisor = this.connByName(owner);
      if (supervisor) this.emit(supervisor, "message", note);
    }
    if (stored && stored.status !== "running") {
      result.finishedRecipient = { name: stored.name, status: stored.status, report: stored.report,
        ...(stored.finishedAt !== undefined ? { finishedAt: stored.finishedAt } : {}) };
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
      agentStartedAt: typeof p.agentStartedAt === "string" && p.agentStartedAt.length <= 128 ? p.agentStartedAt : null,
      sessionId: p.sessionId ?? null,
      startedAt: Number(p.startedAt) || this.now(),
      autoWake: Boolean(p.autoWake),
      wakeOnDirect: Boolean(p.wakeOnDirect),
      wakeAvailable: Boolean(p.wakeAvailable),
      wakeMaxHops: typeof p.wakeMaxHops === "number" ? p.wakeMaxHops : undefined,
      activity: p.activity === "busy" || p.activity === "idle" ? p.activity : null,
      unavailable: p.unavailable === true,
      version: typeof p.version === "string" ? p.version.slice(0, 32) : undefined,
      ...(p.jobAgent && AGENT_KINDS.includes(p.jobAgent) ? { jobAgent: p.jobAgent } : {}),
      ...(p.jobAgent && typeof p.jobOwner === "string" && p.jobOwner ? {
        parentJob: typeof p.parentJob === "string" ? p.parentJob : undefined,
        rootSession: typeof p.rootSession === "string" ? p.rootSession : undefined,
        rootName: typeof p.rootName === "string" ? p.rootName : undefined,
        jobOwner: p.jobOwner, jobParent: typeof p.jobParent === "string" ? p.jobParent : undefined,
        jobTitle: typeof p.jobTitle === "string" ? p.jobTitle : undefined,
        jobSendTo: Array.isArray(p.jobSendTo) ? p.jobSendTo.filter(isJobSendTarget).slice(0, MAX_JOB_SEND_TARGETS) : [],
      } : {}),
    };
    if (!peer.sessionId) peer.sessionId = this.store.recoverSession(peer);
    this.store.rememberSession(peer, this.now());
    conn.peer = peer;
    this.replaceStale(conn, peer);
    this.restoreNames(conn, peer, { reclaim: true, replay: false });
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
    this.replayMail(conn, peer, () => { this.queueCurrentDecisions(peer); });
    return { brokerPid: process.pid, name: peer.name, sessionId: peer.sessionId, peers: this.livePeers().filter((x) => x.id !== peer.id) };
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
      this.replayMail(conn, peer);
    }
    return { moved };
  }

  private onUpdatePeer(conn: Conn, args: RequestMap["updatePeer"][0]): PeerInfo {
    const peer = this.requirePeer(conn);
    if (args.unavailable !== undefined) {
      if (peer.jobAgent || typeof args.unavailable !== "boolean") throw new BridgeError("bad_request", "Only masters can change availability.");
      peer.unavailable = args.unavailable;
      this.routePendingJobMail();
      if (!peer.unavailable) this.replayMail(conn, peer);
    }
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
    if (args.wakeOnDirect !== undefined) peer.wakeOnDirect = Boolean(args.wakeOnDirect);
    if (args.wakeAvailable !== undefined) peer.wakeAvailable = Boolean(args.wakeAvailable);
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
      // Mail that was waiting under the new name is now ours.
      setImmediate(() => {
        for (const m of this.unreadMail(peer.name, PENDING_MAX_LIMIT)) this.emit(conn, "message", m);
      });
    }
    this.log.debug("peer updated", { name: peer.name, sessionId: peer.sessionId, autoWake: peer.autoWake, cwd: peer.cwd });
    this.store.rememberSession(peer, this.now());
    this.store.rememberName(peer, this.now());
    this.restoreNames(conn, peer, { reclaim: args.sessionId !== undefined, replay: true });
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
      if (c === conn || !old || old.agent !== peer.agent) continue;
      const sameSession = peer.sessionId && old.sessionId === peer.sessionId;
      const identity = registrationIdentity(peer);
      // Separate MCP processes of the same CLI can overlap before a hook learns its session id.
      const sameProcess = (old.pid !== peer.pid || old.id === peer.id) && identity && identity === registrationIdentity(old) &&
        (!old.sessionId || !peer.sessionId || old.sessionId === peer.sessionId);
      if (!sameSession && !sameProcess) continue;
      this.store.rememberName(old, this.now());
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
        this.replayMail(conn, peer, () => { this.store.claim(oldName, peer.name); });
      }
    }
  }

  private restoreNames(conn: Conn, peer: PeerInfo, options: { reclaim: boolean; replay: boolean }): void {
    const names = this.store.namesFor(peer);
    const previous = peer.name;
    if (options.reclaim) {
      const base = peer.name.replace(/-\d+$/, "");
      const original = names.find((name) => name.replace(/-\d+$/, "") === base && (name === peer.name || !this.connByName(name)));
      if (original) peer.name = original;
    }
    let moved = 0;
    for (const name of names) {
      if (name === peer.name || this.connByName(name)) continue;
      moved += this.store.claim(name, peer.name);
    }
    this.store.rememberName(peer, this.now());
    if (options.replay && (moved || previous !== peer.name)) this.replayMail(conn, peer);
  }

  /** Exact registrations win; an unoccupied retained alias must identify one live session. */
  private recipientConn(name: string): Conn | undefined {
    const exact = this.connByName(name);
    if (exact) return exact;
    const matches = [...this.conns].filter((c) => c.peer && this.store.namesFor(c.peer).includes(name));
    return matches.length === 1 ? matches[0] : undefined;
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
    if (to.startsWith("project:")) {
      const members = this.localPeers().filter((p) => !p.jobAgent && !p.subagent).map((p) => this.projectPeer(p)).filter((p) => p.projectAddress === to);
      const keys = new Set(members.map((p) => p.projectGroup));
      if (keys.size !== 1) throw new BridgeError(keys.size > 1 ? "ambiguous_target" : "unknown_target", "Use a unique live local project address from peers.");
      const target = members.filter((p) => !p.unavailable).sort((a, b) => Number(Boolean(b.projectMain)) - Number(Boolean(a.projectMain)) || a.startedAt - b.startedAt || a.name.localeCompare(b.name))[0];
      if (!target) throw new BridgeError("unknown_target", "No project master is available; use an exact session name to queue mail.");
      return { live: [this.connByName(target.name)!], queued: [] };
    }
    if (to === BROADCAST) {
      if (others.length === 0) throw new BridgeError("unknown_target", "no other peers are online");
      return { live: others, queued: [] };
    }
    const recipient = this.recipientConn(to);
    const exact = all.find((c) => c.peer!.id === to || c === recipient);
    if (exact) return { live: [exact], queued: [] };
    if (recipient?.peer?.id === sender.id || to === sender.name || to === sender.id) throw new BridgeError("bad_request", "cannot send a message to yourself");
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
    let to = String(args.to ?? "").trim();
    if (!to) throw new BridgeError("bad_request", "missing target");

    // Durable ownership wins over the old name cached in a still-running parent link.
    const own = sender.jobAgent ? this.storedJobs().find((j) => `job:${j.id}` === sender.id) : undefined;
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
    conversationId ||= randomUUID();
    if (own && (to === own.rootName || to === own.owner || this.groups.members(own, this.localPeers()).some((p) => p.name === to) || mastersFor(own).includes(to))) conversationId = this.jobConversation(own, to, conversationId);

    const id = sender.jobAgent && args.dedupeKey?.startsWith(COMPLETION_DEDUPE_PREFIX)
      ? completionMessageId(sender.id, args.dedupeKey.slice(COMPLETION_DEDUPE_PREFIX.length)) : randomUUID();
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
    const remoteTargets = to === BROADCAST ? this.network?.peers().filter((p) => !p.jobAgent).map((p) => p.name) ?? [] : [];
    const { live, queued } = to === BROADCAST && remoteTargets.length
      ? { live: [...this.conns].filter((c) => c.peer && c.peer.id !== sender.id && !c.peer.jobAgent), queued: [] }
      : this.resolveTargets(to, sender);
    // With no available master, retain job reports under the primary without waking it.
    if (own && to === this.jobRecipient(own)) {
      for (let i = live.length - 1; i >= 0; i--) {
        if (live[i]!.peer?.unavailable) queued.push(live.splice(i, 1)[0]!.peer!.name);
      }
    }
    if (conversationId.startsWith(SIBLING_CONVERSATION_PREFIX) &&
        (queued.some((name) => !sender.jobAgent || !this.storedSiblings(sender).some((s) => s.name === name)) ||
          live.some((c) => c.peer!.jobAgent && (!sender.jobAgent || !sender.jobOwner || (!this.sameJobFamily(sender, c.peer!) && !this.sharedJobs(sender, c.peer!) && !sender.jobSendTo?.includes(c.peer!.name)))))) {
      throw new BridgeError("unauthorized", "sibling chat requires the same supervisor or an explicit send_to job grant");
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
    const result: RequestMap["send"][1] = { messages, deliveredTo: live.map((c) => c.peer!.name), queuedFor: queued, recipientStates: live.map((c) => ({ name: c.peer!.name, activity: c.peer!.activity, autoWake: c.peer!.autoWake, wakeOnDirect: c.peer!.wakeOnDirect, wakeAvailable: c.peer!.wakeAvailable, wakeMaxHops: c.peer!.wakeMaxHops })) };
    for (const recipient of remoteTargets) {
      // Fan out only at the originating broker. Receiving brokers deliver one local envelope.
      try {
        const remote = await this.requireNetwork().send({ ...base, recipient });
        for (const message of remote.messages) this.store.insert(message);
        result.messages.push(...remote.messages);
        result.deliveredTo.push(...remote.deliveredTo);
        result.queuedFor.push(...remote.queuedFor);
        result.recipientStates!.push(...remote.recipientStates ?? []);
      } catch (err) {
        const message = { ...base, recipient };
        this.store.insert(message);
        result.messages.push(message);
        (result.failedFor ??= []).push({ name: recipient, reason: (err as Error).message });
        this.log.warn("broadcast recipient delivery failed", { id, recipient, err: String(err) });
      }
    }
    return result;
  }

  private unreadMail(recipient: string, limit: number): BridgeMessage[] {
    const messages = this.store.unread(recipient, limit);
    if (!this.jobsPath) return messages;
    const finished = new Set(this.storedJobs().filter((j) => j.status && j.status !== "running" &&
      (!primaryFor(j) || (!j.projectRoot && !j.deliveryHistory && !j.ownershipHistory && !this.groups.jobRoot(j, this.localPeers())))).map((j) => `job:${j.id}`));
    // Preserve the established retirement of old job status notes. Observer copies and quiet
    // acknowledgements remain available on demand even after the originating job finishes.
    const obsolete = messages.filter((m) => !isQuietMessage(m) && m.conversationId.endsWith(SIBLING_NOTE_SUFFIX) && finished.has(m.from.id));
    this.store.markRead(recipient, obsolete.map((m) => m.id), this.now());
    return messages.filter((m) => !obsolete.includes(m));
  }

  private remoteReceipt(id: string, sender: string, recipient?: string): number | null {
    const message = this.store.byId(id);
    if (!message || message.from.id !== sender) throw new BridgeError("unauthorized", "receipt is only available to the sender");
    const receipts = this.store.receipts(id);
    const receipt = recipient ? receipts.find((r) => r.recipient === recipient) : receipts[0];
    // A queued direct envelope may have moved from a retained alias to the reclaimed name.
    const addressedAlias = recipient && message.to !== BROADCAST && message.to.split("/").at(-1) === recipient;
    return (receipt ?? (addressedAlias ? receipts.find((r) => r.recipient === message.recipient) : undefined))?.readAt ?? null;
  }

  private async messageReceipt(conn: Conn, id: string) {
    const sender = this.requirePeer(conn);
    const message = this.store.byId(z.uuid().parse(id));
    if (!message || message.from.name !== sender.name) throw new BridgeError("unauthorized", "receipt is only available to the sender");
    const receipts = this.store.receipts(id);
    return Promise.all(receipts.map(async (r) => r.recipient.includes("/")
      ? { ...r, readAt: await this.requireNetwork().receipt(r.recipient, id, message.from.id,
        receipts.filter((other) => other.recipient.startsWith(`${r.recipient.split("/")[0]}/`)).length > 1) }
      : r));
  }

  private requireNetwork(): NetworkService {
    if (!this.network) throw new BridgeError("bad_request", "networking is disabled or unavailable; enable it and restart the broker");
    return this.network;
  }

  private async onSendFiles(conn: Conn, args: RequestMap["sendFiles"][0]): Promise<TransferResult | TransferStarted> {
    const sender = this.requirePeer(conn);
    const parsed = z.object({ to: z.string().min(1).max(MAX_FILE_ADDRESS_CHARS), paths: z.array(z.string().min(1).max(MAX_FILE_PATH_CHARS)).min(1).max(MAX_STREAM_ENTRIES) }).parse(args);
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

  private receiveRemote(message: BridgeMessage): { delivered: boolean; recipient: string } {
    const target = this.recipientConn(message.recipient);
    if (target?.peer) message = { ...message, recipient: target.peer.name };
    const existing = this.store.byId(message.id);
    if (existing) {
      const broadcastCopy = existing.to === BROADCAST && message.to === BROADCAST;
      if (existing.from.id !== message.from.id || (!broadcastCopy && existing.recipient !== message.recipient) || existing.to !== message.to || existing.body !== message.body || existing.conversationId !== message.conversationId || existing.replyTo !== message.replyTo || existing.hop !== message.hop) throw new BridgeError("bad_request", "message id already used");
      if (this.store.receipts(message.id).some((r) => r.recipient === message.recipient)) return { delivered: Boolean(target), recipient: message.recipient };
    }
    this.store.insert(message);
    if (target) this.emit(target, "message", message);
    return { delivered: Boolean(target), recipient: message.recipient };
  }
}
