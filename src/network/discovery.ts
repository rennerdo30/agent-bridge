import { createSocket, type Socket } from "node:dgram";
import { isIPv4 } from "node:net";
import { z } from "zod";
import { DISCOVERY_GROUP, DISCOVERY_INTERVAL_MS, DISCOVERY_PORT, DISCOVERY_TTL_MS, MAX_DISCOVERED_INSTANCES, MAX_DISCOVERY_BYTES, MAX_PORT, NETWORK_VERSION } from "./constants.js";
import { publicIdentitySchema, type NetworkIdentity } from "./pairing.js";

const announcementSchema = publicIdentitySchema.extend({ service: z.literal("agent-bridge"), v: z.literal(NETWORK_VERSION), port: z.number().int().min(1).max(MAX_PORT) });
export interface DiscoveredInstance extends NetworkIdentity { host: string; port: number; seenAt: number }
export interface DiscoveryOptions {
  identity: NetworkIdentity;
  port: number;
  bind?: string;
  udpPort?: number;
  destination?: string;
  onError?: (error: Error) => void;
  now?: () => number;
}

/** Announcements are untrusted hints. This module has no ability to create broker links. */
export class NetworkDiscovery {
  private socket: Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly found = new Map<string, DiscoveredInstance>();
  private readonly now: () => number;

  constructor(private readonly opts: DiscoveryOptions) {
    this.now = opts.now ?? Date.now;
  }

  get port(): number { return this.socket?.address().port ?? 0; }

  async start(): Promise<void> {
    if (this.socket) throw new Error("network discovery already started");
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;
    socket.on("message", (data, source) => this.observe(data, source.address));
    socket.on("error", (err) => this.opts.onError?.(err));
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(this.opts.udpPort ?? DISCOVERY_PORT, this.opts.bind ?? "0.0.0.0", () => {
        socket.off("error", reject);
        resolve();
      });
    });
    if ((this.opts.destination ?? DISCOVERY_GROUP) === DISCOVERY_GROUP) {
      socket.addMembership(DISCOVERY_GROUP);
      socket.setMulticastTTL(1);
    }
    this.timer = setInterval(() => this.announce(), DISCOVERY_INTERVAL_MS);
    this.timer.unref();
    this.announce();
  }

  announce(port = this.opts.udpPort === 0 ? this.port : this.opts.udpPort ?? DISCOVERY_PORT): void {
    const data = Buffer.from(JSON.stringify({ service: "agent-bridge", v: NETWORK_VERSION, ...this.opts.identity, port: this.opts.port }));
    this.socket?.send(data, port, this.opts.destination ?? DISCOVERY_GROUP, (err) => { if (err) this.opts.onError?.(err); });
  }

  observe(data: Buffer, host: string): void {
    if (data.length > MAX_DISCOVERY_BYTES || !isIPv4(host)) return;
    try {
      const parsed = announcementSchema.safeParse(JSON.parse(data.toString("utf8")));
      if (!parsed.success || parsed.data.id === this.opts.identity.id) return;
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
    if (socket) await new Promise<void>((resolve) => { try { socket.close(() => resolve()); } catch { resolve(); } });
    this.found.clear();
  }
}
