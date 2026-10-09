import { cloneJson } from "./file-cache.js";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { readIndexedJobs, storeJobRecords, type ArchiveSelection, type IndexedJobSnapshot } from "./job-archive-index.js";

export function readArchivedJobs(path: string): Record<string, unknown>[] {
  return cloneJson(readArchivedJobSnapshot(path).jobs);
}

/** Index identities invalidate cached selections; readers never enumerate archives. */
export function readArchivedJobSnapshot(path: string, selection: ArchiveSelection = {}): IndexedJobSnapshot {
  return readIndexedJobs(path, selection);
}

export function* readArchivedJobSteps(path: string, responsive = false, selection: ArchiveSelection = {}): Generator<void, IndexedJobSnapshot> {
  let canonical: string | undefined;
  try { canonical = realpathSync.native(dirname(path)); } catch { /* No store yet. */ }
  if (responsive) yield;
  if (canonical && realpathSync.native(dirname(path)) !== canonical) throw new Error("job archive ancestor changed during traversal; data kept unchanged");
  return readArchivedJobSnapshot(path, selection);
}

/** Commit full records and all distinct versions before replacing active jobs. */
export function archiveJobs(path: string, jobs: unknown[]): string {
  return storeJobRecords(path, jobs, true);
}
