import { z } from "zod";
import { MAX_DECISION_TEXT_CHARS, MAX_DECISION_TOPIC_CHARS } from "../core/decisions.js";
import { AGENT_KINDS } from "../core/protocol.js";

export const DECISION_SYNC_CAPABILITY = "decisions-sync-v1";
export const DECISION_SYNC_FRAME = "decision-sync";
/** Sync-request id lists stay small: owner decisions are tens of rows, never a full table dump. */
export const MAX_SYNC_KNOWN_IDS = 5_000;
/** Sync-state frames stay well under the network frame limit even with long decision texts. */
export const MAX_SYNC_STATE_BYTES = 1_000_000;
export const MAX_SYNC_STATE_COUNT = 25;

/**
 * Only scope "all" crosses PCs: project folders and session names differ per machine, so
 * narrower scopes are answered locally and never placed on the wire.
 */
const decisionWireSchema = z.object({
  id: z.uuid(),
  topic: z.string().trim().min(1).max(MAX_DECISION_TOPIC_CHARS).transform((topic) => topic.toLowerCase()),
  text: z.string().trim().min(1).max(MAX_DECISION_TEXT_CHARS),
  scope: z.literal("all"),
  author: z.object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    agent: z.enum(AGENT_KINDS),
  }).strict(),
  createdAt: z.number().nonnegative(),
  sourceMessageId: z.string().min(1).max(256).nullable(),
  supersedes: z.string().min(1).max(256).nullable(),
}).strict();
export type DecisionWire = z.infer<typeof decisionWireSchema>;

export const decisionSyncWireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upsert"), decision: decisionWireSchema }).strict(),
  z.object({
    kind: z.literal("sync-request"),
    /** Sender's newest scope-all createdAt; the peer answers with anything newer. */
    since: z.number().nonnegative(),
    /** Sender's known scope-all ids; covers clock skew the `since` watermark could miss. */
    ids: z.array(z.string().min(1).max(256)).max(MAX_SYNC_KNOWN_IDS),
  }).strict(),
  z.object({ kind: z.literal("sync-state"), decisions: z.array(decisionWireSchema).max(MAX_SYNC_STATE_COUNT) }).strict(),
]);
export type DecisionSyncWire = z.infer<typeof decisionSyncWireSchema>;
