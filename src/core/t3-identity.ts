import { z } from "zod";
export { withoutT3Context } from "./job-environment.js";

/** Frontend scope is a digest, never an endpoint or a credential. Provider sessionId stays separate. */
export const t3BindingSchema = z.object({
  kind: z.literal("t3"), scope: z.string().regex(/^[a-f0-9]{64}$/),
  threadId: z.string().min(1).max(512), providerInstanceId: z.string().min(1).max(256),
});
export type T3Binding = z.infer<typeof t3BindingSchema>;

export type McpProfile = "full" | "reduced";

/**
 * AB-483: an ordinary chat inside the T3 Code app. T3's desktop app sets T3CODE_CLI_PATH on its backend,
 * and every provider process the backend starts inherits it. This selects tools and instructions only;
 * it is no frontend identity and changes no delivery. Bridge children strip it (withoutT3Context), and
 * callers exclude delegated and internal Bridge processes. Any explicit AGENT_BRIDGE_HOST other than `auto`
 * opts out (`t3` keeps meaning "injected transport required").
 */
export function nativeT3FromEnv(env: NodeJS.ProcessEnv): boolean {
  const selector = env.AGENT_BRIDGE_HOST;
  if (selector !== undefined && selector !== "auto") return false;
  return Boolean(env.T3CODE_CLI_PATH?.trim());
}

/** Call only after host negotiation; environment hints alone never establish a frontend. */
export function mcpProfileFromEnv(env: NodeJS.ProcessEnv, frontend?: T3Binding, nativeT3 = false): McpProfile {
  const selected = env.AGENT_BRIDGE_MCP_PROFILE ?? "auto";
  if (!["auto", "full", "reduced"].includes(selected)) throw new Error("Invalid AGENT_BRIDGE_MCP_PROFILE; expected auto, reduced or full.");
  if (selected === "reduced" && !frontend && !nativeT3) throw new Error("Reduced MCP profile requires a validated T3 host or a T3 Code chat.");
  if (frontend) t3BindingSchema.parse(frontend);
  return selected === "full" || !frontend && !nativeT3 ? "full" : "reduced";
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
