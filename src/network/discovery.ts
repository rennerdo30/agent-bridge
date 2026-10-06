import { createSocket, type Socket } from "node:dgram";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { z } from "zod";
import { DISCOVERY_BIND, DISCOVERY_GROUP, DISCOVERY_INTERVAL_MS, DISCOVERY_MULTICAST_TTL, DISCOVERY_PORT, DISCOVERY_TTL_MS, MAX_DISCOVERED_INSTANCES, MAX_DISCOVERY_BYTES, MAX_PORT, NETWORK_VERSION } from "./constants.js";
import { publicIdentitySchema, type NetworkIdentity } from "./pairing.js";

const announcementSchema = publicIdentitySchema.extend({ service: z.literal("agent-bridge"), v: z.literal(NETWORK_VERSION), port: z.number().int().min(1).max(MAX_PORT) });
export interface DiscoveredInstance extends NetworkIdentity { host: string; port: number; seenAt: number }
export interface DiscoveryInterface { name: string; address: string; netmask: string; broadcast: string }
export interface DiscoveryDiagnostics {
  bind: string; port: number; multicastGroup: string; multicastTTL: number;
  interfaces: (DiscoveryInterface & { announcing: boolean; multicast: boolean; lastSentAt: number | null })[];
  skippedInterfaces: { name: string; address: string; reason: string }[];
  lastSentAt: number | null; lastReceivedAt: number | null;
  lastError: { at: number; message: string } | null;
}
const VIRTUAL_INTERFACE = /vethernet|hyper-v|wsl|docker|vbox|vmware|virtualbox|^virbr|^br-|^utun|^tun\d|^tap\d|^tailscale|^wg\d/i;
const IPV4_BITS = 32;
const IPV4_OCTET_BITS = 8;
const IPV4_OCTET_MASK = 255;
const MIN_BROADCAST_HOST_MASK = 3;
const ipv4Number = (address: string) => address.split(".").reduce((value, octet) => (value << IPV4_OCTET_BITS) | Number(octet), 0) >>> 0;
const ipv4Address = (value: number) => Array.from({ length: IPV4_BITS / IPV4_OCTET_BITS }, (_, i) => (value >>> (IPV4_BITS - IPV4_OCTET_BITS * (i + 1))) & IPV4_OCTET_MASK).join(".");

/** Select physical LAN addresses, never the OS default multicast route. */
export function discoveryInterfaces(all: ReturnType<typeof networkInterfaces>) {
  const interfaces: DiscoveryInterface[] = [], skippedInterfaces: DiscoveryDiagnostics["skippedInterfaces"] = [];
  for (const [name, addresses] of Object.entries(all)) for (const entry of addresses ?? []) {
    if (entry.family !== "IPv4") continue;
    let reason = "";
    if (entry.internal || entry.address.startsWith("127.")) reason = "loopback";
    else if (VIRTUAL_INTERFACE.test(name)) reason = "virtual or tunnel adapter";
    else if (entry.address.startsWith("169.254.") || entry.address === "0.0.0.0") reason = "no LAN address";
    else if (!isIPv4(entry.address) || !isIPv4(entry.netmask)) reason = "invalid IPv4 subnet";
    else {
      const mask = ipv4Number(entry.netmask), hostMask = (~mask) >>> 0;
      if (mask === 0 || hostMask < MIN_BROADCAST_HOST_MASK || (hostMask & (hostMask + 1)) !== 0) reason = "no broadcast subnet";
    }
    if (reason) skippedInterfaces.push({ name, address: entry.address, reason });
    else if (!interfaces.some((item) => item.address === entry.address)) interfaces.push({
      name, address: entry.address, netmask: entry.netmask,
      broadcast: ipv4Address(ipv4Number(entry.address) | ~ipv4Number(entry.netmask)),
    });
  }
  return { interfaces, skippedInterfaces };
}
export interface DiscoveryOptions {
  identity: NetworkIdentity;
  port: number;
  bind?: string;
  udpPort?: number;
  destination?: string;
  onError?: (error: Error) => void;
  now?: () => number;
  interfaces?: typeof networkInterfaces;
  createSocket?: () => Socket;
}

/** Announcements are untrusted hints. This module has no ability to create broker links. */
export class NetworkDiscovery {
  private socket: Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly found = new Map<string, DiscoveredInstance>();
  private readonly now: () => number;
  private readonly senders = new Map<string, { socket: Socket; info: DiscoveryDiagnostics["interfaces"][number] }>();
  private refreshing: Promise<void> | null = null;
  private skippedInterfaces: DiscoveryDiagnostics["skippedInterfaces"] = [];
  private lastSentAt: number | null = null;
  private lastReceivedAt: number | null = null;
  private lastError: DiscoveryDiagnostics["lastError"] = null;

  constructor(private readonly opts: DiscoveryOptions) {
    this.now = opts.now ?? Date.now;
  }

  get port(): number { return this.socket?.address().port ?? 0; }

  diagnostics(): DiscoveryDiagnostics {
    return {
      bind: this.opts.bind ?? DISCOVERY_BIND, port: this.port, multicastGroup: DISCOVERY_GROUP, multicastTTL: DISCOVERY_MULTICAST_TTL,
      interfaces: [...this.senders.values()].map(({ info }) => ({ ...info })),
      skippedInterfaces: this.skippedInterfaces.map((entry) => ({ ...entry })),
      lastSentAt: this.lastSentAt, lastReceivedAt: this.lastReceivedAt, lastError: this.lastError && { ...this.lastError },
    };
  }

  private error(error: Error): void {
    this.lastError = { at: this.now(), message: error.message };
    this.opts.onError?.(error);
  }

  private makeSocket(): Socket {
    const socket = this.opts.createSocket?.() ?? createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", (err) => this.error(err));
    return socket;
  }

  private bind(socket: Socket, port: number, address: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(port, address, () => { socket.off("error", reject); resolve(); });
    });
  }

  private async refreshInterfaces(): Promise<void> {
    const listener = this.socket;
    if (!listener) return;
    const selection = discoveryInterfaces((this.opts.interfaces ?? networkInterfaces)());
    this.skippedInterfaces = selection.skippedInterfaces;
    for (const [address, sender] of this.senders) if (!selection.interfaces.some((entry) => entry.address === address && entry.netmask === sender.info.netmask)) {
      if (sender.info.multicast) { try { listener.dropMembership(DISCOVERY_GROUP, address); } catch { /* Interface may already be gone. */ } }
      await this.closeSocket(sender.socket);
      this.senders.delete(address);
    }
    for (const entry of selection.interfaces) {
      if (this.senders.has(entry.address)) continue;
      const socket = this.makeSocket();
      try {
        // Bound senders guarantee both source address and directed-broadcast egress.
        await this.bind(socket, 0, entry.address);
        socket.setBroadcast(true);
        const info = { ...entry, announcing: true, multicast: false, lastSentAt: null as number | null };
        this.senders.set(entry.address, { socket, info });
        try {
          socket.setMulticastTTL(DISCOVERY_MULTICAST_TTL);
          socket.setMulticastInterface(entry.address);
          listener.addMembership(DISCOVERY_GROUP, entry.address);
          info.multicast = true;
        } catch (err) { this.error(new Error(`Discovery multicast on ${entry.name} (${entry.address}): ${(err as Error).message}`)); }
      } catch (err) {
        this.error(new Error(`Discovery interface ${entry.name} (${entry.address}): ${(err as Error).message}`));
        await this.closeSocket(socket);
      }
    }
  }

  async start(): Promise<void> {
    if (this.socket) throw new Error("network discovery already started");
    const socket = this.makeSocket();
    this.socket = socket;
    socket.on("message", (data, source) => this.observe(data, source.address));
    try { await this.bind(socket, this.opts.udpPort ?? DISCOVERY_PORT, this.opts.bind ?? DISCOVERY_BIND); }
    catch (err) { await this.close(); throw err; }
    this.timer = setInterval(() => { void this.announce(); }, DISCOVERY_INTERVAL_MS);
    this.timer.unref();
    await this.announce();
  }

  async announce(port = this.opts.udpPort === 0 ? this.port : this.opts.udpPort ?? DISCOVERY_PORT): Promise<void> {
    if (!this.socket) return;
    const data = Buffer.from(JSON.stringify({ service: "agent-bridge", v: NETWORK_VERSION, ...this.opts.identity, port: this.opts.port }));
    if (this.opts.destination && this.opts.destination !== DISCOVERY_GROUP) {
      this.send(this.socket, data, port, this.opts.destination);
      return;
    }
    if (!this.refreshing) this.refreshing = this.refreshInterfaces().catch((err: Error) => this.error(err)).finally(() => { this.refreshing = null; });
    await this.refreshing;
    if (!this.socket) return;
    for (const { socket, info } of this.senders.values()) {
      this.send(socket, data, port, info.broadcast, info);
      if (info.multicast) this.send(socket, data, port, DISCOVERY_GROUP, info);
    }
  }

  private send(socket: Socket, data: Buffer, port: number, destination: string, info?: DiscoveryDiagnostics["interfaces"][number]): void {
    try {
      socket.send(data, port, destination, (err) => {
        if (err) this.error(new Error(`Discovery send to ${destination}: ${err.message}`));
        else { this.lastSentAt = this.now(); if (info) info.lastSentAt = this.lastSentAt; }
      });
    } catch (err) { this.error(err as Error); }
  }

  observe(data: Buffer, host: string): void {
    if (data.length > MAX_DISCOVERY_BYTES || !isIPv4(host)) return;
    try {
      const parsed = announcementSchema.safeParse(JSON.parse(data.toString("utf8")));
      if (!parsed.success || parsed.data.id === this.opts.identity.id) return;
      this.lastReceivedAt = this.now();
      const { id, name, fingerprint, port } = parsed.data;
      this.instances();
      if (!this.found.has(id) && this.found.size >= MAX_DISCOVERED_INSTANCES) return;
      this.found.set(id, { id, name, fingerprint, port, host, seenAt: this.now() });
    } catch { /* malformed datagrams are ignored */ }
  }

  instances(): DiscoveredInstance[] {
    for (const [id, entry] of this.found) if (this.now() - entry.seenAt >= DISCOVERY_TTL_MS) this.found.delete(id);
    return [...this.found.values()].map((x) => ({ ...x }));
  }

  async close(): Promise<void> {
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

  private closeSocket(socket: Socket): Promise<void> {
    return new Promise<void>((resolve) => { try { socket.close(() => resolve()); } catch { resolve(); } });
  }
}
