import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { RUNS_DIR_NAME } from "../core/runfeed.js";

const POLL_MS = 500;
const CHUNK = 64 * 1024;
const FINISHED = / finished after \d+s · /;

/** Newest run log, or the newest whose name contains `filter`. */
export function findRunLog(home: string, filter?: string): string | null {
  const dir = join(home, RUNS_DIR_NAME);
  if (!existsSync(dir)) return null;
  const logs = readdirSync(dir)
    .filter((f) => f.endsWith(".log") && (!filter || f.includes(filter)))
    .map((f) => ({ path: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return logs[0]?.path ?? null;
}

/** Print a run log and follow it until the run finishes (or Ctrl+C). */
export async function watchRunLog(path: string, out: (s: string) => void): Promise<void> {
  let offset = 0;
  let pending = "";
  const decoder = new StringDecoder("utf8");
  for (;;) {
    const size = statSync(path).size;
    if (size > offset) {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(Math.min(CHUNK, size - offset));
        const n = readSync(fd, buf, 0, buf.length, offset);
        offset += n;
        // A chunk can end inside a multi-byte character: the decoder keeps the partial bytes for the next read.
        pending += decoder.write(buf.subarray(0, n));
      } finally {
        closeSync(fd);
      }
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        out(line);
        if (FINISHED.test(line)) return;
      }
      continue;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
