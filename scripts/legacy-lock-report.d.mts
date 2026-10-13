export interface LockHolderEvidence { status: string; pids: number[]; reason: string }
export interface LegacyLockEvidence {
  path: string;
  kind: string;
  ageMs: number;
  matchingJobs: { name?: string; status?: string; worktree?: unknown }[];
  worktreeState: Record<string, unknown> | null;
  processHolders: LockHolderEvidence;
  recommendedAction: string;
}
export function reportLegacyLocks(home: string, options?: {
  now?: number;
  holders?: (path: string) => Promise<LockHolderEvidence>;
}): Promise<{
  version: number;
  mode: string;
  home: string;
  generatedAt: number;
  locks: LegacyLockEvidence[];
  limitations: string[];
}>;
export function main(args: string[]): Promise<void>;
export function lockHolders(path: string): Promise<LockHolderEvidence>;
