import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SLOT_DB_NAME, SLOT_LEASE_MS, type SlotEntry } from "./resource-slots.js";
import { STARTUP_CAPACITY, STARTUP_RESOURCE, STARTUP_ROW_SEPARATOR } from "./startup-admission.js";

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
  /** For kind "job-limit": "root" when the shared root job budget (not this session's own limit) holds it back. */
  scope?: "session" | "root";
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

/**
 * Slot rows a job's processes own are named `<job>-<uuid>` (root budget, resource slots) and, on the startup
 * resource, `<job>~startup-<uuid>`. `~` is not a peer-name character, so job "x-startup" never claims job "x"'s
 * startup row and vice versa. Startup rows of older runners (`startup-<uuid>`, `<job>-startup-<uuid>`) match no job.
 * Case-sensitive: job names are case-sensitive and randomUUID() is lower case.
 */
export function slotWaitFor(entries: readonly SlotEntry[], job: string, capacities: Record<string, number> = {}, now = Date.now()): WaitingFor | null {
  const name = escapeRegExp(job);
  const startupRow = new RegExp(`^${name}${escapeRegExp(STARTUP_ROW_SEPARATOR)}${UUID}$`), slotRow = new RegExp(`^${name}-${UUID}$`);
  const own = entries.filter(e => !e.held && (e.resource === STARTUP_RESOURCE ? startupRow : slotRow).test(e.id) && e.expiresAt - SLOT_LEASE_MS > now - WAIT_FRESH_MS)
    .sort((a, b) => a.ticket - b.ticket)[0];
  if (!own) return null;
  const same = entries.filter(e => e.resource === own.resource);
  const position = 1 + same.filter(e => !e.held && e.ticket < own.ticket).length;
  const holders = same.filter(e => e.held).length;
  if (own.resource === STARTUP_RESOURCE) return { kind: "startup", position, holders, capacity: STARTUP_CAPACITY };
  if (own.resource.startsWith("root-")) return { kind: "job-limit", scope: "root", position, holders, capacity: null };
  return { kind: "resource", resource: own.resource, position, holders, capacity: capacities[own.resource] ?? null };
}

/** How long a display snapshot of the slot queues is reused per home (the dashboard polls every 1.5 s per tab). */
export const SLOT_SNAPSHOT_CACHE_MS = 1_500;
/** Busy timeout of the read-only snapshot connection: a display read never waits long for a writer. */
const SNAPSHOT_BUSY_MS = 50;
const MAX_CACHED_HOMES = 16;
const snapshotCache = new Map<string, { at: number; entries: readonly SlotEntry[] }>();
/** The read-only opener; tests may count opens through it. */
export const slotSnapshotIo = { open: (path: string): DatabaseSync => new DatabaseSync(path, { readOnly: true, timeout: SNAPSHOT_BUSY_MS }) };

/**
 * Display snapshot of the machine's slot queues (unexpired rows, ticket order), the same rows as
 * ResourceSlots.snapshot(): a read-only connection with a short busy timeout, no pragmas, no DDL, no mkdir and
 * nothing created when the database is missing. Readers never write to the slot database; pruning stays with
 * list and acquisition. Errors (busy, an older file without the table) read as "no known wait".
 * `maxAgeMs` reuses a snapshot of the same home read within that window (the dashboard's polls); 0 reads now.
 */
export function readSlotSnapshot(home: string, maxAgeMs = SLOT_SNAPSHOT_CACHE_MS, now = Date.now()): readonly SlotEntry[] {
  const key = resolve(home), cached = snapshotCache.get(key);
  if (cached && maxAgeMs > 0 && now >= cached.at && now - cached.at < maxAgeMs) return cached.entries;
  const entries = readSlotRows(join(home, SLOT_DB_NAME), now);
  snapshotCache.delete(key);
  snapshotCache.set(key, { at: now, entries });
  while (snapshotCache.size > MAX_CACHED_HOMES) snapshotCache.delete(snapshotCache.keys().next().value!);
  return entries;
}

function readSlotRows(path: string, now: number): readonly SlotEntry[] {
  if (!existsSync(path)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = slotSnapshotIo.open(path);
    return Object.freeze(db.prepare("SELECT resource, id, pid, ticket, held, expiresAt FROM slots WHERE expiresAt > ? ORDER BY ticket").all(now)
      .map((row) => Object.freeze({ resource: String(row.resource), id: String(row.id), pid: Number(row.pid), ticket: Number(row.ticket), held: Boolean(row.held), expiresAt: Number(row.expiresAt) })));
  } catch { return []; }
  finally { try { db?.close(); } catch { /* advisory */ } }
}

export interface WaitCandidate { name: string; owner?: string | null; status?: string; startedAt?: number; waitingForStart?: boolean }

/**
 * Waits of stored jobs for the dashboard and /api/state. A job held back by its session's subagent limit is
 * saved with waitingForStart: its position is its place among its session's waiting jobs (oldest first),
 * its holders that session's running jobs. A running job is matched against the slot queues.
 * The desktop dashboard renders a "waiting" pill only for running jobs (slot and startup waits); a stored job-limit
 * wait is not running, so it reaches /api/state and peers but the dashboard shows no pill for it (AB-401).
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
  if (wait.kind === "job-limit" && wait.scope === "root") return `waiting for the shared root job budget: position ${wait.position} in queue`;
  const what = wait.kind === "startup" ? "machine startup admission" : wait.kind === "job-limit" ? "a subagent slot (job limit)" : `machine resource slot "${wait.resource}"`;
  const held = wait.kind === "job-limit" ? "running" : "held";
  return `waiting for ${what}: position ${wait.position} in queue, ${wait.holders}${wait.capacity !== null ? `/${wait.capacity}` : ""} ${held}`;
}
