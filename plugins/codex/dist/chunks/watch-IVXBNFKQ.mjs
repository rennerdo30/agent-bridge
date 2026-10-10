import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RUNS_DIR_NAME,
  finishedRunLine,
  runFileName,
  runLogFiles
} from "./chunk-I6MYXRDE.mjs";
import "./chunk-UNRS7LDN.mjs";
import "./chunk-VBHAVRFY.mjs";
import "./chunk-DLCSA3SJ.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/cli/watch.ts
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
var POLL_MS = 500;
var CHUNK = 64 * 1024;
function findRunLog(home, filter) {
  const dir = join(home, RUNS_DIR_NAME);
  if (!existsSync(dir)) return null;
  const logs = runLogFiles(home).filter((f) => !filter || runFileName(f).includes(filter)).map((path) => ({ path, t: statSync(path).mtimeMs })).sort((a, b) => b.t - a.t);
  return logs[0]?.path ?? null;
}
async function watchRunLog(path, out) {
  let offset = 0;
  let pending = "";
  const decoder = new StringDecoder("utf8");
  for (; ; ) {
    const size = statSync(path).size;
    if (size > offset) {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(Math.min(CHUNK, size - offset));
        const n = readSync(fd, buf, 0, buf.length, offset);
        offset += n;
        pending += decoder.write(buf.subarray(0, n));
      } finally {
        closeSync(fd);
      }
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        out(line);
      }
      if (offset >= size && !pending.trim() && finishedRunLine(lines.join("\n"))) return;
      continue;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
export {
  findRunLog,
  watchRunLog
};
