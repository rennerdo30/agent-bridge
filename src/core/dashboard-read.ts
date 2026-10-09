import { worktreeRoots } from "./worktree.js";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { JOBS_FILE } from "./constants.js";
import { isPluginCacheCwd } from "./session-visibility.js";
import type { Logger } from "./logger.js";
import { CODING_AGENTS, type PeerInfo } from "./protocol.js";
import { isRecord } from "./json-store.js";
import { type RunMeta } from "./runfeed.js";
import { finishedRunLine } from "./run-archive.js";
import { readRunLogPreview } from "./run-log-preview.js";
import { DEFAULT_RUN_PAGE_SIZE, MAX_RUN_PAGE_SIZE, pageRuns, readHistoryJobs, readHistoryJson, readRunLogsSteps, historyJobsSteps, selectHistoryJobs, selectHistoryJobsResponsive, unchangedContainedFile } from "./run-history.js";
import { drainScan, drainScanResponsive } from "./responsive-scan.js";
import type { Worktree } from "./worktree.js";
import { listNativeSubagents, readTranscript, TRANSCRIPT_ID, validTranscriptCursor, type TranscriptPaths } from "./transcripts/index.js";
import { JOB_OUTCOME_CONTRACT_VERSION, type JobOutcome, type OutcomeJob } from "./job-outcomes.js";
import { cachedOutcomes, type OutcomeInput } from "./outcome-background.js";
import { JOB_SETTING_KEYS } from "../mcp/job-settings.js";
import { cloneJson, fileSignature, readJsonSnapshot } from "./file-cache.js";
import type { readStore } from "../mcp/jobs.js";
import { readArchivedJobSteps } from "./job-archive.js";
import { indexedJobProjectionCurrent } from "./job-archive-index.js";
import { dashboardRequestSchema, type DashboardReadRequest, type DashboardReadResult } from "../network/dashboard-protocol.js";
const TASK_PREVIEW_CHARS = 300;
const STALE_RUN_MS = 150_000;
const LEGACY_JOB_START_TOLERANCE_MS = 1_000;
const MAX_LOG_CHUNK = 128 * 1024;
export interface RunSummary extends RunMeta {
  name: string;
  agent: string;
  header: string;
  startedAt: number;
  updatedAt: number;
  status: "running" | "done" | "failed" | "interrupted" | "cancelled";
  last: string;
  /** Start of the prompt, for lists. */
  task: string;
  archived?: boolean;
  recovered?: boolean;
  hasLog?: boolean;
  owner?: string | null;
  sessionId?: string | null;
  prompt?: string;
  finishedAt?: number;
  worktree?: Worktree | null;
  branch?: string;
  parentJob?: string;
  rootSession?: string;
  rootName?: string;
  host?: string;
}

/** Read-only projection: legacy metadata stays byte-for-byte intact. */
export async function finishedRunOutcomes(home: string, log: Logger, names?: Set<string>): Promise<Record<string, JobOutcome>> {
  const runs = await listRunsResponsive(home, Date.now(), names);
  const jobs = await readOutcomeJobs(home, log, new Set(runs.flatMap(run => run.job ? [run.job] : [])));
  const inputs: OutcomeInput[] = [];
  for (const run of runs) {
    if (names && !names.has(run.name)) continue;
    if (!run.job || !["done", "failed", "cancelled"].includes(run.status)) continue;
    const stored = jobs.find((j) => j.name === run.job);
    const startedAt = run.jobStartedAt ?? run.startedAt;
    const latest = stored && (run.jobStartedAt !== undefined ? stored.startedAt === startedAt : Math.abs(stored.startedAt - startedAt) < LEGACY_JOB_START_TOLERANCE_MS);
    const job: OutcomeJob = {
      id: stored?.id ?? run.job.replace(/^.*-(?:job|ask)-/, ""), name: run.job,
      owner: latest ? stored.owner : run.by,
      startedAt: run.jobStartedAt ?? (latest ? stored.startedAt : run.startedAt),
      status: run.status, worktree: stored?.worktree,
      remote: (run as RunSummary & { remote?: OutcomeJob["remote"] }).remote ?? (stored as OutcomeJob | undefined)?.remote,
    };
    inputs.push({ key: run.name, kind: "run", job, opts: {
      branch: run.branch, baseBranch: run.baseBranch, repoRoot: run.repoRoot,
      branchHead: run.branchHead,
    } });
  }
  return cachedOutcomes(home, inputs, log);
}

/** Cached display evidence only; explicit supervisor decisions use fresh deriveJobOutcome. */
async function dashboardJobOutcomes(home: string, log: Logger, names: Set<string>): Promise<Record<string, { startedAt: number; status: string; outcome: JobOutcome }>> {
  const jobs = (await readOutcomeJobs(home, log, names)).filter(job => ["done", "failed", "cancelled"].includes(job.status));
  const outcomes = await cachedOutcomes(home, jobs.map(job => ({ key: job.name, kind: "job", opts: {}, job: {
    id: job.id, name: job.name, owner: job.owner, startedAt: job.startedAt, status: job.status, worktree: job.worktree, remote: job.remote,
  } })), log);
  return Object.fromEntries(jobs.map(job => [job.name, { startedAt: job.startedAt, status: job.status, outcome: outcomes[job.name]! }]));
}

/** Match readStore's ID precedence; do not clone unselected full job payloads. */
async function readOutcomeJobs(home: string, log: Logger, names?: ReadonlySet<string>): Promise<ReturnType<typeof readStore>> {
  const path = join(home, JOBS_FILE);
  try {
    return await drainScanResponsive((function* () {
      const all = new Map<string, Record<string, unknown>>();
      const canonicalHome = realpathSync.native(home), activePath = join(canonicalHome, JOBS_FILE);
      let data: unknown = null, activeStat: Stats | undefined;
      try {
        if (!indexedJobProjectionCurrent(activePath)) activeStat = lstatSync(activePath);
        if (activeStat) {
        if (!unchangedContainedFile(canonicalHome, activePath, activeStat, canonicalHome)) throw new Error("outcome job store must be a contained physical file");
        data = readJsonSnapshot(activePath, { file: activePath, stat: activeStat }).value;
        }
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
      const active = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : [];
      for (const job of [...(yield* readArchivedJobSteps(activePath, true, { metadata: true, names })).jobs, ...active]) {
        yield;
        if (isRecord(job) && typeof job.id === "string" && typeof job.name === "string") all.set(job.id, job);
      }
      const selected: ReturnType<typeof readStore> = [];
      for (const job of all.values()) {
        yield;
        if (!names || names.has(String(job.name))) selected.push({
          id: job.id, name: job.name, owner: job.owner, startedAt: job.startedAt, status: job.status,
          worktree: cloneJson(job.worktree), remote: cloneJson(job.remote),
        } as ReturnType<typeof readStore>[number]);
      }
      if (activeStat && !unchangedContainedFile(canonicalHome, activePath, activeStat, canonicalHome)) throw new Error("outcome job store changed during catalog traversal");
      return selected;
    })());
  } catch (err) { log.warn("could not read outcome jobs", { path, err: String(err) }); return []; }
}

/** Parse the head and tail of a run log written by runfeed.ts, plus its metadata (older runs: from the header). */
export function summarizeRun(file: string, text: string, mtimeMs: number, now: number, meta: RunMeta = {}): RunSummary {
  const lines = text.split("\n").filter(Boolean);
  const finished = finishedRunLine(text);
  const last = (finished ?? lines.at(-1) ?? "").replace(/^\d\d:\d\d:\d\d /, "");
  const status: RunSummary["status"] = finished
    ? / · done$/.test(finished)
      ? "done"
      : / · cancelled$/.test(finished) ? "cancelled" : "failed"
    : now - mtimeMs > STALE_RUN_MS
      ? "interrupted"
      : "running";
  const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-([a-z]+)-/.exec(file);
  const startedAt = m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : Math.floor(mtimeMs);
  const header = (lines[0] ?? "").replace(/^\d\d:\d\d:\d\d /, "");
  const end = lines.findIndex((l) => l.trim() === "---");
  const task = lines
    .slice(1, end > 0 ? end : 1)
    .map((l) => l.trim())
    .join(" ")
    .slice(0, TASK_PREVIEW_CHARS);
  return {
    by: / by ([\w.-]+)/.exec(header)?.[1],
    workdir: / in (.+?), access /.exec(header)?.[1],
    continues: /, continues (\S+)/.exec(header)?.[1] ?? null,
    ...meta,
    ...(status !== "running" ? { etaAt: undefined, etaReportedAt: undefined } : {}),
    name: file.replace(/\.log$/, ""),
    agent: m?.[7] ?? "agent",
    header,
    startedAt,
    updatedAt: mtimeMs,
    status,
    last,
    task,
  };
}

export function listRuns(home: string, now = Date.now(), names?: Set<string>): RunSummary[] {
  return drainScan(listRunsSteps(home, now, names));
}

/** Complete catalog with the same projection/cursors, yielding during traversal. */
export function listRunsResponsive(home: string, now = Date.now(), names?: Set<string>): Promise<RunSummary[]> {
  return drainScanResponsive(listRunsSteps(home, now, names, true));
}

function* listRunsSteps(home: string, now: number, names?: Set<string>, responsive = false): Generator<void, RunSummary[]> {
  const runs: RunSummary[] = [];
  for (const log of yield* readRunLogsSteps(home, names, responsive)) {
    yield;
    try {
      const signature = `${log.signature}:${JSON.stringify(log.meta)}`;
      let cached = runSummaries.get(log.file);
      if (cached?.signature !== signature) {
        // Parse once while fresh; derive interrupted/ETA state on every poll, even for unchanged logs.
        cached = { signature, summary: summarizeRun(`${log.name}.log`, readRunLogPreview(log.file, log.signature), log.updatedAt, log.updatedAt, log.meta) };
        runSummaries.delete(log.file); runSummaries.set(log.file, cached);
        if (runSummaries.size > 2048) runSummaries.delete(runSummaries.keys().next().value!);
      }
      const stale = cached.summary.status === "running" && now - log.updatedAt > STALE_RUN_MS;
      runs.push({ ...cloneJson(cached.summary), ...(stale ? { status: "interrupted", etaAt: undefined, etaReportedAt: undefined } : {}), archived: log.archived, recovered: false, hasLog: true });
    }
    catch { /* A concurrent archive operation is retried on the next refresh. */ }
  }
  // An exact retained run needs no job-snapshot recovery or unrelated archive reads.
  if (names && [...names].every((name) => runs.some((run) => run.name === name)))
    return pageRuns(runs, null, runs.length).runs;
  const representedJobs = new Set(runs.map((run) => run.job));
  const representedSuffixes = new Set<string>();
  for (const run of runs) for (let at = run.name.indexOf("-"); at >= 0; at = run.name.indexOf("-", at + 1)) representedSuffixes.add(run.name.slice(at));
  // Summary construction only reads these immutable records. Detach exposed
  // nested fields individually instead of cloning every retained full prompt.
  const current = yield* historyJobsSteps(home, responsive, { names, metadata: !names });
  // Filtered outcome pages may recover several jobs. Inspect the log registry once,
  // rather than repeating all metadata stats and clones for each recovered job.
  const retainedLogs = names ? yield* readRunLogsSteps(home, undefined, responsive) : undefined;
  for (const [name, job] of current) {
    yield;
    if (names && !names.has(name)) continue;
    // Filtering log bodies must not invent a recovered run for a job whose real
    // retained run simply belongs to a different outcome page.
    if (names && retainedLogs!.some((r) => r.meta.job === name ||
      (typeof job.id === "string" && r.name.endsWith(`-${job.agent}-${job.id}`)))) continue;
    // Older logs lack job metadata; their filename still includes the original agent/job id.
    if (representedJobs.has(name) || (typeof job.id === "string" && representedSuffixes.has(`-${job.agent}-${job.id}`))) continue;
    const args = isRecord(job.args) ? job.args : {};
    const worktree = isRecord(job.worktree) ? cloneJson(job.worktree) as unknown as Worktree : null;
    const prompt = typeof job.prompt === "string" ? job.prompt : "";
    const owner = typeof job.owner === "string" ? job.owner : null;
    const sessionId = typeof job.sessionId === "string" ? job.sessionId : typeof job.threadId === "string" ? job.threadId : null;
    const startedAt = typeof job.startedAt === "number" && Number.isSafeInteger(job.startedAt) && job.startedAt >= 0 ? job.startedAt : 0;
    const finishedAt = typeof job.finishedAt === "number" && Number.isSafeInteger(job.finishedAt) ? job.finishedAt : undefined;
    runs.push({
      name, job: name, agent: typeof job.agent === "string" ? job.agent : "agent", model: typeof job.model === "string" ? job.model : null,
      title: typeof args.title === "string" ? args.title : typeof job.title === "string" ? job.title : undefined,
      by: owner ?? undefined, owner, session: sessionId, sessionId, prompt, task: prompt.slice(0, TASK_PREVIEW_CHARS),
      workdir: typeof job.workdir === "string" ? job.workdir : worktree?.cwd ?? (typeof args.cwd === "string" ? args.cwd : undefined),
      worktree, branch: worktree?.branch ?? (typeof job.branch === "string" ? job.branch : undefined),
      parentJob: typeof job.parentJob === "string" ? job.parentJob : undefined, rootSession: typeof job.rootSession === "string" ? job.rootSession : undefined,
      startedAt, finishedAt, updatedAt: finishedAt ?? startedAt,
      // A historical snapshot does not prove that an old process is still running.
      status: job.status === "done" || job.status === "failed" || job.status === "cancelled" ? job.status : "interrupted",
      header: `Recovered ${name}`, last: "Run log unavailable; conversation may be available in the CLI transcript.", recovered: true, hasLog: false,
    });
  }
  for (const run of runs) {
    yield;
    const job = run.job && current.get(run.job);
    if (job && Array.isArray(job.ownershipHistory) && job.ownershipHistory.length) {
      // Project current supervision without altering original run metadata or prompts.
      run.owner = typeof job.owner === "string" ? job.owner : run.owner;
      run.rootName = typeof job.rootName === "string" ? job.rootName : undefined;
      run.rootSession = typeof job.rootSession === "string" ? job.rootSession : undefined;
      run.parentJob = typeof job.parentJob === "string" ? job.parentJob : undefined;
    }
  }
  return pageRuns(runs, null, runs.length).runs;
}

const runSummaries = new Map<string, { signature: string; summary: RunSummary }>();

export function readMeta(file: string): RunMeta {
  try {
    const value = readHistoryJson(file);
    return isRecord(value) ? value as RunMeta : {};
  } catch {
    return {};
  }
}

/** What the dashboard reads of a stored job: its owner and the settings its next turn uses. */
export interface StoredJobView {
  owner: string | null;
  next: Record<string, unknown>;
  projectRoot?: string;
  remote?: { host: string; name: string };
}

/** Jobs from the sessions' store (`{ jobs: [...] }`; before 0.26 a bare array). Read-only and best effort. */
export function readStoredJobs(home: string, names?: ReadonlySet<string>): Map<string, StoredJobView> {
  return storedJobViews(drainScan(historyJobsSteps(home, false, { names, metadata: true })));
}

function storedJobViews(jobs: Map<string, Record<string, unknown>>): Map<string, StoredJobView> {
  return drainScan(storedJobViewSteps(jobs));
}

/** All saved settings, without cloning retained prompt/context fields. */
export function readStoredJobsResponsive(home: string, names?: ReadonlySet<string>): Promise<Map<string, StoredJobView>> {
  return drainScanResponsive((function* () {
    return yield* storedJobViewSteps(yield* historyJobsSteps(home, true, { names, metadata: true }), names);
  })());
}

function* storedJobViewSteps(jobs: Map<string, Record<string, unknown>>, names?: ReadonlySet<string>): Generator<void, Map<string, StoredJobView>> {
  const out = new Map<string, StoredJobView>();
  for (const j of jobs.values()) {
    yield;
    if (!j || typeof j !== "object") continue;
    const { name, owner, args, remote } = j as { name?: unknown; owner?: unknown; args?: unknown; remote?: { host: string; name: string } };
    if (typeof name !== "string" || names && !names.has(name)) continue;
    const saved = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    out.set(name, {
      owner: typeof owner === "string" && owner ? owner : null,
      ...(typeof j.projectRoot === "string" ? { projectRoot: j.projectRoot } : {}),
      next: cloneJson(Object.fromEntries(JOB_SETTING_KEYS.filter((key) => saved[key] !== undefined).map((key) => [key, saved[key]]))),
      ...(remote && typeof remote.host === "string" && typeof remote.name === "string" ? { remote: cloneJson(remote) } : {}),
    });
  }
  return out;
}

export type DashboardPeer = PeerInfo & { subagent: boolean; parent: string | null };

/**
 * Sessions in a subagent worktree are subagents, not sessions of their own (older versions let them join):
 * show them under the session whose run used that folder.
 */
export function classifyPeers(peers: PeerInfo[], runs: RunSummary[], home: string): DashboardPeer[] {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const roots = worktreeRoots(home).map(root => `${norm(root)}/`);
  const byWorkdir = new Map<string, RunSummary>();
  for (const run of runs) if (run.workdir && !byWorkdir.has(norm(run.workdir))) byWorkdir.set(norm(run.workdir), run);
  return peers.filter((p) => !isPluginCacheCwd(p.cwd)).map((p) => {
    const cwd = norm(p.cwd ?? "");
    const subagent = roots.some(root => cwd.startsWith(root));
    const run = subagent ? byWorkdir.get(cwd) : undefined;
    return { ...p, subagent: Boolean(p.jobAgent || p.subagent || subagent), parent: p.parentJob ?? p.jobParent ?? p.rootName ?? run?.by ?? null };
  });
}

export interface DashboardReadContext { home: string; log: Logger; peers: () => Promise<PeerInfo[]> | PeerInfo[]; transcripts?: TranscriptPaths }
const reply = (status: number, body: unknown): DashboardReadResult => ({ status, body });
/** The same read-only handlers serve HTTP locally and authenticated paired-link requests. */
export async function readDashboard(ctx: DashboardReadContext, request: DashboardReadRequest): Promise<DashboardReadResult> {
  if (!dashboardRequestSchema.safeParse(request).success) return reply(400, { error: "invalid dashboard read request" });
  const url = new URL(request.path, "http://localhost");
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
    if (url.pathname === "/api/state") {
      const page = pageRuns(await listRunsResponsive(ctx.home), null, DEFAULT_RUN_PAGE_SIZE);
      // Only settings for jobs on this bounded run page are needed by its inspector.
      const names = new Set(page.runs.flatMap((run) => run.job ? [run.job] : []));
      const selected = await selectHistoryJobsResponsive(ctx.home, names);
      const jobs = Object.fromEntries([...storedJobViews(selected)].map(([name, job]) => [name, { next: job.next, ...(job.remote ? { remote: job.remote } : {}) }]));
      return reply(200, { runs: page.runs, runsNext: page.next, runsTotal: page.total, jobs });
    }
    if (url.pathname === "/api/job-outcomes") {
      const jobName = url.searchParams.get("job"), runName = url.searchParams.get("run");
      if (jobName !== null || runName !== null) {
        if (jobName !== null && runName !== null) return reply(400, { error: "choose job or run" });
        const name = jobName ?? runName!;
        if (!/^[\w.-]{1,256}$/.test(name) || name === "." || name === "..") return reply(400, { error: "invalid outcome name" });
        const names = new Set([name]);
        const jobs = jobName !== null ? await dashboardJobOutcomes(ctx.home, ctx.log, names) : {};
        const runs = runName !== null ? await finishedRunOutcomes(ctx.home, ctx.log, names) : {};
        if (!Object.hasOwn(jobs, name) && !Object.hasOwn(runs, name)) return reply(404, { error: "no such finished job or run" });
        const groups: Record<string, string[]> = { needsReview: [], held: [], merged: [], discarded: [] };
        for (const [key, job] of Object.entries(jobs)) {
          const state = job.outcome.merge.state;
          groups[state === "unmerged" ? "needsReview" : state]!.push(key);
        }
        return reply(200, { contractVersion: JOB_OUTCOME_CONTRACT_VERSION, jobs, runs, groups, next: null });
      }
      const rawLimit = url.searchParams.get("limit") ?? String(DEFAULT_RUN_PAGE_SIZE);
      const limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RUN_PAGE_SIZE) return reply(400, { error: "invalid outcome page limit" });
      const before = url.searchParams.get("before");
      if (before !== null && !/^[\w.-]{1,256}$/.test(before)) return reply(400, { error: "invalid outcome cursor" });
      const select = (names: string[]) => [...new Set(names)].sort().filter((name) => before === null || name > before).slice(0, limit);
      const stored = (await readOutcomeJobs(ctx.home, ctx.log)).filter((j) => ["done", "failed", "cancelled"].includes(j.status));
      const runs = (await listRunsResponsive(ctx.home)).filter((r) => r.job && ["done", "failed", "cancelled"].includes(r.status));
      const names = select([...stored.map((j) => j.name), ...runs.map((r) => r.name)]);
      const next = [...stored.map((j) => j.name), ...runs.map((r) => r.name)].some((name) => names.length > 0 && name > names.at(-1)!) ? names.at(-1) : null;
      const jobs = await dashboardJobOutcomes(ctx.home, ctx.log, new Set(names));
      const groups: Record<string, string[]> = { needsReview: [], held: [], merged: [], discarded: [] };
      for (const [name, job] of Object.entries(jobs)) {
        const state = job.outcome.merge.state;
        groups[state === "unmerged" ? "needsReview" : state]!.push(name);
      }
      return reply(200, { contractVersion: JOB_OUTCOME_CONTRACT_VERSION, jobs, runs: await finishedRunOutcomes(ctx.home, ctx.log, new Set(names)), groups, next });
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)\/(chat|subagents)(?:\/([^/]+))?$/.exec(url.pathname);
    if (sessionMatch) {
      let name: string, child: string | undefined;
      try { name = decodeURIComponent(sessionMatch[1]!); child = sessionMatch[3] === undefined ? undefined : decodeURIComponent(sessionMatch[3]); }
      catch { return reply(404, { error: "no such local session" }); }
      if (name.includes("/") || name.includes("\\") || (child !== undefined && !TRANSCRIPT_ID.test(child)) || (sessionMatch[2] === "chat" && child !== undefined)) return reply(404, { error: "no such local session or subagent" });
      const peers = await ctx.peers();
      const peer = peers.find((p) => p.name === name && !p.name.includes("/") && !isPluginCacheCwd(p.cwd));
      if (!peer) return reply(404, { error: "no such local session" });
      if (!peer.sessionId) return reply(409, { error: "This session has no sessionId yet." });
      if (!TRANSCRIPT_ID.test(peer.sessionId) || !CODING_AGENTS.includes(peer.agent as typeof CODING_AGENTS[number])) return reply(404, { error: "no transcript for this session" });
      if (sessionMatch[2] === "subagents" && child === undefined) return reply(200, { subagents: listNativeSubagents(peer, ctx.transcripts) });
      const from = url.searchParams.get("from") ?? "0";
      if (!validTranscriptCursor(from)) return reply(400, { error: "invalid transcript cursor" });
      const page = readTranscript(peer, from, child, ctx.transcripts);
      return page ? reply(200, page) : reply(404, { error: "no transcript for this session or subagent" });
    }
    if (url.pathname === "/api/runs") {
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? DEFAULT_RUN_PAGE_SIZE : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RUN_PAGE_SIZE) return reply(400, { error: `limit must be an integer from 1 to ${MAX_RUN_PAGE_SIZE}` });
      try { return reply(200, pageRuns(await listRunsResponsive(ctx.home), url.searchParams.get("before"), limit)); }
      catch { return reply(400, { error: "invalid run cursor" }); }
    }
    const jobChildrenMatch = /^\/api\/jobs\/([\w.-]+)\/subagents(?:\/([^/]+))?$/.exec(url.pathname);
    if (jobChildrenMatch) {
      const name = jobChildrenMatch[1]!;
      let child: string | undefined;
      try { child = jobChildrenMatch[2] === undefined ? undefined : decodeURIComponent(jobChildrenMatch[2]); }
      catch { return reply(404, { error: "no such job or subagent" }); }
      if (child !== undefined && !TRANSCRIPT_ID.test(child)) return reply(404, { error: "no such job or subagent" });
      const job = (await selectHistoryJobsResponsive(ctx.home, new Set([name]))).get(name);
      const run = (await listRunsResponsive(ctx.home)).find((r) => r.job === name);
      if (!job && !run) return reply(404, { error: "no such job" });
      const agent = typeof job?.agent === "string" ? job.agent : run?.agent;
      const sessionId = typeof job?.sessionId === "string" ? job.sessionId : typeof job?.threadId === "string" ? job.threadId : run?.sessionId ?? run?.session;
      if (!sessionId) return reply(409, { error: "This job has no sessionId yet." });
      if (!TRANSCRIPT_ID.test(sessionId) || !CODING_AGENTS.includes(agent as typeof CODING_AGENTS[number])) return reply(404, { error: "no transcript for this job" });
      const session = { agent: agent as PeerInfo["agent"], sessionId, cwd: typeof job?.workdir === "string" ? job.workdir : run?.workdir ?? "" };
      if (child === undefined) return reply(200, { subagents: listNativeSubagents(session, ctx.transcripts) });
      const from = url.searchParams.get("from") ?? "0";
      if (!validTranscriptCursor(from)) return reply(400, { error: "invalid transcript cursor" });
      const page = readTranscript(session, from, child, ctx.transcripts);
      return page ? reply(200, page) : reply(404, { error: "no transcript for this job or subagent" });
    }
    const runChatMatch = /^\/api\/runs\/([\w.-]+)\/chat$/.exec(url.pathname);
    if (runChatMatch) {
      const from = url.searchParams.get("from") ?? "0";
      if (!validTranscriptCursor(from)) return reply(400, { error: "invalid transcript cursor" });
      const run = (await listRunsResponsive(ctx.home)).find((r) => r.name === runChatMatch[1] || r.job === runChatMatch[1]);
      if (!run) return reply(404, { error: "no such run" });
      const job = run.job ? (await selectHistoryJobsResponsive(ctx.home, new Set([run.job]))).get(run.job) : undefined;
      const sessionId = run.sessionId ?? run.session ?? (typeof job?.sessionId === "string" ? job.sessionId : typeof job?.threadId === "string" ? job.threadId : null);
      if (!sessionId) return reply(409, { error: "This run has no sessionId yet." });
      if (!TRANSCRIPT_ID.test(sessionId) || !CODING_AGENTS.includes(run.agent as typeof CODING_AGENTS[number])) return reply(404, { error: "no transcript for this run" });
      const page = readTranscript({ agent: run.agent as PeerInfo["agent"], sessionId, cwd: run.workdir ?? "" }, from, undefined, ctx.transcripts);
      return page ? reply(200, page) : reply(404, { error: "no transcript for this run" });
    }
    const runMatch = /^\/api\/runs\/([\w.-]+)$/.exec(url.pathname);
    if (runMatch) {
      const log = (await drainScanResponsive(readRunLogsSteps(ctx.home, new Set([runMatch[1]!]), true))).find((record) => record.name === runMatch[1]);
      if (!log) {
        const recovered = (await listRunsResponsive(ctx.home)).find((run) => run.name === runMatch[1] && run.recovered);
        return recovered ? reply(200, { text: "", next: 0, size: 0, recovered: true, hasLog: false }) : reply(404, { error: "no such run" });
      }
      const rawFrom = url.searchParams.get("from") ?? "0";
      if (!/^\d+$/.test(rawFrom) || !Number.isSafeInteger(Number(rawFrom))) return reply(400, { error: "invalid log cursor" });
      const from = Number(rawFrom);
      const witnessed = lstatSync(log.file);
      const logRoot = isInsideDir(log.file, join(ctx.home, "cold")) ? join(ctx.home, "cold") : join(ctx.home, "runs");
      if (!unchangedContainedFile(logRoot, log.file, witnessed)) return reply(404, { error: "no such run" });
      const size = witnessed.size;
      const fd = openSync(log.file, "r");
      const buf = Buffer.alloc(Math.min(MAX_LOG_CHUNK + 1, Math.max(0, size - from)));
      try {
        if (fileSignature(fstatSync(fd)) !== fileSignature(witnessed)) return reply(404, { error: "run changed before reading" });
        readSync(fd, buf, 0, buf.length, from);
      } finally { closeSync(fd); }
      let end = Math.min(buf.length, MAX_LOG_CHUNK);
      // Never cut a UTF-8 character in half: step back over continuation bytes (10xxxxxx).
      while (end < buf.length && end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
      return reply(200, { text: buf.subarray(0, end).toString("utf8"), next: Math.min(size, from + end), size });
    }
  return reply(404, { error: "not found" });
}

function isInsideDir(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
