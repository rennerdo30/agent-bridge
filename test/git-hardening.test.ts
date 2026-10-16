import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { closeMetadataDb } from "../src/core/metadata-db.js";
import { createWorktree, finishWorktree, gitChangeSnapshot, gitStatusSnapshot } from "../src/core/worktree.js";
import { cleanupWorktrees } from "../src/core/worktree-cleanup.js";

/**
 * AB-422: a job can write the repository's .git/config, .gitattributes and hooks. The bridge's own git calls in
 * that repository run as the owner, outside the job sandbox, and must never execute a program the job planted.
 */
let root: string;
let repo: string;
let home: string;
let evil: string;
let markers: string;

const slash = (p: string) => p.replace(/\\/g, "/");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();
/** A shell command (git runs these through sh) that appends its tag to the marker file and exits. */
const planted = (tag: string) => `node "${slash(join(evil, "marker.js"))}" ${tag}`;
const markerText = () => (existsSync(markers) ? readFileSync(markers, "utf8") : "");

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-422-")));
  repo = join(root, "repo");
  home = join(root, "home");
  evil = join(root, "evil");
  markers = join(evil, "markers.log");
  for (const dir of [repo, home, evil, join(evil, "hooks")]) mkdirSync(dir, { recursive: true });
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "global.gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("AGENT_BRIDGE_HOME", home);
  writeFileSync(join(evil, "marker.js"),
    `require("fs").appendFileSync(${JSON.stringify(markers)}, process.argv.slice(2).join(" ") + "\\n");\n`);
  for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-checkout", "reference-transaction", "post-index-change", "pre-auto-gc"]) {
    const file = join(evil, "hooks", hook);
    writeFileSync(file, `#!/bin/sh\n${planted(`hook:${hook}`)}\n`);
    chmodSync(file, 0o755);
  }
  // The clean repository the owner had before the job.
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Repository Owner");
  git(repo, "config", "user.email", "owner@example.test");
  writeFileSync(join(repo, ".gitattributes"), "* text=auto eol=lf\n*.txt filter=evil diff=evil\n");
  writeFileSync(join(repo, "a.txt"), "original\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
});

afterEach(() => {
  try { git(repo, "worktree", "prune"); } catch { /* fixture already gone */ }
  closeMetadataDb(home);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.unstubAllEnvs();
});

/** What a job with write access to the repository can plant in its local configuration. */
function plantRepositoryConfig(): void {
  const set = (key: string, value: string) => git(repo, "config", key, value);
  set("filter.evil.clean", planted("filter:clean"));
  set("filter.evil.smudge", planted("filter:smudge"));
  set("filter.evil.process", planted("filter:process"));
  set("core.hooksPath", slash(join(evil, "hooks")));
  set("diff.evil.textconv", planted("diff:textconv"));
  set("diff.evil.command", planted("diff:command"));
  set("diff.external", planted("diff:external"));
  set("core.editor", planted("editor"));
  set("sequence.editor", planted("sequence-editor"));
  set("commit.gpgSign", "true");
  set("gpg.program", planted("gpg"));
  set("log.showSignature", "true");
  // core.fsmonitor arrives through an included file the job wrote.
  const included = join(evil, "included.gitconfig");
  writeFileSync(included, `[core]\n\tfsmonitor = ${planted("fsmonitor")}\n\tuntrackedCache = true\n`);
  set("include.path", slash(included));
}

/** Make a file stat-dirty with unchanged content, so git re-reads it (and would run its clean filter). */
function touch(file: string): void {
  const when = new Date(Date.now() - 3_600_000);
  utimesSync(file, when, when);
}

describe("bridge git calls in job-controlled repositories (AB-422)", () => {
  it("plants work: the fixture really executes the markers in plain git", () => {
    plantRepositoryConfig();
    touch(join(repo, "a.txt"));
    git(repo, "status", "--porcelain");
    expect(markerText()).toMatch(/fsmonitor|filter:/);
  });

  it("change snapshots, worktree creation, WIP commits and cleanup inspection run no planted program", async () => {
    plantRepositoryConfig();
    touch(join(repo, "a.txt"));
    writeFileSync(join(repo, "b.txt"), "user's own edit\n");

    const snapshot = await gitChangeSnapshot(repo, nullLogger);
    expect(snapshot?.has("b.txt")).toBe(true);
    expect(await gitStatusSnapshot(repo, nullLogger)).not.toBeNull();
    expect(markerText()).toBe("");

    const wt = await createWorktree({ cwd: repo, home, jobId: "ab422aaa", log: nullLogger });
    // The smudge filter was neutralised: the checkout holds the committed content.
    expect(readFileSync(join(wt.path, "a.txt"), "utf8")).toBe("original\n");
    expect(markerText()).toBe("");

    writeFileSync(join(wt.path, "a.txt"), "job change\n");
    writeFileSync(join(wt.path, "new.txt"), "job file\n");
    const outcome = await finishWorktree(wt, "WIP: save job work", nullLogger, true);
    expect(outcome.files.sort()).toEqual(["a.txt", "new.txt"]);
    expect(git(repo, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "log", "-1", "--format=%s", "--no-show-signature", wt.branch)).toBe("WIP: save job work");
    expect(markerText()).toBe("");

    touch(join(wt.path, "a.txt"));
    const entries = await cleanupWorktrees({ cwd: repo, home, apply: false, log: nullLogger });
    expect(entries.length).toBeGreaterThan(0);
    expect(markerText()).toBe("");
  });

  it("refuses a remote fetch when repository-local config can start a transport program", async () => {
    const upstream = join(root, "upstream");
    git(root, "clone", "-q", "--bare", repo, upstream);
    git(repo, "remote", "add", "origin", slash(upstream));
    git(repo, "config", "remote.origin.uploadpack", planted("uploadpack"));
    git(repo, "config", "core.sshCommand", planted("ssh"));
    const wt = await createWorktree({ cwd: repo, home, jobId: "ab422bbb", log: nullLogger });
    expect(wt.baseNotes?.join("\n")).toMatch(/WARNING/);
    expect(markerText()).toBe("");
  });

  it("neutralises filter drivers a job planted in a submodule's own config", async () => {
    const lib = join(root, "lib");
    mkdirSync(lib);
    git(lib, "init", "-q");
    writeFileSync(join(lib, ".gitattributes"), "*.txt filter=subevil\n");
    writeFileSync(join(lib, "s.txt"), "library\n");
    git(lib, "add", ".");
    git(lib, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "lib");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", slash(lib), "lib");
    git(repo, "commit", "-q", "-m", "add submodule");
    git(join(repo, "lib"), "config", "filter.subevil.clean", planted("submodule-filter"));
    touch(join(repo, "lib", "s.txt"));
    // Control: plain git status recurses into the submodule and runs its filter.
    git(repo, "status", "--porcelain");
    expect(markerText()).toMatch(/submodule-filter/);
    rmSync(markers);
    touch(join(repo, "lib", "s.txt"));
    expect(await gitChangeSnapshot(repo, nullLogger)).not.toBeNull();
    expect(markerText()).toBe("");
  });

  it("fails closed when the bridge's empty hooks directory is not empty", async () => {
    const hooks = join(home, "git-hooks-empty");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\n${planted("hook:bridge-dir")}\n`);
    expect(await gitChangeSnapshot(repo, nullLogger)).toBeNull();
    await expect(createWorktree({ cwd: repo, home, jobId: "ab422ccc", log: nullLogger })).rejects.toThrow();
    expect(markerText()).toBe("");
  });
});
