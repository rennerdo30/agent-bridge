import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  JOB_OUTCOME_CONTRACT_VERSION,
  deriveJobOutcome,
  listJobOutcomes
} from "./chunk-OE5VOKE2.mjs";
import {
  DEFAULT_RUN_PAGE_SIZE,
  JOB_SETTING_KEYS,
  MAX_RUN_PAGE_SIZE,
  acquireLock,
  pageRuns,
  primaryFor,
  readHistoryJobs,
  readJobsDocument,
  readRunLogs,
  readStore
} from "./chunk-HWDBJOHT.mjs";
import {
  readArchivedJobSnapshot
} from "./chunk-G6MLDC24.mjs";
import {
  listNativeSubagents,
  readTranscript,
  validTranscriptCursor
} from "./chunk-S7VTNSOR.mjs";
import {
  BridgeError,
  CODING_AGENTS
} from "./chunk-SOPZATYP.mjs";
import {
  TRANSCRIPT_ID,
  migrateProjectJobs
} from "./chunk-AT5K4DQH.mjs";
import {
  isPluginCacheCwd
} from "./chunk-2EE2AGA4.mjs";
import {
  external_exports
} from "./chunk-FDMEMG4Z.mjs";
import {
  JSON_STORE_VERSION,
  assertWritableStore,
  isRecord,
  writeJsonStore
} from "./chunk-4BCYRJ3A.mjs";
import {
  JOBS_FILE
} from "./chunk-X27LYYGH.mjs";

// src/core/job-handoff.ts
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
var handoffSchema = external_exports.object({
  to: external_exports.string().min(1).max(64),
  jobs: external_exports.union([external_exports.literal("all"), external_exports.array(external_exports.string().min(1).max(80)).min(1).max(1e3)]).default("all"),
  note: external_exports.string().max(4e3).optional(),
  switch_project_main: external_exports.boolean().optional()
}).strict();
function commitHandoff(path, source, target, input, options = {}) {
  const args = handoffSchema.parse(input);
  if (source.jobAgent) throw new BridgeError("unauthorized", "Only the current supervisor session can hand off its own jobs.");
  if (isPluginCacheCwd(source.cwd) || isPluginCacheCwd(target.cwd) || target.host || target.name.includes("/") || target.jobAgent || !CODING_AGENTS.includes(target.agent)) {
    throw new BridgeError("bad_request", "The target must be an exact live local Claude Code, Codex, opencode or Antigravity session. Paired-PC handoff is not supported.");
  }
  if (target.name === source.name && options.reason !== "group-restored" && !options.canControl) throw new BridgeError("bad_request", "Choose another local supervisor session.");
  const unlock = acquireLock(`${path}.lock`, 0);
  try {
    let previous = null;
    try {
      previous = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const migrated = migrateJobOwnership(previous);
    const activeRecords = migrated.jobs;
    const byId = /* @__PURE__ */ new Map();
    for (const j of [...readArchivedJobSnapshot(path).jobs, ...activeRecords]) {
      if (isRecord(j) && typeof j.id === "string" && typeof j.name === "string") byId.set(j.id, j);
    }
    const records = [...byId.values()];
    const own = records.filter((j) => !j.parentJob && (j.owner === source.name || options.canControl?.(j)));
    const selected = args.jobs === "all" ? own : args.jobs.map((name2) => {
      const job = own.find((j) => j.name === name2);
      if (!job) throw new BridgeError("unauthorized", `Job ${name2} is not controlled by this master (use an exact job name).`);
      return job;
    });
    if (selected.length && selected.every((job) => primaryFor(job) === target.name) && options.reason !== "group-restored") throw new BridgeError("bad_request", "The target is already the primary for these jobs.");
    const moved = new Set(selected.map((j) => j.name));
    for (let changed = true; changed; ) {
      changed = false;
      for (const j of records) if (j.parentJob && moved.has(j.parentJob) && !moved.has(j.name)) {
        moved.add(j.name);
        changed = true;
      }
    }
    const jobs = records.filter((j) => moved.has(j.name));
    if (!jobs.length) throw new BridgeError("bad_request", "This supervisor has no jobs to hand off.");
    if (jobs.some((j) => j.remote || j.args?.host)) throw new BridgeError("bad_request", "Remote jobs (remote-jobs-v1) cannot be handed off yet. Select only local jobs; no jobs were moved.");
    const existing = records.find((j) => j.owner === target.name && !j.parentJob && j.supervisor);
    const rootSession = existing?.supervisor ?? target.sessionId ?? target.id;
    const receipt = {
      id: randomUUID(),
      at: Date.now(),
      from: source.name,
      to: target.name,
      rootSession,
      note: args.note,
      reason: options.reason ?? "explicit-handoff",
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        title: String(j.args?.title ?? "Untitled job"),
        status: j.status,
        from: j.owner ?? source.name,
        to: j.parentJob ?? target.name,
        oldRoot: j.rootName
      }))
    };
    const updates = new Map(jobs.map((j) => {
      const history = j.ownershipHistory;
      const change = {
        id: receipt.id,
        at: receipt.at,
        from: j.owner ?? source.name,
        to: j.parentJob ?? target.name,
        fromRoot: j.rootSession,
        fromRootName: j.rootName,
        rootSession,
        rootName: target.name,
        note: args.note,
        reason: receipt.reason
      };
      const sendTo = j.args?.send_to;
      return [j.id, {
        ...j,
        owner: change.to,
        supervisor: rootSession,
        rootSession,
        rootName: target.name,
        masters: [.../* @__PURE__ */ new Set([target.name, source.name, ...Array.isArray(j.masters) ? j.masters : []])],
        ...j.status === "running" && !j.host ? { executionOwner: j.executionOwner ?? j.owner } : {},
        args: { ...j.args, ...Array.isArray(sendTo) ? { send_to: [...new Set(sendTo.map((name2) => name2 === source.name ? target.name : name2))] } : {} },
        ownershipHistory: [...Array.isArray(history) ? history : [], change]
      }];
    }));
    const active = activeRecords;
    const ids = new Set(active.filter(isRecord).map((j) => j.id));
    const all = active.map((j) => isRecord(j) ? updates.get(String(j.id)) ?? j : j);
    for (const [id, job] of updates) if (!ids.has(id)) all.push(job);
    const journal = isRecord(previous) && Array.isArray(previous.handoffs) ? previous.handoffs : [];
    writeJsonStore(path, { ...migrated, jobs: all, handoffs: [...journal, receipt] }, previous);
    return receipt;
  } finally {
    unlock();
  }
}
function handoffJournal(path) {
  const value = readJobsDocument(path);
  return isRecord(value) && Array.isArray(value.handoffs) ? value.handoffs : [];
}
function migrateJobOwnership(previous) {
  assertWritableStore(previous);
  if (previous !== null && !Array.isArray(previous) && (!isRecord(previous) || !Array.isArray(previous.jobs))) throw new Error("Invalid job registry; migration left it untouched.");
  const jobs = Array.isArray(previous) ? previous : isRecord(previous) ? previous.jobs : [];
  if (isRecord(previous) && previous.handoffs !== void 0 && !Array.isArray(previous.handoffs)) throw new Error("Invalid handoff history; migration left it untouched.");
  return { ...isRecord(previous) ? previous : {}, version: JSON_STORE_VERSION, jobs: migrateProjectJobs(jobs), handoffs: isRecord(previous) ? previous.handoffs ?? [] : [] };
}

// src/network/dashboard-protocol.ts
var DASHBOARD_CAPABILITY = "dashboard-read-v1";
var DASHBOARD_FRAME = "dashboard-read";
var DASHBOARD_TIMEOUT_MS = 1e4;
var DASHBOARD_RATE_LIMIT = 120;
var DASHBOARD_RATE_WINDOW_MS = 6e4;
var DASHBOARD_MAX_PENDING = 32;
var DASHBOARD_MAX_RESPONSE_BYTES = 15e5;
var name = /^[\w.-]{1,256}$/;
function isDashboardReadPath(path) {
  if (path === "/api/state" || path === "/api/runs" || path === "/api/job-outcomes") return true;
  const match = /^\/api\/(runs|sessions|jobs)\/([^/]+)(.*)$/.exec(path);
  if (!match) return false;
  let target;
  try {
    target = decodeURIComponent(match[2]);
  } catch {
    return false;
  }
  if (!name.test(target) || target === "." || target === "..") return false;
  const suffix = match[3];
  if (match[1] === "runs") return suffix === "" || suffix === "/chat";
  if (match[1] === "sessions" && suffix === "/chat") return true;
  if (suffix === "/subagents") return true;
  const child = /^\/subagents\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(suffix);
  return !!child;
}
var dashboardRequestSchema = external_exports.object({
  path: external_exports.string().max(600).refine(isDashboardReadPath),
  query: external_exports.object({ from: external_exports.string().max(256).optional(), before: external_exports.string().max(512).optional(), limit: external_exports.string().max(3).optional() }).strict().optional()
}).strict();
var dashboardWireSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("request"), rid: external_exports.uuid(), request: dashboardRequestSchema }).strict(),
  external_exports.object({ kind: external_exports.literal("response"), rid: external_exports.uuid(), result: external_exports.object({ status: external_exports.number().int().min(200).max(599), body: external_exports.unknown() }).strict() }).strict()
]);

// src/core/dashboard-read.ts
import { closeSync, openSync, readFileSync as readFileSync2, readSync, statSync } from "node:fs";
import { join } from "node:path";
var TASK_PREVIEW_CHARS = 300;
var STALE_RUN_MS = 15e4;
var LEGACY_JOB_START_TOLERANCE_MS = 1e3;
var MAX_LOG_CHUNK = 128 * 1024;
async function finishedRunOutcomes(home, log, names) {
  const runs = listRuns(home);
  const jobs = readStore(join(home, JOBS_FILE), log, true);
  const out = {};
  for (const run of runs) {
    if (names && !names.has(run.name)) continue;
    if (!run.job || run.status !== "done" && run.status !== "failed") continue;
    const stored = jobs.find((j) => j.name === run.job);
    const startedAt = run.jobStartedAt ?? run.startedAt;
    const latest = stored && (run.jobStartedAt !== void 0 ? stored.startedAt === startedAt : Math.abs(stored.startedAt - startedAt) < LEGACY_JOB_START_TOLERANCE_MS);
    const job = {
      id: stored?.id ?? run.job.replace(/^.*-(?:job|ask)-/, ""),
      name: run.job,
      owner: latest ? stored.owner : run.by,
      startedAt: run.jobStartedAt ?? (latest ? stored.startedAt : run.startedAt),
      status: run.status,
      worktree: stored?.worktree,
      remote: run.remote ?? stored?.remote
    };
    const next = runs.filter((r) => r.job === run.job && (r.jobStartedAt ?? r.startedAt) > startedAt).sort((a, b) => (a.jobStartedAt ?? a.startedAt) - (b.jobStartedAt ?? b.startedAt))[0];
    out[run.name] = await deriveJobOutcome(home, job, log, {
      branch: run.branch,
      baseBranch: run.baseBranch,
      repoRoot: run.repoRoot,
      branchHead: run.branchHead,
      before: next?.jobStartedAt ?? next?.startedAt
    });
  }
  return out;
}
function summarizeRun(file, text, mtimeMs, now, meta = {}) {
  const lines = text.split("\n").filter(Boolean);
  const finished = [...lines].reverse().find((l) => / finished after \d+s · /.test(l));
  const last = (finished ?? lines.at(-1) ?? "").replace(/^\d\d:\d\d:\d\d /, "");
  const status = finished ? / · done$/.test(finished) ? "done" : "failed" : now - mtimeMs > STALE_RUN_MS ? "interrupted" : "running";
  const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-([a-z]+)-/.exec(file);
  const startedAt = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Math.floor(mtimeMs);
  const header = (lines[0] ?? "").replace(/^\d\d:\d\d:\d\d /, "");
  const end = lines.findIndex((l) => l.trim() === "---");
  const task = lines.slice(1, end > 0 ? end : 1).map((l) => l.trim()).join(" ").slice(0, TASK_PREVIEW_CHARS);
  return {
    by: / by ([\w.-]+)/.exec(header)?.[1],
    workdir: / in (.+?), access /.exec(header)?.[1],
    continues: /, continues (\S+)/.exec(header)?.[1] ?? null,
    ...meta,
    ...status !== "running" ? { etaAt: void 0, etaReportedAt: void 0 } : {},
    name: file.replace(/\.log$/, ""),
    agent: m?.[7] ?? "agent",
    header,
    startedAt,
    updatedAt: mtimeMs,
    status,
    last,
    task
  };
}
function listRuns(home, now = Date.now()) {
  const runs = [];
  for (const log of readRunLogs(home)) {
    try {
      const signature = `${log.signature}:${JSON.stringify(log.meta)}`;
      let cached = runSummaries.get(log.file);
      if (cached?.signature !== signature) {
        cached = { signature, summary: summarizeRun(`${log.name}.log`, readFileSync2(log.file, "utf8"), log.updatedAt, log.updatedAt, log.meta) };
        runSummaries.delete(log.file);
        runSummaries.set(log.file, cached);
        if (runSummaries.size > 2048) runSummaries.delete(runSummaries.keys().next().value);
      }
      const stale = cached.summary.status === "running" && now - log.updatedAt > STALE_RUN_MS;
      runs.push({ ...structuredClone(cached.summary), ...stale ? { status: "interrupted", etaAt: void 0, etaReportedAt: void 0 } : {}, archived: log.archived, recovered: false, hasLog: true });
    } catch {
    }
  }
  const representedJobs = new Set(runs.map((run) => run.job));
  const representedSuffixes = /* @__PURE__ */ new Set();
  for (const run of runs) for (let at = run.name.indexOf("-"); at >= 0; at = run.name.indexOf("-", at + 1)) representedSuffixes.add(run.name.slice(at));
  for (const [name2, job] of readHistoryJobs(home)) {
    if (representedJobs.has(name2) || typeof job.id === "string" && representedSuffixes.has(`-${job.agent}-${job.id}`)) continue;
    const args = isRecord(job.args) ? job.args : {};
    const worktree = isRecord(job.worktree) ? job.worktree : null;
    const prompt = typeof job.prompt === "string" ? job.prompt : "";
    const owner = typeof job.owner === "string" ? job.owner : null;
    const sessionId = typeof job.sessionId === "string" ? job.sessionId : typeof job.threadId === "string" ? job.threadId : null;
    const startedAt = typeof job.startedAt === "number" && Number.isSafeInteger(job.startedAt) && job.startedAt >= 0 ? job.startedAt : 0;
    const finishedAt = typeof job.finishedAt === "number" && Number.isSafeInteger(job.finishedAt) ? job.finishedAt : void 0;
    runs.push({
      name: name2,
      job: name2,
      agent: typeof job.agent === "string" ? job.agent : "agent",
      model: typeof job.model === "string" ? job.model : null,
      title: typeof args.title === "string" ? args.title : typeof job.title === "string" ? job.title : void 0,
      by: owner ?? void 0,
      owner,
      session: sessionId,
      sessionId,
      prompt,
      task: prompt.slice(0, TASK_PREVIEW_CHARS),
      workdir: typeof job.workdir === "string" ? job.workdir : worktree?.cwd ?? (typeof args.cwd === "string" ? args.cwd : void 0),
      worktree,
      branch: worktree?.branch ?? (typeof job.branch === "string" ? job.branch : void 0),
      parentJob: typeof job.parentJob === "string" ? job.parentJob : void 0,
      rootSession: typeof job.rootSession === "string" ? job.rootSession : void 0,
      startedAt,
      finishedAt,
      updatedAt: finishedAt ?? startedAt,
      // A historical snapshot does not prove that an old process is still running.
      status: job.status === "done" || job.status === "failed" ? job.status : "interrupted",
      header: `Recovered ${name2}`,
      last: "Run log unavailable; conversation may be available in the CLI transcript.",
      recovered: true,
      hasLog: false
    });
  }
  const current = readHistoryJobs(home);
  for (const run of runs) {
    const job = run.job && current.get(run.job);
    if (job && Array.isArray(job.ownershipHistory) && job.ownershipHistory.length) {
      run.owner = typeof job.owner === "string" ? job.owner : run.owner;
      run.rootName = typeof job.rootName === "string" ? job.rootName : void 0;
      run.rootSession = typeof job.rootSession === "string" ? job.rootSession : void 0;
      run.parentJob = typeof job.parentJob === "string" ? job.parentJob : void 0;
    }
  }
  return pageRuns(runs, null, runs.length).runs;
}
var runSummaries = /* @__PURE__ */ new Map();
function readStoredJobs(home) {
  const out = /* @__PURE__ */ new Map();
  for (const j of readHistoryJobs(home).values()) {
    if (!j || typeof j !== "object") continue;
    const { name: name2, owner, args, remote } = j;
    if (typeof name2 !== "string") continue;
    const saved = args && typeof args === "object" ? args : {};
    out.set(name2, {
      owner: typeof owner === "string" && owner ? owner : null,
      ...typeof j.projectRoot === "string" ? { projectRoot: j.projectRoot } : {},
      next: Object.fromEntries(JOB_SETTING_KEYS.filter((key) => saved[key] !== void 0).map((key) => [key, saved[key]])),
      ...remote && typeof remote.host === "string" && typeof remote.name === "string" ? { remote } : {}
    });
  }
  return out;
}
function classifyPeers(peers, runs, home) {
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const worktrees = `${norm(join(home, "worktrees"))}/`;
  const byWorkdir = /* @__PURE__ */ new Map();
  for (const run of runs) if (run.workdir && !byWorkdir.has(norm(run.workdir))) byWorkdir.set(norm(run.workdir), run);
  return peers.filter((p) => !isPluginCacheCwd(p.cwd)).map((p) => {
    const cwd = norm(p.cwd ?? "");
    const subagent = cwd.startsWith(worktrees);
    const run = subagent ? byWorkdir.get(cwd) : void 0;
    return { ...p, subagent: Boolean(p.jobAgent || p.subagent || subagent), parent: p.parentJob ?? p.jobParent ?? p.rootName ?? run?.by ?? null };
  });
}
var reply = (status, body) => ({ status, body });
async function readDashboard(ctx, request) {
  if (!dashboardRequestSchema.safeParse(request).success) return reply(400, { error: "invalid dashboard read request" });
  const url = new URL(request.path, "http://localhost");
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
  if (url.pathname === "/api/state") {
    const page = pageRuns(listRuns(ctx.home), null, DEFAULT_RUN_PAGE_SIZE);
    const names = new Set(page.runs.map((run) => run.job));
    const jobs = Object.fromEntries([...readStoredJobs(ctx.home)].filter(([name2]) => names.has(name2)).map(([name2, job]) => [name2, { next: job.next, ...job.remote ? { remote: job.remote } : {} }]));
    return reply(200, { runs: page.runs, runsNext: page.next, runsTotal: page.total, jobs });
  }
  if (url.pathname === "/api/job-outcomes") {
    const rawLimit = url.searchParams.get("limit") ?? String(DEFAULT_RUN_PAGE_SIZE);
    const limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RUN_PAGE_SIZE) return reply(400, { error: "invalid outcome page limit" });
    const before = url.searchParams.get("before");
    if (before !== null && !/^[\w.-]{1,256}$/.test(before)) return reply(400, { error: "invalid outcome cursor" });
    const select = (names2) => [...new Set(names2)].sort().filter((name2) => before === null || name2 > before).slice(0, limit);
    const stored = readStore(join(ctx.home, JOBS_FILE), ctx.log, true).filter((j) => j.status === "done" || j.status === "failed");
    const runs = listRuns(ctx.home).filter((r) => r.job && (r.status === "done" || r.status === "failed"));
    const names = select([...stored.map((j) => j.name), ...runs.map((r) => r.name)]);
    const next = [...stored.map((j) => j.name), ...runs.map((r) => r.name)].some((name2) => names.length > 0 && name2 > names.at(-1)) ? names.at(-1) : null;
    const jobs = await listJobOutcomes(ctx.home, ctx.log, new Set(names));
    const groups = { needsReview: [], held: [], merged: [], discarded: [] };
    for (const [name2, job] of Object.entries(jobs)) {
      const state = job.outcome.merge.state;
      groups[state === "unmerged" ? "needsReview" : state].push(name2);
    }
    return reply(200, { contractVersion: JOB_OUTCOME_CONTRACT_VERSION, jobs, runs: await finishedRunOutcomes(ctx.home, ctx.log, new Set(names)), groups, next });
  }
  const sessionMatch = /^\/api\/sessions\/([^/]+)\/(chat|subagents)(?:\/([^/]+))?$/.exec(url.pathname);
  if (sessionMatch) {
    let name2, child;
    try {
      name2 = decodeURIComponent(sessionMatch[1]);
      child = sessionMatch[3] === void 0 ? void 0 : decodeURIComponent(sessionMatch[3]);
    } catch {
      return reply(404, { error: "no such local session" });
    }
    if (name2.includes("/") || name2.includes("\\") || child !== void 0 && !TRANSCRIPT_ID.test(child) || sessionMatch[2] === "chat" && child !== void 0) return reply(404, { error: "no such local session or subagent" });
    const peers = await ctx.peers();
    const peer = peers.find((p) => p.name === name2 && !p.name.includes("/") && !isPluginCacheCwd(p.cwd));
    if (!peer) return reply(404, { error: "no such local session" });
    if (!peer.sessionId) return reply(409, { error: "This session has no sessionId yet." });
    if (!TRANSCRIPT_ID.test(peer.sessionId) || !CODING_AGENTS.includes(peer.agent)) return reply(404, { error: "no transcript for this session" });
    if (sessionMatch[2] === "subagents" && child === void 0) return reply(200, { subagents: listNativeSubagents(peer, ctx.transcripts) });
    const from = url.searchParams.get("from") ?? "0";
    if (!validTranscriptCursor(from)) return reply(400, { error: "invalid transcript cursor" });
    const page = readTranscript(peer, from, child, ctx.transcripts);
    return page ? reply(200, page) : reply(404, { error: "no transcript for this session or subagent" });
  }
  if (url.pathname === "/api/runs") {
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? DEFAULT_RUN_PAGE_SIZE : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RUN_PAGE_SIZE) return reply(400, { error: `limit must be an integer from 1 to ${MAX_RUN_PAGE_SIZE}` });
    try {
      return reply(200, pageRuns(listRuns(ctx.home), url.searchParams.get("before"), limit));
    } catch {
      return reply(400, { error: "invalid run cursor" });
    }
  }
  const jobChildrenMatch = /^\/api\/jobs\/([\w.-]+)\/subagents(?:\/([^/]+))?$/.exec(url.pathname);
  if (jobChildrenMatch) {
    const name2 = jobChildrenMatch[1];
    let child;
    try {
      child = jobChildrenMatch[2] === void 0 ? void 0 : decodeURIComponent(jobChildrenMatch[2]);
    } catch {
      return reply(404, { error: "no such job or subagent" });
    }
    if (child !== void 0 && !TRANSCRIPT_ID.test(child)) return reply(404, { error: "no such job or subagent" });
    const job = readHistoryJobs(ctx.home).get(name2);
    const run = listRuns(ctx.home).find((r) => r.job === name2);
    if (!job && !run) return reply(404, { error: "no such job" });
    const agent = typeof job?.agent === "string" ? job.agent : run?.agent;
    const sessionId = typeof job?.sessionId === "string" ? job.sessionId : typeof job?.threadId === "string" ? job.threadId : run?.sessionId ?? run?.session;
    if (!sessionId) return reply(409, { error: "This job has no sessionId yet." });
    if (!TRANSCRIPT_ID.test(sessionId) || !CODING_AGENTS.includes(agent)) return reply(404, { error: "no transcript for this job" });
    const session = { agent, sessionId, cwd: typeof job?.workdir === "string" ? job.workdir : run?.workdir ?? "" };
    if (child === void 0) return reply(200, { subagents: listNativeSubagents(session, ctx.transcripts) });
    const from = url.searchParams.get("from") ?? "0";
    if (!validTranscriptCursor(from)) return reply(400, { error: "invalid transcript cursor" });
    const page = readTranscript(session, from, child, ctx.transcripts);
    return page ? reply(200, page) : reply(404, { error: "no transcript for this job or subagent" });
  }
  const runChatMatch = /^\/api\/runs\/([\w.-]+)\/chat$/.exec(url.pathname);
  if (runChatMatch) {
    const from = url.searchParams.get("from") ?? "0";
    if (!validTranscriptCursor(from)) return reply(400, { error: "invalid transcript cursor" });
    const run = listRuns(ctx.home).find((r) => r.name === runChatMatch[1] || r.job === runChatMatch[1]);
    if (!run) return reply(404, { error: "no such run" });
    const job = run.job ? readHistoryJobs(ctx.home).get(run.job) : void 0;
    const sessionId = run.sessionId ?? run.session ?? (typeof job?.sessionId === "string" ? job.sessionId : typeof job?.threadId === "string" ? job.threadId : null);
    if (!sessionId) return reply(409, { error: "This run has no sessionId yet." });
    if (!TRANSCRIPT_ID.test(sessionId) || !CODING_AGENTS.includes(run.agent)) return reply(404, { error: "no transcript for this run" });
    const page = readTranscript({ agent: run.agent, sessionId, cwd: run.workdir ?? "" }, from, void 0, ctx.transcripts);
    return page ? reply(200, page) : reply(404, { error: "no transcript for this run" });
  }
  const runMatch = /^\/api\/runs\/([\w.-]+)$/.exec(url.pathname);
  if (runMatch) {
    const log = readRunLogs(ctx.home).find((record) => record.name === runMatch[1]);
    if (!log) {
      const recovered = listRuns(ctx.home).find((run) => run.name === runMatch[1] && run.recovered);
      return recovered ? reply(200, { text: "", next: 0, size: 0, recovered: true, hasLog: false }) : reply(404, { error: "no such run" });
    }
    const rawFrom = url.searchParams.get("from") ?? "0";
    if (!/^\d+$/.test(rawFrom) || !Number.isSafeInteger(Number(rawFrom))) return reply(400, { error: "invalid log cursor" });
    const from = Number(rawFrom);
    const size = statSync(log.file).size;
    const fd = openSync(log.file, "r");
    const buf = Buffer.alloc(Math.min(MAX_LOG_CHUNK + 1, Math.max(0, size - from)));
    try {
      readSync(fd, buf, 0, buf.length, from);
    } finally {
      closeSync(fd);
    }
    let end = Math.min(buf.length, MAX_LOG_CHUNK);
    while (end < buf.length && end > 0 && (buf[end] & 192) === 128) end--;
    return reply(200, { text: buf.subarray(0, end).toString("utf8"), next: Math.min(size, from + end), size });
  }
  return reply(404, { error: "not found" });
}

// src/network/remote-dashboard.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var dashboardError = (code, error, status = 503) => ({ status, body: { code, error } });
var RemoteDashboard = class {
  constructor(network, context) {
    this.network = network;
    this.context = context;
    network.registerExtension(DASHBOARD_FRAME, DASHBOARD_CAPABILITY, (payload, pair) => this.receive(payload, pair));
  }
  network;
  context;
  pending = /* @__PURE__ */ new Map();
  rates = /* @__PURE__ */ new Map();
  closed = false;
  async request(host, raw) {
    const parsed = dashboardRequestSchema.safeParse(raw);
    if (!parsed.success) return dashboardError("bad_request", "Invalid dashboard read request.", 400);
    const pair = this.network.status().paired.find((p) => p.id === host || p.name === host);
    if (this.closed || !pair?.connected) return dashboardError("remote_offline", "The paired PC is not connected.");
    if (!this.network.peerSupports(host, DASHBOARD_CAPABILITY)) return dashboardError("remote_update_needed", "Update and restart the paired PC's hosting sessions to read its dashboard.", 409);
    if (this.pending.size >= DASHBOARD_MAX_PENDING) return dashboardError("remote_busy", "Too many pending dashboard reads.", 429);
    const rid = randomUUID2();
    const response = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        resolve(dashboardError("remote_timeout", "The paired dashboard read timed out.", 504));
      }, DASHBOARD_TIMEOUT_MS);
      this.pending.set(rid, { host: pair.id, resolve, timer });
    });
    try {
      await this.network.sendExtension(host, DASHBOARD_FRAME, { kind: "request", rid, request: parsed.data });
    } catch {
      this.finish(rid, dashboardError("remote_offline", "The paired PC disconnected."));
    }
    return response;
  }
  finish(rid, result) {
    const pending = this.pending.get(rid);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(rid);
    pending.resolve(result);
  }
  async receive(payload, pair) {
    const parsed = dashboardWireSchema.safeParse(payload);
    if (!parsed.success) {
      if (payload.kind === "request" && external_exports.uuid().safeParse(payload.rid).success) {
        try {
          await this.network.sendExtension(pair.id, DASHBOARD_FRAME, { kind: "response", rid: payload.rid, result: dashboardError("bad_request", "Invalid dashboard read request.", 400) });
        } catch {
        }
      }
      return;
    }
    const frame = parsed.data;
    if (frame.kind === "response") {
      if (this.pending.get(frame.rid)?.host === pair.id) this.finish(frame.rid, frame.result);
      return;
    }
    const now = Date.now();
    let rate = this.rates.get(pair.id);
    if (!rate || now - rate.at >= DASHBOARD_RATE_WINDOW_MS) {
      rate = { at: now, count: 0 };
      this.rates.set(pair.id, rate);
    }
    let result;
    if (++rate.count > DASHBOARD_RATE_LIMIT) result = dashboardError("remote_rate_limited", "Dashboard read rate limit reached.", 429);
    else {
      try {
        result = await readDashboard(this.context, frame.request);
      } catch {
        result = dashboardError("remote_read_failed", "The paired dashboard could not read this record.", 500);
      }
    }
    if (Buffer.byteLength(JSON.stringify(result)) > DASHBOARD_MAX_RESPONSE_BYTES) result = dashboardError("remote_response_too_large", "This dashboard page is too large; request a smaller page.", 413);
    try {
      await this.network.sendExtension(pair.id, DASHBOARD_FRAME, { kind: "response", rid: frame.rid, result });
    } catch {
    }
  }
  close() {
    this.closed = true;
    for (const rid of this.pending.keys()) this.finish(rid, dashboardError("remote_offline", "Networking stopped."));
    this.rates.clear();
  }
};

export {
  handoffSchema,
  commitHandoff,
  handoffJournal,
  DASHBOARD_TIMEOUT_MS,
  isDashboardReadPath,
  dashboardRequestSchema,
  finishedRunOutcomes,
  summarizeRun,
  listRuns,
  readStoredJobs,
  classifyPeers,
  readDashboard,
  dashboardError,
  RemoteDashboard
};
