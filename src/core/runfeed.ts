import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Live feed of one delegated run: every progress line goes to ~/.agent-bridge/runs/<name>.log (so the
 * user can follow it with `agent-bridge watch`), and a heartbeat reports quiet phases, so a long
 * thinking or test phase never looks like a hang.
 */
export const RUNS_DIR_NAME = "runs";
/** Report a quiet phase after this long without a new step, then again at the same interval. */
export const HEARTBEAT_MS = 60_000;
const KEEP_RUN_LOGS = 50;

export interface RunFeed {
  logPath: string;
  report: (message: string, full?: string) => void;
  end: (summary: string, answer?: string) => void;
  /** Add facts to the run's metadata file (e.g. the subagent's session once known). */
  meta: (patch: RunMeta) => void;
}

/** Who started a run and how it relates to others; the dashboard groups runs with it. Kept next to the log. */
export interface RunMeta {
  /** Peer name of the session that started it, its agent kind and project folder. */
  by?: string;
  byAgent?: string;
  byCwd?: string;
  /** Job name (e.g. codex-job-1a2b3c4d); follow-ups share it. */
  job?: string;
  model?: string | null;
  access?: string;
  workdir?: string;
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
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(KEEP_RUN_LOGS)) {
      unlinkSync(join(dir, f));
      try {
        unlinkSync(join(dir, runMetaPath(f)));
      } catch {
        // older runs have no metadata
      }
    }
  } catch {
    // best effort
  }
}

export function startRunFeed(opts: {
  home: string;
  name: string;
  header: string;
  forward?: (message: string) => void;
  meta?: RunMeta;
  now?: () => number;
  heartbeatMs?: number;
}): RunFeed {
  const now = opts.now ?? Date.now;
  const dir = join(opts.home, RUNS_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  pruneOldLogs(dir);
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
  const writeMeta = () => {
    try {
      writeFileSync(runMetaPath(logPath), JSON.stringify(meta));
    } catch {
      // never break a run because of the feed
    }
  };
  writeMeta();
  write(opts.header);

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
      if (answer?.trim()) write(`answer: ${answer.trim()}`);
      write(`finished after ${Math.round((now() - started) / 1000)}s · ${summary}`);
    },
    meta: (patch) => {
      meta = { ...meta, ...patch };
      writeMeta();
    },
  };
}
