import { AGENT_KINDS } from "./protocol.js";

/** Sibling contract discussions need more room than unattended session auto-wake threads. */
export const DEFAULT_SIBLING_MAX_HOPS = 32;
export const MAX_JOB_SEND_TARGETS = 20;
const EXACT_PEER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Only exact local session names can be granted; never broadcasts, agent kinds or job names. */
export function isJobSendTarget(value: unknown): value is string {
  return typeof value === "string" && EXACT_PEER_NAME_PATTERN.test(value) &&
    !(AGENT_KINDS as readonly string[]).includes(value) && !value.includes("-job-") && !value.includes("-ask-");
}

export function siblingMaxHops(maxHops: number): number {
  return maxHops > 0 ? Math.max(maxHops, DEFAULT_SIBLING_MAX_HOPS) : 0;
}

export interface JobMessagingPolicy {
  maxHops: number;
  sendTo: string[];
}
