import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { archiveFile, isRecord, JSON_STORE_VERSION, readJsonStore, writeJsonStore } from "./json-store.js";
import type { Worktree } from "./worktree.js";
import { readHistoryJson } from "./run-history.js";

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
export function recordWorktreeProcessProof(home: string, wt: Worktree, stopped: boolean): void {
  const state = readWorktreeState(home, wt);
  if (state) saveWorktreeState(home, wt, { ...state, processesStopped: stopped });
}

/** A job using a managed cwd without saved worktree metadata cannot inherit an older shutdown proof. */
export function invalidateWorktreePathProof(home: string, path: string): void {
  const value = readHistoryJson(statePath(home, { path }));
  if (!isRecord(value) || typeof value.repoRoot !== "string" || typeof value.base !== "string") return;
  const wt = { path, cwd: path, repoRoot: value.repoRoot, base: value.base, branch: "" };
  const state = readWorktreeState(home, wt);
  if (state) saveWorktreeState(home, wt, { ...state, processesStopped: false, lastContinuation: Date.now() });
}

/** Run and close share an exclusive physical-folder lease. Busy/unknown leases always retain data. */
export function worktreeLease(home: string, wt: Pick<Worktree, "path">): () => void {
  const dir = join(home, "worktree-leases");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, key(wt));
  try { mkdirSync(path); }
  catch { throw new Error("Worktree is running, closing, or has an unreconciled lease; kept unchanged."); }
  return () => { archiveFile(path); };
}
