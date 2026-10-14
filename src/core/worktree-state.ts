import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord, JSON_STORE_VERSION, readJsonStore, writeJsonStore } from "./json-store.js";
import type { Worktree } from "./worktree.js";
import { readHistoryJson } from "./run-history.js";
import { worktreeRowLease } from "./worktree-row-lease.js";
import { refreshStorePeerIdentities } from "./store-compatibility.js";
import type { Logger } from "./logger.js";

export const WORKTREE_STATE_CONTRACT = 1;
export interface WorktreeState {
  contractVersion: 1;
  path: string;
  repoRoot: string;
  base: string;
  rootId: string;
  /** Physical, initially absent Library directories beside tracked Unity version settings. */
  libraries: string[];
  lastContinuation: number;
  processesStopped?: boolean;
  closedAt?: number;
  reapedAt?: number;
  pushed?: { ref: string; sha: string }[];
  resumeBranch?: string;
}
const key = (wt: Pick<Worktree, "path">) => createHash("sha256").update(resolve(wt.path).toLowerCase()).digest("hex");
const statePath = (home: string, wt: Pick<Worktree, "path">) => join(home, "worktree-state", `${key(wt)}.json`);
export const rootId = (path: string) => { const stat = lstatSync(path); return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; };

export function readWorktreeState(home: string, wt: Worktree): WorktreeState | null {
  const value = readHistoryJson(statePath(home, wt));
  if (!isRecord(value) || (typeof value.version === "number" && value.version > JSON_STORE_VERSION) || value.contractVersion !== WORKTREE_STATE_CONTRACT || value.path !== wt.path || value.repoRoot !== wt.repoRoot || value.base !== wt.base || typeof value.rootId !== "string" || !Array.isArray(value.libraries) || !value.libraries.every((p) => typeof p === "string") || typeof value.lastContinuation !== "number") return null;
  return value as unknown as WorktreeState;
}
export function saveWorktreeState(home: string, wt: Worktree, value: WorktreeState): void {
  const path = statePath(home, wt);
  writeJsonStore(path, { ...value }, readJsonStore(path));
}

/** How long a turn-time worktree state write waits for briefly unverifiable readers (AB-260). */
export const WORKTREE_STATE_UPGRADE_WAIT_MS = 120_000;

export interface WorktreeStateRetryOptions {
  deadlineMs?: number;
  signal?: AbortSignal;
  log?: Logger | null;
  onWait?: (message: string) => void;
}

/**
 * A turn-time worktree state write: a reader that is just exiting (ESRCH a moment later) must not fail
 * the whole turn at once. Retries STORE_UPGRADE_DEFERRED with a fresh identity scan and backoff until
 * the deadline, then throws the last blocker message unchanged. A genuinely old reader still blocks.
 */
export async function saveWorktreeStateWithRetry(home: string, wt: Pick<Worktree, "path">, value: WorktreeState, opts: WorktreeStateRetryOptions = {}): Promise<void> {
  const deadlineMs = opts.deadlineMs ?? WORKTREE_STATE_UPGRADE_WAIT_MS;
  const start = Date.now();
  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      saveWorktreeState(home, wt as Worktree, value);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "STORE_UPGRADE_DEFERRED") throw error;
      if (Date.now() - start >= deadlineMs) throw error;
      if (attempt === 0) opts.onWait?.(String(error));
      if (attempt === 0) opts.log?.info("worktree state waits for retained store readers", { reason: String(error) });
      await refreshStorePeerIdentities(home, opts.signal).catch(() => {});
      opts.signal?.throwIfAborted();
      try {
        await delay(Math.min(1_000, (attempt + 1) * 100), undefined, { signal: opts.signal });
      } catch {
        opts.signal?.throwIfAborted();
        throw error;
      }
    }
  }
}

/** Proof write after a turn, retried the same way; resolved state is read once up front. */
export async function recordWorktreeProcessProofWithRetry(home: string, wt: Worktree, stopped: boolean, opts: WorktreeStateRetryOptions = {}): Promise<void> {
  const state = readWorktreeState(home, wt);
  if (!state) return;
  await saveWorktreeStateWithRetry(home, wt, { ...state, processesStopped: stopped }, opts);
}

/** Path-proof invalidation inside the run lease, retried the same way. */
export async function invalidateWorktreePathProofWithRetry(home: string, path: string, opts: WorktreeStateRetryOptions = {}): Promise<void> {
  const value = readHistoryJson(statePath(home, { path }));
  if (!isRecord(value) || typeof value.repoRoot !== "string" || typeof value.base !== "string") return;
  const wt = { path, cwd: path, repoRoot: value.repoRoot, base: value.base, branch: "" };
  const state = readWorktreeState(home, wt);
  if (!state) return;
  await saveWorktreeStateWithRetry(home, wt, { ...state, processesStopped: false, lastContinuation: Date.now() }, opts);
}
export function recordWorktreeProcessProof(home: string, wt: Worktree, stopped: boolean): void {
  const state = readWorktreeState(home, wt);
  if (state) saveWorktreeState(home, wt, { ...state, processesStopped: stopped });
}

/** A job using a managed cwd without saved worktree metadata cannot inherit an older shutdown proof. */

const LEASE_BUSY = "Worktree is running, closing, or has an unreconciled lease; kept unchanged.";

/** Run and close share an exclusive physical-folder lease. Busy/unknown leases always retain data. */
export function worktreeLease(home: string, wt: Pick<Worktree, "path">, jobId?: string): () => void {
  try { return worktreeRowLease(home, key(wt), wt.path, jobId); }
  catch (error) { throw new Error(`${LEASE_BUSY} ${(error as Error).message}`); }
}
