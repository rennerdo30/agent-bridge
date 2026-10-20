import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { closeMetadataDb } from "../src/core/metadata-db.js";
import { changedFilesNote, codexHookObservation, createWorktree, git as bridgeGit, finishWorktree, gitChangeSnapshot, gitStatusSnapshot, snapshotChanges } from "../src/core/worktree.js";
import { NO_LAZY_FETCH_ARGS, repositoryGuards, resetGitFeatureCache } from "../src/core/git-safety.js";
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
  set("core.fsmonitor", planted("fsmonitor"));
  set("core.untrackedCache", "true");
  // Includes (plain or conditional) make filter-capable calls refuse (round 3), so they have their own tests below.
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

/** A fake `git-lfs` first on PATH: clean stores `pointer:<content>`, smudge restores it, and clean runs every
 * `lfs.extension.<n>.clean` program like the real git-lfs does. Each call is recorded as `lfs:<command>`. */
function fakeGitLfs(): void {
  const bin = join(root, "fakebin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "git-lfs");
  writeFileSync(script, [
    "#!/bin/sh",
    `node "${slash(join(evil, "marker.js"))}" ` + '"lfs:$1" "prompt=${GIT_TERMINAL_PROMPT:-unset}" "gcm=${GCM_INTERACTIVE:-unset}"',
    'case "$1" in',
    "  clean)",
    "    git config --get-regexp '^lfs\\.extension\\..*\\.clean$' | while read -r key cmd; do sh -c \"$cmd\" </dev/null; done",
    "    printf 'pointer:'; cat ;;",
    "  smudge) sed 's/^pointer://' ;;",
    "  *) cat ;;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(script, 0o755);
  // Git prepends its exec path to PATH before running filters. On Windows that contains the real git-lfs.exe,
  // which otherwise wins over this extensionless fixture even when fakebin leads the parent PATH.
  // Keep both overrides process-local; the canonical driver strings and all pointer assertions stay unchanged.
  vi.stubEnv("GIT_EXEC_PATH", bin);
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
}

const CANONICAL_LFS = [["filter.lfs.clean", "git-lfs clean -- %f"], ["filter.lfs.smudge", "git-lfs smudge -- %f"], ["filter.lfs.required", "true"]] as const;

/** Commit `big.bin` through the LFS filter (plain git, before anything is planted). */
function commitLfsFile(): void {
  writeFileSync(join(repo, ".gitattributes"), "*.bin filter=lfs\n");
  writeFileSync(join(repo, "big.bin"), "binary payload\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "lfs file");
  expect(git(repo, "cat-file", "-p", "HEAD:big.bin")).toBe("pointer:binary payload");
  rmSync(markers, { force: true });
}

/** A repository with its own filter driver, committed into the superproject as a bare gitlink (no .gitmodules). */
function embeddedRepository(path: string, driver: string, gitDir?: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", ...(gitDir ? ["--separate-git-dir", gitDir] : []));
  writeFileSync(join(path, ".gitattributes"), `*.txt filter=${driver}\n`);
  writeFileSync(join(path, "s.txt"), "embedded\n");
  git(path, "add", ".");
  git(path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "embedded");
  git(repo, "add", slash(path.slice(repo.length + 1)));
  git(repo, "commit", "-q", "-m", "add gitlink");
  git(path, "config", `filter.${driver}.clean`, planted(`${driver}-filter`));
}

describe("bridge git calls: nested repositories, target worktrees and Git LFS (AB-422 review)", () => {
  it("neutralises a filter in an embedded repository committed as a gitlink without .gitmodules", async () => {
    embeddedRepository(join(repo, "sub"), "embevil");
    touch(join(repo, "sub", "s.txt"));
    git(repo, "status", "--porcelain");
    expect(markerText()).toMatch(/embevil-filter/);
    rmSync(markers);
    touch(join(repo, "sub", "s.txt"));
    expect(await gitChangeSnapshot(repo, nullLogger)).not.toBeNull();
    expect(markerText()).toBe("");
  });

  it("neutralises a filter in a gitlink whose .git file points outside the superproject's modules/", async () => {
    mkdirSync(join(root, "outside"));
    embeddedRepository(join(repo, "sub2"), "farevil", slash(join(root, "outside", "sub2.git")));
    expect(readFileSync(join(repo, "sub2", ".git"), "utf8")).toMatch(/^gitdir: /);
    touch(join(repo, "sub2", "s.txt"));
    git(repo, "status", "--porcelain");
    expect(markerText()).toMatch(/farevil-filter/);
    rmSync(markers);
    touch(join(repo, "sub2", "s.txt"));
    expect(await gitChangeSnapshot(repo, nullLogger)).not.toBeNull();
    expect(markerText()).toBe("");
  });

  it("cleanup's `git worktree remove` runs no filter from the target worktree's own config.worktree", async () => {
    const wt = await createWorktree({ cwd: repo, home, jobId: "ab422ddd", log: nullLogger });
    git(repo, "config", "extensions.worktreeConfig", "true");
    git(wt.path, "config", "--worktree", "filter.wtevil.clean", planted("worktree-filter"));
    const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
    mkdirSync(join(common, "info"), { recursive: true });
    writeFileSync(join(common, "info", "attributes"), "a.txt filter=wtevil\n");
    // A future mtime keeps the entry racily clean, so every status in the target re-reads it through its filter.
    const future = () => { const when = new Date(Date.now() + 86_400_000); utimesSync(join(wt.path, "a.txt"), when, when); };
    future();
    git(wt.path, "status", "--porcelain");
    expect(markerText()).toMatch(/worktree-filter/);
    rmSync(markers);
    future();
    const entries = await cleanupWorktrees({ cwd: repo, home, apply: true, log: nullLogger });
    expect(markerText()).toBe("");
    expect(entries.find((e) => e.branch === wt.branch)?.action).toBe("removed");
  });

  it("finds gitlinks of a repository whose core.worktree points to another directory", async () => {
    // The git directory lives in gitroot; its work tree (core.worktree) is a separate folder.
    const gitroot = join(root, "gitroot"), tree = join(root, "tree");
    mkdirSync(gitroot);
    mkdirSync(tree);
    git(gitroot, "init", "-q");
    git(gitroot, "config", "core.worktree", slash(tree));
    git(gitroot, "config", "user.name", "Repository Owner");
    git(gitroot, "config", "user.email", "owner@example.test");
    writeFileSync(join(tree, "top.txt"), "top\n");
    const inner = join(tree, "inner");
    mkdirSync(inner);
    git(inner, "init", "-q");
    writeFileSync(join(inner, ".gitattributes"), "*.txt filter=wtinner\n");
    writeFileSync(join(inner, "s.txt"), "inner\n");
    git(inner, "add", ".");
    git(inner, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "inner");
    git(gitroot, "add", "top.txt", "inner");
    git(gitroot, "commit", "-q", "-m", "tree with gitlink");
    git(inner, "config", "filter.wtinner.clean", planted("core-worktree-filter"));
    touch(join(inner, "s.txt"));
    git(gitroot, "status", "--porcelain");
    expect(markerText()).toMatch(/core-worktree-filter/);
    rmSync(markers);
    touch(join(inner, "s.txt"));
    expect(await gitChangeSnapshot(gitroot, nullLogger)).not.toBeNull();
    expect(markerText()).toBe("");
  });

  it("cleanup keeps a worktree whose removal the guards refused, even when the refusal text looks like a permission error", async () => {
    const wt = await createWorktree({ cwd: repo, home, jobId: "ab422abd", log: nullLogger });
    // A gitlink named "Permission denied" in the main checkout's index whose .git file points nowhere: only
    // `worktree remove` (run in the main checkout) reaches it, and its guard refusal names that path.
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${head},Permission denied`);
    mkdirSync(join(repo, "Permission denied"));
    writeFileSync(join(repo, "Permission denied", ".git"), `gitdir: ${slash(join(root, "missing"))}\n`);
    const entries = await cleanupWorktrees({ cwd: repo, home, apply: true, log: nullLogger });
    const entry = entries.find((e) => e.branch === wt.branch);
    expect(entry?.action).toBe("kept");
    expect(entry?.reason).toMatch(/AB-422/);
    expect(existsSync(join(wt.path, "a.txt"))).toBe(true);
  });

  it("keeps a canonical repository-local Git LFS driver working (checkout smudges, WIP commits clean)", async () => {
    fakeGitLfs();
    for (const [key, value] of CANONICAL_LFS) git(repo, "config", key, value);
    commitLfsFile();
    const wt = await createWorktree({ cwd: repo, home, jobId: "ab422eee", log: nullLogger });
    expect(readFileSync(join(wt.path, "big.bin"), "utf8")).toBe("binary payload\n");
    expect(markerText()).toMatch(/lfs:smudge/);
    // Finding 4 of the second review: an LFS endpoint from repository config can never open a login prompt.
    expect(markerText()).toMatch(/lfs:smudge prompt=0 gcm=Never/);
    writeFileSync(join(wt.path, "new.bin"), "job binary\n");
    await finishWorktree(wt, "WIP: lfs work", nullLogger, true);
    expect(git(repo, "cat-file", "-p", `${wt.branch}:new.bin`)).toBe("pointer:job binary");
  });

  it("refuses filter-capable calls while Git LFS is active and repository-local config sets an lfs.extension", async () => {
    fakeGitLfs();
    // The owner's global Git LFS install.
    writeFileSync(join(home, "global.gitconfig"), `[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\trequired = true\n`);
    commitLfsFile();
    git(repo, "config", "lfs.extension.evil.clean", planted("lfs-extension"));
    git(repo, "config", "lfs.extension.evil.smudge", planted("lfs-extension-smudge"));
    git(repo, "config", "lfs.extension.evil.priority", "0");
    touch(join(repo, "big.bin"));
    git(repo, "status", "--porcelain");
    expect(markerText()).toMatch(/lfs-extension/);
    rmSync(markers);
    touch(join(repo, "big.bin"));
    expect(await gitChangeSnapshot(repo, nullLogger)).toBeNull();
    await expect(createWorktree({ cwd: repo, home, jobId: "ab422fff", log: nullLogger })).rejects.toThrow(/lfs\.extension/);
    expect(markerText()).not.toMatch(/lfs-extension/);
  });

  it.each([
    ["http.proxy", "http://127.0.0.1:9"],
    ["http.sslVerify", "false"],
    ["http.https://example.test/.sslCAInfo", "/tmp/evil-ca.pem"],
    ["http.curloptResolve", "example.test:443:127.0.0.1"],
    ["remote.origin.proxy", "http://127.0.0.1:9"],
  ])("refuses the base fetch when repository-local config sets %s", async (key, value) => {
    const upstream = join(root, "upstream");
    git(root, "clone", "-q", "--bare", repo, upstream);
    git(repo, "remote", "add", "origin", slash(upstream));
    git(repo, "config", key, value);
    const wt = await createWorktree({ cwd: repo, home, jobId: "ab422aab", log: nullLogger });
    expect(wt.baseNotes?.join("\n")).toMatch(/discovery failed|fetch failed/);
  });

  it("still fetches the base when repository-local config only tunes http.postBuffer", async () => {
    const upstream = join(root, "upstream");
    git(root, "clone", "-q", "--bare", repo, upstream);
    git(repo, "remote", "add", "origin", slash(upstream));
    git(repo, "config", "http.postBuffer", "524288000");
    const wt = await createWorktree({ cwd: repo, home, jobId: "ab422aac", log: nullLogger });
    expect(wt.baseNotes?.join("\n") ?? "").not.toMatch(/discovery failed|fetch failed/);
  });
});

describe("AB-422 guard decisions", () => {
  /** A runner that answers `git config --list` with the given entries (scope, key, value) and lists no gitlinks. */
  const configured = (entries: [string, string, string][]) => async (args: string[]) =>
    args[0] === "--version" ? "git version 2.55.0\n" : args[0] === "config" ? entries.map(([scope, key, value]) => `${scope}\0file:x\0${key}\n${value}\0`).join("") : "";

  it("keeps the canonical local filter.lfs driver and neutralises any other value of it", async () => {
    const canonical: [string, string, string][] = [["local", "filter.lfs.clean", "git-lfs clean -- %f"], ["local", "filter.lfs.smudge", "git-lfs smudge -- %f"],
      ["local", "filter.lfs.process", "git-lfs filter-process"], ["local", "filter.lfs.required", "true"]];
    expect((await repositoryGuards(["status"], root, configured(canonical))).args).toEqual(NO_LAZY_FETCH_ARGS);
    for (const value of ["git-lfs.exe filter-process", "/tmp/git-lfs filter-process", "git-lfs filter-process --verbose", "evil"]) {
      const guards = await repositoryGuards(["status"], root, configured([...canonical, ["local", "filter.lfs.process", value]]));
      expect(guards.args).toContain("filter.lfs.process=");
    }
  });

  const activeLfs = (key: string): [string, string, string][] => [["global", "filter.lfs.process", "git-lfs filter-process"], ["local", key, "x"]];

  it.each(["lfs.extension.x.clean", "lfs.customtransfer.x.path", "lfs.standalonetransferagent"])(
    "refuses every filter-capable call with active Git LFS and local %s", async (key) => {
      for (const command of [["status"], ["add", "-A"], ["commit", "-m", "x"], ["checkout", "main"], ["worktree", "add", "x"]]) {
        await expect(repositoryGuards(command, root, configured(activeLfs(key)))).rejects.toThrow(/Git LFS is active/);
      }
    });

  it.each(["credential.helper", "core.sshCommand", "http.proxy", "http.sslVerify", "remote.origin.proxy"])(
    "with active Git LFS and local %s, refuses only commands that can smudge (download)", async (key) => {
      for (const command of [["checkout", "main"], ["switch", "main"], ["restore", "."], ["reset", "--hard"], ["stash"], ["merge", "x"], ["pull"], ["worktree", "add", "x"],
        ["read-tree", "-u", "x"], ["checkout-index", "-a"], ["cherry-pick", "x"], ["revert", "x"], ["rebase", "x"], ["am"]]) {
        // pull is also a network command and may be refused by that check first.
        await expect(repositoryGuards(command, root, configured(activeLfs(key))), command.join(" ")).rejects.toThrow(command[0] === "pull" ? /refused/ : /Git LFS is active/);
      }
      // Clean-only commands never download, so the owner's local credential or http settings do not block them.
      for (const command of [["status", "--porcelain"], ["add", "-A"], ["commit", "-m", "x"], ["diff"], ["rm", "x"], ["mv", "a", "b"], ["update-index", "--refresh"], ["worktree", "remove", "x"]]) {
        expect((await repositoryGuards(command, root, configured(activeLfs(key)))).args, command.join(" ")).toEqual(NO_LAZY_FETCH_ARGS);
      }
    });

  it("sets no-prompt variables for the guarded command while Git LFS is active, and only then", async () => {
    const active = await repositoryGuards(["status"], root, configured([["global", "filter.lfs.process", "git-lfs filter-process"]]));
    expect(active.env).toEqual({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_NO_LAZY_FETCH: "1" });
    expect((await repositoryGuards(["status"], root, configured([]))).env).toEqual({ GIT_NO_LAZY_FETCH: "1" });
  });

  it("records a failed hook observation when the working copy could be compared before the job but not after it", () => {
    expect(codexHookObservation(1, null)).toBe("verified");
    expect(codexHookObservation(0, ["a.txt"])).toBe("failed");
    expect(codexHookObservation(0, null)).toBe("failed");
    expect(codexHookObservation(0, [])).toBeNull();
  });

  it.each(["http.proxy", "http.sslVerify", "http.https://example.test/.sslCAInfo", "http.curloptResolve", "http.extraHeader", "remote.origin.proxy"])(
    "refuses network commands with local %s", async (key) => {
      await expect(repositoryGuards(["fetch"], root, configured([["local", key, "x"]]))).rejects.toThrow(/refused/);
    });

  it("allows pure http transfer tuning for network commands", async () => {
    expect((await repositoryGuards(["fetch"], root, configured([["local", "http.postbuffer", "1"], ["local", "http.https://x/.lowspeedtime", "9"]]))).args).toEqual([]);
  });

  it("reports an unavailable after-snapshot as unknown, never as 'No files changed'", () => {
    const before = new Map([["a.txt", " M:1"]]);
    expect(snapshotChanges(before, null)).toBeNull();
    const note = changedFilesNote(snapshotChanges(before, null), "edit");
    expect(note).toMatch(/unknown/);
    expect(note).not.toMatch(/No files changed/);
    expect(changedFilesNote(snapshotChanges(before, new Map(before)), "edit")).toBe("No files changed.");
    expect(changedFilesNote([], "ask")).toBeNull();
  });

  it("reads effective config with --includes", async () => {
    const reads: string[][] = [];
    await repositoryGuards(["status"], root, async (args) => { reads.push(args); return args[0] === "--version" ? "git version 2.55.0\n" : ""; });
    expect(reads.find((args) => args[0] === "config")).toContain("--includes");
  });

  it.each(["include.path", "includeIf.onbranch:agent-bridge/**.path", "includeIf.gitdir:**/worktrees/**.path"])(
    "refuses every filter-capable command when a reached repository's local config has %s", async (key) => {
      for (const command of [["status"], ["diff"], ["add", "-A"], ["checkout", "main"], ["worktree", "add", "x"], ["worktree", "remove", "x"]]) {
        await expect(repositoryGuards(command, root, configured([["local", key, "/tmp/x.gitconfig"]])), command.join(" ")).rejects.toThrow(/include/);
      }
      // Commands that run no filter are unaffected; the owner's global includes are trusted.
      expect((await repositoryGuards(["rev-parse", "HEAD"], root, configured([["local", key, "/tmp/x"]]))).args).toEqual(NO_LAZY_FETCH_ARGS);
      expect((await repositoryGuards(["status"], root, configured([["global", key, "/tmp/x"]]))).args).toEqual(NO_LAZY_FETCH_ARGS);
    });

  it("blocks lazy fetches for every command that is not an intended network command", async () => {
    for (const command of [["status"], ["diff"], ["show", "HEAD"], ["log", "-p"], ["rev-parse", "HEAD"], ["cat-file", "-p", "x"], ["worktree", "add", "x"]]) {
      const guards = await repositoryGuards(command, root, configured([]));
      expect(guards.env.GIT_NO_LAZY_FETCH, command.join(" ")).toBe("1");
      for (const value of ["protocol.allow=never", "protocol.ext.allow=never", "protocol.file.allow=never", "protocol.git.allow=never",
        "protocol.http.allow=never", "protocol.https.allow=never", "protocol.ssh.allow=never"]) expect(guards.args).toContain(value);
    }
    const fetch = await repositoryGuards(["fetch"], root, configured([]));
    expect(fetch.args).toEqual([]);
    expect(fetch.env.GIT_NO_LAZY_FETCH).toBeUndefined();
  });

  it("refuses promisor repositories when git cannot enforce disabled lazy fetching", async () => {
    const promisor: [string, string, string][] = [["local", "remote.evil.promisor", "true"]];
    const at = (version: string, entries: [string, string, string][]) => async (args: string[]) =>
      args[0] === "--version" ? `git version ${version}\n` : configured(entries)(args);
    try {
      for (const entries of [promisor, [["local", "extensions.partialclone", "evil"]], [["local", "remote.evil.partialclonefilter", "blob:none"]]] as [string, string, string][][]) {
        resetGitFeatureCache();
        await expect(repositoryGuards(["rev-parse", "HEAD"], root, at("2.43.0.windows.1", entries))).rejects.toThrow(/lazy/);
      }
      resetGitFeatureCache();
      expect((await repositoryGuards(["rev-parse", "HEAD"], root, at("2.43.0", []))).args).toEqual(NO_LAZY_FETCH_ARGS);
      resetGitFeatureCache();
      await expect(repositoryGuards(["show", "HEAD"], root, at("2.44.0", promisor))).rejects.toThrow(/lazy/);
    } finally { resetGitFeatureCache(); }
  });

  it("network commands also refuse local protocol keys and ext::/fd:: URL rewrites", async () => {
    for (const [key, value] of [["protocol.ext.allow", "always"], ["protocol.allow", "always"], ["url.ext::sh -c evil.insteadof", "https://"], ["url.fd::3.pushinsteadof", "ssh://"]] as const) {
      await expect(repositoryGuards(["fetch"], root, configured([["local", key, value]])), key).rejects.toThrow(/refused/);
    }
  });
});

describe("AB-422 round 4: enforcement floors and every reached repository", () => {
  const config = (entries: [string, string, string][]) => entries.map(([scope, key, value]) =>
    `${scope}\0file:fixture\0${key}\n${value}\0`).join("");
  const promisor = config([["local", "remote.fixture.promisor", "true"]]);

  // Source-verified official tags; these mock the version, not the installed old Git implementation.
  it.each([
    ["2.39.3", false], ["2.39.4", true], ["2.40.1", false], ["2.40.2", true],
    ["2.41.0", false], ["2.41.1", true], ["2.42.1", false], ["2.42.2", true],
    ["2.43.3", false], ["2.43.4", true], ["2.44.0.windows.99", false], ["2.44.1.windows.1", true],
    ["2.45.0", false], ["2.45.1", true], ["2.46.0", true], ["2.55.0.windows.2", true],
    ["2.38.99.vendor-backport", false], ["2.45", false], ["2.45.1-rc0", false], ["unknown", false],
  ])("version %s has direct-prefetch enforcement: %s (mock)", async (version, supported) => {
    resetGitFeatureCache();
    try {
      const pending = repositoryGuards(["show", "HEAD"], root, async (args) =>
        args[0] === "--version" ? `git version ${version}\n` : args[0] === "config" ? promisor : "");
      if (supported) expect((await pending).env.GIT_NO_LAZY_FETCH).toBe("1");
      else await expect(pending).rejects.toThrow(/lazy/);
    } finally { resetGitFeatureCache(); }
  });

  it.each(["show", "status", "fetch"])("denies arbitrary specific protocols for %s before dispatch", async (sub) => {
    resetGitFeatureCache();
    const entries = config([["local", "protocol.x/../payload.allow", "always"], ["global", "protocol.OwnerHelper.allow", "always"]]);
    const pending = repositoryGuards([sub, "HEAD"], root, async (args) => args[0] === "--version" ? "git version 2.55.0" : args[0] === "config" ? entries : "");
    if (sub === "fetch") await expect(pending).rejects.toThrow(/refused/);
    else {
      const guards = await pending;
      expect(guards.args).toContain("protocol.x/../payload.allow=never");
      expect(guards.args).toContain("protocol.OwnerHelper.allow=never");
    }
  });

  it.each(["embedded", "gitfile", "nested"])("refuses legacy promisor config in a reached %s repo before its index read", async (layout) => {
    const sub = join(repo, "sub");
    embeddedRepository(sub, "fixture", layout === "gitfile" ? join(root, "external-git-dir") : undefined);
    let target = sub;
    if (layout === "nested") {
      target = join(sub, "deep");
      mkdirSync(target);
      git(target, "init", "-q");
      writeFileSync(join(target, "x"), "x");
      git(target, "add", ".");
      git(target, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "deep");
      git(sub, "add", "deep");
    }
    git(target, "config", "remote.fixture.promisor", "true");
    resetGitFeatureCache();
    const reads: { args: string[]; dir: string | null }[] = [];
    try {
      await expect(repositoryGuards(["status"], repo, async (args, dir) => {
        reads.push({ args, dir });
        return args[0] === "--version" ? "git version 2.43.3.vendor" : git(dir ?? repo, ...args);
      })).rejects.toThrow(/lazy/);
      expect(reads.some((read) => read.dir === target && read.args[0] === "ls-files")).toBe(false);
    } finally { resetGitFeatureCache(); }
  });

  it.each([["remove", false], ["move", false], ["remove", true], ["move", true]] as const)(
    "refuses legacy promisor config.worktree in the %s target (shorthand %s)", async (command, shorthand) => {
    const target = join(root, "target");
    git(repo, "worktree", "add", "-qb", "fixture-target", target);
    git(repo, "config", "extensions.worktreeConfig", "true");
    git(target, "config", "--worktree", "remote.fixture.promisor", "true");
    resetGitFeatureCache();
    try {
      await expect(repositoryGuards(["worktree", command, shorthand ? "target" : target, join(root, "moved")], repo, async (args, dir) =>
        args[0] === "--version" ? "git version 2.45.0" : git(dir ?? repo, ...args))).rejects.toThrow(/lazy/);
      expect(existsSync(join(target, ".git"))).toBe(true);
    } finally { resetGitFeatureCache(); }
  });

  it.each(["configured", "explicit"])("checks nested network config with %s submodule recursion", async (recursion) => {
    const sub = join(repo, "sub");
    embeddedRepository(sub, "fixture");
    git(repo, "config", "fetch.recurseSubmodules", "true");
    git(sub, "config", "remote.fixture.uploadpack", "fixture-only-never-executed");
    await expect(repositoryGuards(["fetch", ...(recursion === "explicit" ? ["--recurse-submodules"] : [])], repo,
      async (args, dir) => git(dir ?? repo, ...args))).rejects.toThrow(/refused/);
    expect(markerText()).toBe("");
  });

  it("refuses unreadable nested configuration and recovers from an unknown version without caching it", async () => {
    embeddedRepository(join(repo, "sub"), "fixture");
    resetGitFeatureCache();
    try {
      const pending = repositoryGuards(["status"], repo, async (args, dir) => {
        if (args[0] === "--version") return "unknown";
        if (dir && args[0] === "config") throw new Error("unreadable fixture config: fixture-secret-value");
        return git(dir ?? repo, ...args);
      });
      await expect(pending).rejects.toThrow(/cannot read/);
      await expect(pending).rejects.not.toThrow(/fixture-secret-value/);
      const versions: string[] = [];
      const guards = await repositoryGuards(["show", "HEAD"], repo, async (args) => {
        if (args[0] === "--version") { versions.push("read"); return "git version 2.45.1"; }
        return args[0] === "config" ? promisor : "";
      });
      expect(versions).toHaveLength(1);
      expect(guards.env.GIT_NO_LAZY_FETCH).toBe("1");
    } finally { resetGitFeatureCache(); }
  });
});

describe("AB-422 round 3: conditional includes and lazy fetches", () => {
  it("refuses worktree creation when repository config has an include that activates only in the new worktree", async () => {
    const included = join(evil, "onbranch.gitconfig");
    writeFileSync(included, `[filter "evil"]\n\tsmudge = ${planted("include-smudge")}\n\tclean = ${planted("include-clean")}\n`);
    git(repo, "config", "includeIf.onbranch:agent-bridge/**.path", slash(included));
    // Control: inactive on the source branch, active in the checkout of a new agent-bridge/ worktree.
    touch(join(repo, "a.txt"));
    git(repo, "status", "--porcelain");
    expect(markerText()).toBe("");
    git(repo, "worktree", "add", "-q", "-b", "agent-bridge/control", join(root, "control"));
    expect(markerText()).toMatch(/include-smudge/);
    rmSync(markers);
    await expect(createWorktree({ cwd: repo, home, jobId: "ab422inc", log: nullLogger })).rejects.toThrow(/include/);
    expect(markerText()).toBe("");
  });

  it("refuses filter-capable calls with an active plain include.path", async () => {
    const included = join(evil, "included.gitconfig");
    writeFileSync(included, `[core]\n\tfsmonitor = ${planted("fsmonitor")}\n`);
    git(repo, "config", "include.path", slash(included));
    touch(join(repo, "a.txt"));
    expect(await gitChangeSnapshot(repo, nullLogger)).toBeNull();
    expect(await bridgeGit(["rev-parse", "HEAD"], repo, nullLogger)).toMatch(/^[0-9a-f]{40}$/);
    expect(markerText()).toBe("");
  });

  it("an ordinary read never lazily fetches a missing object from a planted promisor remote", async () => {
    writeFileSync(join(repo, "lazy.txt"), "lazy blob content\n");
    git(repo, "add", "lazy.txt");
    git(repo, "commit", "-q", "-m", "lazy");
    const blob = git(repo, "rev-parse", "HEAD:lazy.txt");
    rmSync(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    git(repo, "config", "core.repositoryformatversion", "1");
    git(repo, "config", "extensions.partialClone", "evil");
    git(repo, "config", "remote.evil.url", `ext::node ${slash(join(evil, "marker.js"))} lazy-fetch`);
    git(repo, "config", "remote.evil.promisor", "true");
    git(repo, "config", "protocol.ext.allow", "always");
    // Control: plain git lazily fetches through the planted transport.
    try { git(repo, "cat-file", "-p", blob); } catch { /* the fake transport fails after it ran */ }
    expect(markerText()).toMatch(/lazy-fetch/);
    rmSync(markers);
    await expect(bridgeGit(["show", "HEAD:lazy.txt"], repo, nullLogger)).rejects.toThrow();
    await expect(bridgeGit(["diff", "HEAD~1", "HEAD"], repo, nullLogger)).rejects.toThrow();
    expect(markerText()).toBe("");
  });
});
