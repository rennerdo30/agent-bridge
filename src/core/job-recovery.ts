import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./json-store.js";
import { AGENT_KINDS } from "./protocol.js";
import { readHistoryJobs, readHistoryJson, readRunLogs } from "./run-history.js";
import { safeFile } from "./transcripts/common.js";
import { pidAlive } from "./delegate.js";
import type { Job } from "../mcp/jobs.js";
type StoredJob = Omit<Job, "controller" | "progress" | "queue" | "resume">;
function runStart(run: ReturnType<typeof readRunLogs>[number]): number {
  if (run.meta.jobStartedAt !== undefined) return run.meta.jobStartedAt;
  const stamp = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(run.name);
  return stamp ? Date.UTC(+stamp[1]!, +stamp[2]! - 1, +stamp[3]!, +stamp[4]!, +stamp[5]!, +stamp[6]!) : run.updatedAt;
}

/** Read-only recovery from retained 0.29.10 snapshots, launch specs and run feeds.
 * Current registry ownership and grants always take precedence over original run metadata. */
export function recoverJobRecord(home: string, ref: string): StoredJob | undefined {
  const id = ref.replace(/^.*-(?:job|ask)-/, "");
  if (!/^[\w-]+$/.test(id)) return undefined;
  const history = [...readHistoryJobs(home).values()].find((j) => j.name === ref || j.id === id);
  const file = safeFile(home, join(home, "jobs", `${id}.spec.json`));
  const spec = file ? readHistoryJson(file) : null;
  const launch = isRecord(spec) && isRecord(spec.job) ? spec.job : undefined;
  const runs = readRunLogs(home).filter((r) => r.meta.job === ref || r.meta.job === history?.name ||
    r.name.endsWith(`-${launch?.agent ?? history?.agent ?? ref.split("-")[0]}-${id}`))
    .sort((a, b) => runStart(b) - runStart(a));
  const run = runs[0], meta = run?.meta;
  const name = history?.name ?? launch?.name ?? meta?.job ?? (run && /^[\w]+-(?:job|ask)-[\w-]+$/.test(ref) ? ref : undefined);
  const agent = history?.agent ?? launch?.agent ?? ref.split("-")[0];
  if (typeof name !== "string" || !AGENT_KINDS.includes(agent as never)) return undefined;
  let prompt = "", header = "";
  if (run) {
    try {
      const text = readFileSync(run.file, "utf8"), lines = text.split("\n");
      header = lines[0] ?? "";
      const end = lines.findIndex((line) => line.trim() === "---");
      if (end > 0) prompt = lines.slice(1, end).map((line) => line.replace(/^ {9}/, "")).join("\n");
    } catch { /* Keep the intact spec/snapshot if the run was concurrently archived. */ }
  }
  const base = { ...launch, ...history };
  const stateFile = safeFile(home, join(home, "jobs", `${id}.json`));
  const rawState = stateFile ? readHistoryJson(stateFile) : null;
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
    model: base.model ?? meta?.model ?? null, prompt: base.prompt ?? prompt, startedAt,
    owner, rootName: base.rootName ?? owner, rootSession: base.rootSession ?? meta?.rootSession,
    parentJob: base.parentJob ?? meta?.parentJob,
    projectRoot: base.projectRoot ?? (isRecord(spec) ? spec.cwd : undefined) ?? meta?.byCwd ?? meta?.repoRoot,
    args: { ...(meta?.access ? { access: meta.access } : {}), ...(meta?.model ? { model: meta.model } : {}),
      ...(meta?.effort ? { effort: meta.effort } : {}), ...(meta?.title ? { title: meta.title } : {}),
      ...(isRecord(spec) && isRecord(spec.base) ? spec.base : {}), ...(isRecord(base.args) ? base.args : {}) },
    sessionId,
    workdir: currentState?.workdir ?? base.workdir ?? meta?.workdir ?? null,
    worktree: currentState?.worktree ?? base.worktree ?? null,
    status: alive ? "running" : currentState?.status === "done" || currentState?.status === "failed" ? currentState.status
      : base.status === "done" || base.status === "failed" ? base.status : "interrupted",
    host: alive ? { pid: currentState!.pid, peer: currentState!.peer ?? name, startedAt } : null,
  } as StoredJob;
}
