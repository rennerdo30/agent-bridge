import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanWorktreeLinks, worktreeLinkWarning } from "../src/core/worktree-links.js";

describe("external worktree links", () => {
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
