import { randomUUID } from "node:crypto";
import type { BridgeNode } from "./node.js";
import type { BridgeMessage } from "./protocol.js";

/** Dashboard commands and replies stay out of the agent's chat and wake-up paths. */
export const DASHBOARD_JOB_CONVERSATION = "jobctl-dashboard";
const CONTROL_TIMEOUT_MS = 10_000;

export interface JobMessageResult {
  outcome: string;
  text: string;
  isError: boolean;
}

export class JobControlError extends Error {
  constructor(message: string, readonly reason: "offline" | "timeout") {
    super(message);
  }
}

/** A command for the session that owns the job: a follow-up message, or its next-turn settings. */
export type DashboardJobCommand = { type: "message"; body: string } | { type: "settings"; settings: Record<string, unknown> };

export function messageDashboardJob(node: BridgeNode, owner: string, job: string, body: string): Promise<JobMessageResult> {
  return controlDashboardJob(node, owner, job, { type: "message", body });
}

export async function controlDashboardJob(node: BridgeNode, owner: string, job: string, command: DashboardJobCommand): Promise<JobMessageResult> {
  if (!(await node.peers()).some((p) => p.name === owner)) throw new JobControlError("The owning session is not connected. Reopen it to continue this subagent.", "offline");
  const requestId = randomUUID();
  let receive!: (m: BridgeMessage) => void;
  let timer: NodeJS.Timeout | undefined;
  const reply = new Promise<JobMessageResult>((resolve, reject) => {
    receive = (m) => {
      if (m.from.name !== owner) return;
      try {
        const result = JSON.parse(m.body);
        if (result.type === "result" && result.requestId === requestId && typeof result.text === "string" && typeof result.outcome === "string" && typeof result.isError === "boolean") resolve(result);
      } catch {
        // Not a reply to this command.
      }
    };
    node.on("job_control", receive);
    timer = setTimeout(() => reject(new JobControlError("The owning session did not confirm delivery. Check its chat before sending again.", "timeout")), CONTROL_TIMEOUT_MS);
  });
  // A send may fail before the reply is awaited.
  reply.catch(() => {});
  try {
    await node.send({ to: owner, body: JSON.stringify({ ...command, requestId, job }), conversationId: DASHBOARD_JOB_CONVERSATION }, { quiet: true });
    return await reply;
  } finally {
    clearTimeout(timer);
    node.off("job_control", receive);
  }
}
