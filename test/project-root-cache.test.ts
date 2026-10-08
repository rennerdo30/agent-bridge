import { mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { canonicalProjectRoot, conversationProject, migrateProjectJobs, projectKey } from "../src/core/project-identity.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const git = vi.hoisted(() => vi.fn());
const actualGit = vi.hoisted(() => ({ run: undefined as typeof import("node:child_process").execFileSync | undefined }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>(); actualGit.run = actual.execFileSync;
  return { ...actual, execFileSync: git };
});
let env: TestEnv;
beforeEach(() => { env = makeEnv(); git.mockReset(); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await env.cleanup(); });

const fixtureCeiling = () => realpathSync.native(resolve('.agent-bridge-test')).replace(/\\/g, '/');
function ceiling(...entries: string[]): void { vi.stubEnv('GIT_CEILING_DIRECTORIES', [fixtureCeiling(), ...entries].join(delimiter)); }
function cli(root: string, args: string[]): string {
  const config = join(env.home, 'empty-git-config'); writeFileSync(config, '');
  const fixtureEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_TEMPLATE_DIR']) delete fixtureEnv[name];
  return String(actualGit.run!('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    env: fixtureEnv })).trim();
}
function cliProject(cwd: string): string {
  try { const common = realpathSync.native(resolve(cwd, cli(cwd, ['rev-parse', '--git-common-dir']))); return common.endsWith('/.git') || common.endsWith('\\.git') ? realpathSync.native(resolve(common, '..')) : realpathSync.native(cli(cwd, ['rev-parse', '--show-toplevel'])); }
  catch { return realpathSync.native(cwd); }
}

function repository(root: string): void {
  mkdirSync(join(root, ".git", "objects"), { recursive: true }); mkdirSync(join(root, ".git", "refs"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n"); writeFileSync(join(root, ".git", "config"), "[core]\n\tbare = false\n");
}
function linked(cwd: string, root: string): void {
  mkdirSync(cwd, { recursive: true });
  const gitDir = join(root, ".git", "worktrees", "fixture"); mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(cwd, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/fixture\n");
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  writeFileSync(join(gitDir, "gitdir"), `${join(cwd, ".git")}\n`);
}

it("shares canonical roots across repeated legacy-job migrations and refreshes bounded stale results", () => {
  const cwd = join(env.home, "cwd"), first = join(env.home, "first"), second = join(env.home, "second");
  for (const root of [first, second]) repository(root);
  linked(cwd, first); let now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const records = [{ id: "legacy", workdir: cwd, retainedField: "keep" }];
  for (let i = 0; i < 50; i++) expect(migrateProjectJobs(records)).toEqual([{ ...records[0], projectRoot: realpathSync.native(first) }]);
  expect(git).not.toHaveBeenCalled();
  expect(records[0]).not.toHaveProperty("projectRoot");
  linked(cwd, second); now += 30_001;
  expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(second));
  expect(git).not.toHaveBeenCalled();
});

it("does not retain missing paths when a project appears later", () => {
  const cwd = join(env.home, "created-later");
  expect(canonicalProjectRoot(cwd)).toBeNull();
  repository(cwd);
  expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(cwd));
  expect(git).not.toHaveBeenCalled();
});

it("invalidates a non-Git identity when an ancestor becomes a repository", () => {
  const cwd = join(env.home, "nested"); mkdirSync(cwd);
  expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(cwd));
  repository(env.home);
  expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(env.home));
});

it("resolves ordinary and linked ancestor layouts without any Git subprocess", () => {
  const root = join(env.home, "main with spaces"), wt = join(env.home, "linked with spaces"); repository(root); linked(wt, root);
  for (const cwd of [join(root, "nested", "child"), join(wt, "nested", "child")]) {
    mkdirSync(cwd, { recursive: true }); expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(root));
  }
  const gitDir = join(root, ".git", "worktrees", "fixture");
  // Git's Windows layouts accept relative pointers and either separator convention.
  writeFileSync(join(wt, ".git"), `gitdir: ${relative(wt, gitDir).split("\\").join("/")}\r\n`);
  writeFileSync(join(gitDir, "commondir"), process.platform === "win32" ? "..\\..\r\n" : "../..\r\n");
  expect(canonicalProjectRoot(wt)).toBe(realpathSync.native(root));
  expect(git).not.toHaveBeenCalled();
});

it("invalidates changed common/back pointers immediately and never guesses an ancestor for damaged layouts", () => {
  const root = join(env.home, "root"), wt = join(env.home, "linked"); repository(root); linked(wt, root);
  expect(canonicalProjectRoot(wt)).toBe(realpathSync.native(root));
  const gitDir = join(root, ".git", "worktrees", "fixture");
  writeFileSync(join(gitDir, "gitdir"), `${join(root, ".git")}\n`);
  expect(canonicalProjectRoot(wt)).toBeNull();
  writeFileSync(join(gitDir, "gitdir"), `${join(wt, ".git")}\n`);
  expect(canonicalProjectRoot(wt)).toBe(realpathSync.native(root));
  writeFileSync(join(gitDir, "commondir"), "missing-common-directory\n");
  expect(canonicalProjectRoot(wt)).toBeNull();
  expect(git).not.toHaveBeenCalled();
});

it("bounds malformed pointer reads and preserves unusual-layout fallback", () => {
  const root = join(env.home, "oversized"); mkdirSync(root); writeFileSync(join(root, ".git"), "x".repeat(16 * 1024));
  expect(canonicalProjectRoot(root)).toBeNull(); expect(git).not.toHaveBeenCalled();
  const unusual = join(env.home, "unusual"); repository(unusual); writeFileSync(join(unusual, ".git", "config"), "[core]\n bare = false\n worktree = ../elsewhere\n");
  git.mockImplementation((_file: string, args: string[]) => args.at(-1) === "--git-common-dir" ? join(unusual, ".git") : unusual);
  expect(canonicalProjectRoot(unusual)).toBe(realpathSync.native(unusual)); expect(git).toHaveBeenCalledTimes(2);
});

it('matches Git ceilings for nested repositories, plain children and cwd at the ceiling', () => {
  const root = join(env.home, 'outer'); mkdirSync(root); cli(root, ['init', '-b', 'main']);
  const plain = join(root, 'plain'), nested = join(root, 'nested'); mkdirSync(plain); mkdirSync(nested);
  cli(nested, ['init', '-b', 'main']); ceiling(root);
  for (const cwd of [plain, nested, root]) expect(canonicalProjectRoot(cwd)).toBe(cliProject(cwd));
  expect(canonicalProjectRoot(plain)).toBe(realpathSync.native(plain));
  expect(canonicalProjectRoot(nested)).toBe(realpathSync.native(nested));
  expect(canonicalProjectRoot(root)).toBe(realpathSync.native(root));
  expect(git).not.toHaveBeenCalled();
});

it('invalidates project and conversation caches immediately when the ceiling changes', () => {
  const root = join(env.home, 'outer'), cwd = join(root, 'plain'); mkdirSync(cwd, { recursive: true }); cli(root, ['init', '-b', 'main']);
  ceiling(); expect(canonicalProjectRoot(cwd)).toBe(cliProject(cwd)); expect(conversationProject(cwd)).toBe(projectKey(realpathSync.native(root)));
  ceiling(root); expect(canonicalProjectRoot(cwd)).toBe(cliProject(cwd)); expect(conversationProject(cwd)).toBe(projectKey(realpathSync.native(cwd)));
  ceiling(); expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(root)); expect(git).not.toHaveBeenCalled();
});

it('matches Git for relative/malformed entries, normalized paths and empty-entry literal semantics', () => {
  const root = join(env.home, 'outer'), cwd = join(root, 'plain'); mkdirSync(cwd, { recursive: true }); cli(root, ['init', '-b', 'main']);
  for (const entries of [['relative'], ['..'], [join(env.home, 'does-not-exist')], [root + '/.'], [root + '/'], ['', root], ['', root.replace(/\\/g, '/')], [cwd]]) {
    ceiling(...entries); expect(canonicalProjectRoot(cwd), JSON.stringify(entries)).toBe(cliProject(cwd));
  }
  expect(git).not.toHaveBeenCalled();
});

it('canonicalizes linked ceiling aliases and resolves explicit linked-worktree common directories outside the ceiling', () => {
  const main = join(env.home, 'main'), boundary = join(env.home, 'boundary'), wt = join(boundary, 'linked'); mkdirSync(main); mkdirSync(boundary);
  cli(boundary, ['init', '-b', 'main']);
  cli(main, ['init', '-b', 'main']); cli(main, ['-c', 'user.name=rennerdo30', '-c', 'user.email=9086097+rennerdo30@users.noreply.github.com', 'commit', '--allow-empty', '-m', 'Synthetic project-root fixture']);
  cli(main, ['worktree', 'add', '-b', 'fixture', wt]);
  const alias = join(env.home, 'ceiling-alias'); symlinkSync(boundary, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    ceiling(alias); expect(canonicalProjectRoot(wt)).toBe(cliProject(wt)); expect(canonicalProjectRoot(wt)).toBe(realpathSync.native(main));
    const plain = join(boundary, 'plain'); mkdirSync(plain); expect(canonicalProjectRoot(plain)).toBe(cliProject(plain));
    expect(canonicalProjectRoot(plain)).toBe(realpathSync.native(plain));
    ceiling('', alias.replace(/\\/g, '/')); expect(canonicalProjectRoot(plain)).toBe(cliProject(plain));
    expect(canonicalProjectRoot(plain)).toBe(realpathSync.native(boundary));
  } finally { unlinkSync(alias); }
  expect(git).not.toHaveBeenCalled();
});
