import type { PeerInfo } from "./protocol.js";

export type OwnedJob = Record<string, unknown>;
function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }

export function primaryFor(job: OwnedJob): string {
  return (!job.parentJob && (!Array.isArray(job.ownershipHistory) || !job.ownershipHistory.length) ? text(job.owner) : undefined) ?? text(job.rootName) ?? text(job.owner) ?? "";
}

/** Persisted grants and historical primaries remain masters; nested parent jobs are not sessions. */
export function mastersFor(job: OwnedJob): string[] {
  const history = Array.isArray(job.ownershipHistory) ? job.ownershipHistory : [];
  const names = [job.parentJob || !text(job.owner) || history.length ? text(job.rootName) : undefined, !job.parentJob ? text(job.owner) : undefined,
    ...(Array.isArray(job.masters) ? job.masters.filter((v): v is string => typeof v === "string") : []),
    ...history.flatMap((h) => h && typeof h === "object" ? [text(h.fromRootName), text(h.rootName), !job.parentJob ? text(h.from) : undefined, !job.parentJob ? text(h.to) : undefined] : [])];
  return [...new Set(names.filter((v): v is string => Boolean(v) && !v!.includes("/")))];
}

export function canControlJob(job: OwnedJob, name: string, groupMasters: readonly PeerInfo[] = []): boolean {
  return !name.includes("/") && (mastersFor(job).includes(name) || groupMasters.some((p) => p.name === name && !p.host && !p.jobAgent && !p.subagent));
}

/** Routing never mutates the primary. When it returns, only future mail returns to it. */
export function chooseJobRecipient(job: OwnedJob, livePeers: readonly PeerInfo[], groupMasters: readonly PeerInfo[] = []): string {
  const primary = primaryFor(job);
  const live = new Set(livePeers.filter((p) => !p.host && !p.jobAgent && !p.subagent && !p.unavailable && !p.name.includes("/")).map((p) => p.name));
  if (live.has(primary)) return primary;
  const history = Array.isArray(job.ownershipHistory) ? job.ownershipHistory : [];
  const previous = history.slice().reverse().flatMap((h) => h && typeof h === "object" ? [text(h.fromRootName), !job.parentJob ? text(h.from) : undefined] : []);
  const grants = mastersFor(job).slice().reverse();
  const group = [...groupMasters].sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name));
  return [...previous, ...grants, ...group.map((p) => p.name)].find((name) => name && live.has(name)) ?? primary;
}
