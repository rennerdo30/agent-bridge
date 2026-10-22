import { z } from "zod";
import { AGENT_KINDS } from "./protocol.js";

/** Explicit routing authority, disjoint from a concrete native/frontend owner. */
export const roleQueueSchema = z.object({ kind: z.literal("agent-role"), namespace: z.string().regex(/^[a-f0-9]{64}$/),
  agent: z.enum(AGENT_KINDS), project: z.string().min(1).max(8192) }).strict();
export type RoleQueue = z.infer<typeof roleQueueSchema>;
