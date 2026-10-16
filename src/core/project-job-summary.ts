import { MAX_FRAME_BYTES } from "./constants.js";

/**
 * The few fields `peers` shows or filters on for a shared project job (AB-404). Full stored job records carry
 * prompts, delivery history and retained run settings; thousands of them do not fit one broker frame.
 */
export interface ProjectJobSummary {
  id?: string;
  name: string;
  agent: string;
  status: string;
  owner?: string;
  supervisor?: string;
  title?: string;
  cwd?: string;
  workdir?: string;
  projectRoot?: string;
  finishedAt?: number;
  /** The job's own agent session is known, so it can be continued. */
  hasSession: boolean;
  remote?: { host: string; name: string };
}

export interface ProjectJobSummaryPage { jobs: ProjectJobSummary[]; total: number; nextOffset: number | null }

export const PROJECT_JOB_SUMMARY_PAGE_MAX = 5_000;
/** Room kept below the frame limit for the response envelope. */
const PAGE_MAX_BYTES = MAX_FRAME_BYTES - 64 * 1024;
const MAX_FIELD_CHARS = 1_024;

const str = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  if (value.length <= MAX_FIELD_CHARS) return value;
  // Never leave half a surrogate pair at the cut.
  const end = /[\uD800-\uDBFF]/.test(value[MAX_FIELD_CHARS - 1]!) ? MAX_FIELD_CHARS - 1 : MAX_FIELD_CHARS;
  return value.slice(0, end);
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function summarizeProjectJob(job: Record<string, unknown>): ProjectJobSummary {
  const args = record(job.args), remote = record(job.remote);
  const summary: ProjectJobSummary = { name: str(job.name) ?? "", agent: str(job.agent) ?? "unknown", status: str(job.status) ?? "unknown",
    hasSession: typeof job.sessionId === "string" && job.sessionId.length > 0 };
  const id = str(job.id), owner = str(job.owner), supervisor = str(job.supervisor), title = str(args?.title);
  const cwd = str(args?.cwd), workdir = str(job.workdir), projectRoot = str(job.projectRoot);
  if (id !== undefined) summary.id = id;
  if (owner !== undefined) summary.owner = owner;
  if (supervisor !== undefined) summary.supervisor = supervisor;
  if (title !== undefined) summary.title = title;
  if (cwd !== undefined) summary.cwd = cwd;
  if (workdir !== undefined) summary.workdir = workdir;
  if (projectRoot !== undefined) summary.projectRoot = projectRoot;
  if (typeof job.finishedAt === "number") summary.finishedAt = job.finishedAt;
  const host = str(remote?.host), remoteName = str(remote?.name);
  if (host !== undefined && remoteName !== undefined) summary.remote = { host, name: remoteName };
  return summary;
}

/** Deterministic order (name, then id) so offsets page stably while the registry is unchanged. */
export function compareProjectJobSummaries(a: ProjectJobSummary, b: ProjectJobSummary): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : (a.id ?? "") < (b.id ?? "") ? -1 : (a.id ?? "") > (b.id ?? "") ? 1 : 0;
}

/** One page of summaries that always fits one broker frame, however many jobs are retained. */
export function pageProjectJobSummaries(jobs: readonly Record<string, unknown>[], options: { offset?: number; limit?: number } = {},
  maxBytes = PAGE_MAX_BYTES): ProjectJobSummaryPage {
  const all = jobs.map(summarizeProjectJob).sort(compareProjectJobSummaries);
  const offset = Math.max(0, options.offset ?? 0), limit = Math.min(options.limit ?? PROJECT_JOB_SUMMARY_PAGE_MAX, PROJECT_JOB_SUMMARY_PAGE_MAX);
  const page: ProjectJobSummary[] = [];
  let bytes = 0;
  for (let i = offset; i < all.length && page.length < limit; i++) {
    const size = Buffer.byteLength(JSON.stringify(all[i])) + 1;
    // Every field is capped, so a single summary always fits; never return an empty page before the end.
    if (page.length > 0 && bytes + size > maxBytes) break;
    page.push(all[i]!);
    bytes += size;
  }
  const end = offset + page.length;
  return { jobs: page, total: all.length, nextOffset: end < all.length ? end : null };
}
