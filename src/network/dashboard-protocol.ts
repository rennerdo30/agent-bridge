import { z } from "zod";

export const DASHBOARD_CAPABILITY = "dashboard-read-v1";
export const DASHBOARD_FRAME = "dashboard-read";
export const DASHBOARD_TIMEOUT_MS = 10_000;
export const DASHBOARD_RATE_LIMIT = 120;
export const DASHBOARD_RATE_WINDOW_MS = 60_000;
export const DASHBOARD_MAX_PENDING = 32;
export const DASHBOARD_MAX_RESPONSE_BYTES = 1_500_000;
const name = /^[\w.-]{1,256}$/;

/** Only local dashboard identities, never a path or a second paired host. */
export function isDashboardReadPath(path: string): boolean {
  if (path === "/api/state" || path === "/api/runs" || path === "/api/job-outcomes") return true;
  const match = /^\/api\/(runs|sessions|jobs)\/([^/]+)(.*)$/.exec(path);
  if (!match) return false;
  let target: string;
  try { target = decodeURIComponent(match[2]!); } catch { return false; }
  if (!name.test(target) || target === "." || target === "..") return false;
  const suffix = match[3]!;
  if (match[1] === "runs") return suffix === "" || suffix === "/chat";
  if (match[1] === "sessions" && suffix === "/chat") return true;
  if (suffix === "/subagents") return true;
  const child = /^\/subagents\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(suffix);
  return !!child;
}

export const dashboardRequestSchema = z.object({
  path: z.string().max(600).refine(isDashboardReadPath),
  query: z.object({ from: z.string().max(256).optional(), before: z.string().max(512).optional(), limit: z.string().max(3).optional() }).strict().optional(),
}).strict();
export type DashboardReadRequest = z.infer<typeof dashboardRequestSchema>;
export interface DashboardReadResult { status: number; body: unknown }
export const dashboardWireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request"), rid: z.uuid(), request: dashboardRequestSchema }).strict(),
  z.object({ kind: z.literal("response"), rid: z.uuid(), result: z.object({ status: z.number().int().min(200).max(599), body: z.unknown() }).strict() }).strict(),
]);
