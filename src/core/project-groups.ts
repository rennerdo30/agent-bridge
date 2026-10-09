import { canonicalProjectRoot, projectGroupsEnabled, projectKey } from "./project-identity.js";
import type { PeerInfo } from "./protocol.js";
import { canControlJob } from "./job-ownership.js";
import { readPendingRunnerSpec } from "./runner-store.js";
import { isRecord } from "./json-store.js";

/** Groups are derived from verified local paths, never from peer names or paired-PC projections. */
export class ProjectGroups {
  private readonly roots = new Map<string, string | null>();
  private readonly jobRoots = new Map<string, string>();
  private readonly settings = new Map<string, boolean>();
  private readonly dispatchRoots = new Map<Record<string, unknown>, string | null>();
  constructor(private readonly home?: string) {}

  private enabled(root: string, agent?: string): boolean {
    const key = JSON.stringify([root, agent]);
    if (!this.settings.has(key)) {
      if (!this.settings.size) queueMicrotask(() => this.settings.clear());
      this.settings.set(key, projectGroupsEnabled(root, this.home, agent));
    }
    return this.settings.get(key)!;
  }

  root(cwd: string): string | null {
    if (!this.roots.has(cwd)) this.roots.set(cwd, canonicalProjectRoot(cwd));
    return this.roots.get(cwd) ?? null;
  }

  same(a: string, b: string): boolean {
    const left = this.root(a), right = this.root(b);
    return Boolean(left && right && projectKey(left) === projectKey(right) && this.enabled(left));
  }

  decorate(peer: PeerInfo): PeerInfo {
    const root = this.root(peer.cwd);
    return { ...peer, projectRoot: root ?? undefined, projectGroup: root && peer.agent !== "other" && !peer.jobAgent && !peer.subagent && this.enabled(root, peer.agent) ? projectKey(root) : undefined };
  }

  /** Paired-PC jobs remain outside local group authority. */
  shareable(job: Record<string, unknown>): boolean {
    return !job.remote;
  }

  jobRoot(job: Record<string, unknown>, peers: PeerInfo[]): string | null {
    if (!this.dispatchRoots.has(job)) {
      if (!this.dispatchRoots.size) queueMicrotask(() => this.dispatchRoots.clear());
      this.dispatchRoots.set(job, this.resolveJobRoot(job, peers));
    }
    return this.dispatchRoots.get(job) ?? null;
  }

  private resolveJobRoot(job: Record<string, unknown>, peers: PeerInfo[]): string | null {
    // Prefer the original checkout to a linked worktree. Existing 0.29.10 records need no rewrite.
    const worktree = job.worktree as Record<string, unknown> | null;
    for (const value of [job.projectRoot, worktree?.repoRoot]) {
      if (typeof value === "string") { const root = this.root(value); if (root) { this.jobRoots.set(String(job.id), root); return root; } }
    }
    const runner = peers.find((p) => p.jobAgent && p.id === `job:${job.id}`);
    let spec: unknown;
    if (this.home && typeof job.id === "string" && /^[a-zA-Z0-9_-]+$/.test(job.id)) {
      try { spec = readPendingRunnerSpec(this.home, job.id); }
      catch { /* A running job has already archived its one-use launch spec. */ }
    }
    for (const value of [isRecord(spec) ? spec.cwd : undefined, job.workdir, runner?.cwd]) {
      if (typeof value === "string") { const root = this.root(value); if (root) { this.jobRoots.set(String(job.id), root); return root; } }
    }
    // Legacy records lacking workdir can still share while their original owner is connected.
    const history = Array.isArray(job.ownershipHistory) ? job.ownershipHistory : [];
    const original = history.length ? history[0]?.fromRootName ?? history[0]?.from : job.rootName ?? job.owner;
    const owner = peers.find((p) => !p.jobAgent && p.name === original);
    if (owner) { const root = this.root(owner.cwd); if (root) this.jobRoots.set(String(job.id), root); return root; }
    return this.jobRoots.get(String(job.id)) ?? null;
  }

  canControl(peer: PeerInfo, job: Record<string, unknown>, local: PeerInfo[]): boolean {
    if (peer.host) return false;
    if (peer.jobAgent && peer.name === job.parentJob) return true;
    if (peer.jobAgent || peer.subagent) return false;
    if (canControlJob(job, peer.name)) return true;
    if (!this.shareable(job)) return false;
    return this.members(job, local).some((p) => p.name === peer.name);
  }

  members(job: Record<string, unknown>, local: PeerInfo[]): PeerInfo[] {
    if (!this.shareable(job)) return [];
    const root = this.jobRoot(job, local);
    if (!root) return [];
    return local.filter((p) => {
      if (p.agent === "other" || p.jobAgent || p.subagent || p.host) return false;
      const candidate = this.root(p.cwd);
      return Boolean(candidate && projectKey(candidate) === projectKey(root) && this.enabled(root, p.agent));
    });
  }

  candidate(job: Record<string, unknown>, local: PeerInfo[]): PeerInfo | undefined {
    if (!this.shareable(job)) return undefined;
    return this.members(job, local).filter((p) => !p.unavailable)
      .sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name))[0];
  }
}
