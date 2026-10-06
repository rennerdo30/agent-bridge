import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorktreeRemovalPath, scanWorktreeLinks, unlinkLinks, WORKTREE_LINK_HINT, worktreeLinkWarning } from "../src/core/worktree-links.js";
import { removeWorktreeDirectory } from "../src/core/worktree.js";

describe("external worktree links", () => {
  it("resolves aliases above the managed boundary while refusing links inside it", () => {
    const fixtures = join(process.cwd(), ".agent-bridge-test");
    mkdirSync(fixtures, { recursive: true });
    const home = realpathSync.native(mkdtempSync(join(fixtures, "ab-alias-cleanup-")));
    const actual = join(home, "actual"), alias = join(home, "alias"), owner = join(home, "owner");
    const container = join(actual, "worktrees"), root = join(container, "job");
    mkdirSync(root, { recursive: true }); mkdirSync(owner);
    writeFileSync(join(owner, "keep.txt"), "owner bytes\n");
    try {
      symlinkSync(actual, alias, "junction");
      const aliasedContainer = join(alias, "worktrees"), aliasedRoot = join(aliasedContainer, "job");
      expect(resolveWorktreeRemovalPath(aliasedRoot, aliasedContainer)).toBe(root);
      symlinkSync(owner, join(root, "linked"), "junction");
      expect(() => removeWorktreeDirectory(join(aliasedRoot, "linked"), aliasedContainer)).toThrow("linked path");
      expect(() => resolveWorktreeRemovalPath(owner, container)).toThrow("outside the managed");
      // Removing a whole worktree detaches its leaf links; it does not recurse through them.
      removeWorktreeDirectory(aliasedRoot, aliasedContainer);
      expect(existsSync(root)).toBe(false);
      expect(readFileSync(join(owner, "keep.txt"), "utf8")).toBe("owner bytes\n");
      expect(existsSync(alias)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it("matches directory-only ignore rules, negations and nested overrides without reading caches", () => {
    const fixtures = join(process.cwd(), ".agent-bridge-test");
    mkdirSync(fixtures, { recursive: true });
    const home = realpathSync.native(mkdtempSync(join(fixtures, "ab-ignore-policy-")));
    const actual = join(home, "actual"), root = join(actual, "repo"), alias = join(home, "alias"), cache = join(home, "cache");
    const aliasedRoot = join(alias, "repo");
    mkdirSync(join(root, "client"), { recursive: true }); mkdirSync(cache);
    const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    try {
      runGit("init", "-q");
      symlinkSync(actual, alias, "junction");
      symlinkSync(cache, join(root, "client", "node_modules"), "junction");
      writeFileSync(join(cache, ".gitignore"), "!node_modules/\n"); // Must never load rules in the linked cache.
      writeFileSync(join(root, ".gitignore"), "node_modules/\n!client/node_modules/\n");
      expect(scanWorktreeLinks(aliasedRoot).readOnlyCacheLinks ?? []).toEqual([]);
      writeFileSync(join(root, "client", ".gitignore"), "node_modules/\n");
      expect(scanWorktreeLinks(aliasedRoot).readOnlyCacheLinks).toEqual([{ path: join(aliasedRoot, "client", "node_modules"), target: cache }]);
      writeFileSync(join(root, "client", ".gitignore"), "!node_modules/\n");
      expect(scanWorktreeLinks(aliasedRoot).readOnlyCacheLinks ?? []).toEqual([]);
      writeFileSync(join(root, "client", ".gitignore"), "");
      writeFileSync(join(root, ".gitignore"), "");
      writeFileSync(join(root, ".git", "info", "exclude"), "/client/node_modules/\n");
      expect(scanWorktreeLinks(aliasedRoot).readOnlyCacheLinks).toHaveLength(1);
      writeFileSync(join(root, ".git", "info", "exclude"), "");
      writeFileSync(join(root, "global-ignore"), "/client/node_modules/\n");
      runGit("config", "core.excludesFile", "global-ignore");
      expect(scanWorktreeLinks(aliasedRoot).readOnlyCacheLinks).toHaveLength(1);
      expect(readFileSync(join(cache, ".gitignore"), "utf8")).toBe("!node_modules/\n");
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it("permits reads from ignored Unity and dependency caches without allowing owner folders", () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-read-cache-")));
    const root = join(home, "worktree"), cache = join(home, "cache");
    mkdirSync(join(root, "unity", "Game", "ProjectSettings"), { recursive: true }); mkdirSync(cache);
    const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    try {
      runGit("init", "-q");
      writeFileSync(join(root, ".gitignore"), "Library/\nnode_modules/\nowner/\n");
      writeFileSync(join(root, "unity", "Game", "ProjectSettings", "ProjectVersion.txt"), "Unity version\n");
      writeFileSync(join(cache, "Domain.UnityAdditionalFile.txt"), "complete source cache\n");
      const library = join(root, "unity", "Game", "Library"), modules = join(root, "node_modules");
      symlinkSync(cache, library, "junction"); symlinkSync(cache, modules, "junction");
      symlinkSync(cache, join(root, "owner"), "junction");
      symlinkSync(cache, join(root, "Library"), "junction"); // No Unity marker beside this one.
      const scan = scanWorktreeLinks(root);
      expect(scan.readOnlyCacheLinks).toEqual(expect.arrayContaining([{ path: library, target: cache }, { path: modules, target: cache }]));
      expect(scan.readOnlyCacheLinks).toHaveLength(2);
      expect(worktreeLinkWarning(scan)).toContain("Read-only ignored cache links");
      expect(worktreeLinkWarning(scan)).toContain(`${join(root, "owner")} -> ${cache}`);
      expect(WORKTREE_LINK_HINT).toContain("never substitute an incomplete cache copy");
      expect(WORKTREE_LINK_HINT).toContain("A junction does not enforce read-only access");
      removeWorktreeDirectory(root);
      expect(readFileSync(join(cache, "Domain.UnityAdditionalFile.txt"), "utf8")).toBe("complete source cache\n");
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it("never classifies unignored, tracked, broken or non-cache links as read-only caches", () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-cache-deny-")));
    const root = join(home, "worktree"), cache = join(home, "cache");
    mkdirSync(root); mkdirSync(cache);
    const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    try {
      runGit("init", "-q");
      symlinkSync(cache, join(root, "node_modules"), "junction");
      expect(scanWorktreeLinks(root).readOnlyCacheLinks ?? []).toEqual([]);
      writeFileSync(join(root, ".gitignore"), "node_modules/\n__pycache__/\n");
      writeFileSync(join(cache, "tracked.txt"), "tracked cache bytes\n");
      runGit("add", "-f", "--", "node_modules");
      symlinkSync(join(home, "missing"), join(root, "__pycache__"), "junction");
      expect(scanWorktreeLinks(root).readOnlyCacheLinks ?? []).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it("refuses cleanup through a linked root or parent without touching source entries", () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-unlink-root-")));
    const owner = join(home, "owner"), root = join(home, "worktree");
    mkdirSync(join(owner, "child"), { recursive: true });
    writeFileSync(join(owner, "child", "keep.txt"), "unique source bytes\n");
    try {
      symlinkSync(owner, root, "junction");
      expect(() => unlinkLinks(root)).toThrow("linked path");
      expect(() => removeWorktreeDirectory(join(root, "child"), root)).toThrow("linked path");
      expect(readFileSync(join(owner, "child", "keep.txt"), "utf8")).toBe("unique source bytes\n");
      expect(existsSync(root)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it("detaches nested, chained, cyclic and dangling links before recursive removal", () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-unlink-source-")));
    const owner = join(home, "owner"), root = join(home, "worktree");
    mkdirSync(join(root, "nested"), { recursive: true }); mkdirSync(owner);
    writeFileSync(join(owner, "keep.txt"), "unique source bytes\n");
    try {
      symlinkSync(owner, join(root, "nested", "cache"), "junction");
      symlinkSync(join(root, "nested", "cache"), join(root, "chain"), "junction");
      symlinkSync(owner, join(owner, "cycle"), "junction");
      symlinkSync(join(home, "missing"), join(root, "broken"), "junction");
      removeWorktreeDirectory(root);
      expect(existsSync(root)).toBe(false);
      expect(readFileSync(join(owner, "keep.txt"), "utf8")).toBe("unique source bytes\n");
      expect(existsSync(join(owner, "cycle"))).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it("reports a worktree root replaced by a junction without inspecting its target", () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-root-link-")));
    const root = join(home, "worktree"); const owner = join(home, "owner");
    mkdirSync(owner);
    try {
      symlinkSync(owner, root, "junction");
      expect(scanWorktreeLinks(root)).toEqual({ externalLinks: [{ path: root, target: owner }], errors: [] });
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  it("lists ignored external junctions and broken links without following them", () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-link-scan-")));
    const root = join(home, "worktree");
    const owner = join(home, "owner");
    mkdirSync(root); mkdirSync(owner);
    writeFileSync(join(root, ".gitignore"), "Library/\n");
    writeFileSync(join(owner, "keep.txt"), "owner data");
    try {
      symlinkSync(owner, join(root, "Library"), "junction");
      symlinkSync(root, join(owner, "cycle"), "junction");
      symlinkSync(join(home, "missing"), join(root, "broken"), "junction");
      const scan = scanWorktreeLinks(root);
      expect(scan.errors).toEqual([]);
      expect(scan.externalLinks).toEqual(expect.arrayContaining([{ path: join(root, "Library"), target: owner }, { path: join(root, "broken"), target: join(home, "missing") }]));
      expect(scan.externalLinks).toHaveLength(2);
      expect(worktreeLinkWarning(scan)).toContain("without recursively deleting its target");
      expect(readFileSync(join(owner, "keep.txt"), "utf8")).toBe("owner data");
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it("permits internal links but catches internal chains ending outside the worktree", () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-link-chain-")));
    const root = join(home, "worktree"); const internal = join(root, "cache"); const outside = join(home, "outside");
    mkdirSync(internal, { recursive: true }); mkdirSync(outside);
    try {
      symlinkSync(internal, join(root, "inside"), "junction");
      expect(scanWorktreeLinks(root).externalLinks).toEqual([]);
      symlinkSync(outside, join(root, "external"), "junction");
      symlinkSync(join(root, "external"), join(root, "chain"), "junction");
      const scan = scanWorktreeLinks(root);
      expect(scan.externalLinks.map((l) => l.target)).toEqual([outside, outside]);
      expect(worktreeLinkWarning({ externalLinks: [], errors: ["unreadable folder"] })).toContain("inspection incomplete");
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
});
