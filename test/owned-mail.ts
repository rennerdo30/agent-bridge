import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { AckArgs, BridgeMessage, PeerInfo } from "../src/core/protocol.js";
import { localMailbox, nativeOwner, recipientKey } from "../src/core/recipient-ownership.js";
import { canonicalProjectRoot } from "../src/core/project-identity.js";
import type { MessageStore } from "../src/core/store.js";
import { readJsonStore, writeJsonStore, isRecord } from "../src/core/json-store.js";
import { MessageStore as Store } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import type { Job } from "../src/mcp/jobs.js";
import { DELEGATION_METADATA_VERSION } from "../src/core/constants.js";
import type { BridgeNode } from "../src/core/node.js";
import type { AgentKind } from "../src/core/protocol.js";
import type { DatabaseSync } from "node:sqlite";
import { jobMailAuthority, jobMailDraftDigest, makeJobMailGrant } from "../src/core/job-mail-routing.js";
import { primaryFor } from "../src/core/job-ownership.js";

/** A fixture registration is explicit evidence, never authority inferred from a name. */
export function fixturePeer(store: MessageStore, name: string, overrides: Partial<PeerInfo> = {}): PeerInfo {
  const peer: PeerInfo = { id: randomUUID(), name, agent: "codex", pid: process.pid, agentPid: null,
    cwd: dirname(store.file), sessionId: randomUUID(), startedAt: Date.now(), autoWake: false, ...overrides };
  store.rememberName(peer, Date.now());
  return peer;
}
export function fixtureOwner(store: MessageStore, peer: PeerInfo): string {
  const evidence = store.recipientOwnership(peer.name, peer);
  const owner = recipientKey(evidence.recipientFrontend, evidence.recipientNative);
  if (!owner) throw new Error("Fixture requires a verified recipient registration");
  return owner;
}
/** Handler-only fixtures still carry the complete registration fence. Owner
 * evidence is minted by the real store above, never by a hard-coded proof. */
export function fixtureConnection(store: MessageStore, peer: PeerInfo) {
  return { authed: true, registered: true, retired: false, socket: { destroyed: false }, peer, mailGeneration: 1,
    mailReady: { id: peer.id, name: peer.name, sessionId: peer.sessionId, generation: 1, owner: fixtureOwner(store, peer), namespace: store.namespace } };
}
export function ownedMessage(store: MessageStore, peer: PeerInfo, message: BridgeMessage): BridgeMessage {
  fixtureOwner(store, peer);
  return { ...message, recipient: peer.name, ...store.recipientOwnership(peer.name, peer), recipientMailbox: localMailbox(store.namespace), senderMailbox: message.senderMailbox ?? localMailbox(store.namespace) };
}
/** An explicitly authorized producer draft for recovery/store-unit fixtures.
 * Both creator and recipient come from actual store registrations. The durable
 * job must already authorize that creator; no prefix or wire flag grants it. */
export function fixtureJobReport(store: MessageStore, job: Record<string, unknown>, creator: PeerInfo, recipient: PeerInfo, input: BridgeMessage) {
  const creatorOwner = fixtureOwner(store, creator), owner = fixtureOwner(store, recipient);
  const owners = job.deliveryOwners && typeof job.deliveryOwners === "object" ? Object.values(job.deliveryOwners) : [];
  if (![job.deliveryOwner, ...owners].includes(creatorOwner)) throw new Error("Fixture report creator is not a durable job owner");
  const project = canonicalProjectRoot(String(job.projectRoot ?? job.workdir ?? creator.cwd));
  const grant = project && makeJobMailGrant(job, creatorOwner, project, primaryFor(job), owner);
  if (!grant || input.from.id !== `job:${job.id}` || input.from.name !== job.name || input.from.agent !== job.agent) throw new Error("Fixture report does not match its durable job");
  const message = { ...ownedMessage(store, recipient, input), senderOwner: `native:${grant.principal}`, senderMailbox: localMailbox(store.namespace) };
  return { message, grant, draft: { namespace: store.namespace, grant, digest: jobMailDraftDigest(message) },
    successor: (peer: PeerInfo) => ({ owner: fixtureOwner(store, peer), authority: jobMailAuthority([job.id, fixtureOwner(store, peer)]) }) };
}
export function fixtureNodePeer(store: MessageStore, node: BridgeNode, agent: AgentKind, name = node.name): PeerInfo {
  if (!node.currentSessionId) throw new Error("Fixture node requires an explicit session");
  return fixturePeer(store, name, { id: node.id, agent, sessionId: node.currentSessionId, cwd: node.cwd });
}
/** Explicit intentional role mail, with an actual registered local sender. */
export function fixtureRoleMessage(store: MessageStore, sender: PeerInfo, agent: AgentKind, message: BridgeMessage): BridgeMessage {
  const to = `agent:${agent}`, mailbox = localMailbox(store.namespace), project = canonicalProjectRoot(sender.cwd);
  if (!project) throw new Error("Role fixture requires an actual canonical project");
  return { ...message, from: { id: sender.id, name: sender.name, agent: sender.agent }, to, recipient: to, senderOwner: fixtureOwner(store, sender), senderMailbox: mailbox, recipientMailbox: mailbox,
    recipientRole: { kind: "agent-role", namespace: store.namespace, agent, project } };
}
/** Construct a synthetic pre-v10 fixture from a fresh test store, preserving
 * mail and historical tables. These ownership tables did not exist then. */
export function removePostV9FixtureOwnership(db: DatabaseSync): void {
  db.exec("DROP TABLE job_mail_grants; DROP TABLE job_mail_succession; DROP TABLE job_mail_retirements");
  db.exec("DROP TABLE message_frontends; DROP TABLE send_intents; DROP TABLE send_destinations; DROP TABLE recipient_registrations; DROP TABLE mailbox_store");
  if (db.prepare("PRAGMA table_info(job_delivery_routes)").all().some(row => row.name === "namespace")) db.exec("ALTER TABLE job_delivery_routes DROP COLUMN namespace");
}
export function unreadOwned(store: MessageStore, peer: PeerInfo, limit = 100): BridgeMessage[] {
  return store.unread(peer.name, limit, peer.frontend, nativeOwner(peer));
}
export function fixtureAck(messages: BridgeMessage[]): AckArgs {
  return { ids: messages.map(m => m.id), jobRoutes: Object.fromEntries(messages.flatMap(m => m.jobRoute ? [[m.id, m.jobRoute]] : [])), mailboxProofs: Object.fromEntries(messages.flatMap(m => m.recipientMailbox ? [[m.id, m.recipientMailbox]] : [])),
    nativeOwners: Object.fromEntries(messages.flatMap(m => m.recipientNative ? [[m.id, m.recipientNative]] : [])) };
}
export function markOwned(store: MessageStore, peer: PeerInfo, ids: string[], at: number): number {
  fixtureOwner(store, peer);
  const ack = fixtureAck(ids.flatMap(id => store.messagesById(id).filter(copy => copy.recipient === peer.name)));
  return store.markRead(peer.name, ids, at, peer.frontend, ack.nativeOwners, nativeOwner(peer), ack.jobRoutes);
}

/** A known offline fixture peer, with the same explicit session later used in hello. */
export function retainFixtureNode(home: string, node: BridgeNode, agent: AgentKind): void {
  if (!node.currentSessionId) throw new Error("Known offline node requires an explicit session");
  const store = new Store(join(home, "bridge.db"), nullLogger);
  try {
    const peer = fixturePeer(store, node.name, { id: node.id, agent, sessionId: node.currentSessionId, cwd: node.cwd });
    if (fixtureOwner(store, peer) !== node.mailboxOwner()) throw new Error("Fixture node registration mismatch");
  } finally { store.close(); }
}

/** Publish a synthetic runner through the same durable registry consumed by hello.
 * Delivery evidence comes from an actual prior registration, never an owner-name guess. */
export function retainFixtureJob(home: string, job: Job, owner: string, supervisor: string, cwd = home): Job {
  const store = new Store(join(home, "bridge.db"), nullLogger);
  try {
    const evidence = store.recipientOwnership(owner), key = recipientKey(evidence.recipientFrontend, evidence.recipientNative);
    if (!key) throw new Error(`Fixture supervisor ${owner} must register before recording its job`);
    Object.assign(job, { metadataVersion: DELEGATION_METADATA_VERSION, owner, supervisor, rootName: owner, rootSession: supervisor,
      projectRoot: cwd, workdir: cwd, deliveryOwner: key, deliveryOwners: { [owner]: key } });
  } finally { store.close(); }
  const file = join(home, "jobs.json"), previous = readJsonStore(file), document = isRecord(previous) ? previous : {};
  const jobs = Array.isArray(document.jobs) ? document.jobs.filter((row: unknown) => !isRecord(row) || row.id !== job.id) : [];
  writeJsonStore(file, { ...document, jobs: [...jobs, job] }, previous);
  return job;
}

/** Synthetic job creation is explicit durable authority, as in JobManager's
 * registry, and never a caller-supplied jobOwner registration shortcut. */
export function retainFixtureRunner(home: string, input: { id: string; name: string; agent: AgentKind; owner: string; supervisor: string; cwd: string; grants?: string[] }): void {
  const file = join(home, "jobs.json"), previous = readJsonStore(file), document = isRecord(previous) ? previous : {};
  const jobs = Array.isArray(document.jobs) ? document.jobs : [], existing = jobs.find((row: unknown) => isRecord(row) && row.id === input.id);
  const job = { metadataVersion: DELEGATION_METADATA_VERSION,
    id: input.id, name: input.name, agent: input.agent, owner: input.owner, supervisor: input.supervisor,
    rootName: input.owner, rootSession: input.supervisor, workdir: input.cwd,
    startedAt: isRecord(existing) ? existing.startedAt ?? Date.now() : Date.now(), status: isRecord(existing) ? existing.status ?? "running" : "running",
    ...isRecord(existing) ? existing : {},
    projectRoot: isRecord(existing) ? existing.projectRoot ?? existing.workdir ?? input.cwd : input.cwd,
    args: { ...isRecord(existing) && isRecord(existing.args) ? existing.args : {}, ...(input.grants ? { send_to: input.grants } : {}) } };
  const store = new Store(join(home, "bridge.db"), nullLogger);
  try {
    const name = String(job.owner), evidence = store.recipientOwnership(name), owner = recipientKey(evidence.recipientFrontend, evidence.recipientNative);
    if (owner && !("deliveryOwner" in job)) Object.assign(job, { deliveryOwner: owner, deliveryOwners: { [name]: owner } });
  } finally { store.close(); }
  writeJsonStore(file, { ...document, jobs: [...jobs.filter((row: unknown) => !isRecord(row) || row.id !== input.id), job] }, previous);
}
