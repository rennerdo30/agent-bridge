import { readFileSync } from "node:fs";
import { isRecord } from "./json-store.js";
import { AGENT_KINDS } from "./protocol.js";
import { findHistoryJob, historyJobsSteps, readRunLogs, readRunLogsResponsive } from "./run-history.js";
import { cloneJson } from "./file-cache.js";
import { drainScanResponsive } from "./responsive-scan.js";
import { pidAlive } from "./delegate.js";
import type { Job } from "../mcp/jobs.js";
import { readRecoveryHeader, type RecoveryHeader } from "./job-recovery-feed.js";
import { readPendingRunnerSpec, readRunnerStateRecord } from "./runner-store.js";
type StoredJob = Omit<Job, "controller" | "progress" | "queue" | "resume">;
function runStart(run: ReturnType<typeof readRunLogs>[number]): number {
  if (run.meta.jobStartedAt !== undefined) return run.meta.jobStartedAt;
  const stamp = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(run.name);
  return stamp ? Date.UTC(+stamp[1]!, +stamp[2]! - 1, +stamp[3]!, +stamp[4]!, +stamp[5]!, +stamp[6]!) : run.updatedAt;
}

/** Read-only recovery from retained 0.29.10 snapshots, launch specs and run feeds.
 * Current registry ownership and grants always take precedence over original run metadata. */
export function recoverJobRecord(home: string, ref: string): StoredJob | undefined {
  const recovery = prepareRecovery(home, ref);
  if (!recovery) return undefined;
  let payload: RecoveryHeader = { prompt: "", header: "" };
  if (needsHeader(recovery) && recovery.run) {
    try {
      const lines = readFileSync(recovery.run.file, "utf8").split("\n"), end = lines.findIndex(line => line.trim() === "---");
      payload = { header: lines[0] ?? "", prompt: end > 0 ? lines.slice(1, end).map(line => line.replace(/^ {9}/, "")).join("\n") : "" };
    } catch { /* Keep the intact spec/snapshot if the run was concurrently archived. */ }
  }
  return finishRecovery(home, recovery, payload);
}

/** Broker recovery never synchronously rereads an entire retained run feed. */
export async function recoverJobRecordAsync(home: string, ref: string): Promise<StoredJob | undefined> {
  const recovery = await prepareRecoveryAsync(home, ref);
  if (!recovery) return undefined;
  const payload = needsHeader(recovery) && recovery.run ? await readRecoveryHeader(recovery.run.file) : { prompt: "", header: "" };
  if (!payload) return undefined;
  // A handoff or new native turn can update authority while asynchronous IO yields.
  // Re-read durable facts before publishing/authorizing the recovered context.
  const latest = await prepareRecoveryAsync(home, ref);
  if (!latest) return undefined;
  if (!needsHeader(latest)) return finishRecovery(home, latest, { prompt: "", header: "" });
  if (latest.run?.file !== recovery.run?.file || latest.run?.signature !== recovery.run?.signature || contextIdentity(latest) !== contextIdentity(recovery)) return undefined;
  return finishRecovery(home, latest, payload);
}

function prepareRecovery(home: string, ref: string) {
  const id = recoveryId(ref);
  if (!id) return undefined;
  const history = findHistoryJob(home, ref, id);
  const { spec, launch } = recoverySpec(home, id);
  return selectRecovery(ref, id, history, spec, launch, readRunLogs(home));
}
async function prepareRecoveryAsync(home: string, ref: string) {
  const id = recoveryId(ref);
  if (!id) return undefined;
  const history = await drainScanResponsive((function* () {
    const snapshot = yield* historyJobsSteps(home, true, { ids: new Set([id]), names: new Set([ref]) });
    for (const job of snapshot.values()) {
      yield;
      if (job.name === ref || job.id === id) return cloneJson(job);
    }
    return undefined;
  })());
  const { spec, launch } = recoverySpec(home, id);
  return selectRecovery(ref, id, history, spec, launch, await readRunLogsResponsive(home));
}
function recoveryId(ref: string): string | undefined {
  const id = ref.replace(/^.*-(?:job|ask)-/, "");
  return /^[\w-]+$/.test(id) ? id : undefined;
}
function recoverySpec(home: string, id: string) {
  // Rows (AB-208), or the file of an older server while it is not imported.
  const spec = readPendingRunnerSpec(home, id);
  const launch = isRecord(spec) && isRecord(spec.job) ? spec.job : undefined;
  return { spec, launch };
}
function selectRecovery(ref: string, id: string, history: Record<string, unknown> | undefined, spec: unknown, launch: Record<string, unknown> | undefined, runLogs: ReturnType<typeof readRunLogs>) {
  const runs = runLogs.filter((r) => r.meta.job === ref || r.meta.job === history?.name ||
    r.name.endsWith(`-${launch?.agent ?? history?.agent ?? ref.split("-")[0]}-${id}`))
    .sort((a, b) => runStart(b) - runStart(a));
  const run = runs[0], meta = run?.meta;
  const name = history?.name ?? launch?.name ?? meta?.job ?? (run && /^[\w]+-(?:job|ask)-[\w-]+$/.test(ref) ? ref : undefined);
  const agent = history?.agent ?? launch?.agent ?? ref.split("-")[0];
  if (typeof name !== "string" || !AGENT_KINDS.includes(agent as never)) return undefined;
  const base = { ...launch, ...history };
  return { id, history, spec, launch, run, meta, name, agent, base };
}
type Recovery = NonNullable<ReturnType<typeof prepareRecovery>>;
function contextIdentity({ id, name, agent, base, meta }: Recovery): string {
  // Owner/grant changes may legitimately reuse the same retained native context.
  // A metadata-only new turn must never reuse bytes read for an earlier session.
  return JSON.stringify([id, name, agent, base.id, base.startedAt, base.sessionId, base.threadId,
    meta?.jobStartedAt, meta?.session, meta?.continues, meta?.by, meta?.job]);
}
function needsHeader({ run, base, meta }: Recovery): boolean {
  return Boolean(run && (typeof base.prompt !== "string" || typeof base.owner !== "string" && !meta?.by));
}
function finishRecovery(home: string, { id, history, spec, launch, run, meta, name, agent, base }: Recovery, { prompt, header }: RecoveryHeader): StoredJob | undefined {
  const rawState = readRunnerStateRecord(home, id);
  const state = isRecord(rawState) && typeof rawState.pid === "number" ? rawState : undefined;
  const startedAt = typeof base.startedAt === "number" ? base.startedAt : run ? runStart(run) : 0;
  // Do not mistake a previous runner's final state for a newer continuation.
  const currentState = state && typeof state.updatedAt === "number" && state.updatedAt >= startedAt ? state : undefined;
  const alive = currentState?.status === "running" && pidAlive(Number(currentState.pid));
  const owner = typeof base.owner === "string" ? base.owner : meta?.by ?? / by ([\w.-]+)/.exec(header)?.[1];
  if (!owner) return undefined;
  const sessionId = currentState?.sessionId ?? base.sessionId ?? base.threadId ?? meta?.session ?? meta?.continues ?? null;
  // A label-only log cannot reconstruct a native job; do not overwrite a live manager's facts.
  if (!history && !launch && !sessionId) return undefined;
  return {
    ...base, id: typeof base.id === "string" ? base.id : id, name, agent,
    model: base.model ?? meta?.model ?? null, prompt: typeof base.prompt === "string" ? base.prompt : prompt, startedAt,
    owner, rootName: base.rootName ?? owner, rootSession: base.rootSession ?? meta?.rootSession,
    parentJob: base.parentJob ?? meta?.parentJob,
    projectRoot: base.projectRoot ?? (isRecord(spec) ? spec.cwd : undefined) ?? meta?.byCwd ?? meta?.repoRoot,
    args: { ...(meta?.access ? { access: meta.access } : {}), ...(meta?.model ? { model: meta.model } : {}),
      ...(meta?.effort ? { effort: meta.effort } : {}), ...(meta?.title ? { title: meta.title } : {}),
      ...(isRecord(spec) && isRecord(spec.base) ? spec.base : {}), ...(isRecord(base.args) ? base.args : {}) },
    sessionId,
    workdir: currentState?.workdir ?? base.workdir ?? meta?.workdir ?? null,
    worktree: currentState?.worktree ?? base.worktree ?? null,
    status: alive ? "running" : ["done", "failed", "cancelled"].includes(String(currentState?.status)) ? currentState!.status
      : ["done", "failed", "cancelled"].includes(String(base.status)) ? base.status : "interrupted",
    host: alive ? { pid: currentState!.pid, peer: currentState!.peer ?? name, startedAt } : null,
  } as StoredJob;
}
