import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { acquireLock, readJobsDocument } from "../mcp/jobs.js";
import { assertWritableStore, isRecord, JSON_STORE_VERSION, writeJsonStore } from "./json-store.js";
import { readArchivedJobSnapshot } from "./job-archive.js";
import type { Job } from "../mcp/jobs.js";
import { BridgeError, CODING_AGENTS, type PeerInfo } from "./protocol.js";

export const handoffSchema = z.object({
  to: z.string().min(1).max(64),
  jobs: z.union([z.literal("all"), z.array(z.string().min(1).max(80)).min(1).max(1000)]).default("all"),
  note: z.string().max(4000).optional(),
}).strict();
export type HandoffArgs = z.input<typeof handoffSchema>;
export interface OwnershipChange {
  reason?: "explicit-handoff" | "group-failover" | "group-restored";
  id: string; at: number; from: string; to: string; fromRoot?: string; fromRootName?: string; rootSession: string;
  rootName: string; note?: string;
}
export interface HandoffReceipt {
  reason?: "explicit-handoff" | "group-failover" | "group-restored";
  id: string; at: number; from: string; to: string; rootSession: string; note?: string;
  jobs: { id: string; name: string; title: string; status: string; from: string; to: string; oldRoot?: string }[];
}

/** One atomic registry write is the commit point. All other effects can be replayed from this journal. */
export function commitHandoff(path: string, source: PeerInfo, target: PeerInfo, input: HandoffArgs, options: { reason?: "group-failover" | "group-restored" } = {}): HandoffReceipt {
  const args = handoffSchema.parse(input);
  if (source.jobAgent) throw new BridgeError("unauthorized", "Only the current supervisor session can hand off its own jobs.");
  if (target.host || target.name.includes("/") || target.jobAgent || !CODING_AGENTS.includes(target.agent as typeof CODING_AGENTS[number])) {
    throw new BridgeError("bad_request", "The target must be an exact live local Claude Code, Codex or opencode session. Paired-PC handoff is not supported.");
  }
  if (target.name === source.name && options.reason !== "group-restored") throw new BridgeError("bad_request", "Choose another local supervisor session.");
  const unlock = acquireLock(`${path}.lock`, 0);
  try {
    let previous: unknown = null;
    try { previous = JSON.parse(readFileSync(path, "utf8")); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    const migrated = migrateJobOwnership(previous);
    const activeRecords = migrated.jobs as unknown[];
    const byId = new Map<string, Job & Record<string, unknown>>();
    for (const j of [...readArchivedJobSnapshot(path).jobs, ...activeRecords]) {
      if (isRecord(j) && typeof j.id === "string" && typeof j.name === "string") byId.set(j.id, j as unknown as Job & Record<string, unknown>);
    }
    const records = [...byId.values()];
    const own = records.filter((j) => j.owner === source.name && !j.parentJob);
    const selected = args.jobs === "all" ? own : args.jobs.map((name) => {
      const job = own.find((j) => j.name === name);
      if (!job) throw new BridgeError("unauthorized", `Job ${name} is not owned by the current supervisor (use an exact job name).`);
      return job;
    });
    const moved = new Set(selected.map((j) => j.name));
    for (let changed = true; changed;) {
      changed = false;
      for (const j of records) if (j.parentJob && moved.has(j.parentJob) && !moved.has(j.name)) { moved.add(j.name); changed = true; }
    }
    const jobs = records.filter((j) => moved.has(j.name));
    if (!jobs.length) throw new BridgeError("bad_request", "This supervisor has no jobs to hand off.");
    if (jobs.some((j) => j.remote || j.args?.host)) throw new BridgeError("bad_request", "Remote jobs (remote-jobs-v1) cannot be handed off yet. Select only local jobs; no jobs were moved.");
    const existing = records.find((j) => j.owner === target.name && !j.parentJob && j.supervisor);
    const rootSession = existing?.supervisor ?? target.sessionId ?? target.id;
    const receipt: HandoffReceipt = { id: randomUUID(), at: Date.now(), from: source.name, to: target.name, rootSession, note: args.note, reason: options.reason ?? "explicit-handoff",
      jobs: jobs.map((j) => ({ id: j.id, name: j.name, title: String(j.args?.title ?? "Untitled job"), status: j.status,
        from: j.owner ?? source.name, to: j.parentJob ?? target.name, oldRoot: j.rootName })) };
    const updates = new Map(jobs.map((j) => {
      const history = (j as unknown as Record<string, unknown>).ownershipHistory;
      const change: OwnershipChange = { id: receipt.id, at: receipt.at, from: j.owner ?? source.name, to: j.parentJob ?? target.name,
        fromRoot: j.rootSession, fromRootName: j.rootName, rootSession, rootName: target.name, note: args.note, reason: receipt.reason };
      // Grants name the supervisor explicitly in some older records. Other grants are retained verbatim.
      const sendTo = j.args?.send_to;
      return [j.id, { ...j, owner: change.to, supervisor: rootSession, rootSession, rootName: target.name, masters: [...new Set([target.name, source.name, ...(Array.isArray(j.masters) ? j.masters : [])])],
        ...(j.status === "running" && !j.host ? { executionOwner: (j as unknown as Record<string, unknown>).executionOwner ?? j.owner } : {}),
        args: { ...j.args, ...(Array.isArray(sendTo) ? { send_to: [...new Set(sendTo.map((name) => name === source.name ? target.name : name))] } : {}) },
        ownershipHistory: [...(Array.isArray(history) ? history : []), change] }];
    }));
    const active = Array.isArray(previous) ? previous : isRecord(previous) && Array.isArray(previous.jobs) ? previous.jobs : [];
    const ids = new Set(active.filter(isRecord).map((j) => j.id));
    const all = active.map((j) => isRecord(j) ? updates.get(String(j.id)) ?? j : j);
    for (const [id, job] of updates) if (!ids.has(id)) all.push(job); // An active override preserves the immutable archive.
    const journal = isRecord(previous) && Array.isArray(previous.handoffs) ? previous.handoffs : [];
    writeJsonStore(path, { ...migrated, jobs: all, handoffs: [...journal, receipt] }, previous);
    return receipt;
  } finally { unlock(); }
}

export function handoffJournal(path: string): HandoffReceipt[] {
  const value = readJobsDocument(path);
  return isRecord(value) && Array.isArray(value.handoffs) ? value.handoffs as HandoffReceipt[] : [];
}

/** Version 3 is additive; every old field and record survives. Publishing backs up the old file first. */
export function migrateJobOwnership(previous: unknown): Record<string, unknown> {
  assertWritableStore(previous);
  if (previous !== null && !Array.isArray(previous) && (!isRecord(previous) || !Array.isArray(previous.jobs))) throw new Error("Invalid job registry; migration left it untouched.");
  const jobs = Array.isArray(previous) ? previous : isRecord(previous) ? previous.jobs as unknown[] : [];
  if (isRecord(previous) && previous.handoffs !== undefined && !Array.isArray(previous.handoffs)) throw new Error("Invalid handoff history; migration left it untouched.");
  return { ...(isRecord(previous) ? previous : {}), version: JSON_STORE_VERSION, jobs, handoffs: isRecord(previous) ? previous.handoffs ?? [] : [] };
}
