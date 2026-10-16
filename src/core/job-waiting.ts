import { existsSync } from "node:fs";
import { join } from "node:path";
import { ResourceSlots, SLOT_DB_NAME, SLOT_LEASE_MS, type SlotEntry } from "./resource-slots.js";
import { STARTUP_CAPACITY, STARTUP_RESOURCE } from "./startup-admission.js";

/**
 * AB-401: what a job is queued for on this machine, so a queued job is not mistaken for a stuck one.
 * - "startup": machine-wide startup admission (delegate-startup slots, at most STARTUP_CAPACITY at once).
 * - "job-limit": the session's subagent limit (maxJobs) or the root session's shared job budget.
 * - "resource": a configured resource slot such as unity or blender, taken with the slot CLI.
 * Display only: it is derived from state the queues already keep and never changes admission.
 */
export type WaitKind = "startup" | "job-limit" | "resource";
export interface WaitingFor {
  kind: WaitKind;
  /** The resource slot name, for kind "resource". */
  resource?: string;
  /** 1 = next in line. */
  position: number;
  /** Current holders of the slot kind (running jobs for the job limit). */
  holders: number;
  /** Capacity, when known. */
  capacity: number | null;
}

/**
 * A waiter polls its queue every 250 ms (a busy database every few seconds) and every poll renews its row's lease.
 * A waiting row not touched for this long belongs to a process that stopped polling: that is a stall, not a wait.
 */
export const WAIT_FRESH_MS = 30_000;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Slot rows a job's processes own are named `<job>-<uuid>` (root budget, resource slots) or `<job>-startup-<uuid>`. */
export function slotWaitFor(entries: readonly SlotEntry[], job: string, capacities: Record<string, number> = {}, now = Date.now()): WaitingFor | null {
  const owned = new RegExp(`^${escapeRegExp(job)}-(?:startup-)?${UUID}$`, "i");
  const own = entries.filter(e => !e.held && owned.test(e.id) && e.expiresAt - SLOT_LEASE_MS > now - WAIT_FRESH_MS)
    .sort((a, b) => a.ticket - b.ticket)[0];
  if (!own) return null;
  const same = entries.filter(e => e.resource === own.resource);
  const position = 1 + same.filter(e => !e.held && e.ticket < own.ticket).length;
  const holders = same.filter(e => e.held).length;
  if (own.resource === STARTUP_RESOURCE) return { kind: "startup", position, holders, capacity: STARTUP_CAPACITY };
  if (own.resource.startsWith("root-")) return { kind: "job-limit", position, holders, capacity: null };
  return { kind: "resource", resource: own.resource, position, holders, capacity: capacities[own.resource] ?? null };
}

/**
 * Display snapshot of the machine's slot queues: one indexed read, no process probes, no writes, and nothing
 * created when no slot was ever used. Errors read as "no known wait"; slot state is advisory here.
 */
export function readSlotSnapshot(home: string): SlotEntry[] {
  if (!existsSync(join(home, SLOT_DB_NAME))) return [];
  let slots: ResourceSlots | null = null;
  try { slots = new ResourceSlots(home); return slots.snapshot(); }
  catch { return []; }
  finally { try { slots?.close(); } catch { /* advisory */ } }
}

export interface WaitCandidate { name: string; owner?: string | null; status?: string; startedAt?: number; waitingForStart?: boolean }

/**
 * Waits of stored jobs for the dashboard and /api/state. A job held back by its session's subagent limit is
 * saved with waitingForStart: its position is its place among its session's waiting jobs (oldest first),
 * its holders that session's running jobs. A running job is matched against the slot queues.
 */
export function storedJobWaits(jobs: readonly WaitCandidate[], entries: () => readonly SlotEntry[], capacities: () => Record<string, number>, now = Date.now()): Map<string, WaitingFor> {
  const out = new Map<string, WaitingFor>();
  const startWaiters = jobs.filter(j => j.waitingForStart && j.status !== "paused");
  for (const job of startWaiters) {
    const peers = startWaiters.filter(j => (j.owner ?? null) === (job.owner ?? null)).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.name.localeCompare(b.name));
    const holders = jobs.filter(j => (j.owner ?? null) === (job.owner ?? null) && j.status === "running" && !j.waitingForStart).length;
    out.set(job.name, { kind: "job-limit", position: peers.indexOf(job) + 1, holders, capacity: null });
  }
  const running = jobs.filter(j => j.status === "running" && !j.waitingForStart);
  if (!running.length) return out;
  const snapshot = entries();
  if (!snapshot.some(e => !e.held)) return out;
  let caps: Record<string, number> | null = null;
  for (const job of running) {
    const wait = slotWaitFor(snapshot, job.name, {}, now);
    if (!wait) continue;
    if (wait.kind === "resource") { caps ??= capacities(); wait.capacity = caps[wait.resource!] ?? null; }
    out.set(job.name, wait);
  }
  return out;
}

/** One line for peers and job status: what it waits for, its place in line and who holds the slots. */
export function waitingText(wait: WaitingFor): string {
  const what = wait.kind === "startup" ? "machine startup admission" : wait.kind === "job-limit" ? "a subagent slot (job limit)" : `machine resource slot "${wait.resource}"`;
  const held = wait.kind === "job-limit" ? "running" : "held";
  return `waiting for ${what}: position ${wait.position} in queue, ${wait.holders}${wait.capacity !== null ? `/${wait.capacity}` : ""} ${held}`;
}
