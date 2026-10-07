import { canonicalProjectRoot, projectGroupsEnabled, projectKey } from "./project-identity.js";
import type { PeerInfo } from "./protocol.js";
import { canControlJob } from "./job-ownership.js";

/** Groups are derived from verified local paths, never from peer names or paired-PC projections. */
export class ProjectGroups {
  private readonly roots = new Map<string, string | null>();
  constructor(private readonly home?: string) {}

  root(cwd: string): string | null {
    if (!this.roots.has(cwd)) this.roots.set(cwd, canonicalProjectRoot(cwd));
    return this.roots.get(cwd) ?? null;
  }

  same(a: string, b: string): boolean {
    const left = this.root(a), right = this.root(b);
    return Boolean(left && right && projectKey(left) === projectKey(right) && projectGroupsEnabled(left, this.home));
  }

  decorate(peer: PeerInfo): PeerInfo {
    const root = this.root(peer.cwd);
    return { ...peer, projectRoot: root ?? undefined, projectGroup: root && projectGroupsEnabled(root, this.home, peer.agent) ? projectKey(root) : undefined };
  }

  /** Paired-PC jobs remain outside local group authority. */
  shareable(job: Record<string, unknown>): boolean {
    return !job.remote;
  }

  jobRoot(job: Record<string, unknown>, peers: PeerInfo[]): string | null {
    // Prefer the original checkout to a linked worktree. Existing 0.29.10 records need no rewrite.
    const worktree = job.worktree as Record<string, unknown> | null;
    for (const value of [worktree?.repoRoot, job.workdir]) {
      if (typeof value === "string") { const root = this.root(value); if (root) return root; }
    }
    // Legacy records lacking workdir can still share while their original owner is connected.
    const history = Array.isArray(job.ownershipHistory) ? job.ownershipHistory : [];
    const original = history.length ? history[0]?.fromRootName ?? history[0]?.from : job.rootName ?? job.owner;
    const owner = peers.find((p) => !p.jobAgent && p.name === original);
    if (owner) return this.root(owner.cwd);
    return null;
  }

  canControl(peer: PeerInfo, job: Record<string, unknown>, local: PeerInfo[]): boolean {
    if (peer.jobAgent || peer.subagent || peer.host) return false;
    if (canControlJob(job, peer.name)) return true;
    if (!this.shareable(job)) return false;
    return this.members(job, local).some((p) => p.name === peer.name);
  }

  members(job: Record<string, unknown>, local: PeerInfo[]): PeerInfo[] {
    if (!this.shareable(job)) return [];
    const root = this.jobRoot(job, local);
    if (!root) return [];
    return local.filter((p) => !p.jobAgent && !p.subagent && !p.host && this.same(p.cwd, root) && projectGroupsEnabled(root, this.home, p.agent));
  }

  candidate(job: Record<string, unknown>, local: PeerInfo[]): PeerInfo | undefined {
    if (!this.shareable(job)) return undefined;
    return this.members(job, local).filter((p) => !p.unavailable)
      .sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name))[0];
  }
}
