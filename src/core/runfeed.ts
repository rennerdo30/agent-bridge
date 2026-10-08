import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord, mergeStoreFields, readJsonStore, retentionLimit, writeJsonStore } from "./json-store.js";
import { archiveOldRuns, archiveRun, finishedRunLine } from "./run-archive.js";
import { storageLease } from "./storage-lock.js";
import { refreshStorePeerIdentities } from "./store-compatibility.js";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Live feed of one delegated run: every progress line goes to ~/.agent-bridge/runs/<name>.log (so the
 * user can follow it with `agent-bridge watch`), and a heartbeat reports quiet phases, so a long
 * thinking or test phase never looks like a hang.
 */
export const RUNS_DIR_NAME = "runs";
/** Report a quiet phase after this long without a new step, then again at the same interval. */
export const HEARTBEAT_MS = 60_000;
const KEEP_RUN_LOGS = 50;
const STALE_RUN_MS = 150_000;

export interface RunFeed {
  logPath: string;
  report: (message: string, full?: string) => void;
  end: (summary: string, answer?: string) => void;
  /** Add facts to the run's metadata file (e.g. the subagent's session once known). */
  meta: (patch: RunMeta) => void;
}

/** Who started a run and how it relates to others; the dashboard groups runs with it. Kept next to the log. */
export interface RunMeta {
  /** Remote job location, on the requesting PC's mirrored feed. */
  remote?: { host: string; name: string };
  /** Additive ancestry contract, independent of the JSON store envelope version. */
  metadataVersion?: number;
  bridgeVersion?: string;
  parentJob?: string;
  rootSession?: string;
  /** Peer name of the session that started it, its agent kind and project folder. */
  by?: string;
  byAgent?: string;
  byCwd?: string;
  /** Job name (e.g. codex-job-1a2b3c4d); follow-ups share it. */
  job?: string;
  /** Short title the starting agent gave the subagent. */
  title?: string;
  /** The subagent's own progress estimate (report_progress) and when it came. */
  percent?: number;
  progressNote?: string;
  /** Absolute estimated completion and report receipt time, in epoch milliseconds. */
  etaAt?: number;
  etaReportedAt?: number;
  progressAt?: number;
  model?: string | null;
  /** Reasoning effort: the one asked for, else what the CLI reported or its configured default. */
  effort?: string | null;
  access?: string;
  /** The permission level it really runs at: Codex sandbox, Claude permission mode, opencode approval. */
  permission?: string;
  workdir?: string;
  /** Git identity and the final tip, retained after worktree cleanup. */
  branch?: string;
  baseBranch?: string | null;
  repoRoot?: string;
  branchHead?: string;
  jobStartedAt?: number;
  /** The subagent's own session, and the one this run continued (a follow-up). */
  session?: string | null;
  continues?: string | null;
}

export function runMetaPath(logPath: string): string {
  return logPath.replace(/\.log$/, ".json");
}

/** Indent for the extra lines of a multi-line log entry (width of the "HH:MM:SS " stamp). */
export const CONTINUATION = "         ";

/** Local time, like the user's clock. */
function stamp(t: number): string {
  return new Date(t).toTimeString().slice(0, 8);
}

function pruneOldLogs(dir: string): void {
  try {
    archiveOldRuns(join(dir, ".."));
    const limit = retentionLimit("AGENT_BRIDGE_RUN_LOG_LIMIT", KEEP_RUN_LOGS);
    if (!limit) return;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(limit)) {
      const path = join(dir, f);
      if (Date.now() - statSync(path).mtimeMs <= STALE_RUN_MS && !finishedRunLine(readFileSync(path, "utf8"))) continue;
      archiveRun(path);
    }
  } catch (err) {
    process.stderr.write(`could not archive run logs: ${String(err)}\n`);
  }
}

export interface RunFeedOptions {
  home: string;
  name: string;
  header: string;
  forward?: (message: string) => void;
  meta?: RunMeta;
  now?: () => number;
  heartbeatMs?: number;
  /** A delegated turn must retain its initial context before launching its CLI. */
  requireMetadata?: boolean;
}

/** Per-turn admission: a supervisor reload can publish a new reader after the
 * runner's startup scan. A raced deferred write is retried before any log/CLI. */
export async function startRunFeedReady(opts: RunFeedOptions, signal: AbortSignal): Promise<RunFeed> {
  let queued = false;
  for (;;) {
    signal.throwIfAborted();
    await refreshStorePeerIdentities(opts.home, signal);
    signal.throwIfAborted();
    try { return startRunFeed({ ...opts, requireMetadata: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "STORE_UPGRADE_DEFERRED") throw error;
      if (!queued) { opts.forward?.("queued: waiting for compatible storage readers to retain run context"); queued = true; }
      try { await delay(250, undefined, { signal }); }
      catch (error) { signal.throwIfAborted(); throw error; }
    }
  }
}

export function startRunFeed(opts: RunFeedOptions): RunFeed {
  const now = opts.now ?? Date.now;
  const release = storageLease(opts.home);
  const dir = join(opts.home, RUNS_DIR_NAME);
  const logPath = join(dir, `${new Date(now()).toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${opts.name}.log`);
  /** One entry; extra lines of a multi-line text are indented under it. */
  const write = (line: string) => {
    const [first, ...rest] = line.replace(/\r/g, "").split("\n");
    const body = [first, ...rest.map((l) => `${CONTINUATION}${l}`)].join("\n");
    try {
      appendFileSync(logPath, `${stamp(now())} ${body}\n`);
    } catch {
      // never break a run because of the feed
    }
  };
  let meta: RunMeta = { ...opts.meta };
  const writeMeta = (required = false) => {
    try {
      const path = runMetaPath(logPath);
      const previous = readJsonStore(path);
      writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { ...meta }), previous);
    } catch (err) {
      if (required) throw err;
      process.stderr.write(`could not save run metadata: ${String(err)}\n`);
      // never break a run because of the feed
    }
  };
  try { mkdirSync(dir, { recursive: true }); writeMeta(opts.requireMetadata); }
  catch (error) { release(); throw error; }
  write(opts.header);
  pruneOldLogs(dir);

  const started = now();
  let lastStep = "starting";
  let lastAt = started;
  const emit = (m: string) => {
    write(m);
    opts.forward?.(m);
  };
  emit(`started · follow live: agent-bridge watch ${opts.name}`);
  const timer = setInterval(() => {
    const quietMin = Math.floor((now() - lastAt) / 60_000);
    if (quietMin >= 1) emit(`still working, no new step for ${quietMin}m (last: ${lastStep})`);
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref();

  return {
    logPath,
    report: (m, full) => {
      lastStep = m.split(" · ").pop() ?? m;
      lastAt = now();
      // The log keeps the full text (whole message or command); the host gets the short line.
      write(full ?? m);
      opts.forward?.(m);
    },
    end: (summary, answer) => {
      clearInterval(timer);
      meta = { ...meta, etaAt: undefined, etaReportedAt: undefined };
      writeMeta();
      if (answer?.trim()) write(`answer: ${answer.trim()}`);
      write(`finished after ${Math.round((now() - started) / 1000)}s · ${summary}`);
      release();
    },
    meta: (patch) => {
      meta = { ...meta, ...patch };
      writeMeta();
    },
  };
}
