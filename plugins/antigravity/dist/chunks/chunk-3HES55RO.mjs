import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  STARTUP_CAPACITY,
  STARTUP_RESOURCE,
  STARTUP_ROW_SEPARATOR
} from "./chunk-H4MCWVYM.mjs";
import {
  SLOT_DB_NAME,
  SLOT_LEASE_MS
} from "./chunk-IQTX2O5D.mjs";

// src/core/job-waiting.ts
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
var WAIT_FRESH_MS = 3e4;
var UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
var escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function slotWaitFor(entries, job, capacities = {}, now = Date.now()) {
  const name = escapeRegExp(job);
  const startupRow = new RegExp(`^${name}${escapeRegExp(STARTUP_ROW_SEPARATOR)}${UUID}$`), slotRow = new RegExp(`^${name}-${UUID}$`);
  const own = entries.filter((e) => !e.held && (e.resource === STARTUP_RESOURCE ? startupRow : slotRow).test(e.id) && e.expiresAt - SLOT_LEASE_MS > now - WAIT_FRESH_MS).sort((a, b) => a.ticket - b.ticket)[0];
  if (!own) return null;
  const same = entries.filter((e) => e.resource === own.resource);
  const position = 1 + same.filter((e) => !e.held && e.ticket < own.ticket).length;
  const holders = same.filter((e) => e.held).length;
  if (own.resource === STARTUP_RESOURCE) return { kind: "startup", position, holders, capacity: STARTUP_CAPACITY };
  if (own.resource.startsWith("root-")) return { kind: "job-limit", scope: "root", position, holders, capacity: null };
  return { kind: "resource", resource: own.resource, position, holders, capacity: capacities[own.resource] ?? null };
}
var SLOT_SNAPSHOT_CACHE_MS = 1500;
var SNAPSHOT_BUSY_MS = 50;
var MAX_CACHED_HOMES = 16;
var snapshotCache = /* @__PURE__ */ new Map();
var slotSnapshotIo = { open: (path) => new DatabaseSync(path, { readOnly: true, timeout: SNAPSHOT_BUSY_MS }) };
function readSlotSnapshot(home, maxAgeMs = SLOT_SNAPSHOT_CACHE_MS, now = Date.now()) {
  const key = resolve(home), cached = snapshotCache.get(key);
  if (cached && maxAgeMs > 0 && now >= cached.at && now - cached.at < maxAgeMs) return cached.entries;
  const entries = readSlotRows(join(home, SLOT_DB_NAME), now);
  snapshotCache.delete(key);
  snapshotCache.set(key, { at: now, entries });
  while (snapshotCache.size > MAX_CACHED_HOMES) snapshotCache.delete(snapshotCache.keys().next().value);
  return entries;
}
function readSlotRows(path, now) {
  if (!existsSync(path)) return [];
  let db = null;
  try {
    db = slotSnapshotIo.open(path);
    return Object.freeze(db.prepare("SELECT resource, id, pid, ticket, held, expiresAt FROM slots WHERE expiresAt > ? ORDER BY ticket").all(now).map((row) => Object.freeze({ resource: String(row.resource), id: String(row.id), pid: Number(row.pid), ticket: Number(row.ticket), held: Boolean(row.held), expiresAt: Number(row.expiresAt) })));
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
function storedJobWaits(jobs, entries, capacities, now = Date.now()) {
  const out = /* @__PURE__ */ new Map();
  const startWaiters = jobs.filter((j) => j.waitingForStart && j.status !== "paused");
  for (const job of startWaiters) {
    const peers = startWaiters.filter((j) => (j.owner ?? null) === (job.owner ?? null)).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.name.localeCompare(b.name));
    const holders = jobs.filter((j) => (j.owner ?? null) === (job.owner ?? null) && j.status === "running" && !j.waitingForStart).length;
    out.set(job.name, { kind: "job-limit", position: peers.indexOf(job) + 1, holders, capacity: null });
  }
  const running = jobs.filter((j) => j.status === "running" && !j.waitingForStart);
  if (!running.length) return out;
  const snapshot = entries();
  if (!snapshot.some((e) => !e.held)) return out;
  let caps = null;
  for (const job of running) {
    const wait = slotWaitFor(snapshot, job.name, {}, now);
    if (!wait) continue;
    if (wait.kind === "resource") {
      caps ??= capacities();
      wait.capacity = caps[wait.resource] ?? null;
    }
    out.set(job.name, wait);
  }
  return out;
}
function waitingText(wait) {
  if (wait.kind === "job-limit" && wait.scope === "root") return `waiting for the shared root job budget: position ${wait.position} in queue`;
  const what = wait.kind === "startup" ? "machine startup admission" : wait.kind === "job-limit" ? "a subagent slot (job limit)" : `machine resource slot "${wait.resource}"`;
  const held = wait.kind === "job-limit" ? "running" : "held";
  return `waiting for ${what}: position ${wait.position} in queue, ${wait.holders}${wait.capacity !== null ? `/${wait.capacity}` : ""} ${held}`;
}

export {
  slotWaitFor,
  readSlotSnapshot,
  storedJobWaits,
  waitingText
};
