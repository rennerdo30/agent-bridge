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
  report: (message: string, full?: string) => void;
  end: (summary: string, answer?: string) => void;
}

/** Indent for the extra lines of a multi-line log entry (width of the "HH:MM:SS " stamp). */
export const CONTINUATION = "         ";

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
  };
}
