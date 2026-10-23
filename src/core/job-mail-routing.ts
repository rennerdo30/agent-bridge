import { createHash } from "node:crypto";
import { z } from "zod";
import { durableJobOwner, ownershipFromKey, verifiedNative } from "./recipient-ownership.js";
import type { BridgeMessage } from "./protocol.js";

export const jobRouteSchema = z.object({ grant: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), generation: z.number().int().nonnegative() }).strict();
export type JobRouteProof = z.infer<typeof jobRouteSchema>;
export const jobMailGrantSchema = z.object({
  job: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), incarnation: z.string().regex(/^[a-f0-9]{64}$/),
  principal: z.string().min(1).max(8192), creator: z.string().min(1).max(16384),
  supervisor: z.string().min(1).max(256), supervisorOwner: z.string().min(1).max(16384),
  project: z.string().min(1).max(8192), lineage: z.string().min(1).max(16384), kind: z.literal("report"),
}).strict().superRefine((grant, ctx) => {
  if (ownershipFromKey(grant.creator).recipientAmbiguous || ownershipFromKey(grant.supervisorOwner).recipientAmbiguous)
    ctx.addIssue({ code: "custom", message: "Job routing requires proven original ownership" });
  const native = verifiedNative(grant.principal);
  if (!native || JSON.parse(native).kind !== "job" || JSON.parse(native).id !== `job:${grant.job}`)
    ctx.addIssue({ code: "custom", message: "Job routing requires an exact durable job principal" });
});
export type JobMailGrant = z.infer<typeof jobMailGrantSchema>;
export const jobMailDraftSchema = z.object({ namespace: z.string().regex(/^[a-f0-9]{64}$/), grant: jobMailGrantSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type JobMailDraft = z.infer<typeof jobMailDraftSchema>;
export interface JobMailSuccessor { owner: string; authority: string }
export function jobMailIncarnation(job: Record<string, unknown>): string | null {
  if (!durableJobOwner(job) || typeof job.startedAt !== "number" || !Number.isFinite(job.startedAt)) return null;
  return createHash("sha256").update(JSON.stringify([job.id, job.agent, job.startedAt])).digest("hex");
}
export const jobMailAuthority = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const jobMailDraftDigest = (message: BridgeMessage) => jobMailAuthority([message.id, message.from, message.recipient, message.to,
  message.body, message.replyTo, message.hop, message.createdAt, message.recipientFrontend ?? null, message.recipientNative ?? null, message.recipientMailbox, message.senderOwner, message.senderMailbox]);

export function makeJobMailGrant(job: Record<string, unknown>, creator: string, project: string, supervisor: string, supervisorOwner: string, parent?: Record<string, unknown>): JobMailGrant | null {
  const incarnation = jobMailIncarnation(job), principal = durableJobOwner(job);
  if (!incarnation || !principal) return null;
  const parsed = jobMailGrantSchema.safeParse({ kind: "report", job: job.id, incarnation, principal, creator, project, supervisor, supervisorOwner,
    lineage: JSON.stringify({ supervisor: job.supervisor, rootName: job.rootName, parentJob: job.parentJob ?? null, parentIncarnation: parent ? jobMailIncarnation(parent) : null }) });
  return parsed.success ? parsed.data : null;
}
