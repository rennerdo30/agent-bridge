import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  canControlJob
} from "./chunk-EIBZH3O5.mjs";
import {
  readJsonSnapshot
} from "./chunk-QN2BR77F.mjs";
import {
  canonicalProjectRoot,
  projectGroupsEnabled,
  projectKey
} from "./chunk-H2JCI6FF.mjs";
import {
  isRecord
} from "./chunk-TPCM6ZR4.mjs";

// src/core/project-groups.ts
import { join } from "node:path";
var ProjectGroups = class {
  constructor(home) {
    this.home = home;
  }
  home;
  roots = /* @__PURE__ */ new Map();
  jobRoots = /* @__PURE__ */ new Map();
  settings = /* @__PURE__ */ new Map();
  dispatchRoots = /* @__PURE__ */ new Map();
  enabled(root, agent) {
    const key = JSON.stringify([root, agent]);
    if (!this.settings.has(key)) {
      if (!this.settings.size) queueMicrotask(() => this.settings.clear());
      this.settings.set(key, projectGroupsEnabled(root, this.home, agent));
    }
    return this.settings.get(key);
  }
  root(cwd) {
    if (!this.roots.has(cwd)) this.roots.set(cwd, canonicalProjectRoot(cwd));
    return this.roots.get(cwd) ?? null;
  }
  same(a, b) {
    const left = this.root(a), right = this.root(b);
    return Boolean(left && right && projectKey(left) === projectKey(right) && this.enabled(left));
  }
  decorate(peer) {
    const root = this.root(peer.cwd);
    return { ...peer, projectRoot: root ?? void 0, projectGroup: root && peer.agent !== "other" && !peer.jobAgent && !peer.subagent && this.enabled(root, peer.agent) ? projectKey(root) : void 0 };
  }
  /** Paired-PC jobs remain outside local group authority. */
  shareable(job) {
    return !job.remote;
  }
  jobRoot(job, peers) {
    if (!this.dispatchRoots.has(job)) {
      if (!this.dispatchRoots.size) queueMicrotask(() => this.dispatchRoots.clear());
      this.dispatchRoots.set(job, this.resolveJobRoot(job, peers));
    }
    return this.dispatchRoots.get(job) ?? null;
  }
  resolveJobRoot(job, peers) {
    const worktree = job.worktree;
    for (const value of [job.projectRoot, worktree?.repoRoot]) {
      if (typeof value === "string") {
        const root = this.root(value);
        if (root) {
          this.jobRoots.set(String(job.id), root);
          return root;
        }
      }
    }
    const runner = peers.find((p) => p.jobAgent && p.id === `job:${job.id}`);
    let spec;
    if (this.home && typeof job.id === "string" && /^[a-zA-Z0-9_-]+$/.test(job.id)) {
      try {
        spec = readJsonSnapshot(join(this.home, "jobs", `${job.id}.spec.json`)).value;
      } catch {
      }
    }
    for (const value of [isRecord(spec) ? spec.cwd : void 0, job.workdir, runner?.cwd]) {
      if (typeof value === "string") {
        const root = this.root(value);
        if (root) {
          this.jobRoots.set(String(job.id), root);
          return root;
        }
      }
    }
    const history = Array.isArray(job.ownershipHistory) ? job.ownershipHistory : [];
    const original = history.length ? history[0]?.fromRootName ?? history[0]?.from : job.rootName ?? job.owner;
    const owner = peers.find((p) => !p.jobAgent && p.name === original);
    if (owner) {
      const root = this.root(owner.cwd);
      if (root) this.jobRoots.set(String(job.id), root);
      return root;
    }
    return this.jobRoots.get(String(job.id)) ?? null;
  }
  canControl(peer, job, local) {
    if (peer.host) return false;
    if (peer.jobAgent && peer.name === job.parentJob) return true;
    if (peer.jobAgent || peer.subagent) return false;
    if (canControlJob(job, peer.name)) return true;
    if (!this.shareable(job)) return false;
    return this.members(job, local).some((p) => p.name === peer.name);
  }
  members(job, local) {
    if (!this.shareable(job)) return [];
    const root = this.jobRoot(job, local);
    if (!root) return [];
    return local.filter((p) => {
      if (p.agent === "other" || p.jobAgent || p.subagent || p.host) return false;
      const candidate = this.root(p.cwd);
      return Boolean(candidate && projectKey(candidate) === projectKey(root) && this.enabled(root, p.agent));
    });
  }
  candidate(job, local) {
    if (!this.shareable(job)) return void 0;
    return this.members(job, local).filter((p) => !p.unavailable).sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name))[0];
  }
};

export {
  ProjectGroups
};
