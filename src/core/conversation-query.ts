import { z } from "zod";
export const conversationPageSchema = z
  .object({
    id: z.string().min(1).max(512),
    after: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type ConversationRequest = z.input<typeof conversationPageSchema>;
export interface ConversationPage {
  conversation: {
    id: string;
    agent: string;
    session: string;
    parent: string | null;
    project: string;
    job: string | null;
    kind: string;
  } | null;
  records: {
    id: number;
    source: string;
    generation: number;
    offset: number;
    at: number;
    text: string;
    raw: string;
    part: string | null;
    /** Conclusive fixture provenance, retained for inspection rather than deleted. */
    foreignHome?: true;
  }[];
  next: number | null;
}
