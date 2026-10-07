import { DASHBOARD_JOB_CONVERSATION } from "../core/job-control.js";
import { MAX_BODY_CHARS } from "../core/constants.js";
import { t } from "../core/i18n.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import type { BridgeMessage } from "../core/protocol.js";
import { parseJobSettings } from "./job-settings.js";
import type { JobManager } from "./jobs.js";
import { canControlJob } from "../core/job-ownership.js";

interface DashboardResult {
  outcome: string;
  text: string;
  isError: boolean;
}

/** The owning session routes commands through its manager, including detached runners and continuations. */
export function attachDashboardJobControl(node: BridgeNode, jobs: JobManager, log: Logger): void {
  node.on("job_control", (m: BridgeMessage) => {
    void handle(m).catch((err) => log.warn("dashboard command failed", { err: String(err) }));
  });
  async function handle(m: BridgeMessage) {
    let command;
    try {
      command = JSON.parse(m.body);
    } catch {
      return;
    }
    if (!command || typeof command.requestId !== "string" || typeof command.job !== "string") return;
    let result: DashboardResult;
    if (command.type === "handoff") {
      try {
        jobs.persist();
        const receipt = await node.handoffSubagents({ to: command.to, jobs: command.jobs, note: command.note });
        jobs.refreshOwnership();
        result = { outcome: "transferred", text: `Handed off ${receipt.jobs.length} subagent(s) to ${receipt.to}.`, isError: false };
      } catch (err) { result = { outcome: "rejected", text: (err as Error).message, isError: true }; }
    } else if (command.type === "message") {
      if (typeof command.body !== "string" || !command.body.trim() || command.body.length > MAX_BODY_CHARS) return;
      result = followUp(node, jobs, command.job, command.body);
    } else if (command.type === "settings") {
      result = changeSettings(node, jobs, command.job, command.settings, log);
    } else {
      return;
    }
    void node.send({ to: m.from.name, replyTo: m.id, body: JSON.stringify({ type: "result", requestId: command.requestId, ...result }), conversationId: DASHBOARD_JOB_CONVERSATION }, { quiet: true }).catch((err) => log.warn("dashboard job reply failed", { err: (err as Error).message }));
  }
}

function followUp(node: BridgeNode, jobs: JobManager, ref: string, body: string): DashboardResult {
  const owned = jobs.find(ref);
  const { outcome, job } = owned && canControlJob(owned as unknown as Record<string, unknown>, node.name) ? jobs.followUp(ref, body) : { outcome: "unknown" as const, job: undefined };
  const position = job ? jobs.waiting().indexOf(job) + 1 : 0;
  return {
    outcome,
    text: t(`followUp.${outcome}`, { name: job?.name ?? ref, max: jobs.limit, running: jobs.runningCount(), ahead: position > 1 ? ` (${position - 1} queued before it)` : "" }),
    isError: outcome === "unknown" || outcome === "no-session",
  };
}

/** Next-turn settings only: no follow-up, so a finished subagent stays finished until someone continues it. */
function changeSettings(node: BridgeNode, jobs: JobManager, ref: string, input: unknown, log: Logger): DashboardResult {
  const job = jobs.find(ref);
  if (!job || !canControlJob(job as unknown as Record<string, unknown>, node.name)) return { outcome: "unknown", text: t("followUp.unknown", { name: ref }), isError: true };
  const settings = parseJobSettings(input, job.agent);
  if (typeof settings === "string") return { outcome: "invalid", text: settings, isError: true };
  jobs.setSettings(job.name, settings);
  log.info("dashboard changed subagent settings", { job: job.name, settings });
  const list = Object.entries(settings).map(([key, value]) => `${key}=${value}`).join(", ");
  const when = job.status === "running" ? "Applies from its next turn; the turn running now keeps its settings." : "Applies when it continues.";
  return { outcome: "saved", text: `Saved settings for ${job.name}: ${list}. ${when}`, isError: false };
}
