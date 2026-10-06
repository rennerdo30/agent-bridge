import { isRecord } from "../core/json-store.js";

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
  if (Array.isArray(value.runs)) result.runs = value.runs.map((raw) => item(raw, true));
  else if (isRecord(value.runs)) result.runs = Object.fromEntries(Object.entries(value.runs).map(([key, raw]) => [qualify(key), item(raw)]));
  if (isRecord(value.jobs)) result.jobs = Object.fromEntries(Object.entries(value.jobs).map(([key, raw]) => [qualify(key), item(raw)]));
  if (isRecord(value.groups)) result.groups = Object.fromEntries(Object.entries(value.groups).map(([key, names]) => [key, Array.isArray(names) ? names.map(qualify) : names]));
  return result;
}
