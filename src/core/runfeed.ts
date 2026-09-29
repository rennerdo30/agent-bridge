import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
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
  report: (message: string) => void;
  end: (summary: string) => void;
}

function stamp(t: number): string {
  return new Date(t).toISOString().slice(11, 19);
}

function pruneOldLogs(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(KEEP_RUN_LOGS)) unlinkSync(join(dir, f));
  } catch {
    // best effort
  }
}

export function startRunFeed(opts: {
  home: string;
  name: string;
  header: string;
  forward?: (message: string) => void;
  now?: () => number;
  heartbeatMs?: number;
}): RunFeed {
  const now = opts.now ?? Date.now;
  const dir = join(opts.home, RUNS_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  pruneOldLogs(dir);
  const logPath = join(dir, `${new Date(now()).toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${opts.name}.log`);
  const write = (line: string) => {
    try {
      appendFileSync(logPath, `${stamp(now())} ${line}\n`);
    } catch {
      // never break a run because of the feed
    }
  };
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
    report: (m) => {
      lastStep = m.split(" · ").pop() ?? m;
      lastAt = now();
      emit(m);
    },
    end: (summary) => {
      clearInterval(timer);
      write(`finished after ${Math.round((now() - started) / 1000)}s · ${summary}`);
    },
  };
}
