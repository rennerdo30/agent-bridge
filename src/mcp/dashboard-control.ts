import { DASHBOARD_JOB_CONVERSATION } from "../core/job-control.js";
import { MAX_BODY_CHARS } from "../core/constants.js";
import { t } from "../core/i18n.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import type { BridgeMessage } from "../core/protocol.js";
import type { JobManager } from "./jobs.js";

/** The owning session routes commands through its manager, including detached runners and continuations. */
export function attachDashboardJobControl(node: BridgeNode, jobs: JobManager, log: Logger): void {
  node.on("job_control", (m: BridgeMessage) => {
    let command;
    try {
      command = JSON.parse(m.body);
    } catch {
      return;
    }
    if (!command || command.type !== "message" || typeof command.requestId !== "string" || typeof command.job !== "string" || typeof command.body !== "string" || !command.body.trim() || command.body.length > MAX_BODY_CHARS) return;
    const owned = jobs.find(command.job);
    const { outcome, job } = owned?.owner === node.name ? jobs.followUp(command.job, command.body) : { outcome: "unknown" as const, job: undefined };
    const position = job ? jobs.waiting().indexOf(job) + 1 : 0;
    const result = {
      type: "result",
      requestId: command.requestId,
      outcome,
      text: t(`followUp.${outcome}`, { name: job?.name ?? command.job, max: jobs.limit, running: jobs.runningCount(), ahead: position > 1 ? ` (${position - 1} queued before it)` : "" }),
      isError: outcome === "unknown" || outcome === "no-session",
    };
    void node.send({ to: m.from.name, replyTo: m.id, body: JSON.stringify(result), conversationId: DASHBOARD_JOB_CONVERSATION }, { quiet: true }).catch((err) => log.warn("dashboard job reply failed", { err: (err as Error).message }));
  });
}
