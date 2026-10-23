import { resolve } from "node:path";
import { z } from "zod";
import { AGENT_KINDS, type PeerInfo } from "./protocol.js";
import { physicalPath } from "./project-identity.js";
import { t3BindingSchema, type T3Binding } from "./t3-identity.js";

const agent = z.enum(AGENT_KINDS), text = z.string().min(1).max(8192);
export const mailboxSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), namespace: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("remote"), hostId: z.uuid(), hostFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export type MailboxProvenance = z.infer<typeof mailboxSchema>;
/** Only trusted in-process producers construct this context; it is never a wire field. */
export interface InternalMessageOrigin {
  kind: "file-transfer" | "remote-job-control";
  operation: string;
  source?: MailboxProvenance;
  owner?: string;
  recipientOwner?: string;
  recipientMailbox?: MailboxProvenance;
}
export function internalSender(origin: InternalMessageOrigin): string {
  if (origin.source) mailboxSchema.parse(origin.source);
  if (origin.recipientMailbox) mailboxSchema.parse(origin.recipientMailbox);
  if (!["file-transfer", "remote-job-control"].includes(origin.kind) || !/^[a-zA-Z0-9_-]{1,128}$/.test(origin.operation) ||
      origin.owner && ownershipFromKey(origin.owner).recipientAmbiguous || origin.recipientOwner && ownershipFromKey(origin.recipientOwner).recipientAmbiguous || origin.source?.kind === "remote" && !origin.owner)
    throw new Error("Internal producer ownership is unproven");
  return `internal:${JSON.stringify({ kind: origin.kind, operation: origin.operation, owner: origin.owner })}`;
}
export function localMailbox(namespace: string): MailboxProvenance { return mailboxSchema.parse({ kind: "local", namespace }); }
export function sameMailbox(left: unknown, right: unknown): boolean {
  const a = mailboxSchema.safeParse(left), b = mailboxSchema.safeParse(right);
  return a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data);
}
/** Typed provenance: a session ID can never be confused with a serialized process identity. */
export const nativeIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), agent, sessionId: text }).strict(),
  z.object({ kind: z.literal("process"), agent, pid: z.number().int().positive(), startedAt: text, cwd: text }).strict(),
  z.object({ kind: z.literal("job"), agent, id: text }).strict(),
  z.object({ kind: z.literal("child"), owner: text, session: text, parent: text, agentId: text, incarnation: z.uuid(), parentOwner: text }).strict(),
]);
export function verifiedNative(value?: string): string | undefined {
  try { return value ? JSON.stringify(nativeIdentitySchema.parse(JSON.parse(value))) : undefined; } catch { return undefined; }
}
export function nativeOwner(peer: PeerInfo): string | undefined {
  if (peer.frontend) return undefined;
  // A Bridge job ID is its unique incarnation and survives an explicit supervisor
  // handoff. Existing current-job grants still govern control and sibling access.
  if (peer.jobAgent) return peer.id.startsWith("job:") && peer.jobOwner ? JSON.stringify({ kind: "job", agent: peer.jobAgent, id: peer.id }) : undefined;
  if (peer.sessionId) return JSON.stringify({ kind: "session", agent: peer.agent, sessionId: peer.sessionId });
  if (!Number.isSafeInteger(peer.agentPid) || !peer.agentPid || peer.agentPid <= 1 || !peer.agentStartedAt) return undefined;
  let cwd = resolve(peer.cwd); try { cwd = physicalPath(cwd); } catch { /* Removed project retains its absolute identity. */ }
  if (process.platform === "win32") cwd = cwd.toLowerCase().replace(/^d:/, "e:");
  return JSON.stringify({ kind: "process", agent: peer.agent, pid: peer.agentPid, startedAt: peer.agentStartedAt, cwd });
}
export function recipientKey(frontend?: T3Binding, native?: string): string | null {
  const verified = verifiedNative(native);
  return frontend ? `hosted:${JSON.stringify(t3BindingSchema.parse(frontend))}` : verified ? `native:${verified}` : null;
}
/** Local durable registry evidence, never a peer display name or remote projection. */
export function durableJobOwner(job: Record<string, unknown>): string | undefined {
  // `host` is the local JobHostInfo, not a paired-PC destination. Only proxy
  // records/explicit remote spawn addresses are excluded from local authority.
  if (job.remote || typeof job.args === "object" && job.args && "host" in job.args && job.args.host) return undefined;
  if (typeof job.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(job.id) || !agent.safeParse(job.agent).success ||
      typeof job.supervisor !== "string" || !job.supervisor || job.supervisor.length > 8192) return undefined;
  return JSON.stringify({ kind: "job", agent: job.agent, id: `job:${job.id}` });
}
export function peerOwnership(peer: PeerInfo): { recipientFrontend?: T3Binding; recipientNative?: string; recipientAmbiguous?: true } {
  const owner = nativeOwner(peer);
  return peer.frontend ? { recipientFrontend: t3BindingSchema.parse(peer.frontend) } : owner ? { recipientNative: owner } : { recipientAmbiguous: true };
}
export function ownershipFromKey(key: string): ReturnType<typeof peerOwnership> {
  try {
    if (key.startsWith("hosted:")) return { recipientFrontend: t3BindingSchema.parse(JSON.parse(key.slice(7))) };
    const native = key.startsWith("native:") ? verifiedNative(key.slice(7)) : undefined;
    return native ? { recipientNative: native } : { recipientAmbiguous: true };
  } catch { return { recipientAmbiguous: true }; }
}
export function ownsMessage(peer: PeerInfo, message: { recipientFrontend?: T3Binding; recipientNative?: string; recipientAmbiguous?: true; recipientMailbox?: MailboxProvenance }, namespace: string): boolean {
  const key = recipientKey(peer.frontend, nativeOwner(peer));
  return sameMailbox(message.recipientMailbox, localMailbox(namespace)) && !message.recipientAmbiguous && key !== null && key === recipientKey(message.recipientFrontend, message.recipientNative);
}
