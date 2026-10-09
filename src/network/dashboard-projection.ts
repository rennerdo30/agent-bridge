import { isRecord } from "../core/json-store.js";

const RUN_STATUSES = new Set(["running", "done", "failed", "interrupted", "cancelled"]);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * A paired PC's run summary with the fields the page renders as markup or numbers checked (AB-231): an unknown
 * status reads as interrupted, and non-numeric progress or times are dropped (start and update times become 0).
 */
function sanitizeRun(run: Record<string, unknown>): Record<string, unknown> {
  const next = { ...run };
  if (!RUN_STATUSES.has(next.status as string)) next.status = "interrupted";
  for (const field of ["percent", "etaAt"]) if (field in next && !finite(next[field])) delete next[field];
  for (const field of ["startedAt", "updatedAt"]) if (!finite(next[field])) next[field] = 0;
  return next;
}

/** Qualify dashboard addresses, keeping transcript IDs and paging cursors native to the host. */
export function markRemoteDashboard(value: unknown, host: string): unknown {
  if (!isRecord(value)) return value;
  const qualify = (name: unknown) => typeof name === "string" && name && !name.includes("/") ? `${host}/${name}` : name;
  const item = (raw: unknown, address = false): unknown => {
    if (!isRecord(raw)) return raw;
    const next: Record<string, unknown> = { ...raw, host };
    if (address) for (const field of ["name", "job", "by", "owner", "parentJob", "rootName"]) if (field in next) next[field] = qualify(next[field]);
    if (isRecord(next.subagent)) next.subagent = { ...next.subagent, host };
    return next;
  };
  const result: Record<string, unknown> = { ...value, host };
  for (const key of ["items", "subagents"]) if (Array.isArray(value[key])) result[key] = value[key].map((raw) => item(raw));
  if (Array.isArray(value.runs)) result.runs = value.runs.map((raw) => item(isRecord(raw) ? sanitizeRun(raw) : raw, true));
  else if (isRecord(value.runs)) result.runs = Object.fromEntries(Object.entries(value.runs).map(([key, raw]) => [qualify(key), item(raw)]));
  if (isRecord(value.jobs)) result.jobs = Object.fromEntries(Object.entries(value.jobs).map(([key, raw]) => [qualify(key), item(raw)]));
  if (isRecord(value.groups)) result.groups = Object.fromEntries(Object.entries(value.groups).map(([key, names]) => [key, Array.isArray(names) ? names.map(qualify) : names]));
  return result;
}
