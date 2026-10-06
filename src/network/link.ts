import { randomBytes, randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { connect, createServer, type Server, type TLSSocket } from "node:tls";
import { z } from "zod";
import { MAX_BODY_CHARS } from "../core/constants.js";
import type { Logger } from "../core/logger.js";
import { AGENT_KINDS, BridgeError, type BridgeMessage, type PeerInfo, type SendResult } from "../core/protocol.js";
import type { NetworkConfig } from "./config.js";
import { MAX_NETWORK_FRAME_BYTES, MAX_NETWORK_LINKS, MAX_NETWORK_PEERS, MAX_NETWORK_REQUESTS, NETWORK_NAME_PATTERN, NETWORK_REFRESH_MS, NETWORK_TIMEOUT_MS, NETWORK_VERSION, PAIRING_KEY_BYTES, TLS_CIPHER } from "./constants.js";
import { NetworkDiscovery, type DiscoveredInstance, type DiscoveryDiagnostics } from "./discovery.js";
import { decodePairingCode, keyFingerprint, PairingStore, publicIdentitySchema, type NetworkIdentity, type NetworkPair } from "./pairing.js";
import { receiveTransfer, transferResultSchema, transferSchema, type FileTransfer, type TransferResult } from "./files.js";
import { FILE_STREAM_CAPABILITY, TransferManager, type TransferStarted } from "./transfers.js";

const MAX_METADATA_CHARS = 4_096;
const MAX_ID_CHARS = 128;
const MAX_HOP_COUNT = 100;
const MAX_EXTENSION_HANDLERS = 8;
export type NetworkExtensionType = "file-stream" | "remote-job" | "dashboard-read";
export type NetworkExtensionHandler = (payload: Record<string, unknown>, remote: NetworkPair) => void | Promise<void>;
const textId = z.string().min(1).max(MAX_ID_CHARS);
const peerSchema = z.object({
  id: textId, name: z.string().regex(NETWORK_NAME_PATTERN), agent: z.enum(AGENT_KINDS),
  cwd: z.string().max(MAX_METADATA_CHARS), pid: z.number().int().nonnegative(), agentPid: z.number().int().nonnegative().nullable(),
  sessionId: z.string().max(MAX_METADATA_CHARS).nullable(), startedAt: z.number().nonnegative(), autoWake: z.boolean(),
  wakeOnDirect: z.boolean().optional(), wakeAvailable: z.boolean().optional(), wakeMaxHops: z.number().int().min(0).max(MAX_HOP_COUNT).optional(),
  activity: z.enum(["busy", "idle"]).nullable().optional(), version: z.string().max(MAX_ID_CHARS).optional(), jobAgent: z.enum(AGENT_KINDS).optional(),
  jobParent: z.string().max(MAX_METADATA_CHARS).optional(), jobTitle: z.string().max(MAX_METADATA_CHARS).optional(),
  parentJob: z.string().max(MAX_METADATA_CHARS).optional(), rootSession: z.string().max(MAX_METADATA_CHARS).optional(),
  rootName: z.string().max(MAX_METADATA_CHARS).optional(), subagent: z.boolean().optional(), title: z.string().max(MAX_METADATA_CHARS).optional(),
});
const peersSchema = z.array(peerSchema).max(MAX_NETWORK_PEERS).refine((peers) => new Set(peers.map((p) => p.name)).size === peers.length && new Set(peers.map((p) => p.id)).size === peers.length);
const messageSchema = z.object({
  id: z.uuid(), from: z.object({ id: textId, name: z.string().regex(NETWORK_NAME_PATTERN), agent: z.enum(AGENT_KINDS) }),
  to: z.string().min(1).max(MAX_METADATA_CHARS), recipient: z.string().regex(NETWORK_NAME_PATTERN),
  conversationId: textId, replyTo: textId.nullable(), hop: z.number().int().min(0).max(MAX_HOP_COUNT),
  body: z.string().min(1).max(MAX_BODY_CHARS), createdAt: z.number().nonnegative(), readAt: z.null(),
});
const frameSchema = z.discriminatedUnion("type", [
  publicIdentitySchema.extend({ type: z.literal("hello"), v: z.literal(NETWORK_VERSION), peers: peersSchema, echo: z.boolean().optional(), receipts: z.boolean().optional(), capabilities: z.array(z.string().min(1).max(MAX_ID_CHARS)).max(MAX_EXTENSION_HANDLERS).optional() }),
  z.object({ type: z.literal("file-stream"), payload: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("remote-job"), payload: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("dashboard-read"), payload: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("peers"), peers: peersSchema }),
  z.object({ type: z.literal("send"), rid: z.uuid(), message: messageSchema }),
  z.object({ type: z.literal("echo"), rid: z.uuid() }),
  z.object({ type: z.literal("receipt"), rid: z.uuid(), id: z.uuid(), sender: textId }),
  z.object({ type: z.literal("files"), rid: z.uuid(), transfer: transferSchema }),
  z.object({ type: z.literal("result"), rid: z.uuid(), delivered: z.boolean().optional(), readAt: z.number().nonnegative().nullable().optional(), transfer: transferResultSchema.optional(), error: z.string().max(MAX_METADATA_CHARS).optional() }),
]);
type NetworkFrame = z.infer<typeof frameSchema>;

export interface NetworkBroker {
  peers(): PeerInfo[];
  receipt?(id: string, sender: string): number | null;
  receive(message: BridgeMessage): { delivered: boolean };
}
export interface NetworkStatus {
  enabled: boolean;
  config?: NetworkConfig;
  identity?: NetworkIdentity;
  port?: number;
  discovered: DiscoveredInstance[];
  discoveryDiagnostics?: DiscoveryDiagnostics;
  paired: (NetworkIdentity & { connected: boolean; health?: { lastVerifiedAt: number; roundTripMs: number } })[];
}
interface Pending {
  resolve: (result: boolean | TransferResult | number | null) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  kind: "send" | "files" | "echo" | "receipt";
}

/** Bounded JSON records, only after TLS has authenticated possession of a pairing key. */
class Link {
  remote: NetworkPair | null = null;
  peers: PeerInfo[] = [];
  private echoSupported = false;
  private receiptsSupported = false;
  private capabilities: string[] = [];
  private extensionHandlers = 0;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, Pending>();
  private readonly extensionWrites = new Set<(error: Error) => void>();
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
  private readonly deadline: NodeJS.Timeout;

  constructor(readonly socket: TLSSocket, private readonly service: NetworkService, private readonly key: string, private readonly expected?: NetworkPair) {
    this.deadline = setTimeout(() => this.fail(new Error("network hello timed out")), NETWORK_TIMEOUT_MS);
    // Accepted links have no caller waiting for ready; still handle rejection.
    void this.ready.catch(() => {});
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    });
    socket.on("error", (err) => this.fail(err));
    socket.on("close", () => {
      clearTimeout(this.deadline);
      this.readyReject(new Error("network link closed"));
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("network link closed")); }
      this.pending.clear();
      for (const reject of this.extensionWrites) reject(new Error("network link closed"));
      this.extensionWrites.clear();
      service.detach(this);
    });
    this.write({ type: "hello", v: NETWORK_VERSION, ...service.keys.identity, peers: service.localPeers(), echo: true, receipts: Boolean(service.supportsReceipts), capabilities: service.extensionCapabilities() });
  }

  private processBuffer(): void {
    if (this.socket.destroyed) return;
    try {
      let nl: number;
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
          clearTimeout(this.deadline); this.readyResolve();
        } else if (frame.type === "hello") throw new Error("duplicate network hello");
        else this.onFrame(frame);
      }
      if (this.buffer.length > MAX_NETWORK_FRAME_BYTES) throw new Error("network frame too large");
      if (this.extensionHandlers >= MAX_EXTENSION_HANDLERS) this.socket.pause();
      else this.socket.resume();
    } catch (error) { this.fail(error as Error); }
  }

  write(frame: NetworkFrame): void {
    const data = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(data) > MAX_NETWORK_FRAME_BYTES || this.socket.writableLength > MAX_NETWORK_FRAME_BYTES) throw new Error("network write limit reached");
    if (this.socket.destroyed) throw new Error("network link closed");
    this.socket.write(data);
  }

  supports(capability: string): boolean { return this.capabilities.includes(capability); }

  /** Complete only after the stream has consumed this bounded record; callers await each write. */
  writeExtension(type: NetworkExtensionType, payload: Record<string, unknown>): Promise<void> {
    const data = JSON.stringify({ type, payload }) + "\n";
    if (Buffer.byteLength(data) > MAX_NETWORK_FRAME_BYTES || this.socket.writableLength > MAX_NETWORK_FRAME_BYTES || this.extensionWrites.size >= MAX_NETWORK_REQUESTS) return Promise.reject(new Error("network write limit reached"));
    if (this.socket.destroyed) return Promise.reject(new Error("network link closed"));
    return new Promise((resolve, reject) => {
      const failed = (error: Error) => { this.extensionWrites.delete(failed); reject(error); };
      this.extensionWrites.add(failed);
      try { this.socket.write(data, (error) => { this.extensionWrites.delete(failed); if (error) reject(error); else resolve(); }); }
      catch (error) { failed(error as Error); }
    });
  }

  refresh(): void {
    if (this.remote) this.write({ type: "peers", peers: this.service.localPeers() });
  }

  send(message: BridgeMessage): Promise<boolean> {
    return this.request({ type: "send", rid: randomUUID(), message: messageSchema.parse(message) }) as Promise<boolean>;
  }

  receipt(id: string, sender: string): Promise<number | null> {
    if (!this.receiptsSupported) return Promise.reject(new Error("Remote broker does not support read receipts. Update and reload its hosting sessions."));
    return this.request({ type: "receipt", rid: randomUUID(), id, sender }) as Promise<number | null>;
  }

  files(transfer: FileTransfer): Promise<TransferResult> {
    return this.request({ type: "files", rid: randomUUID(), transfer: transferSchema.parse(transfer) }) as Promise<TransferResult>;
  }

  async echo(): Promise<void> {
    if (!this.echoSupported) throw new Error("Remote broker does not support verification. Update and restart its hosting sessions.");
    const result = await this.request({ type: "echo", rid: randomUUID() });
    if (result !== true) throw new Error("network echo was not acknowledged");
  }

  private request(frame: Extract<NetworkFrame, { type: "send" | "files" | "echo" | "receipt" }>): Promise<boolean | TransferResult | number | null> {
    if (this.pending.size >= MAX_NETWORK_REQUESTS) return Promise.reject(new Error("too many network requests"));
    return new Promise((resolve, reject) => {
      const rid = frame.rid;
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error("network send timed out; delivery may have occurred")); }, NETWORK_TIMEOUT_MS);
      this.pending.set(rid, { resolve, reject, timer, kind: frame.type });
      try {
        this.refresh();
        this.write(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(err);
      }
    });
  }

  private onFrame(frame: Exclude<NetworkFrame, { type: "hello" }>): void {
    if (frame.type === "file-stream" || frame.type === "remote-job" || frame.type === "dashboard-read") {
      if (++this.extensionHandlers > MAX_EXTENSION_HANDLERS) throw new Error("too many extension handlers");
      void Promise.resolve().then(() => this.service.receiveExtension(frame.type, frame.payload, this.remote!))
        .catch((error: Error) => this.fail(error)).finally(() => { this.extensionHandlers--; this.processBuffer(); });
      return;
    }
    if (frame.type === "peers") { this.peers = frame.peers; return; }
    if (frame.type === "result") {
      const pending = this.pending.get(frame.rid);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.rid);
      if (frame.error) pending.reject(new Error(frame.error));
      else if ((pending.kind === "send" || pending.kind === "echo") && frame.delivered !== undefined) pending.resolve(frame.delivered);
      else if (pending.kind === "receipt" && frame.readAt !== undefined) pending.resolve(frame.readAt);
      else if (pending.kind === "files" && frame.transfer) pending.resolve(frame.transfer);
      else pending.reject(new Error("invalid network result"));
      return;
    }
    if (frame.type === "echo") { this.write({ type: "result", rid: frame.rid, delivered: true }); return; }
    try {
      if (frame.type === "receipt") {
        const readAt = this.service.readReceipt(frame.id, `${this.remote!.id}/${frame.sender}`);
        this.write({ type: "result", rid: frame.rid, readAt });
        return;
      }
      const from = frame.type === "send" ? frame.message.from : frame.transfer.from;
      const sender = this.peers.find((p) => p.id === from.id && p.name === from.name);
      if (!sender || (sender.jobAgent ?? sender.agent) !== from.agent) throw new Error("sender not advertised by paired instance");
      const remote = this.remote!;
      if (frame.type === "files") {
        const result = this.service.receiveFiles(frame.transfer, `${remote.name}/${from.name}`, `${remote.id}/${from.id}`);
        this.write({ type: "result", rid: frame.rid, transfer: result });
        return;
      }
      const message = { ...frame.message, from: { ...frame.message.from, id: `${remote.id}/${frame.message.from.id}`, name: `${remote.name}/${frame.message.from.name}` } };
      const result = this.service.receive(message);
      this.refresh();
      this.write({ type: "result", rid: frame.rid, delivered: result.delivered });
    } catch (err) {
      this.write({ type: "result", rid: frame.rid, error: String((err as Error).message).slice(0, MAX_METADATA_CHARS) });
    }
  }

  fail(error: Error): void {
    this.readyReject(error);
    this.socket.destroy();
  }
}

/** One per elected local broker. Discovery cannot call link(); only an authenticated local request can. */
export class NetworkService {
  readonly keys: PairingStore;
  readonly transfers: TransferManager;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly links = new Map<string, Link>();
  private readonly connecting = new Set<string>();
  private readonly health = new Map<string, { lastVerifiedAt: number; roundTripMs: number }>();
  private discovery: NetworkDiscovery | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly extensions = new Map<NetworkExtensionType, { capability: string; handler: NetworkExtensionHandler }>();

  constructor(private readonly home: string, private readonly cfg: NetworkConfig, private readonly broker: NetworkBroker, private readonly log: Logger) {
    this.keys = new PairingStore(home, cfg.name);
    this.transfers = new TransferManager(home, {
      supports: (remote) => this.peerSupports(remote, FILE_STREAM_CAPABILITY),
      send: (remote, payload) => {
        if (payload.op === "offer" || payload.op === "fetch") this.instanceLink(remote).refresh();
        return this.sendExtension(remote, "file-stream", payload);
      },
      validSender: (remote, sender) => this.links.get(remote)?.peers.some((peer) => peer.id === sender.id && peer.name === sender.name && (peer.jobAgent ?? peer.agent) === sender.agent) ?? false,
      localPeer: (name) => {
        const peer = this.broker.peers().find((peer) => peer.name === name);
        return peer ? { id: peer.id, name: peer.name, agent: peer.jobAgent ?? peer.agent, cwd: peer.cwd } : undefined;
      },
      notify: (message) => { this.broker.receive(message); },
      legacy: (remote, transfer) => this.instanceLink(remote).files(transfer),
    }, log, { maxBytes: cfg.maxTransferBytes, fetchRoots: cfg.fetchRoots });
    this.registerExtension("file-stream", FILE_STREAM_CAPABILITY, (payload, remote) => this.transfers.handle(payload, remote.id, remote.name));
  }

  get port(): number {
    const address = this.server?.address();
    return address && typeof address !== "string" ? address.port : 0;
  }

  registerExtension(type: NetworkExtensionType, capability: string, handler: NetworkExtensionHandler): void {
    if (this.server || this.extensions.has(type)) throw new Error("register extensions once before starting networking");
    this.extensions.set(type, { capability, handler });
  }

  extensionCapabilities(): string[] { return [...this.extensions.values()].map((extension) => extension.capability); }

  receiveExtension(type: NetworkExtensionType, payload: Record<string, unknown>, remote: NetworkPair): void | Promise<void> {
    const extension = this.extensions.get(type);
    if (!extension) throw new Error("unsupported network extension");
    return extension.handler(payload, remote);
  }

  private instanceLink(instance: string): Link {
    const link = [...this.links.values()].find((candidate) => candidate.remote!.id === instance || candidate.remote!.name === instance);
    if (!link) throw new Error("paired instance is not connected");
    return link;
  }

  peerSupports(instance: string, capability: string): boolean {
    try { return this.instanceLink(instance).supports(capability); } catch { return false; }
  }

  async sendExtension(instance: string, type: NetworkExtensionType, payload: Record<string, unknown>): Promise<void> {
    const extension = this.extensions.get(type);
    const link = this.instanceLink(instance);
    if (!extension || !link.supports(extension.capability)) return Promise.reject(new Error("remote broker does not support this extension"));
    // A session can join/reload between periodic refreshes. Advertise it before the remote authorization check.
    if (type === "remote-job" && payload.kind === "request") link.refresh();
    return link.writeExtension(type, payload);
  }

  get supportsReceipts(): boolean { return Boolean(this.broker.receipt); }
  readReceipt(id: string, sender: string): number | null {
    if (!this.broker.receipt) throw new Error("read receipts unavailable");
    return this.broker.receipt(id, sender);
  }
  async receipt(address: string, id: string, sender: string): Promise<number | null> {
    return this.target(address).link.receipt(id, sender);
  }

  localPeers(): PeerInfo[] { return peersSchema.parse(this.broker.peers()); }
  receive(message: BridgeMessage): { delivered: boolean } { return this.broker.receive(message); }

  async start(): Promise<void> {
    if (!this.cfg.enabled) throw new Error("networking is disabled");
    if (this.server || this.closed) throw new Error("network service already started or closed");
    const acceptedKeys = new WeakMap<TLSSocket, string>();
    const server = createServer({
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ciphers: TLS_CIPHER, handshakeTimeout: NETWORK_TIMEOUT_MS,
      pskCallback: (socket, identity) => {
        const key = this.keys.keyFor(identity);
        if (key) acceptedKeys.set(socket, key);
        return key ? Buffer.from(key, "hex") : randomBytes(PAIRING_KEY_BYTES);
      },
    }, (socket) => {
      const key = acceptedKeys.get(socket);
      if (!key || socket.getProtocol() !== "TLSv1.3") return socket.destroy();
      try { new Link(socket, this, key); }
      catch (err) { socket.destroy(); this.log.warn("network hello could not be sent", { message: (err as Error).message }); }
    });
    this.server = server;
    server.maxConnections = MAX_NETWORK_LINKS;
    server.on("connection", (socket) => { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); });
    server.on("tlsClientError", () => this.log.debug("network TLS authentication failed"));
    server.on("error", (err) => this.log.warn("network listener error", { message: err.message }));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.cfg.port, this.cfg.bind, () => { server.off("error", reject); resolve(); });
      });
      if (this.cfg.discovery) {
        this.discovery = new NetworkDiscovery({ identity: this.keys.identity, port: this.port, onError: (err) => this.log.warn("network discovery error", { message: err.message }) });
        await this.discovery.start();
      }
      this.timer = setInterval(() => {
        for (const link of this.links.values()) { try { link.refresh(); } catch (err) { link.fail(err as Error); } }
        for (const pair of this.keys.pairs()) if (pair.host && pair.port && !this.links.has(pair.id) && !this.connecting.has(pair.id)) void this.connectPair(pair).catch(() => {});
      }, NETWORK_REFRESH_MS);
      this.timer.unref();
      for (const pair of this.keys.pairs()) if (pair.host && pair.port) void this.connectPair(pair).catch(() => {});
    } catch (err) { await this.close(); throw err; }
  }

  attach(link: Link): void {
    const remote = link.remote!;
    if (this.closed) throw new Error("network service closed");
    const existing = this.links.get(remote.id);
    if (existing && existing !== link) throw new Error("instance already connected");
    this.links.set(remote.id, link);
    setImmediate(() => this.transfers.resume());
  }

  detach(link: Link): void {
    if (link.remote && this.links.get(link.remote.id) === link) { this.links.delete(link.remote.id); this.transfers.disconnected(link.remote.id); }
  }

  peers(): PeerInfo[] {
    return [...this.links.values()].flatMap((link) => link.peers.map((p) => {
      const host = link.remote!.name;
      const qualify = (value: string | undefined, prefix = host) => value && !value.includes("/") ? `${prefix}/${value}` : value;
      return { ...p, agent: p.jobAgent ?? p.agent, host, id: `${link.remote!.id}/${p.id}`, name: `${host}/${p.name}`,
        jobParent: qualify(p.jobParent), parentJob: qualify(p.parentJob), rootName: qualify(p.rootName), rootSession: qualify(p.rootSession, link.remote!.id) };
    }));
  }

  status(): NetworkStatus {
    return { enabled: true, config: this.cfg, identity: this.keys.identity, port: this.port, discovered: this.discovery?.instances() ?? [], ...(this.discovery ? { discoveryDiagnostics: this.discovery.diagnostics() } : {}), paired: this.keys.pairs().map(({ id, name, fingerprint }) => ({ id, name, fingerprint, connected: this.links.has(id), ...(this.health.has(id) ? { health: this.health.get(id)! } : {}) })) };
  }

  async verify(id: string): Promise<{ peers: PeerInfo[]; roundTripMs: number }> {
    const link = this.links.get(id);
    if (!link) throw new Error("paired instance is not connected");
    const start = performance.now();
    await link.echo();
    const roundTripMs = Math.round(performance.now() - start);
    this.health.set(id, { lastVerifiedAt: Date.now(), roundTripMs });
    return { peers: this.peers().filter((p) => p.id.startsWith(`${id}/`)), roundTripMs };
  }

  async link(code: string, host: string, port: number): Promise<NetworkIdentity> {
    const decoded = decodePairingCode(code);
    const pair = this.keys.validatePair(decoded, host, port);
    // Remember only after the TLS link proves the code belongs to the remote instance.
    await this.connectPair(pair);
    try { this.keys.remember(decoded, host, port); }
    catch (err) { this.links.get(pair.id)?.socket.destroy(); throw err; }
    return { id: decoded.id, name: decoded.name, fingerprint: decoded.fingerprint };
  }

  private async connectPair(pair: NetworkPair): Promise<void> {
    if (this.closed || this.links.has(pair.id) || this.connecting.has(pair.id)) throw new Error("instance already connected or connecting");
    this.connecting.add(pair.id);
    let socket: TLSSocket | null = null;
    try {
      socket = connect({
        host: pair.host, port: pair.port, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ciphers: TLS_CIPHER,
        // TLS-PSK has no certificate. The PSK is mandatory; certificate-based fallbacks are rejected below.
        rejectUnauthorized: false, checkServerIdentity: () => undefined,
        pskCallback: () => ({ identity: keyFingerprint(pair.key), psk: Buffer.from(pair.key, "hex") }),
      });
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket!));
      const secured = socket;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { secured.destroy(); reject(new Error("network TLS handshake timed out")); }, NETWORK_TIMEOUT_MS);
        const onError = (err: Error) => { clearTimeout(timer); reject(err); };
        secured.once("error", onError);
        secured.once("secureConnect", () => { clearTimeout(timer); secured.off("error", onError); resolve(); });
      });
      if (secured.getProtocol() !== "TLSv1.3" || Object.keys(secured.getPeerCertificate()).length) throw new Error("TLS-PSK required");
      // Outbound links authenticate against the expected pin; inbound links consume an invitation.
      await new Link(secured, this, pair.key, pair).ready;
    } catch (err) { socket?.destroy(); throw err; }
    finally { this.connecting.delete(pair.id); }
  }

  unlink(id: string): void {
    try { this.keys.remove(id); this.health.delete(id); }
    finally { this.links.get(id)?.socket.destroy(); }
  }

  async send(message: BridgeMessage): Promise<SendResult> {
    const { link, target } = this.target(message.recipient);
    const recipient = `${link.remote!.name}/${target}`;
    const delivered = await link.send({ ...message, recipient: target });
    return { messages: [{ ...message, recipient }], deliveredTo: delivered ? [recipient] : [], queuedFor: delivered ? [] : [recipient], recipientStates: link.peers.filter((p) => p.name === target).map((p) => ({ name: recipient, activity: p.activity, autoWake: p.autoWake, wakeOnDirect: p.wakeOnDirect, wakeAvailable: p.wakeAvailable, wakeMaxHops: p.wakeMaxHops })) };
  }

  private target(address: string): { link: Link; target: string } {
    const slash = address.indexOf("/");
    const host = address.slice(0, slash);
    const raw = address.slice(slash + 1);
    const link = [...this.links.values()].find((l) => l.remote!.name === host || l.remote!.id === host);
    const target = link?.peers.find((p) => p.name === raw || p.id === raw)?.name ?? raw;
    if (!link || !NETWORK_NAME_PATTERN.test(target)) throw new BridgeError("unknown_target", "paired instance is not connected or target is invalid");
    return { link, target };
  }

  async sendFiles(address: string, transfer: FileTransfer): Promise<TransferResult> {
    const { link, target } = this.target(address);
    return link.files({ ...transfer, to: target });
  }

  startFiles(address: string, paths: string[], cwd: string, from: FileTransfer["from"], pull = false): TransferStarted {
    const { link, target } = this.target(address);
    if (!link.peers.some((peer) => peer.name === target)) throw new Error("file recipient is not online");
    const streaming = link.supports(FILE_STREAM_CAPABILITY);
    if (pull && !streaming) throw new Error("remote broker does not support fetch_files; update its hosting sessions");
    return this.transfers.start(link.remote!.id, `${link.remote!.name}/${target}`, target, paths, cwd, from, pull, undefined, !streaming);
  }

  fileTarget(address: string): string { return this.target(address).target; }

  receiveFiles(transfer: FileTransfer, name: string, id: string): TransferResult {
    if (!this.broker.peers().some((p) => p.name === transfer.to)) throw new Error("file recipient is not online");
    const bytes = transfer.entries.reduce((sum, entry) => sum + (entry.kind === "file" ? Buffer.byteLength(entry.data, "base64") : 0), 0);
    if (this.cfg.maxTransferBytes !== undefined && bytes > this.cfg.maxTransferBytes) throw new Error("transfer exceeds size limit");
    const result = receiveTransfer(this.home, transfer);
    this.transfers.recordLegacy(transfer, id.split("/")[0]!, name);
    this.log.info("legacy files received", { ...result, sender: name });
    this.broker.receive({ id: transfer.id, from: { ...transfer.from, name, id }, to: transfer.to, recipient: transfer.to, conversationId: transfer.id, replyTo: null, hop: 0, body: `Received ${result.files} files (${result.bytes} bytes) in ${result.inbox}`, createdAt: Date.now(), readAt: null });
    return result;
  }

  async close(): Promise<void> {
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
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
