import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  listNativeSubagents,
  readTranscript,
  validTranscriptCursor
} from "./chunk-AJ3G2ZXC.mjs";
import {
  cachedOutcomes
} from "./chunk-HZAGME3J.mjs";
import {
  JOB_OUTCOME_CONTRACT_VERSION
} from "./chunk-VEVZLUIE.mjs";
import {
  worktreeRoots
} from "./chunk-L4FJJHBQ.mjs";
import {
  JOB_SETTING_KEYS
} from "./chunk-6YY4CXED.mjs";
import {
  readArchivedJobSteps
} from "./chunk-HJNZCLEX.mjs";
import {
  MAX_NETWORK_HOST_CHARS,
  MAX_NETWORK_LINKS,
  MAX_PAIRING_CODE_CHARS,
  MAX_PORT,
  NETWORK_NAME_PATTERN,
  NETWORK_VERSION,
  OWNER_DIR_MODE,
  OWNER_FILE_MODE,
  PAIRING_KEY_BYTES,
  PAIRING_TTL_MS
} from "./chunk-GLDOOU7N.mjs";
import {
  CODING_AGENTS
} from "./chunk-4QXHCXBU.mjs";
import {
  external_exports,
  isPluginCacheCwd
} from "./chunk-EA6YAI7Y.mjs";
import {
  DEFAULT_RUN_PAGE_SIZE,
  MAX_RUN_PAGE_SIZE,
  historyJobsSteps,
  pageRuns,
  readRunLogsSteps,
  readRunnerStateRecord,
  selectHistoryJobsResponsive,
  unchangedContainedFile
} from "./chunk-2EM5QMTJ.mjs";
import {
  finishedRunLine,
  readRunLogPreview
} from "./chunk-I6JYRIAB.mjs";
import {
  TRANSCRIPT_ID
} from "./chunk-WM3QOXKL.mjs";
import {
  cloneJson,
  drainScan,
  drainScanResponsive,
  fileSignature,
  indexedJobProjectionCurrent,
  isRecord,
  readJsonSnapshot
} from "./chunk-BQ7FXNML.mjs";
import {
  JOBS_FILE
} from "./chunk-EZXQJRQM.mjs";

// src/network/pairing.ts
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var DEFAULT_SYSTEM_ROOT = "C:\\Windows";
var SYSTEM32 = join(process.env.SystemRoot || DEFAULT_SYSTEM_ROOT, "System32");
var WHOAMI = join(SYSTEM32, "whoami.exe");
var ICACLS = join(SYSTEM32, "icacls.exe");
var keySchema = external_exports.string().regex(/^[0-9a-f]{64}$/);
var identitySchema = external_exports.object({ id: external_exports.uuid(), key: keySchema });
var publicIdentitySchema = external_exports.object({ id: external_exports.uuid(), name: external_exports.string().regex(NETWORK_NAME_PATTERN), fingerprint: keySchema });
var invitationSchema = external_exports.object({ key: keySchema, expiresAt: external_exports.number().int() });
var pairSchema = publicIdentitySchema.extend({ key: keySchema, host: external_exports.string().min(1).max(MAX_NETWORK_HOST_CHARS).optional(), port: external_exports.number().int().min(1).max(MAX_PORT).optional() });
var stateSchema = external_exports.object({ identity: identitySchema, invitations: external_exports.array(invitationSchema).max(MAX_NETWORK_LINKS), pairs: external_exports.array(pairSchema).max(MAX_NETWORK_LINKS) });
var codeSchema = publicIdentitySchema.extend({ v: external_exports.literal(NETWORK_VERSION), key: keySchema });
function keyFingerprint(key) {
  return createHash("sha256").update(Buffer.from(key, "hex")).digest("hex");
}
var ACL_PRINCIPAL = /([^\s:][^:]*?):\(/;
function protect(path, mode, ownNewPath = false) {
  if (process.platform !== "win32") return chmodSync(path, mode);
  const [account, sid] = (execFileSync(WHOAMI, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).match(/"([^"]+)","(S-\d+(?:-\d+)+)"/) ?? []).slice(1);
  if (!sid || !account) throw new Error("cannot identify the account for network key permissions");
  const grant = mode === OWNER_DIR_MODE ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  execFileSync(ICACLS, [path, "/inheritance:r", "/grant:r", grant, "/Q"], { windowsHide: true, stdio: "pipe" });
  if (ownNewPath) execFileSync(ICACLS, [path, "/setowner", `*${sid}`, "/Q"], { windowsHide: true, stdio: "pipe" });
  const others = execFileSync(ICACLS, [path], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).map((line) => (line.startsWith(path) ? line.slice(path.length) : line).trim()).map((line) => ACL_PRINCIPAL.exec(line)?.[1]).filter((p) => Boolean(p) && p.toLowerCase() !== account.toLowerCase());
  for (const principal of new Set(others)) execFileSync(ICACLS, [path, "/remove:g", principal, "/Q"], { windowsHide: true, stdio: "pipe" });
  const acl = execFileSync(ICACLS, [path], { encoding: "utf8", windowsHide: true });
  if ((acl.match(/:\(/g) ?? []).length !== 1 || acl.includes("(I)")) throw new Error("network key location has additional ACL grants; restrict it to the current account");
}
function decodePairingCode(code) {
  if (code.length > MAX_PAIRING_CODE_CHARS || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("invalid pairing code");
  return codeSchema.parse(JSON.parse(Buffer.from(code, "base64url").toString("utf8")));
}
var PairingStore = class {
  constructor(home, name2, now = Date.now) {
    this.name = name2;
    this.now = now;
    if (!NETWORK_NAME_PATTERN.test(name2)) throw new Error("invalid network instance name");
    this.dir = join(home, "network");
    this.file = join(this.dir, "keys.json");
    mkdirSync(this.dir, { recursive: true, mode: OWNER_DIR_MODE });
    protect(this.dir, OWNER_DIR_MODE);
    if (existsSync(this.file)) {
      protect(this.file, OWNER_FILE_MODE);
      this.state = stateSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } else {
      this.state = { identity: { id: randomUUID(), key: randomBytes(PAIRING_KEY_BYTES).toString("hex") }, invitations: [], pairs: [] };
      this.save();
    }
  }
  name;
  now;
  dir;
  file;
  state;
  get identity() {
    return { id: this.state.identity.id, name: this.name, fingerprint: keyFingerprint(this.state.identity.key) };
  }
  pairs() {
    return this.state.pairs.map((p) => ({ ...p }));
  }
  invite() {
    return this.inviteWithExpiry().code;
  }
  inviteWithExpiry() {
    this.state.invitations = this.state.invitations.filter((p) => p.expiresAt > this.now());
    if (this.state.invitations.length + this.state.pairs.length >= MAX_NETWORK_LINKS) throw new Error("network pairing limit reached");
    const key = randomBytes(PAIRING_KEY_BYTES).toString("hex");
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.state.invitations.push({ key, expiresAt });
    this.save();
    return { code: Buffer.from(JSON.stringify({ v: NETWORK_VERSION, ...this.identity, key })).toString("base64url"), expiresAt };
  }
  keyFor(identity) {
    return this.state.pairs.find((p) => keyFingerprint(p.key) === identity)?.key ?? this.state.invitations.find((p) => p.expiresAt > this.now() && keyFingerprint(p.key) === identity)?.key;
  }
  accept(key, remote) {
    if (remote.id === this.identity.id || remote.name === this.name) throw new Error("network instance ids and names must differ");
    const known = this.state.pairs.find((p) => p.key === key);
    if (known) {
      if (known.id !== remote.id || known.name !== remote.name || known.fingerprint !== remote.fingerprint) throw new Error("paired identity changed");
      return known;
    }
    const invitation = this.state.invitations.find((p) => p.key === key && p.expiresAt > this.now());
    if (!invitation) throw new Error("pairing code expired or revoked");
    this.checkNew(remote);
    const pair = { ...remote, key };
    this.state.pairs.push(pair);
    this.state.invitations = this.state.invitations.filter((p) => p !== invitation);
    this.save();
    return pair;
  }
  remember(code, host, port) {
    const parsed = this.validatePair(code, host, port);
    this.state.pairs = this.state.pairs.filter((p) => p.id !== parsed.id);
    this.state.pairs.push(parsed);
    this.save();
    return parsed;
  }
  validatePair(code, host, port) {
    const parsed = pairSchema.parse({ id: code.id, name: code.name, fingerprint: code.fingerprint, key: code.key, host, port });
    const old = this.state.pairs.find((p) => p.id === code.id);
    if (old && (old.key !== code.key || old.fingerprint !== code.fingerprint || old.name !== code.name)) throw new Error("unlink the existing peer before pairing again");
    if (!old) this.checkNew(parsed);
    return parsed;
  }
  checkNew(remote) {
    if (remote.id === this.identity.id || remote.name === this.name) throw new Error("cannot pair with this instance");
    if (this.state.pairs.length >= MAX_NETWORK_LINKS) throw new Error("network pairing limit reached");
    if (this.state.pairs.some((p) => p.id === remote.id || p.name === remote.name)) throw new Error("instance already paired; unlink it first");
  }
  remove(id) {
    this.state.pairs = this.state.pairs.filter((p) => p.id !== id);
    this.save();
  }
  save() {
    const temp = join(this.dir, `${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify(this.state, null, 2) + "\n", { mode: OWNER_FILE_MODE, flag: "wx" });
    protect(temp, OWNER_FILE_MODE);
    renameSync(temp, this.file);
  }
};

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
  query: external_exports.object({ job: external_exports.string().max(256).optional(), run: external_exports.string().max(256).optional(), from: external_exports.string().max(256).optional(), before: external_exports.string().max(512).optional(), limit: external_exports.string().max(3).optional() }).strict().optional()
}).strict();
var dashboardWireSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("request"), rid: external_exports.uuid(), request: dashboardRequestSchema }).strict(),
  external_exports.object({ kind: external_exports.literal("response"), rid: external_exports.uuid(), result: external_exports.object({ status: external_exports.number().int().min(200).max(599), body: external_exports.unknown() }).strict() }).strict()
]);

// src/core/dashboard-read.ts
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join as join2, relative } from "node:path";
var TASK_PREVIEW_CHARS = 300;
var STALE_RUN_MS = 15e4;
var LEGACY_JOB_START_TOLERANCE_MS = 1e3;
var MAX_LOG_CHUNK = 128 * 1024;
async function finishedRunOutcomes(home, log, names) {
  const runs = await listRunsResponsive(home, Date.now(), names);
  const jobs = await readOutcomeJobs(home, log, new Set(runs.flatMap((run) => run.job ? [run.job] : [])));
  const inputs = [];
  for (const run of runs) {
    if (names && !names.has(run.name)) continue;
    if (!run.job || !["done", "failed", "cancelled"].includes(run.status)) continue;
    const stored = jobs.find((j2) => j2.name === run.job);
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
    inputs.push({ key: run.name, kind: "run", job, opts: {
      branch: run.branch,
      baseBranch: run.baseBranch,
      repoRoot: run.repoRoot,
      branchHead: run.branchHead
    } });
  }
  return cachedOutcomes(home, inputs, log);
}
async function dashboardJobOutcomes(home, log, names) {
  const jobs = (await readOutcomeJobs(home, log, names)).filter((job) => ["done", "failed", "cancelled"].includes(job.status));
  const outcomes = await cachedOutcomes(home, jobs.map((job) => ({ key: job.name, kind: "job", opts: {}, job: {
    id: job.id,
    name: job.name,
    owner: job.owner,
    startedAt: job.startedAt,
    status: job.status,
    worktree: job.worktree,
    remote: job.remote
  } })), log);
  return Object.fromEntries(jobs.map((job) => [job.name, { startedAt: job.startedAt, status: job.status, outcome: outcomes[job.name] }]));
}
async function readOutcomeJobs(home, log, names) {
  const path = join2(home, JOBS_FILE);
  try {
    return await drainScanResponsive((function* () {
      const all = /* @__PURE__ */ new Map();
      const canonicalHome = realpathSync.native(home), activePath = join2(canonicalHome, JOBS_FILE);
      let data = null, activeStat;
      try {
        if (!indexedJobProjectionCurrent(activePath)) activeStat = lstatSync(activePath, { bigint: true });
        if (activeStat) {
          if (!unchangedContainedFile(canonicalHome, activePath, activeStat, canonicalHome)) throw new Error("outcome job store must be a contained physical file");
          data = readJsonSnapshot(activePath, { file: activePath, stat: activeStat }).value;
        }
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      const active = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : [];
      for (const job of [...(yield* readArchivedJobSteps(activePath, true, { metadata: true, names })).jobs, ...active]) {
        yield;
        if (isRecord(job) && typeof job.id === "string" && typeof job.name === "string") all.set(job.id, job);
      }
      const selected = [];
      for (const job of all.values()) {
        yield;
        if (!names || names.has(String(job.name))) selected.push({
          id: job.id,
          name: job.name,
          owner: job.owner,
          startedAt: job.startedAt,
          status: job.status,
          worktree: cloneJson(job.worktree),
          remote: cloneJson(job.remote)
        });
      }
      if (activeStat && !unchangedContainedFile(canonicalHome, activePath, activeStat, canonicalHome)) throw new Error("outcome job store changed during catalog traversal");
      return selected;
    })());
  } catch (err) {
    log.warn("could not read outcome jobs", { path, err: String(err) });
    return [];
  }
}
function summarizeRun(file, text, mtimeMs, now, meta = {}) {
  const lines = text.split("\n").filter(Boolean);
  const finished = finishedRunLine(text);
  const last = (finished ?? lines.at(-1) ?? "").replace(/^\d\d:\d\d:\d\d /, "");
  const status = finished ? / · done$/.test(finished) ? "done" : / · cancelled$/.test(finished) ? "cancelled" : "failed" : now - mtimeMs > STALE_RUN_MS ? "interrupted" : "running";
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
function listRunsResponsive(home, now = Date.now(), names) {
  return drainScanResponsive(listRunsSteps(home, now, names, true));
}
function runnerHeartbeatFresh(home, job, now) {
  const id = typeof job === "string" ? /-(?:job|ask)-([0-9a-f]{8})$/.exec(job)?.[1] : void 0;
  if (!id) return false;
  try {
    const state = readRunnerStateRecord(home, id);
    return typeof state?.updatedAt === "number" && state.status === "running" && now - state.updatedAt < STALE_RUN_MS;
  } catch {
    return false;
  }
}
function* listRunsSteps(home, now, names, responsive = false) {
  const runs = [];
  for (const log of yield* readRunLogsSteps(home, names, responsive)) {
    yield;
    try {
      const signature = `${log.signature}:${JSON.stringify(log.meta)}`;
      let cached = runSummaries.get(log.file);
      if (cached?.signature !== signature) {
        cached = { signature, summary: summarizeRun(`${log.name}.log`, readRunLogPreview(log.file, log.signature), log.updatedAt, log.updatedAt, log.meta) };
        runSummaries.delete(log.file);
        runSummaries.set(log.file, cached);
        if (runSummaries.size > 2048) runSummaries.delete(runSummaries.keys().next().value);
      }
      const stale = cached.summary.status === "running" && now - log.updatedAt > STALE_RUN_MS && !runnerHeartbeatFresh(home, log.meta.job, now);
      runs.push({ ...cloneJson(cached.summary), ...stale ? { status: "interrupted", etaAt: void 0, etaReportedAt: void 0 } : {}, archived: log.archived, recovered: false, hasLog: true });
    } catch {
    }
  }
  if (names && [...names].every((name2) => runs.some((run) => run.name === name2)))
    return pageRuns(runs, null, runs.length).runs;
  const representedJobs = new Set(runs.map((run) => run.job));
  const representedSuffixes = /* @__PURE__ */ new Set();
  for (const run of runs) for (let at = run.name.indexOf("-"); at >= 0; at = run.name.indexOf("-", at + 1)) representedSuffixes.add(run.name.slice(at));
  const current = yield* historyJobsSteps(home, responsive, { names, metadata: !names });
  const retainedLogs = names ? yield* readRunLogsSteps(home, void 0, responsive) : void 0;
  for (const [name2, job] of current) {
    yield;
    if (names && !names.has(name2)) continue;
    if (names && retainedLogs.some((r) => r.meta.job === name2 || typeof job.id === "string" && r.name.endsWith(`-${job.agent}-${job.id}`))) continue;
    if (representedJobs.has(name2) || typeof job.id === "string" && representedSuffixes.has(`-${job.agent}-${job.id}`)) continue;
    const args = isRecord(job.args) ? job.args : {};
    const worktree = isRecord(job.worktree) ? cloneJson(job.worktree) : null;
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
      status: job.status === "done" || job.status === "failed" || job.status === "cancelled" ? job.status : "interrupted",
      header: `Recovered ${name2}`,
      last: "Run log unavailable; conversation may be available in the CLI transcript.",
      recovered: true,
      hasLog: false
    });
  }
  for (const run of runs) {
    yield;
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
function storedJobViews(jobs) {
  return drainScan(storedJobViewSteps(jobs));
}
function readStoredJobsResponsive(home, names) {
  return drainScanResponsive((function* () {
    return yield* storedJobViewSteps(yield* historyJobsSteps(home, true, { names, metadata: true }), names);
  })());
}
function* storedJobViewSteps(jobs, names) {
  const out = /* @__PURE__ */ new Map();
  for (const j2 of jobs.values()) {
    yield;
    if (!j2 || typeof j2 !== "object") continue;
    const { name: name2, owner, args, remote } = j2;
    if (typeof name2 !== "string" || names && !names.has(name2)) continue;
    const saved = args && typeof args === "object" ? args : {};
    out.set(name2, {
      owner: typeof owner === "string" && owner ? owner : null,
      ...typeof j2.projectRoot === "string" ? { projectRoot: j2.projectRoot } : {},
      next: cloneJson(Object.fromEntries(JOB_SETTING_KEYS.filter((key) => saved[key] !== void 0).map((key) => [key, saved[key]]))),
      ...remote && typeof remote.host === "string" && typeof remote.name === "string" ? { remote: cloneJson(remote) } : {}
    });
  }
  return out;
}
function classifyPeers(peers, runs, home) {
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const roots = worktreeRoots(home).map((root) => `${norm(root)}/`);
  const byWorkdir = /* @__PURE__ */ new Map();
  for (const run of runs) if (run.workdir && !byWorkdir.has(norm(run.workdir))) byWorkdir.set(norm(run.workdir), run);
  return peers.filter((p) => !isPluginCacheCwd(p.cwd)).map((p) => {
    const cwd = norm(p.cwd ?? "");
    const subagent = roots.some((root) => cwd.startsWith(root));
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
    const page = pageRuns(await listRunsResponsive(ctx.home), null, DEFAULT_RUN_PAGE_SIZE);
    const names = new Set(page.runs.flatMap((run) => run.job ? [run.job] : []));
    const selected = await selectHistoryJobsResponsive(ctx.home, names);
    const jobs = Object.fromEntries([...storedJobViews(selected)].map(([name2, job]) => [name2, { next: job.next, ...job.remote ? { remote: job.remote } : {} }]));
    return reply(200, { runs: page.runs, runsNext: page.next, runsTotal: page.total, jobs });
  }
  if (url.pathname === "/api/job-outcomes") {
    const jobName = url.searchParams.get("job"), runName = url.searchParams.get("run");
    if (jobName !== null || runName !== null) {
      if (jobName !== null && runName !== null) return reply(400, { error: "choose job or run" });
      const name2 = jobName ?? runName;
      if (!/^[\w.-]{1,256}$/.test(name2) || name2 === "." || name2 === "..") return reply(400, { error: "invalid outcome name" });
      const names2 = /* @__PURE__ */ new Set([name2]);
      const jobs2 = jobName !== null ? await dashboardJobOutcomes(ctx.home, ctx.log, names2) : {};
      const runs2 = runName !== null ? await finishedRunOutcomes(ctx.home, ctx.log, names2) : {};
      if (!Object.hasOwn(jobs2, name2) && !Object.hasOwn(runs2, name2)) return reply(404, { error: "no such finished job or run" });
      const groups2 = { needsReview: [], held: [], merged: [], discarded: [] };
      for (const [key, job] of Object.entries(jobs2)) {
        const state = job.outcome.merge.state;
        groups2[state === "unmerged" ? "needsReview" : state].push(key);
      }
      return reply(200, { contractVersion: JOB_OUTCOME_CONTRACT_VERSION, jobs: jobs2, runs: runs2, groups: groups2, next: null });
    }
    const rawLimit = url.searchParams.get("limit") ?? String(DEFAULT_RUN_PAGE_SIZE);
    const limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RUN_PAGE_SIZE) return reply(400, { error: "invalid outcome page limit" });
    const before = url.searchParams.get("before");
    if (before !== null && !/^[\w.-]{1,256}$/.test(before)) return reply(400, { error: "invalid outcome cursor" });
    const select = (names2) => [...new Set(names2)].sort().filter((name2) => before === null || name2 > before).slice(0, limit);
    const stored = (await readOutcomeJobs(ctx.home, ctx.log)).filter((j2) => ["done", "failed", "cancelled"].includes(j2.status));
    const runs = (await listRunsResponsive(ctx.home)).filter((r) => r.job && ["done", "failed", "cancelled"].includes(r.status));
    const names = select([...stored.map((j2) => j2.name), ...runs.map((r) => r.name)]);
    const next = [...stored.map((j2) => j2.name), ...runs.map((r) => r.name)].some((name2) => names.length > 0 && name2 > names.at(-1)) ? names.at(-1) : null;
    const jobs = await dashboardJobOutcomes(ctx.home, ctx.log, new Set(names));
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
      return reply(200, pageRuns(await listRunsResponsive(ctx.home), url.searchParams.get("before"), limit));
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
    const job = (await selectHistoryJobsResponsive(ctx.home, /* @__PURE__ */ new Set([name2]))).get(name2);
    const run = (await listRunsResponsive(ctx.home)).find((r) => r.job === name2);
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
    const run = (await listRunsResponsive(ctx.home)).find((r) => r.name === runChatMatch[1] || r.job === runChatMatch[1]);
    if (!run) return reply(404, { error: "no such run" });
    const job = run.job ? (await selectHistoryJobsResponsive(ctx.home, /* @__PURE__ */ new Set([run.job]))).get(run.job) : void 0;
    const sessionId = run.sessionId ?? run.session ?? (typeof job?.sessionId === "string" ? job.sessionId : typeof job?.threadId === "string" ? job.threadId : null);
    if (!sessionId) return reply(409, { error: "This run has no sessionId yet." });
    if (!TRANSCRIPT_ID.test(sessionId) || !CODING_AGENTS.includes(run.agent)) return reply(404, { error: "no transcript for this run" });
    const page = readTranscript({ agent: run.agent, sessionId, cwd: run.workdir ?? "" }, from, void 0, ctx.transcripts);
    return page ? reply(200, page) : reply(404, { error: "no transcript for this run" });
  }
  const runMatch = /^\/api\/runs\/([\w.-]+)$/.exec(url.pathname);
  if (runMatch) {
    const log = (await drainScanResponsive(readRunLogsSteps(ctx.home, /* @__PURE__ */ new Set([runMatch[1]]), true))).find((record) => record.name === runMatch[1]);
    if (!log) {
      const recovered = (await listRunsResponsive(ctx.home)).find((run) => run.name === runMatch[1] && run.recovered);
      return recovered ? reply(200, { text: "", next: 0, size: 0, recovered: true, hasLog: false }) : reply(404, { error: "no such run" });
    }
    const rawFrom = url.searchParams.get("from") ?? "0";
    if (!/^\d+$/.test(rawFrom) || !Number.isSafeInteger(Number(rawFrom))) return reply(400, { error: "invalid log cursor" });
    const from = Number(rawFrom);
    const witnessed = lstatSync(log.file, { bigint: true });
    const logRoot = isInsideDir(log.file, join2(ctx.home, "cold")) ? join2(ctx.home, "cold") : join2(ctx.home, "runs");
    if (!unchangedContainedFile(logRoot, log.file, witnessed)) return reply(404, { error: "no such run" });
    const size = Number(witnessed.size);
    const fd = openSync(log.file, "r");
    const buf = Buffer.alloc(Math.min(MAX_LOG_CHUNK + 1, Math.max(0, size - from)));
    try {
      if (fileSignature(fstatSync(fd, { bigint: true })) !== fileSignature(witnessed)) return reply(404, { error: "run changed before reading" });
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
function isInsideDir(child, parent) {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// src/mobile/store.ts
import { createHash as createHash2, randomBytes as randomBytes2, randomUUID as randomUUID2, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// src/mobile/contract.ts
function grantCovers(grant, entity) {
  if (grant.scope === "all") return true;
  if (entity.kind === "session" && grant.sessionIds.includes(entity.id)) return true;
  if (entity.kind === "job" && grant.jobIds.includes(entity.id)) return true;
  return (grant.scope === "project" || entity.kind === "question") && !!entity.projectId && grant.projectIds.includes(entity.projectId);
}
function shortPin(pin) {
  return pin.slice(0, 4) + "\xB7" + pin.slice(4, 8) + "\xB7" + pin.slice(8, 12) + "\xB7" + pin.slice(12, 16);
}

// src/mobile/store.ts
var secret = () => randomBytes2(32).toString("base64url");
var digest = (domain, value) => createHash2("sha256").update(domain + "\0" + value).digest("hex");
function equal(a, b) {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
var MobileFault = class extends Error {
  constructor(status, code, currentVersion) {
    super(code);
    this.status = status;
    this.code = code;
    this.currentVersion = currentVersion;
  }
  status;
  code;
  currentVersion;
};
var ACCESS_MS = 5 * 6e4;
var REFRESH_MS = 30 * 24 * 60 * 6e4;
var MobileStore = class {
  constructor(file, pcId, origin, now = Date.now, alternateOrigins = [], pins) {
    this.pcId = pcId;
    this.origin = origin;
    this.now = now;
    this.pins = pins;
    if (pins !== void 0 && (pins.length < 1 || pins.length > 2 || pins.some((pin) => !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(pin)) || new Set(pins).size !== pins.length)) throw new Error("Invalid SPKI pins");
    this.origins = [.../* @__PURE__ */ new Set([origin, ...alternateOrigins])];
    if (this.origins.length > 8) throw new Error("At most eight private HTTPS addresses");
    for (const configured of this.origins) {
      const url = new URL(configured);
      if (url.protocol !== "https:" || url.origin !== configured || url.username || url.password) throw new Error("Provision an exact trusted HTTPS origin");
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS mobile_records(kind TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS mobile_replays(principal TEXT NOT NULL,route TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,
        state TEXT NOT NULL,result TEXT,expires_at INTEGER NOT NULL,PRIMARY KEY(principal,route,key));`);
    this.transaction(() => {
      const columns = new Set(this.db.prepare("PRAGMA table_info(mobile_records)").all().map((row) => String(row.name)));
      if (!columns.has("status")) this.db.exec("ALTER TABLE mobile_records ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
      if (!columns.has("revokedAt")) this.db.exec("ALTER TABLE mobile_records ADD COLUMN revokedAt INTEGER");
      if (!columns.has("reason")) this.db.exec("ALTER TABLE mobile_records ADD COLUMN reason TEXT");
      this.db.exec(`CREATE TABLE IF NOT EXISTS mobile_push_history(
        revision INTEGER PRIMARY KEY,deviceId TEXT NOT NULL,record TEXT NOT NULL,status TEXT NOT NULL,
        revokedAt INTEGER,reason TEXT,retainedAt INTEGER NOT NULL);`);
    });
    const identity = this.get("meta", "pc");
    if (identity && identity.pcId !== pcId) {
      this.db.close();
      throw new Error("Mobile registry belongs to a different PC");
    }
    this.put("meta", "pc", { pcId, origins: this.origins });
  }
  pcId;
  origin;
  now;
  pins;
  db;
  transactionDepth = 0;
  origins;
  close() {
    this.db.close();
  }
  transaction(fn) {
    if (this.transactionDepth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.transactionDepth--;
    }
  }
  get(kind, id) {
    const row = this.db.prepare("SELECT record FROM mobile_records WHERE kind=? AND id=? AND status='active'").get(kind, id);
    return row ? JSON.parse(String(row.record)) : void 0;
  }
  put(kind, id, record) {
    this.transaction(() => {
      if (kind === "push") this.db.prepare(`INSERT INTO mobile_push_history(deviceId,record,status,revokedAt,reason,retainedAt)
        SELECT id,record,status,revokedAt,reason,? FROM mobile_records WHERE kind='push' AND id=?`).run(this.now(), id);
      this.db.prepare(`INSERT INTO mobile_records(kind,id,record,status) VALUES(?,?,?,'active')
        ON CONFLICT(kind,id) DO UPDATE SET record=excluded.record,status='active',revokedAt=NULL,reason=NULL`).run(kind, id, JSON.stringify(record));
    });
  }
  list(kind) {
    return this.db.prepare("SELECT record FROM mobile_records WHERE kind=? AND status='active'").all(kind).map((row) => JSON.parse(String(row.record)));
  }
  archivePush(id, reason, expectedCiphertext) {
    this.db.prepare(`UPDATE mobile_records SET status='revoked',revokedAt=?,reason=?
      WHERE kind='push' AND id=? AND status='active' AND (? IS NULL OR json_extract(record,'$.ciphertext')=?)`).run(this.now(), reason, id, expectedCiphertext ?? null, expectedCiphertext ?? null);
  }
  replay(principal, route, key, hash) {
    const prior = this.db.prepare("SELECT * FROM mobile_replays WHERE principal=? AND route=? AND key=?").get(principal, route, key);
    if (!prior) return void 0;
    if (prior.hash !== hash || Number(prior.expires_at) <= this.now()) throw new MobileFault(409, "idempotency_conflict");
    return { state: String(prior.state), result: prior.result ? JSON.parse(String(prior.result)) : null, expiresAt: Number(prior.expires_at) };
  }
  reserve(principal, route, key, hash) {
    this.db.prepare("INSERT INTO mobile_replays VALUES(?,?,?,?,?,?,?)").run(principal, route, key, hash, "unconfirmed", null, this.now() + 24 * 60 * 6e4);
  }
  finish(principal, route, key, result) {
    this.db.prepare("UPDATE mobile_replays SET state='recorded',result=? WHERE principal=? AND route=? AND key=?").run(JSON.stringify(result), principal, route, key);
  }
  mutate(principal, route, key, hash, fn) {
    return this.transaction(() => {
      const prior = this.replay(principal, route, key, hash);
      if (prior) return prior.result ?? { state: "unconfirmed" };
      this.reserve(principal, route, key, hash);
      const result = fn();
      this.finish(principal, route, key, result.replay);
      return result.response;
    });
  }
  invite() {
    const pending = this.list("invite").filter((i) => i.expiresAt > this.now());
    if (pending.length >= 10) throw new MobileFault(429, "pairing_limit");
    const id = randomUUID2(), nonce = secret(), expiresAt = this.now() + 12e4;
    this.put("invite", id, { id, pcId: this.pcId, origins: [...this.origins], nonceHash: digest("qr", nonce), expiresAt, claimed: false });
    const fields = { origin: this.origin, origins: [...this.origins], pcId: this.pcId, invitationId: id, nonce, expiresAt };
    return this.pins ? { v: 2, ...fields, pins: [...this.pins] } : { v: 1, ...fields };
  }
  claim(invitationId, nonce, name2, platform, key) {
    return this.mutate("invite:" + invitationId, "claim", key, digest("claim-body", JSON.stringify([nonce, name2, platform])), () => {
      const invite = this.get("invite", invitationId);
      if (!invite || !equal(invite.nonceHash, digest("qr", nonce)) || invite.expiresAt <= this.now() || invite.claimed) throw new MobileFault(409, "pairing_expired_or_consumed");
      invite.claimed = true;
      this.put("invite", invitationId, invite);
      const id = randomUUID2(), token = secret(), code = String(randomBytes2(4).readUInt32BE() % 1e6).padStart(6, "0");
      this.put("claim", id, { id, tokenHash: digest("claim", token), code, name: name2, platform, expiresAt: invite.expiresAt, state: "pending" });
      return { response: { claimId: id, claimToken: token, comparisonCode: code, expiresAt: invite.expiresAt }, replay: { state: "claimed", claimId: id } };
    });
  }
  pending() {
    return this.list("claim").filter((c) => c.state === "pending" && c.expiresAt > this.now()).map((c) => ({ claimId: c.id, name: c.name, platform: c.platform, comparisonCode: c.code, expiresAt: c.expiresAt }));
  }
  confirm(claimId, comparisonCode, allow, grants) {
    this.transaction(() => {
      const claim = this.get("claim", claimId);
      if (!claim || claim.expiresAt <= this.now() || claim.state !== "pending" || !equal(claim.code, comparisonCode)) throw new MobileFault(409, "pairing_conflict");
      if (grants.some((g) => g.pcId !== this.pcId && g.capabilities.includes("questions.answer"))) throw new MobileFault(403, "remote_write_unsupported");
      claim.state = allow ? "approved" : "denied";
      if (allow) {
        const device = { id: randomUUID2(), name: claim.name, platform: claim.platform, pairedAt: this.now(), revoked: false, revision: randomUUID2(), grants };
        this.put("device", device.id, device);
        claim.deviceId = device.id;
      }
      this.put("claim", claimId, claim);
    });
  }
  pollClaim(id, token, key) {
    return this.mutate("claim:" + id, "issue", key, digest("claim-issue", token), () => {
      const claim = this.get("claim", id);
      if (!claim || !equal(claim.tokenHash, digest("claim", token))) throw new MobileFault(401, "unauthorized");
      if (claim.state === "pending") throw new MobileFault(claim.expiresAt <= this.now() ? 410 : 202, claim.expiresAt <= this.now() ? "pairing_expired" : "pairing_pending");
      if (claim.expiresAt <= this.now()) return { response: { state: "expired" }, replay: { state: "expired" } };
      if (claim.state !== "approved") return { response: { state: claim.state }, replay: { state: claim.state } };
      const device = this.get("device", claim.deviceId);
      if (device.revoked) throw new MobileFault(401, "device_revoked");
      const credentials = this.issue(device);
      claim.state = "issued";
      this.put("claim", id, claim);
      return { response: { state: "approved", credentials }, replay: { state: "issued" } };
    });
  }
  issue(device, existing) {
    const accessToken = secret(), refreshToken = secret(), csrfToken = secret(), at = this.now();
    const session = {
      id: existing?.id ?? randomUUID2(),
      deviceId: device.id,
      accessHash: digest("access", accessToken),
      refreshHash: digest("refresh", refreshToken),
      csrfHash: digest("csrf", csrfToken),
      retired: existing ? [...existing.retired, existing.refreshHash] : [],
      accessExpiresAt: at + ACCESS_MS,
      refreshExpiresAt: existing?.refreshExpiresAt ?? at + REFRESH_MS,
      revoked: false
    };
    this.put("session", session.id, session);
    const capabilities = [...new Set(device.grants.flatMap((g) => g.capabilities))];
    return { deviceId: device.id, sessionId: session.id, pcId: this.pcId, accessToken, refreshToken, csrfToken, accessExpiresAt: session.accessExpiresAt, refreshExpiresAt: session.refreshExpiresAt, capabilities, scopes: device.grants };
  }
  refresh(token, csrf, key) {
    const hash = digest("refresh", token), session = this.list("session").find((s) => s.refreshHash === hash || s.retired.includes(hash));
    if (!session) throw new MobileFault(401, "unauthorized");
    const device = this.get("device", session.deviceId);
    if (session.revoked || device.revoked) throw new MobileFault(401, "device_revoked");
    const requestHash = digest("refresh-body", JSON.stringify([token, csrf]));
    const prior = this.replay(session.id, "refresh", key, requestHash);
    if (prior) return prior.result;
    if (session.refreshHash !== hash) {
      this.revoke(device.id, "refresh-reuse");
      throw new MobileFault(401, "refresh_reuse");
    }
    if (session.refreshExpiresAt <= this.now()) throw new MobileFault(401, "credential_expired");
    if (!equal(session.csrfHash, digest("csrf", csrf))) throw new MobileFault(403, "csrf");
    return this.mutate(session.id, "refresh", key, requestHash, () => {
      const current = this.get("session", session.id), currentDevice = this.get("device", device.id);
      if (current.revoked || currentDevice.revoked || current.refreshHash !== hash || !equal(current.csrfHash, digest("csrf", csrf))) throw new MobileFault(401, "credential_changed");
      return { response: this.issue(currentDevice, current), replay: { state: "issued" } };
    });
  }
  authenticate(token) {
    const hash = digest("access", token), session = this.list("session").find((s) => equal(s.accessHash, hash));
    if (!session) throw new MobileFault(401, "unauthorized");
    const device = this.get("device", session.deviceId);
    if (device.revoked || session.revoked) throw new MobileFault(401, "device_revoked");
    if (session.accessExpiresAt <= this.now()) throw new MobileFault(401, "credential_expired");
    return { device, session };
  }
  checkCsrf(principal, csrf) {
    if (!equal(principal.session.csrfHash, digest("csrf", csrf))) throw new MobileFault(403, "csrf");
  }
  devices() {
    return this.list("device").map(({ grants, revision, ...device }) => device);
  }
  revoke(id, reason = "device-revoke") {
    this.transaction(() => {
      const device = this.get("device", id);
      if (!device) throw new MobileFault(404, "not_found");
      device.revoked = true;
      device.revision = randomUUID2();
      this.put("device", id, device);
      this.archivePush(id, reason);
    });
  }
  can(device, capability, pcId, entity) {
    return device.grants.some((g) => g.pcId === pcId && g.capabilities.includes(capability) && (!entity || grantCovers(g, entity)));
  }
};

// src/mobile/vendor/qrcode.js
var v = function(w, x) {
  let s = w, l = j[x], e = null, t = 0, u = null, p = [], y = {}, h = function(r, c) {
    t = s * 4 + 17, e = (function(n) {
      let f = new Array(n);
      for (let i = 0; i < n; i += 1) {
        f[i] = new Array(n);
        for (let g = 0; g < n; g += 1) f[i][g] = null;
      }
      return f;
    })(t), a(0, 0), a(t - 7, 0), a(0, t - 7), D(), P(), I(r, c), s >= 7 && E(r), u == null && (u = Z(s, l, p)), m(u, c);
  }, a = function(r, c) {
    for (let n = -1; n <= 7; n += 1) if (!(r + n <= -1 || t <= r + n)) for (let f = -1; f <= 7; f += 1) c + f <= -1 || t <= c + f || (0 <= n && n <= 6 && (f == 0 || f == 6) || 0 <= f && f <= 6 && (n == 0 || n == 6) || 2 <= n && n <= 4 && 2 <= f && f <= 4 ? e[r + n][c + f] = true : e[r + n][c + f] = false);
  }, _ = function() {
    let r = 0, c = 0;
    for (let n = 0; n < 8; n += 1) {
      h(true, n);
      let f = O.getLostPoint(y);
      (n == 0 || r > f) && (r = f, c = n);
    }
    return c;
  }, P = function() {
    for (let r = 8; r < t - 8; r += 1) e[r][6] == null && (e[r][6] = r % 2 == 0);
    for (let r = 8; r < t - 8; r += 1) e[6][r] == null && (e[6][r] = r % 2 == 0);
  }, D = function() {
    let r = O.getPatternPosition(s);
    for (let c = 0; c < r.length; c += 1) for (let n = 0; n < r.length; n += 1) {
      let f = r[c], i = r[n];
      if (e[f][i] == null) for (let g = -2; g <= 2; g += 1) for (let A = -2; A <= 2; A += 1) g == -2 || g == 2 || A == -2 || A == 2 || g == 0 && A == 0 ? e[f + g][i + A] = true : e[f + g][i + A] = false;
    }
  }, E = function(r) {
    let c = O.getBCHTypeNumber(s);
    for (let n = 0; n < 18; n += 1) {
      let f = !r && (c >> n & 1) == 1;
      e[Math.floor(n / 3)][n % 3 + t - 8 - 3] = f;
    }
    for (let n = 0; n < 18; n += 1) {
      let f = !r && (c >> n & 1) == 1;
      e[n % 3 + t - 8 - 3][Math.floor(n / 3)] = f;
    }
  }, I = function(r, c) {
    let n = l << 3 | c, f = O.getBCHTypeInfo(n);
    for (let i = 0; i < 15; i += 1) {
      let g = !r && (f >> i & 1) == 1;
      i < 6 ? e[i][8] = g : i < 8 ? e[i + 1][8] = g : e[t - 15 + i][8] = g;
    }
    for (let i = 0; i < 15; i += 1) {
      let g = !r && (f >> i & 1) == 1;
      i < 8 ? e[8][t - i - 1] = g : i < 9 ? e[8][15 - i - 1 + 1] = g : e[8][15 - i - 1] = g;
    }
    e[t - 8][8] = !r;
  }, m = function(r, c) {
    let n = -1, f = t - 1, i = 7, g = 0, A = O.getMaskFunction(c);
    for (let B = t - 1; B > 0; B -= 2) for (B == 6 && (B -= 1); ; ) {
      for (let M = 0; M < 2; M += 1) if (e[f][B - M] == null) {
        let T = false;
        g < r.length && (T = (r[g] >>> i & 1) == 1), A(f, B - M) && (T = !T), e[f][B - M] = T, i -= 1, i == -1 && (g += 1, i = 7);
      }
      if (f += n, f < 0 || t <= f) {
        f -= n, n = -n;
        break;
      }
    }
  }, X = function(r, c) {
    let n = 0, f = 0, i = 0, g = new Array(c.length), A = new Array(c.length);
    for (let b = 0; b < c.length; b += 1) {
      let C = c[b].dataCount, L = c[b].totalCount - C;
      f = Math.max(f, C), i = Math.max(i, L), g[b] = new Array(C);
      for (let R = 0; R < g[b].length; R += 1) g[b][R] = 255 & r.getBuffer()[R + n];
      n += C;
      let Q = O.getErrorCorrectPolynomial(L), F = K(g[b], Q.getLength() - 1).mod(Q);
      A[b] = new Array(Q.getLength() - 1);
      for (let R = 0; R < A[b].length; R += 1) {
        let S = R + F.getLength() - A[b].length;
        A[b][R] = S >= 0 ? F.getAt(S) : 0;
      }
    }
    let B = 0;
    for (let b = 0; b < c.length; b += 1) B += c[b].totalCount;
    let M = new Array(B), T = 0;
    for (let b = 0; b < f; b += 1) for (let C = 0; C < c.length; C += 1) b < g[C].length && (M[T] = g[C][b], T += 1);
    for (let b = 0; b < i; b += 1) for (let C = 0; C < c.length; C += 1) b < A[C].length && (M[T] = A[C][b], T += 1);
    return M;
  }, Z = function(r, c, n) {
    let f = Y.getRSBlocks(r, c), i = G();
    for (let A = 0; A < n.length; A += 1) {
      let B = n[A];
      i.put(B.getMode(), 4), i.put(B.getLength(), O.getLengthInBits(B.getMode(), r)), B.write(i);
    }
    let g = 0;
    for (let A = 0; A < f.length; A += 1) g += f[A].dataCount;
    if (i.getLengthInBits() > g * 8) throw "code length overflow. (" + i.getLengthInBits() + ">" + g * 8 + ")";
    for (i.getLengthInBits() + 4 <= g * 8 && i.put(0, 4); i.getLengthInBits() % 8 != 0; ) i.putBit(false);
    for (; !(i.getLengthInBits() >= g * 8 || (i.put(236, 8), i.getLengthInBits() >= g * 8)); ) i.put(17, 8);
    return X(i, f);
  };
  y.addData = function(r, c) {
    c = c || "Byte";
    let n = null;
    switch (c) {
      case "Numeric":
        n = W(r);
        break;
      case "Alphanumeric":
        n = V(r);
        break;
      case "Byte":
        n = q(r);
        break;
      case "Kanji":
        n = z(r);
        break;
      default:
        throw "mode:" + c;
    }
    p.push(n), u = null;
  }, y.isDark = function(r, c) {
    if (r < 0 || t <= r || c < 0 || t <= c) throw r + "," + c;
    return e[r][c];
  }, y.getModuleCount = function() {
    return t;
  }, y.make = function() {
    if (s < 1) {
      let r = 1;
      for (; r < 40; r++) {
        let c = Y.getRSBlocks(r, l), n = G();
        for (let i = 0; i < p.length; i++) {
          let g = p[i];
          n.put(g.getMode(), 4), n.put(g.getLength(), O.getLengthInBits(g.getMode(), r)), g.write(n);
        }
        let f = 0;
        for (let i = 0; i < c.length; i++) f += c[i].dataCount;
        if (n.getLengthInBits() <= f * 8) break;
      }
      s = r;
    }
    h(false, _());
  }, y.createTableTag = function(r, c) {
    r = r || 2, c = typeof c > "u" ? r * 4 : c;
    let n = "";
    n += '<table style="', n += " border-width: 0px; border-style: none;", n += " border-collapse: collapse;", n += " padding: 0px; margin: " + c + "px;", n += '">', n += "<tbody>";
    for (let f = 0; f < y.getModuleCount(); f += 1) {
      n += "<tr>";
      for (let i = 0; i < y.getModuleCount(); i += 1) n += '<td style="', n += " border-width: 0px; border-style: none;", n += " border-collapse: collapse;", n += " padding: 0px; margin: 0px;", n += " width: " + r + "px;", n += " height: " + r + "px;", n += " background-color: ", n += y.isDark(f, i) ? "#000000" : "#ffffff", n += ";", n += '"/>';
      n += "</tr>";
    }
    return n += "</tbody>", n += "</table>", n;
  }, y.createSvgTag = function(r, c, n, f) {
    let i = {};
    typeof arguments[0] == "object" && (i = arguments[0], r = i.cellSize, c = i.margin, n = i.alt, f = i.title), r = r || 2, c = typeof c > "u" ? r * 4 : c, n = typeof n == "string" ? { text: n } : n || {}, n.text = n.text || null, n.id = n.text ? n.id || "qrcode-description" : null, f = typeof f == "string" ? { text: f } : f || {}, f.text = f.text || null, f.id = f.text ? f.id || "qrcode-title" : null;
    let g = y.getModuleCount() * r + c * 2, A, B, M, T, b = "", C;
    for (C = "l" + r + ",0 0," + r + " -" + r + ",0 0,-" + r + "z ", b += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"', b += i.scalable ? "" : ' width="' + g + 'px" height="' + g + 'px"', b += ' viewBox="0 0 ' + g + " " + g + '" ', b += ' preserveAspectRatio="xMinYMin meet"', b += f.text || n.text ? ' role="img" aria-labelledby="' + U([f.id, n.id].join(" ").trim()) + '"' : "", b += ">", b += f.text ? '<title id="' + U(f.id) + '">' + U(f.text) + "</title>" : "", b += n.text ? '<description id="' + U(n.id) + '">' + U(n.text) + "</description>" : "", b += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>', b += '<path d="', M = 0; M < y.getModuleCount(); M += 1) for (T = M * r + c, A = 0; A < y.getModuleCount(); A += 1) y.isDark(M, A) && (B = A * r + c, b += "M" + B + "," + T + C);
    return b += '" stroke="transparent" fill="black"/>', b += "</svg>", b;
  }, y.createDataURL = function(r, c) {
    r = r || 2, c = typeof c > "u" ? r * 4 : c;
    let n = y.getModuleCount() * r + c * 2, f = c, i = n - c;
    return rt(n, n, function(g, A) {
      if (f <= g && g < i && f <= A && A < i) {
        let B = Math.floor((g - f) / r), M = Math.floor((A - f) / r);
        return y.isDark(M, B) ? 0 : 1;
      } else return 1;
    });
  }, y.createImgTag = function(r, c, n) {
    r = r || 2, c = typeof c > "u" ? r * 4 : c;
    let f = y.getModuleCount() * r + c * 2, i = "";
    return i += "<img", i += ' src="', i += y.createDataURL(r, c), i += '"', i += ' width="', i += f, i += '"', i += ' height="', i += f, i += '"', n && (i += ' alt="', i += U(n), i += '"'), i += "/>", i;
  };
  let U = function(r) {
    let c = "";
    for (let n = 0; n < r.length; n += 1) {
      let f = r.charAt(n);
      switch (f) {
        case "<":
          c += "&lt;";
          break;
        case ">":
          c += "&gt;";
          break;
        case "&":
          c += "&amp;";
          break;
        case '"':
          c += "&quot;";
          break;
        default:
          c += f;
          break;
      }
    }
    return c;
  }, $ = function(r) {
    r = typeof r > "u" ? 2 : r;
    let n = y.getModuleCount() * 1 + r * 2, f = r, i = n - r, g, A, B, M, T, b = { "\u2588\u2588": "\u2588", "\u2588 ": "\u2580", " \u2588": "\u2584", "  ": " " }, C = { "\u2588\u2588": "\u2580", "\u2588 ": "\u2580", " \u2588": " ", "  ": " " }, L = "";
    for (g = 0; g < n; g += 2) {
      for (B = Math.floor((g - f) / 1), M = Math.floor((g + 1 - f) / 1), A = 0; A < n; A += 1) T = "\u2588", f <= A && A < i && f <= g && g < i && y.isDark(B, Math.floor((A - f) / 1)) && (T = " "), f <= A && A < i && f <= g + 1 && g + 1 < i && y.isDark(M, Math.floor((A - f) / 1)) ? T += " " : T += "\u2588", L += r < 1 && g + 1 >= i ? C[T] : b[T];
      L += `
`;
    }
    return n % 2 && r > 0 ? L.substring(0, L.length - n - 1) + Array(n + 1).join("\u2580") : L.substring(0, L.length - 1);
  };
  return y.createASCII = function(r, c) {
    if (r = r || 1, r < 2) return $(c);
    r -= 1, c = typeof c > "u" ? r * 2 : c;
    let n = y.getModuleCount() * r + c * 2, f = c, i = n - c, g, A, B, M, T = Array(r + 1).join("\u2588\u2588"), b = Array(r + 1).join("  "), C = "", L = "";
    for (g = 0; g < n; g += 1) {
      for (B = Math.floor((g - f) / r), L = "", A = 0; A < n; A += 1) M = 1, f <= A && A < i && f <= g && g < i && y.isDark(B, Math.floor((A - f) / r)) && (M = 0), L += M ? T : b;
      for (B = 0; B < r; B += 1) C += L + `
`;
    }
    return C.substring(0, C.length - 1);
  }, y.renderTo2dContext = function(r, c) {
    c = c || 2;
    let n = y.getModuleCount();
    for (let f = 0; f < n; f++) for (let i = 0; i < n; i++) r.fillStyle = y.isDark(f, i) ? "black" : "white", r.fillRect(i * c, f * c, c, c);
  }, y;
};
v.stringToBytes = function(w) {
  let x = [];
  for (let d = 0; d < w.length; d += 1) {
    let o = w.charCodeAt(d);
    x.push(o & 255);
  }
  return x;
};
v.createStringToBytes = function(w, x) {
  let d = (function() {
    let s = et(w), l = function() {
      let u = s.read();
      if (u == -1) throw "eof";
      return u;
    }, e = 0, t = {};
    for (; ; ) {
      let u = s.read();
      if (u == -1) break;
      let p = l(), y = l(), h = l(), a = String.fromCharCode(u << 8 | p), _ = y << 8 | h;
      t[a] = _, e += 1;
    }
    if (e != x) throw e + " != " + x;
    return t;
  })(), o = 63;
  return function(s) {
    let l = [];
    for (let e = 0; e < s.length; e += 1) {
      let t = s.charCodeAt(e);
      if (t < 128) l.push(t);
      else {
        let u = d[s.charAt(e)];
        typeof u == "number" ? (u & 255) == u ? l.push(u) : (l.push(u >>> 8), l.push(u & 255)) : l.push(o);
      }
    }
    return l;
  };
};
var k = { MODE_NUMBER: 1, MODE_ALPHA_NUM: 2, MODE_8BIT_BYTE: 4, MODE_KANJI: 8 };
var j = { L: 1, M: 0, Q: 3, H: 2 };
var N = { PATTERN000: 0, PATTERN001: 1, PATTERN010: 2, PATTERN011: 3, PATTERN100: 4, PATTERN101: 5, PATTERN110: 6, PATTERN111: 7 };
var O = (function() {
  let w = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]], x = 1335, d = 7973, o = 21522, s = {}, l = function(e) {
    let t = 0;
    for (; e != 0; ) t += 1, e >>>= 1;
    return t;
  };
  return s.getBCHTypeInfo = function(e) {
    let t = e << 10;
    for (; l(t) - l(x) >= 0; ) t ^= x << l(t) - l(x);
    return (e << 10 | t) ^ o;
  }, s.getBCHTypeNumber = function(e) {
    let t = e << 12;
    for (; l(t) - l(d) >= 0; ) t ^= d << l(t) - l(d);
    return e << 12 | t;
  }, s.getPatternPosition = function(e) {
    return w[e - 1];
  }, s.getMaskFunction = function(e) {
    switch (e) {
      case N.PATTERN000:
        return function(t, u) {
          return (t + u) % 2 == 0;
        };
      case N.PATTERN001:
        return function(t, u) {
          return t % 2 == 0;
        };
      case N.PATTERN010:
        return function(t, u) {
          return u % 3 == 0;
        };
      case N.PATTERN011:
        return function(t, u) {
          return (t + u) % 3 == 0;
        };
      case N.PATTERN100:
        return function(t, u) {
          return (Math.floor(t / 2) + Math.floor(u / 3)) % 2 == 0;
        };
      case N.PATTERN101:
        return function(t, u) {
          return t * u % 2 + t * u % 3 == 0;
        };
      case N.PATTERN110:
        return function(t, u) {
          return (t * u % 2 + t * u % 3) % 2 == 0;
        };
      case N.PATTERN111:
        return function(t, u) {
          return (t * u % 3 + (t + u) % 2) % 2 == 0;
        };
      default:
        throw "bad maskPattern:" + e;
    }
  }, s.getErrorCorrectPolynomial = function(e) {
    let t = K([1], 0);
    for (let u = 0; u < e; u += 1) t = t.multiply(K([1, H.gexp(u)], 0));
    return t;
  }, s.getLengthInBits = function(e, t) {
    if (1 <= t && t < 10) switch (e) {
      case k.MODE_NUMBER:
        return 10;
      case k.MODE_ALPHA_NUM:
        return 9;
      case k.MODE_8BIT_BYTE:
        return 8;
      case k.MODE_KANJI:
        return 8;
      default:
        throw "mode:" + e;
    }
    else if (t < 27) switch (e) {
      case k.MODE_NUMBER:
        return 12;
      case k.MODE_ALPHA_NUM:
        return 11;
      case k.MODE_8BIT_BYTE:
        return 16;
      case k.MODE_KANJI:
        return 10;
      default:
        throw "mode:" + e;
    }
    else if (t < 41) switch (e) {
      case k.MODE_NUMBER:
        return 14;
      case k.MODE_ALPHA_NUM:
        return 13;
      case k.MODE_8BIT_BYTE:
        return 16;
      case k.MODE_KANJI:
        return 12;
      default:
        throw "mode:" + e;
    }
    else throw "type:" + t;
  }, s.getLostPoint = function(e) {
    let t = e.getModuleCount(), u = 0;
    for (let h = 0; h < t; h += 1) for (let a = 0; a < t; a += 1) {
      let _ = 0, P = e.isDark(h, a);
      for (let D = -1; D <= 1; D += 1) if (!(h + D < 0 || t <= h + D)) for (let E = -1; E <= 1; E += 1) a + E < 0 || t <= a + E || D == 0 && E == 0 || P == e.isDark(h + D, a + E) && (_ += 1);
      _ > 5 && (u += 3 + _ - 5);
    }
    for (let h = 0; h < t - 1; h += 1) for (let a = 0; a < t - 1; a += 1) {
      let _ = 0;
      e.isDark(h, a) && (_ += 1), e.isDark(h + 1, a) && (_ += 1), e.isDark(h, a + 1) && (_ += 1), e.isDark(h + 1, a + 1) && (_ += 1), (_ == 0 || _ == 4) && (u += 3);
    }
    for (let h = 0; h < t; h += 1) for (let a = 0; a < t - 6; a += 1) e.isDark(h, a) && !e.isDark(h, a + 1) && e.isDark(h, a + 2) && e.isDark(h, a + 3) && e.isDark(h, a + 4) && !e.isDark(h, a + 5) && e.isDark(h, a + 6) && (u += 40);
    for (let h = 0; h < t; h += 1) for (let a = 0; a < t - 6; a += 1) e.isDark(a, h) && !e.isDark(a + 1, h) && e.isDark(a + 2, h) && e.isDark(a + 3, h) && e.isDark(a + 4, h) && !e.isDark(a + 5, h) && e.isDark(a + 6, h) && (u += 40);
    let p = 0;
    for (let h = 0; h < t; h += 1) for (let a = 0; a < t; a += 1) e.isDark(a, h) && (p += 1);
    let y = Math.abs(100 * p / t / t - 50) / 5;
    return u += y * 10, u;
  }, s;
})();
var H = (function() {
  let w = new Array(256), x = new Array(256);
  for (let o = 0; o < 8; o += 1) w[o] = 1 << o;
  for (let o = 8; o < 256; o += 1) w[o] = w[o - 4] ^ w[o - 5] ^ w[o - 6] ^ w[o - 8];
  for (let o = 0; o < 255; o += 1) x[w[o]] = o;
  let d = {};
  return d.glog = function(o) {
    if (o < 1) throw "glog(" + o + ")";
    return x[o];
  }, d.gexp = function(o) {
    for (; o < 0; ) o += 255;
    for (; o >= 256; ) o -= 255;
    return w[o];
  }, d;
})();
var K = function(w, x) {
  if (typeof w.length > "u") throw w.length + "/" + x;
  let d = (function() {
    let s = 0;
    for (; s < w.length && w[s] == 0; ) s += 1;
    let l = new Array(w.length - s + x);
    for (let e = 0; e < w.length - s; e += 1) l[e] = w[e + s];
    return l;
  })(), o = {};
  return o.getAt = function(s) {
    return d[s];
  }, o.getLength = function() {
    return d.length;
  }, o.multiply = function(s) {
    let l = new Array(o.getLength() + s.getLength() - 1);
    for (let e = 0; e < o.getLength(); e += 1) for (let t = 0; t < s.getLength(); t += 1) l[e + t] ^= H.gexp(H.glog(o.getAt(e)) + H.glog(s.getAt(t)));
    return K(l, 0);
  }, o.mod = function(s) {
    if (o.getLength() - s.getLength() < 0) return o;
    let l = H.glog(o.getAt(0)) - H.glog(s.getAt(0)), e = new Array(o.getLength());
    for (let t = 0; t < o.getLength(); t += 1) e[t] = o.getAt(t);
    for (let t = 0; t < s.getLength(); t += 1) e[t] ^= H.gexp(H.glog(s.getAt(t)) + l);
    return K(e, 0).mod(s);
  }, o;
};
var Y = (function() {
  let w = [[1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9], [1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16], [1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13], [1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9], [1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12], [2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15], [2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14], [2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15], [2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13], [2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16], [4, 101, 81], [1, 80, 50, 4, 81, 51], [4, 50, 22, 4, 51, 23], [3, 36, 12, 8, 37, 13], [2, 116, 92, 2, 117, 93], [6, 58, 36, 2, 59, 37], [4, 46, 20, 6, 47, 21], [7, 42, 14, 4, 43, 15], [4, 133, 107], [8, 59, 37, 1, 60, 38], [8, 44, 20, 4, 45, 21], [12, 33, 11, 4, 34, 12], [3, 145, 115, 1, 146, 116], [4, 64, 40, 5, 65, 41], [11, 36, 16, 5, 37, 17], [11, 36, 12, 5, 37, 13], [5, 109, 87, 1, 110, 88], [5, 65, 41, 5, 66, 42], [5, 54, 24, 7, 55, 25], [11, 36, 12, 7, 37, 13], [5, 122, 98, 1, 123, 99], [7, 73, 45, 3, 74, 46], [15, 43, 19, 2, 44, 20], [3, 45, 15, 13, 46, 16], [1, 135, 107, 5, 136, 108], [10, 74, 46, 1, 75, 47], [1, 50, 22, 15, 51, 23], [2, 42, 14, 17, 43, 15], [5, 150, 120, 1, 151, 121], [9, 69, 43, 4, 70, 44], [17, 50, 22, 1, 51, 23], [2, 42, 14, 19, 43, 15], [3, 141, 113, 4, 142, 114], [3, 70, 44, 11, 71, 45], [17, 47, 21, 4, 48, 22], [9, 39, 13, 16, 40, 14], [3, 135, 107, 5, 136, 108], [3, 67, 41, 13, 68, 42], [15, 54, 24, 5, 55, 25], [15, 43, 15, 10, 44, 16], [4, 144, 116, 4, 145, 117], [17, 68, 42], [17, 50, 22, 6, 51, 23], [19, 46, 16, 6, 47, 17], [2, 139, 111, 7, 140, 112], [17, 74, 46], [7, 54, 24, 16, 55, 25], [34, 37, 13], [4, 151, 121, 5, 152, 122], [4, 75, 47, 14, 76, 48], [11, 54, 24, 14, 55, 25], [16, 45, 15, 14, 46, 16], [6, 147, 117, 4, 148, 118], [6, 73, 45, 14, 74, 46], [11, 54, 24, 16, 55, 25], [30, 46, 16, 2, 47, 17], [8, 132, 106, 4, 133, 107], [8, 75, 47, 13, 76, 48], [7, 54, 24, 22, 55, 25], [22, 45, 15, 13, 46, 16], [10, 142, 114, 2, 143, 115], [19, 74, 46, 4, 75, 47], [28, 50, 22, 6, 51, 23], [33, 46, 16, 4, 47, 17], [8, 152, 122, 4, 153, 123], [22, 73, 45, 3, 74, 46], [8, 53, 23, 26, 54, 24], [12, 45, 15, 28, 46, 16], [3, 147, 117, 10, 148, 118], [3, 73, 45, 23, 74, 46], [4, 54, 24, 31, 55, 25], [11, 45, 15, 31, 46, 16], [7, 146, 116, 7, 147, 117], [21, 73, 45, 7, 74, 46], [1, 53, 23, 37, 54, 24], [19, 45, 15, 26, 46, 16], [5, 145, 115, 10, 146, 116], [19, 75, 47, 10, 76, 48], [15, 54, 24, 25, 55, 25], [23, 45, 15, 25, 46, 16], [13, 145, 115, 3, 146, 116], [2, 74, 46, 29, 75, 47], [42, 54, 24, 1, 55, 25], [23, 45, 15, 28, 46, 16], [17, 145, 115], [10, 74, 46, 23, 75, 47], [10, 54, 24, 35, 55, 25], [19, 45, 15, 35, 46, 16], [17, 145, 115, 1, 146, 116], [14, 74, 46, 21, 75, 47], [29, 54, 24, 19, 55, 25], [11, 45, 15, 46, 46, 16], [13, 145, 115, 6, 146, 116], [14, 74, 46, 23, 75, 47], [44, 54, 24, 7, 55, 25], [59, 46, 16, 1, 47, 17], [12, 151, 121, 7, 152, 122], [12, 75, 47, 26, 76, 48], [39, 54, 24, 14, 55, 25], [22, 45, 15, 41, 46, 16], [6, 151, 121, 14, 152, 122], [6, 75, 47, 34, 76, 48], [46, 54, 24, 10, 55, 25], [2, 45, 15, 64, 46, 16], [17, 152, 122, 4, 153, 123], [29, 74, 46, 14, 75, 47], [49, 54, 24, 10, 55, 25], [24, 45, 15, 46, 46, 16], [4, 152, 122, 18, 153, 123], [13, 74, 46, 32, 75, 47], [48, 54, 24, 14, 55, 25], [42, 45, 15, 32, 46, 16], [20, 147, 117, 4, 148, 118], [40, 75, 47, 7, 76, 48], [43, 54, 24, 22, 55, 25], [10, 45, 15, 67, 46, 16], [19, 148, 118, 6, 149, 119], [18, 75, 47, 31, 76, 48], [34, 54, 24, 34, 55, 25], [20, 45, 15, 61, 46, 16]], x = function(s, l) {
    let e = {};
    return e.totalCount = s, e.dataCount = l, e;
  }, d = {}, o = function(s, l) {
    switch (l) {
      case j.L:
        return w[(s - 1) * 4 + 0];
      case j.M:
        return w[(s - 1) * 4 + 1];
      case j.Q:
        return w[(s - 1) * 4 + 2];
      case j.H:
        return w[(s - 1) * 4 + 3];
      default:
        return;
    }
  };
  return d.getRSBlocks = function(s, l) {
    let e = o(s, l);
    if (typeof e > "u") throw "bad rs block @ typeNumber:" + s + "/errorCorrectionLevel:" + l;
    let t = e.length / 3, u = [];
    for (let p = 0; p < t; p += 1) {
      let y = e[p * 3 + 0], h = e[p * 3 + 1], a = e[p * 3 + 2];
      for (let _ = 0; _ < y; _ += 1) u.push(x(h, a));
    }
    return u;
  }, d;
})();
var G = function() {
  let w = [], x = 0, d = {};
  return d.getBuffer = function() {
    return w;
  }, d.getAt = function(o) {
    let s = Math.floor(o / 8);
    return (w[s] >>> 7 - o % 8 & 1) == 1;
  }, d.put = function(o, s) {
    for (let l = 0; l < s; l += 1) d.putBit((o >>> s - l - 1 & 1) == 1);
  }, d.getLengthInBits = function() {
    return x;
  }, d.putBit = function(o) {
    let s = Math.floor(x / 8);
    w.length <= s && w.push(0), o && (w[s] |= 128 >>> x % 8), x += 1;
  }, d;
};
var W = function(w) {
  let x = k.MODE_NUMBER, d = w, o = {};
  o.getMode = function() {
    return x;
  }, o.getLength = function(e) {
    return d.length;
  }, o.write = function(e) {
    let t = d, u = 0;
    for (; u + 2 < t.length; ) e.put(s(t.substring(u, u + 3)), 10), u += 3;
    u < t.length && (t.length - u == 1 ? e.put(s(t.substring(u, u + 1)), 4) : t.length - u == 2 && e.put(s(t.substring(u, u + 2)), 7));
  };
  let s = function(e) {
    let t = 0;
    for (let u = 0; u < e.length; u += 1) t = t * 10 + l(e.charAt(u));
    return t;
  }, l = function(e) {
    if ("0" <= e && e <= "9") return e.charCodeAt(0) - 48;
    throw "illegal char :" + e;
  };
  return o;
};
var V = function(w) {
  let x = k.MODE_ALPHA_NUM, d = w, o = {};
  o.getMode = function() {
    return x;
  }, o.getLength = function(l) {
    return d.length;
  }, o.write = function(l) {
    let e = d, t = 0;
    for (; t + 1 < e.length; ) l.put(s(e.charAt(t)) * 45 + s(e.charAt(t + 1)), 11), t += 2;
    t < e.length && l.put(s(e.charAt(t)), 6);
  };
  let s = function(l) {
    if ("0" <= l && l <= "9") return l.charCodeAt(0) - 48;
    if ("A" <= l && l <= "Z") return l.charCodeAt(0) - 65 + 10;
    switch (l) {
      case " ":
        return 36;
      case "$":
        return 37;
      case "%":
        return 38;
      case "*":
        return 39;
      case "+":
        return 40;
      case "-":
        return 41;
      case ".":
        return 42;
      case "/":
        return 43;
      case ":":
        return 44;
      default:
        throw "illegal char :" + l;
    }
  };
  return o;
};
var q = function(w) {
  let x = k.MODE_8BIT_BYTE, d = w, o = v.stringToBytes(w), s = {};
  return s.getMode = function() {
    return x;
  }, s.getLength = function(l) {
    return o.length;
  }, s.write = function(l) {
    for (let e = 0; e < o.length; e += 1) l.put(o[e], 8);
  }, s;
};
var z = function(w) {
  let x = k.MODE_KANJI, d = w, o = v.stringToBytes;
  (function(e, t) {
    let u = o(e);
    if (u.length != 2 || (u[0] << 8 | u[1]) != t) throw "sjis not supported.";
  })("\u53CB", 38726);
  let s = o(w), l = {};
  return l.getMode = function() {
    return x;
  }, l.getLength = function(e) {
    return ~~(s.length / 2);
  }, l.write = function(e) {
    let t = s, u = 0;
    for (; u + 1 < t.length; ) {
      let p = (255 & t[u]) << 8 | 255 & t[u + 1];
      if (33088 <= p && p <= 40956) p -= 33088;
      else if (57408 <= p && p <= 60351) p -= 49472;
      else throw "illegal char at " + (u + 1) + "/" + p;
      p = (p >>> 8 & 255) * 192 + (p & 255), e.put(p, 13), u += 2;
    }
    if (u < t.length) throw "illegal char at " + (u + 1);
  }, l;
};
var J = function() {
  let w = [], x = {};
  return x.writeByte = function(d) {
    w.push(d & 255);
  }, x.writeShort = function(d) {
    x.writeByte(d), x.writeByte(d >>> 8);
  }, x.writeBytes = function(d, o, s) {
    o = o || 0, s = s || d.length;
    for (let l = 0; l < s; l += 1) x.writeByte(d[l + o]);
  }, x.writeString = function(d) {
    for (let o = 0; o < d.length; o += 1) x.writeByte(d.charCodeAt(o));
  }, x.toByteArray = function() {
    return w;
  }, x.toString = function() {
    let d = "";
    d += "[";
    for (let o = 0; o < w.length; o += 1) o > 0 && (d += ","), d += w[o];
    return d += "]", d;
  }, x;
};
var tt = function() {
  let w = 0, x = 0, d = 0, o = "", s = {}, l = function(t) {
    o += String.fromCharCode(e(t & 63));
  }, e = function(t) {
    if (t < 0) throw "n:" + t;
    if (t < 26) return 65 + t;
    if (t < 52) return 97 + (t - 26);
    if (t < 62) return 48 + (t - 52);
    if (t == 62) return 43;
    if (t == 63) return 47;
    throw "n:" + t;
  };
  return s.writeByte = function(t) {
    for (w = w << 8 | t & 255, x += 8, d += 1; x >= 6; ) l(w >>> x - 6), x -= 6;
  }, s.flush = function() {
    if (x > 0 && (l(w << 6 - x), w = 0, x = 0), d % 3 != 0) {
      let t = 3 - d % 3;
      for (let u = 0; u < t; u += 1) o += "=";
    }
  }, s.toString = function() {
    return o;
  }, s;
};
var et = function(w) {
  let x = w, d = 0, o = 0, s = 0, l = {};
  l.read = function() {
    for (; s < 8; ) {
      if (d >= x.length) {
        if (s == 0) return -1;
        throw "unexpected end of file./" + s;
      }
      let u = x.charAt(d);
      if (d += 1, u == "=") return s = 0, -1;
      if (u.match(/^\s$/)) continue;
      o = o << 6 | e(u.charCodeAt(0)), s += 6;
    }
    let t = o >>> s - 8 & 255;
    return s -= 8, t;
  };
  let e = function(t) {
    if (65 <= t && t <= 90) return t - 65;
    if (97 <= t && t <= 122) return t - 97 + 26;
    if (48 <= t && t <= 57) return t - 48 + 52;
    if (t == 43) return 62;
    if (t == 47) return 63;
    throw "c:" + t;
  };
  return l;
};
var nt = function(w, x) {
  let d = w, o = x, s = new Array(w * x), l = {};
  l.setPixel = function(p, y, h) {
    s[y * d + p] = h;
  }, l.write = function(p) {
    p.writeString("GIF87a"), p.writeShort(d), p.writeShort(o), p.writeByte(128), p.writeByte(0), p.writeByte(0), p.writeByte(0), p.writeByte(0), p.writeByte(0), p.writeByte(255), p.writeByte(255), p.writeByte(255), p.writeString(","), p.writeShort(0), p.writeShort(0), p.writeShort(d), p.writeShort(o), p.writeByte(0);
    let y = 2, h = t(y);
    p.writeByte(y);
    let a = 0;
    for (; h.length - a > 255; ) p.writeByte(255), p.writeBytes(h, a, 255), a += 255;
    p.writeByte(h.length - a), p.writeBytes(h, a, h.length - a), p.writeByte(0), p.writeString(";");
  };
  let e = function(p) {
    let y = p, h = 0, a = 0, _ = {};
    return _.write = function(P, D) {
      if (P >>> D) throw "length over";
      for (; h + D >= 8; ) y.writeByte(255 & (P << h | a)), D -= 8 - h, P >>>= 8 - h, a = 0, h = 0;
      a = P << h | a, h = h + D;
    }, _.flush = function() {
      h > 0 && y.writeByte(a);
    }, _;
  }, t = function(p) {
    let y = 1 << p, h = (1 << p) + 1, a = p + 1, _ = u();
    for (let m = 0; m < y; m += 1) _.add(String.fromCharCode(m));
    _.add(String.fromCharCode(y)), _.add(String.fromCharCode(h));
    let P = J(), D = e(P);
    D.write(y, a);
    let E = 0, I = String.fromCharCode(s[E]);
    for (E += 1; E < s.length; ) {
      let m = String.fromCharCode(s[E]);
      E += 1, _.contains(I + m) ? I = I + m : (D.write(_.indexOf(I), a), _.size() < 4095 && (_.size() == 1 << a && (a += 1), _.add(I + m)), I = m);
    }
    return D.write(_.indexOf(I), a), D.write(h, a), D.flush(), P.toByteArray();
  }, u = function() {
    let p = {}, y = 0, h = {};
    return h.add = function(a) {
      if (h.contains(a)) throw "dup key:" + a;
      p[a] = y, y += 1;
    }, h.size = function() {
      return y;
    }, h.indexOf = function(a) {
      return p[a];
    }, h.contains = function(a) {
      return typeof p[a] < "u";
    }, h;
  };
  return l;
};
var rt = function(w, x, d) {
  let o = nt(w, x);
  for (let t = 0; t < x; t += 1) for (let u = 0; u < w; u += 1) o.setPixel(u, t, d(u, t));
  let s = J();
  o.write(s);
  let l = tt(), e = s.toByteArray();
  for (let t = 0; t < e.length; t += 1) l.writeByte(e[t]);
  return l.flush(), "data:image/gif;base64," + l;
};
var it = v;
var st = v.stringToBytes;

// src/mobile/desktop.ts
var grantsSchema = external_exports.array(external_exports.object({ pcId: external_exports.string().min(1).max(128), scope: external_exports.enum(["all", "project"]).optional(), projectIds: external_exports.array(external_exports.string().max(128)).max(100), sessionIds: external_exports.array(external_exports.string().max(128)).max(100), jobIds: external_exports.array(external_exports.string().max(128)).max(100), capabilities: external_exports.array(external_exports.enum(["overview.read", "chat.read", "questions.read", "questions.answer"])).max(4) }).strict()).max(10);
function catalog(pcId, view, folders = /* @__PURE__ */ new Map()) {
  const ids = [.../* @__PURE__ */ new Set([...view.sessions.flatMap((s) => s.projectId ? [s.projectId] : []), ...view.jobs.flatMap((j2) => j2.projectId ? [j2.projectId] : []), ...view.questions.map((q2) => q2.projectId)])];
  const projects = ids.map((id) => {
    const folder = folders.get(id) ?? null;
    return {
      id,
      name: folder ? folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder : null,
      folder,
      sessions: view.sessions.filter((s) => s.projectId === id).length,
      jobs: view.jobs.filter((j2) => j2.projectId === id).length,
      questions: view.questions.filter((q2) => q2.projectId === id && q2.status === "open").length
    };
  }).sort((a, b) => b.sessions - a.sessions || (a.name ?? "\uFFFF").localeCompare(b.name ?? "\uFFFF") || a.id.localeCompare(b.id));
  return { pcId, projects, sessions: view.sessions.map((s) => ({ id: s.id, name: s.name, agent: s.agent, projectId: s.projectId })) };
}
function access(grants) {
  const scope = grants.some((g) => g.scope === "all") ? "all" : grants.some((g) => g.scope === "project") ? "project" : "selected";
  return {
    scope,
    projects: new Set(grants.flatMap((g) => g.projectIds)).size,
    sessions: new Set(grants.flatMap((g) => g.sessionIds)).size,
    jobs: new Set(grants.flatMap((g) => g.jobIds)).size,
    answers: grants.some((g) => g.capabilities.includes("questions.answer"))
  };
}
async function readMobileDesktopBody(stream) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 32 * 1024) throw new MobileFault(413, "body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
var MobileDesktopAdmin = class {
  constructor(store, source, localOrigin, ready = () => true) {
    this.store = store;
    this.source = source;
    this.localOrigin = localOrigin;
    this.ready = ready;
    const origin = new URL(localOrigin);
    if (origin.origin !== localOrigin || !["localhost", "127.0.0.1"].includes(origin.hostname) || origin.protocol !== "http:") throw new Error("Exact loopback desktop origin required");
  }
  store;
  source;
  localOrigin;
  ready;
  isReady() {
    return this.ready();
  }
  csrf = secret();
  async handle(method, path, headers, body) {
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    if (headers["sec-fetch-site"] === "cross-site" || headers.origin && headers.origin !== this.localOrigin) throw new MobileFault(403, "desktop_origin");
    if (method === "GET" && path === "/api/mobile/phones") {
      const view = await this.source.snapshot();
      if (!this.ready()) throw new MobileFault(503, "source_unavailable");
      const devices = this.store.list("device").map(({ grants, revision, ...device }) => ({ ...device, access: access(grants) }));
      return { status: 200, body: {
        csrfToken: this.csrf,
        devices,
        pending: this.store.pending(),
        catalog: catalog(this.store.pcId, view, this.source.projectFolders?.()),
        gatewayOrigins: this.store.origins,
        fingerprints: this.store.pins?.map(shortPin) ?? []
      } };
    }
    if (headers.origin !== this.localOrigin || !equal(headers["x-mobile-admin-csrf"] ?? "", this.csrf)) throw new MobileFault(403, "desktop_csrf");
    const key = external_exports.string().uuid().parse(headers["idempotency-key"]);
    if (body && Buffer.byteLength(body) > 32 * 1024) throw new MobileFault(413, "body_too_large");
    if (body && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers["content-type"] ?? "")) throw new MobileFault(400, "json_required");
    const args = body ? JSON.parse(body) : {};
    if (method === "POST" && path === "/api/mobile/invitations") {
      external_exports.object({}).strict().parse(args);
      const qr = this.store.mutate("desktop-owner", method + path, key, digest("admin", "invite"), () => {
        const invitation = this.store.invite(), payload = JSON.stringify(invitation), qr2 = it(0, "M");
        qr2.addData(payload);
        qr2.make();
        return { response: { qr: invitation, qrPayload: payload, qrSvg: qr2.createSvgTag({ cellSize: 4, margin: 16, scalable: true }) }, replay: { state: "invited" } };
      });
      return { status: 201, body: qr };
    }
    const confirm = /^\/api\/mobile\/claims\/([\w-]+)$/.exec(path);
    if (method === "POST" && confirm) {
      const parsed = external_exports.object({ comparisonCode: external_exports.string().regex(/^\d{6}$/), allow: external_exports.boolean(), grants: grantsSchema }).strict().parse(args);
      const view = await this.source.snapshot();
      if (!this.ready()) throw new MobileFault(503, "source_unavailable");
      for (const grant of parsed.grants) {
        if (grant.scope === "all" && (grant.projectIds.length || grant.sessionIds.length || grant.jobIds.length) || grant.scope === "project" && !grant.projectIds.length) throw new MobileFault(403, "unsupported_grant");
        if (grant.pcId !== this.store.pcId || grant.sessionIds.some((id) => !view.sessions.some((s) => s.id === id)) || grant.jobIds.some((id) => !view.jobs.some((j2) => j2.id === id)) || grant.projectIds.some((id) => ![...view.questions, ...view.sessions, ...view.jobs].some((q2) => q2.projectId === id))) throw new MobileFault(403, "unsupported_grant");
      }
      this.store.mutate("desktop-owner", method + path, key, digest("admin", JSON.stringify(parsed)), () => {
        this.store.confirm(confirm[1], parsed.comparisonCode, parsed.allow, parsed.grants);
        return { response: { state: "recorded" }, replay: { state: "recorded" } };
      });
      return { status: 200, body: { state: "recorded" } };
    }
    const revoke = /^\/api\/mobile\/devices\/([\w-]+)$/.exec(path);
    if (method === "DELETE" && revoke) {
      external_exports.object({}).strict().parse(args);
      this.store.mutate("desktop-owner", method + path, key, digest("admin", "revoke"), () => {
        this.store.revoke(revoke[1]);
        return { response: null, replay: null };
      });
      return { status: 204 };
    }
    throw new MobileFault(404, "unsupported");
  }
};

export {
  publicIdentitySchema,
  keyFingerprint,
  protect,
  decodePairingCode,
  PairingStore,
  DASHBOARD_CAPABILITY,
  DASHBOARD_FRAME,
  DASHBOARD_TIMEOUT_MS,
  DASHBOARD_RATE_LIMIT,
  DASHBOARD_RATE_WINDOW_MS,
  DASHBOARD_MAX_PENDING,
  DASHBOARD_MAX_RESPONSE_BYTES,
  isDashboardReadPath,
  dashboardRequestSchema,
  dashboardWireSchema,
  listRunsResponsive,
  readStoredJobsResponsive,
  classifyPeers,
  readDashboard,
  secret,
  digest,
  MobileFault,
  MobileStore,
  readMobileDesktopBody,
  MobileDesktopAdmin
};
