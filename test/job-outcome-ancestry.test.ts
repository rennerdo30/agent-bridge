import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deriveJobOutcome, type OutcomeJob } from "../src/core/job-outcomes.js";
import { nullLogger } from "../src/core/logger.js";
import * as worktree from "../src/core/worktree.js";

let home: string, base: string, tip: string, job: OutcomeJob;
const git = (...args: string[]) => execFileSync("git", ["-C", home, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ab-ancestry-"));
  git("init", "-b", "main");
  git("config", "user.name", "rennerdo30");
  git("config", "user.email", "9086097+rennerdo30@users.noreply.github.com");
  git("commit", "--allow-empty", "-m", "Fixture base"); base = git("rev-parse", "HEAD");
  git("checkout", "-b", "fixture");
  git("commit", "--allow-empty", "-m", "Fixture work"); tip = git("rev-parse", "HEAD");
  git("checkout", "main");
  job = { id: "fixture", name: "codex-job-fixture", startedAt: 1, status: "done", worktree: { repoRoot: home, path: home, cwd: home, branch: "fixture", baseBranch: "main", base } };
});
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

it("uses complete current loose ancestry without Git startup and sees a changed base", async () => {
  const spy = vi.spyOn(worktree, "git");
  expect((await deriveJobOutcome(home, job, nullLogger)).merge.state).toBe("unmerged");
  expect(spy).not.toHaveBeenCalled();
  git("merge", "--ff-only", "fixture"); git("commit", "--allow-empty", "-m", "Fixture later base");
  expect((await deriveJobOutcome(home, job, nullLogger)).merge.state).toBe("merged");
  expect(spy).not.toHaveBeenCalled();
});

it("retains Git fallback for packed and missing commit evidence", async () => {
  git("repack", "-a", "-d");
  const spy = vi.spyOn(worktree, "git");
  expect((await deriveJobOutcome(home, job, nullLogger)).merge.state).toBe("unmerged");
  expect(spy).toHaveBeenCalledWith(expect.arrayContaining(["merge-base", "--is-ancestor", tip, base]), home, nullLogger);
  spy.mockClear();
  const missing = "1".repeat(40);
  expect((await deriveJobOutcome(home, job, nullLogger, { branchHead: missing })).merge.state).toBe("unmerged");
  expect(spy).toHaveBeenCalledWith(expect.arrayContaining(["merge-base", "--is-ancestor", missing, base]), home, nullLogger);
});

it("honors replacement ancestry through Git instead of ordinary object parents", async () => {
  // The replacement base has the selected tip as a parent.
  const replacement = git("commit-tree", git("rev-parse", `${tip}^{tree}`), "-p", tip, "-m", "Fixture replacement");
  git("replace", base, replacement);
  const spy = vi.spyOn(worktree, "git");
  expect((await deriveJobOutcome(home, job, nullLogger)).merge.state).toBe("merged");
  expect(spy).toHaveBeenCalled();
});

it("honors shallow ancestry through Git and preserves the shallow boundary", async () => {
  const spy = vi.spyOn(worktree, "git");
  git("merge", "--ff-only", "fixture"); git("commit", "--allow-empty", "-m", "Fixture later base");
  const later = git("rev-parse", "HEAD");
  writeFileSync(join(home, ".git", "shallow"), `${later}\n`);
  spy.mockClear();
  expect((await deriveJobOutcome(home, job, nullLogger)).merge.state).toBe("unmerged");
  expect(spy).toHaveBeenCalled();
  expect(readFileSync(join(home, ".git", "shallow"), "utf8")).toBe(`${later}\n`);
});
