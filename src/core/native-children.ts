import { BridgeError, type NativeChildAddress, type PeerInfo } from "./protocol.js";
import { isJobSendTarget, DEFAULT_SIBLING_MAX_HOPS, MAX_JOB_SEND_TARGETS } from "./job-messaging.js";
import type { MessageStore } from "./store.js";

export const NATIVE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function isNativeChildAddress(address: unknown): boolean { return typeof address === "string" && address.includes("/sub:"); }
interface Child extends NativeChildAddress { owner: string; session: string; active: boolean }

/** These are queues under a session, never PeerInfo registrations or project authorities. */
export class NativeChildren {
  private readonly children = new Map<string, Child>();
  private readonly endedParents = new Set<string>();
  private recovery: Promise<void> | null = null;
  constructor(private readonly store: MessageStore) {}
  private parentKey(peer: PeerInfo): string { return JSON.stringify([peer.id, peer.sessionId, peer.name]); }

  recover(): Promise<void> {
    return this.recovery ??= this.recoverOrphans();
  }
  private async recoverOrphans(): Promise<void> {
    // No connection survived a broker restart. The retained mapping makes orphan recovery exact.
    for (const route of this.store.nativeChildRoutes()) await this.store.retryWrite(() => this.store.returnNativeChild(route.address, route.parent));
  }
  private parent(peer: PeerInfo): string {
    if (peer.agent !== "claude" || peer.jobAgent || peer.subagent || !peer.sessionId) throw new BridgeError("unauthorized", "Native child addresses require a registered Claude parent session.");
    return peer.sessionId;
  }
  own(peer: PeerInfo, agentId: string): Child {
    const session = this.parent(peer);
    if (this.endedParents.has(this.parentKey(peer))) throw new BridgeError("unauthorized", "Native child parent session has ended.");
    if (!NATIVE_AGENT_ID.test(agentId)) throw new BridgeError("bad_request", "Invalid native agent_id.");
    const child = this.children.get(`${peer.name}/sub:${agentId}`);
    if (!child?.active || child.owner !== peer.id || child.session !== session) throw new BridgeError("unauthorized", "No live native child belongs to this parent session.");
    return child;
  }
  list(peer: PeerInfo): NativeChildAddress[] {
    return [...this.children.values()].filter(c => c.active && c.owner === peer.id && c.session === peer.sessionId).map(c => this.public(c));
  }
  public(child: Child): NativeChildAddress {
    const { address, agentId, parent, sendTo, maxHops } = child;
    return { address, agentId, parent, sendTo: [...sendTo], maxHops };
  }
  target(address: string): Child {
    const child = this.children.get(address);
    if (!child?.active) throw new BridgeError("unauthorized", "Native child address is unavailable or unauthorized.");
    return child;
  }
  async start(peer: PeerInfo, agentId: string, maxHops = DEFAULT_SIBLING_MAX_HOPS): Promise<NativeChildAddress> {
    await this.recover();
    const session = this.parent(peer);
    if (this.endedParents.has(this.parentKey(peer))) throw new BridgeError("unauthorized", "Native child parent session has ended.");
    if (!NATIVE_AGENT_ID.test(agentId) || !Number.isInteger(maxHops) || maxHops < 0 || maxHops > DEFAULT_SIBLING_MAX_HOPS) throw new BridgeError("bad_request", "Invalid native child id or hop limit.");
    const address = `${peer.name}/sub:${agentId}`, previous = this.children.get(address);
    if (previous?.owner === peer.id && previous.session === session) return this.public(this.own(peer, agentId)); // A late hook cannot resurrect a stopped child.
    if (previous?.active) throw new BridgeError("unauthorized", "Native child address belongs to another parent session.");
    const child: Child = { address, agentId, parent: peer.name, owner: peer.id, session, active: true, sendTo: [], maxHops };
    await this.store.retryWrite(() => this.store.retainNativeChild(address, peer.name));
    this.children.set(address, child);
    return this.public(child);
  }
  grant(peer: PeerInfo, agentId: string, names: string[]): NativeChildAddress {
    const child = this.own(peer, agentId);
    if (!Array.isArray(names) || names.length > MAX_JOB_SEND_TARGETS || !names.every(isJobSendTarget)) throw new BridgeError("bad_request", "send_to must contain exact local session or job names.");
    child.sendTo = [...new Set(names)];
    return this.public(child);
  }
  async end(peer: PeerInfo, agentId: string): Promise<void> {
    const child = this.own(peer, agentId);
    child.active = false; // Stop admission before waiting for the durable fallback.
    await this.store.retryWrite(() => this.store.returnNativeChild(child.address, child.parent));
  }
  async endParent(peer: PeerInfo): Promise<void> {
    this.endedParents.add(this.parentKey(peer));
    const children = [...this.children.values()].filter(c => c.owner === peer.id && c.active);
    children.forEach(c => { c.active = false; });
    for (const child of children) await this.store.retryWrite(() => this.store.returnNativeChild(child.address, child.parent));
  }
}
