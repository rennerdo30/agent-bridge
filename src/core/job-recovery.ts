import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { isRecord } from "./json-store.js";
import { AGENT_KINDS } from "./protocol.js";
import { findHistoryJob, historyJobsSteps, readRunLogs, readRunLogsResponsive, type RunLogRecord } from "./run-history.js";
import { indexedJobRun, jobRunIndexReady, legacyJobRunAmbiguous, JOB_INDEX_WAIT_MS, waitForJobRunIndex } from "./job-run-index.js";
import { BridgeError } from "./protocol.js";
import { cloneJson, fileSignature, fileTimeMs, readJsonSnapshot } from "./file-cache.js";
import { drainScanResponsive } from "./responsive-scan.js";
import { pidAlive } from "./delegate.js";
import { writtenBeforeBoot } from "./boot-time.js";
import type { Job } from "../mcp/jobs.js";
import { readRecoveryHeader, type RecoveryHeader } from "./job-recovery-feed.js";
import { readPendingRunnerSpec, readRunnerStateRecord } from "./runner-store.js";
import { safeFile } from "./transcripts/common.js";
import { RUNS_DIR_NAME, type RunMeta } from "./runfeed.js";
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
  const deadline = performance.now() + JOB_INDEX_WAIT_MS;
  // A handoff or new native turn can update authority while asynchronous IO yields.
  // Re-read durable facts before publishing/authorizing the recovered context, and
  // retry the whole observation a bounded number of times when the facts moved
  // once during the read (concurrent recoveries publish enriched facts the same
  // way); a context that keeps changing still fails closed.
  for (let attempt = 0; attempt < 3; attempt++) {
    const recovery = await prepareRecoveryAsync(home, ref, deadline);
    if (!recovery) return undefined;
    const payload = needsHeader(recovery) && recovery.run ? await readRecoveryHeader(recovery.run.file) : { prompt: "", header: "" };
    if (!payload) return undefined;
    const latest = await prepareRecoveryAsync(home, ref, deadline);
    if (!latest) return undefined;
    if (!needsHeader(latest)) return finishRecovery(home, latest, { prompt: "", header: "" });
    if (latest.run?.file !== recovery.run?.file || latest.run?.signature !== recovery.run?.signature || contextIdentity(latest) !== contextIdentity(recovery)) continue;
    return finishRecovery(home, latest, payload);
  }
  return undefined;
}

function prepareRecovery(home: string, ref: string) {
  const id = recoveryId(ref);
  if (!id) return undefined;
  const history = findHistoryJob(home, ref, id);
  const { spec, launch } = recoverySpec(home, id);
  if (completeContext(home, history, id)) return selectRecovery(ref, id, history, spec, launch, []);
  const key = typeof history?.name === "string" ? history.name : ref;
  let ready = false, ambiguous = false;
  try { ready = jobRunIndexReady(home); ambiguous = ready && legacyJobRunAmbiguous(home, key); } catch { ready = false; }
  const indexed = ready && !ambiguous ? indexedJobRun(home, key, typeof history?.startedAt === "number" ? history.startedAt : undefined) : [];
  // Synchronous callers cannot wait for a per-key reobservation. A ready-index miss (a run an
  // older or external writer created after completion) keeps the pre-index discovery;
  // selectRecovery applies the same job, generation and single-candidate rules to it.
  return selectRecovery(ref, id, history, spec, launch, indexed.length ? indexed : readRunLogs(home), ambiguous);
}
async function prepareRecoveryAsync(home: string, ref: string, deadline: number) {
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
  if (completeContext(home, history, id)) return selectRecovery(ref, id, history, spec, launch, []);
  const currentRun = witnessedRun(home, id, history);
  if (currentRun) return selectRecovery(ref, id, history, spec, launch, [currentRun]);
  const key = typeof history?.name === "string" ? history.name : ref;
  const startedAt = typeof history?.startedAt === "number" ? history.startedAt : undefined;
  // Bounded, yielding discovery sharing the original deadline: the pre-index path, never a
  // synchronous scan on the broker event loop.
  const discover = async (legacyAmbiguous: boolean, state: string) => {
    const stop = new AbortController(), remaining = deadline - performance.now();
    const error = () => new BridgeError("job_index_preparing", `Job index preparing (${state}); retry later. No control submitted.`);
    if (remaining <= 0) throw error();
    let timer: NodeJS.Timeout | undefined;
    try {
      const runs = await Promise.race([readRunLogsResponsive(home, undefined, undefined, stop.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { stop.abort(); reject(error()); }, remaining); })]);
      return selectRecovery(ref, id, history, spec, launch, runs, legacyAmbiguous);
    } catch { throw error(); }
    finally { clearTimeout(timer); stop.abort(); }
  };
  // An unavailable index (failed backfill, busy SQLite) never fails the request.
  if (await waitForJobRunIndex(home, deadline, key, startedAt) === "discover") return discover(false, "discovery running");
  let ambiguous: boolean;
  try { ambiguous = legacyJobRunAmbiguous(home, key); } catch { return discover(false, "discovery running"); }
  // Legacy ambiguity requires discovery too.
  if (ambiguous) return discover(true, "ambiguous legacy discovery");
  let runs: RunLogRecord[];
  // A moved, changing or unreadable indexed route fails only this lookup: discover instead.
  try { runs = indexedJobRun(home, key, startedAt); } catch { return discover(false, "discovery running"); }
  return selectRecovery(ref, id, history, spec, launch, runs);
}

/** Full history rows come from the selected durable payload, never the routing
 * metadata (whose prompt is truncated). Native session identity must be known
 * in the row or supplied by current runner state; null can mean it had not yet
 * been learned. Other incomplete legacy fields still need spec/run enrichment. */
function completeContext(home: string, history: Record<string, unknown> | undefined, id: string): boolean {
  const nullableString = (value: unknown) => value === null || typeof value === "string";
  const complete = history?.id === id && typeof history.name === "string" && AGENT_KINDS.includes(history.agent as never) &&
    typeof history.owner === "string" && typeof history.prompt === "string" && Number.isFinite(history.startedAt) &&
    ["running", "paused", "done", "failed", "cancelled", "interrupted"].includes(String(history.status)) &&
    isRecord(history.args) && nullableString(history.model) && nullableString(history.sessionId) &&
    nullableString(history.workdir) && (history.worktree === null || isRecord(history.worktree));
  if (!complete) return false;
  if (typeof history.sessionId === "string") return true;
  const state = readRunnerStateRecord(home, id);
  // Match finishRecovery's current-state gate so the session is actually overlaid.
  return typeof state?.pid === "number" && typeof state.updatedAt === "number" &&
    state.updatedAt >= Number(history.startedAt) && typeof state.sessionId === "string";
}

/** A runner publishes the exact feed for this job generation. Missing or
 * inconsistent evidence must preserve discovery by metadata, including runs
 * whose filenames do not contain the job id. No filename convention is proof. */
function witnessedRun(home: string, id: string, history: Record<string, unknown> | undefined): RunLogRecord | undefined {
  if (history?.id !== id || !Number.isFinite(history.startedAt)) return undefined;
  const state = readRunnerStateRecord(home, id), witness = state?.currentRun;
  const running = state?.status === "running";
  if (!state || !["running", "paused", "done", "failed", "cancelled"].includes(String(state.status)) || state.peer !== history.name ||
      running && (history.status !== "running" || !isRecord(history.host) || state.pid !== history.host.pid ||
        writtenBeforeBoot(Number(state.updatedAt)) || !pidAlive(Number(state.pid))) ||
      !(Number(state.updatedAt) >= Number(history.startedAt)) ||
      !isRecord(witness) || witness.id !== id || witness.startedAt !== history.startedAt ||
      typeof witness.log !== "string" || basename(witness.log) !== witness.log || !/^[\w.-]+\.log$/.test(witness.log)) return undefined;
  try {
    const root = join(home, RUNS_DIR_NAME), canonical = realpathSync.native(root);
    const log = join(root, witness.log), meta = log.replace(/\.log$/, ".json");
    const file = safeFile(root, log, canonical), metadata = safeFile(root, meta, canonical);
    if (!file || !metadata) return undefined;
    const logStat = statSync(file, { bigint: true }), metaStat = statSync(metadata, { bigint: true });
    if (!logStat.isFile() || !metaStat.isFile()) return undefined;
    const value = readJsonSnapshot(metadata, { file: metadata, stat: metaStat }).value;
    if (!isRecord(value) || value.job !== history.name || value.jobStartedAt !== history.startedAt) return undefined;
    // Match the containment and replacement fences of the broad reader. The
    // second prepareRecoveryAsync repeats this observation after any await.
    if (safeFile(root, log, canonical) !== file || safeFile(root, meta, canonical) !== metadata ||
        realpathSync.native(root) !== canonical || fileSignature(statSync(file, { bigint: true })) !== fileSignature(logStat) ||
        fileSignature(statSync(metadata, { bigint: true })) !== fileSignature(metaStat)) return undefined;
    return { name: witness.log.slice(0, -4), file, updatedAt: fileTimeMs(logStat.mtimeMs, logStat.mtimeNs),
      size: Number(logStat.size), signature: fileSignature(logStat), archived: false, meta: value as RunMeta };
  } catch { return undefined; }
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
function selectRecovery(ref: string, id: string, history: Record<string, unknown> | undefined, spec: unknown, launch: Record<string, unknown> | undefined, runLogs: ReturnType<typeof readRunLogs>, legacyAmbiguous = false) {
  const key = typeof history?.name === "string" ? history.name : ref;
  const candidates = runLogs.filter(r => r.metadataFile || Object.keys(r.meta).length
    ? r.meta.job === key
    : r.name.endsWith(`-${launch?.agent ?? history?.agent ?? ref.split("-")[0]}-${id}`));
  const runs = candidates.filter(r => r.meta.jobStartedAt !== undefined
    ? !Number.isFinite(history?.startedAt) || r.meta.jobStartedAt === history!.startedAt
    : !legacyAmbiguous && candidates.length === 1)
    .sort((a, b) => runStart(b) - runStart(a));
  const run = runs[0], meta = run?.meta;
  const name = history?.name ?? launch?.name ?? meta?.job ?? (run && /^[\w]+-(?:job|ask)-[\w-]+$/.test(ref) ? ref : undefined);
  const agent = history?.agent ?? launch?.agent ?? ref.split("-")[0];
  if (typeof name !== "string" || !AGENT_KINDS.includes(agent as never)) return undefined;
  const base = { ...launch, ...history };
  if (!run && typeof base.prompt !== "string") return undefined;
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
  // A runner whose last heartbeat predates the current boot is gone even when its PID answers again (AB-256).
  const alive = currentState?.status === "running" && pidAlive(Number(currentState.pid)) && !writtenBeforeBoot(Number(currentState.updatedAt));
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
    status: alive ? base.status === "paused" ? "paused" : "running" : ["paused", "done", "failed", "cancelled"].includes(String(currentState?.status)) ? currentState!.status
      : ["paused", "done", "failed", "cancelled"].includes(String(base.status)) ? base.status : "interrupted",
    pausePending: alive && base.pausePending === true ? true : undefined,
    host: alive ? { pid: currentState!.pid, peer: currentState!.peer ?? name, startedAt } : null,
  } as StoredJob;
}
