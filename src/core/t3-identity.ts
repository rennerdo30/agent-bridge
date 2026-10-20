import { z } from "zod";
export { withoutT3Context } from "./job-environment.js";

/** Frontend scope is a digest, never an endpoint or a credential. Provider sessionId stays separate. */
export const t3BindingSchema = z.object({
  kind: z.literal("t3"), scope: z.string().regex(/^[a-f0-9]{64}$/),
  threadId: z.string().min(1).max(512), providerInstanceId: z.string().min(1).max(256),
});
export type T3Binding = z.infer<typeof t3BindingSchema>;

/** A hosted and an ordinary session can never recover or replace one another. */
export function sameFrontend(a: { frontend?: T3Binding }, b: { frontend?: T3Binding }): boolean {
  if (!a.frontend && !b.frontend) return true;
  return Boolean(a.frontend && b.frontend && a.frontend.scope === b.frontend.scope &&
    a.frontend.threadId === b.frontend.threadId && a.frontend.providerInstanceId === b.frontend.providerInstanceId);
}
