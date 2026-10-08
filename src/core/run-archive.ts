import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { retentionLimit } from "./json-store.js";
import { readRunLogPreview } from "./run-log-preview.js";

export const DEFAULT_ARCHIVE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const ARCHIVE_AGE_ENV = "AGENT_BRIDGE_ARCHIVE_AGE_MS";
const FINISHED_RUN = /^\d\d:\d\d:\d\d finished after \d+s · [^\r\n]+$/;

/** The feed writes its finish marker last; quoted output earlier in the log is not completion. */
export function finishedRunLine(text: string): string | null {
  const last = text.trimEnd().split("\n").at(-1) ?? "";
  return FINISHED_RUN.test(last) ? last : null;
}

/** Preserve the original basename so metadata and log remain addressable as a pair. */
export function archiveRun(log: string): void {
  if (!finishedRunLine(readRunLogPreview(log))) return;
  const dir = join(log, "..", "archive");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, basename(log));
  if (existsSync(target)) throw new Error(`run archive already exists: ${target}`);
  const meta = log.replace(/\.log$/, ".json");
  const archivedMeta = target.replace(/\.log$/, ".json");
  // Copy metadata before moving the log. On failure either location still has a complete log.
  if (existsSync(meta)) {
    if (existsSync(archivedMeta)) throw new Error(`run metadata archive already exists: ${archivedMeta}`);
    copyFileSync(meta, archivedMeta);
  }
  renameSync(log, target);
  if (existsSync(meta)) renameSync(meta, archivedMeta);
}

/** Includes archives written before AB-84, whose filenames carry a timestamp and UUID suffix. */
export function runLogFiles(home: string): string[] {
  const dir = join(home, "runs");
  return [dir, join(dir, "archive")].flatMap((root) => existsSync(root) ? readdirSync(root)
    .filter((f) => /\.log(?:-\d+-[\w-]+)?$/.test(f)).map((f) => join(root, f)) : []);
}

export function runFileName(path: string): string { return basename(path).replace(/(\.log)-\d+-[\w-]+$/, "$1"); }

export function archivedRunMeta(path: string): string {
  const current = join(path, "..", runFileName(path).replace(/\.log$/, ".json"));
  if (existsSync(current)) return current;
  // Legacy archiveFile renamed log and metadata independently.
  const prefix = runFileName(path).replace(/\.log$/, ".json-");
  const dir = join(path, "..");
  return join(dir, readdirSync(dir).find((f) => f.startsWith(prefix)) ?? basename(current));
}

export function archiveOldRuns(home: string, now = Date.now()): number {
  const age = retentionLimit(ARCHIVE_AGE_ENV, DEFAULT_ARCHIVE_AGE_MS);
  if (!age) return 0;
  let count = 0;
  for (const file of runLogFiles(home).filter((p) => !p.includes(`${join("runs", "archive")}`))) {
    if (statSync(file).mtimeMs < now - age && finishedRunLine(readRunLogPreview(file))) { archiveRun(file); count++; }
  }
  return count;
}
