import { z } from "zod";
export { withoutT3Context } from "./job-environment.js";

/** Frontend scope is a digest, never an endpoint or a credential. Provider sessionId stays separate. */
export const t3BindingSchema = z.object({
  kind: z.literal("t3"), scope: z.string().regex(/^[a-f0-9]{64}$/),
  threadId: z.string().min(1).max(512), providerInstanceId: z.string().min(1).max(256),
});
export type T3Binding = z.infer<typeof t3BindingSchema>;

export type McpProfile = "full" | "reduced";
/** Call only after host negotiation; environment hints alone never establish a frontend. */
export function mcpProfileFromEnv(env: NodeJS.ProcessEnv, frontend?: T3Binding): McpProfile {
  const selected = env.AGENT_BRIDGE_MCP_PROFILE ?? "auto";
  if (!["auto", "full", "reduced"].includes(selected)) throw new Error("Invalid AGENT_BRIDGE_MCP_PROFILE; expected auto, reduced or full.");
  if (selected === "reduced" && !frontend) throw new Error("Reduced MCP profile requires a validated T3 host.");
  if (frontend) t3BindingSchema.parse(frontend);
  return selected === "full" || !frontend ? "full" : "reduced";
}

/** Keep the unique messaging, security, lifecycle, project and remote-job surfaces. */
const REDUCED_HIDDEN = new Set(["t3_capabilities", "t3_delegate", "t3_task_status", "t3_task_cancel", "t3_send",
  "list_models", "usage_limits"]);
export function profileAllowsTool(profile: McpProfile, name: string): boolean {
  return profile !== "reduced" || !REDUCED_HIDDEN.has(name);
}

/** A hosted and an ordinary session can never recover or replace one another. */
export function sameFrontend(a: { frontend?: T3Binding }, b: { frontend?: T3Binding }): boolean {
  if (!a.frontend && !b.frontend) return true;
  return Boolean(a.frontend && b.frontend && a.frontend.scope === b.frontend.scope &&
    a.frontend.threadId === b.frontend.threadId && a.frontend.providerInstanceId === b.frontend.providerInstanceId);
}
