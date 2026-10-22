import { BridgeError, type NativeChildAddress, type PeerInfo } from "./protocol.js";
import { isJobSendTarget, DEFAULT_SIBLING_MAX_HOPS, MAX_JOB_SEND_TARGETS } from "./job-messaging.js";
import type { MessageStore } from "./store.js";
import { randomUUID } from "node:crypto";
import { nativeRouteDigest, NATIVE_LIFECYCLE_ROUTE_LIMIT } from "./native-lifecycle-reader.js";
import { nativeOwner, recipientKey } from "./recipient-ownership.js";

export const NATIVE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function isNativeChildAddress(address: unknown): boolean { return typeof address === "string" && address.includes("/sub:"); }
interface Child extends NativeChildAddress { owner: string; session: string; active: boolean; identity: string }
export interface NativeLifecycleObservation { generation: number; memoryActive: number; durableActive: number; pending: number;
  blocker: "native_routes_active" | "native_writes_pending" | "native_state_unknown" | null }

/** These are queues under a session, never PeerInfo registrations or project authorities. */
export class NativeChildren {
  private readonly children = new Map<string, Child>();
  private readonly endedParents = new Set<string>();
  private recovery: Promise<void> | null = null;
  private recoverySettled = false;
  private lifecycleFrozen = false;
  private lifecycleGeneration = 0;
  private nativeWriteUnknown = false;
  private readonly pendingNative = new Set<Promise<unknown>>();
  private readonly ownerInstance = randomUUID();
  constructor(private readonly store: MessageStore) {}
  private parentKey(peer: PeerInfo): string { return JSON.stringify([peer.id, peer.sessionId, peer.name]); }

  recover(): Promise<void> {
    return this.recovery ??= this.recoverOrphans().then(() => { this.recoverySettled = true; });
  }
  private admitNative(): void { if (this.lifecycleFrozen) throw new BridgeError("bad_request", "Native subagent admission is draining; retry later."); }
  private trackNative<T>(operation: () => Promise<T>): Promise<T> {
    this.lifecycleGeneration++;
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const pending = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    this.pendingNative.add(pending);
    try { operation().then(resolve, reject); } catch (error) { reject(error); }
    void pending.finally(() => { this.pendingNative.delete(pending); this.lifecycleGeneration++; }).catch(() => {});
    return pending;
  }
  private async writeNative(operation: () => void): Promise<void> {
    try { await this.store.retryWrite(operation); }
    catch (error) { this.nativeWriteUnknown = true; throw error; }
  }
  /** Only the native subguard. The coordinator must separately drain all dispatch/mail producers. */
  freezeLifecycleAdmission(): void { this.lifecycleFrozen = true; }
  resumeLifecycleAdmission(): void { this.lifecycleFrozen = false; }
  async settleLifecycleWrites(deadline: number): Promise<NativeLifecycleObservation> {
    if (!this.lifecycleFrozen || !Number.isFinite(deadline)) return this.observeNativeLifecycle(deadline, "native_state_unknown");
    if (performance.now() >= deadline) return this.observeNativeLifecycle(deadline, "native_state_unknown");
    if (this.pendingNative.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled([...this.pendingNative]), new Promise<void>(resolve => {
          timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
        })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    return this.observeNativeLifecycle(deadline, performance.now() >= deadline ? "native_state_unknown" : undefined);
  }
  lifecycleOwnerManifest(): { pendingWrites: number; pendingReaders: number; frozen: boolean; generation: number; unknown: boolean } {
    return { pendingWrites: this.pendingNative.size, pendingReaders: this.store.nativeLifecyclePendingReaders(), frozen: this.lifecycleFrozen,
      generation: this.lifecycleGeneration, unknown: this.nativeWriteUnknown || !this.recoverySettled };
  }
  private async observeNativeLifecycle(deadline: number, forced?: NativeLifecycleObservation["blocker"]): Promise<NativeLifecycleObservation> {
    const observation: NativeLifecycleObservation = { generation: this.lifecycleGeneration,
      memoryActive: [...this.children.values()].filter(child => child.active).length, durableActive: -1, pending: this.pendingNative.size, blocker: forced ?? null };
    if (forced || !this.lifecycleFrozen || !this.recoverySettled || this.nativeWriteUnknown) { observation.blocker = forced ?? "native_state_unknown"; return observation; }
    if (observation.pending) { observation.blocker = "native_writes_pending"; return observation; }
    try {
      const memory = [...this.children.values()].filter(child => child.active);
      if (memory.length > NATIVE_LIFECYCLE_ROUTE_LIMIT) throw new Error("native_state_unknown");
      const durable = await this.store.committedNativeChildRoutes(this.ownerInstance, observation.generation, deadline);
      observation.durableActive = durable.active;
      if (!this.lifecycleFrozen || observation.generation !== this.lifecycleGeneration || this.pendingNative.size || this.nativeWriteUnknown || performance.now() >= deadline || memory.length !== durable.active || nativeRouteDigest(memory) !== durable.digest) observation.blocker = "native_state_unknown";
      else if (durable.active) observation.blocker = "native_routes_active";
    } catch { observation.blocker = "native_state_unknown"; }
    return observation;
  }
  async zeroLifecycleWitnessCurrent(observation: NativeLifecycleObservation, deadline: number): Promise<boolean> {
    if (observation.blocker || observation.generation !== this.lifecycleGeneration || !this.lifecycleFrozen) return false;
    const current = await this.observeNativeLifecycle(deadline);
    return !current.blocker && current.generation === observation.generation && current.memoryActive === 0 && current.durableActive === 0 && current.pending === 0;
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
    this.admitNative();
    return this.trackNative(() => this.startAccepted(peer, agentId, maxHops));
  }
  private async startAccepted(peer: PeerInfo, agentId: string, maxHops: number): Promise<NativeChildAddress> {
    await this.recover();
    const session = this.parent(peer);
    if (this.endedParents.has(this.parentKey(peer))) throw new BridgeError("unauthorized", "Native child parent session has ended.");
    if (!NATIVE_AGENT_ID.test(agentId) || !Number.isInteger(maxHops) || maxHops < 0 || maxHops > DEFAULT_SIBLING_MAX_HOPS) throw new BridgeError("bad_request", "Invalid native child id or hop limit.");
    const address = `${peer.name}/sub:${agentId}`, previous = this.children.get(address);
    if (previous?.owner === peer.id && previous.session === session) return this.public(this.own(peer, agentId)); // A late hook cannot resurrect a stopped child.
    if (previous?.active) throw new BridgeError("unauthorized", "Native child address belongs to another parent session.");
    const parentOwner = recipientKey(peer.frontend, nativeOwner(peer));
    if (!parentOwner) throw new BridgeError("unauthorized", "Native child parent ownership is unproven.");
    const identity = JSON.stringify({ kind: "child", owner: peer.id, session, parent: peer.name, agentId, incarnation: randomUUID(), parentOwner });
    const child: Child = { address, agentId, parent: peer.name, owner: peer.id, session, active: true, sendTo: [], maxHops, identity };
    await this.writeNative(() => this.store.retainNativeChild(address, peer.name));
    this.children.set(address, child);
    return this.public(child);
  }
  grant(peer: PeerInfo, agentId: string, names: string[]): NativeChildAddress {
    this.admitNative();
    const child = this.own(peer, agentId);
    if (!Array.isArray(names) || names.length > MAX_JOB_SEND_TARGETS || !names.every(isJobSendTarget)) throw new BridgeError("bad_request", "send_to must contain exact local session or job names.");
    child.sendTo = [...new Set(names)];
    this.lifecycleGeneration++;
    return this.public(child);
  }
  async end(peer: PeerInfo, agentId: string): Promise<void> {
    this.admitNative();
    return this.trackNative(() => this.endAccepted(peer, agentId));
  }
  private async endAccepted(peer: PeerInfo, agentId: string): Promise<void> {
    const child = this.own(peer, agentId);
    child.active = false; // Stop admission before waiting for the durable fallback.
    await this.writeNative(() => this.store.returnNativeChild(child.address, child.parent));
  }
  async endParent(peer: PeerInfo, implicitDisconnect = false): Promise<void> {
    if (!implicitDisconnect) this.admitNative();
    return this.trackNative(() => this.endParentAccepted(peer));
  }
  private async endParentAccepted(peer: PeerInfo): Promise<void> {
    this.endedParents.add(this.parentKey(peer));
    const children = [...this.children.values()].filter(c => c.owner === peer.id && c.active);
    children.forEach(c => { c.active = false; });
    for (const child of children) await this.writeNative(() => this.store.returnNativeChild(child.address, child.parent));
  }
}
