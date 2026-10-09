import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { closeJobWorktree } from "../src/core/job-close.js";
import { readWorktreeState, saveWorktreeState } from "../src/core/worktree-state.js";
import { runDelegate, type RunContext } from "../src/mcp/delegate-run.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";

let fixture: string;
const links: string[] = [];
beforeEach(() => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!;
  mkdirSync(root, { recursive: true });
  fixture = realpathSync.native(mkdtempSync(join(root, "cache-lifecycle-")));
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(fixture, "global.gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  // Detach only generated link entries before removing the private fixture tree.
  for (const path of links.splice(0)) if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
  rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("retains ignored Unity and dependency cache links across completion, close and continuation", async () => {
  const repo = join(fixture, "repo"), home = join(fixture, "bridge"), libraryCache = join(fixture, "unity-cache"), moduleCache = join(fixture, "modules-cache");
  for (const folder of [repo, home, libraryCache, moduleCache]) mkdirSync(folder);
  mkdirSync(join(repo, "Game", "ProjectSettings"), { recursive: true });
  writeFileSync(join(repo, "Game", "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: fixture\n");
  writeFileSync(join(repo, ".gitignore"), "Library/\nnode_modules/\n");
  writeFileSync(join(libraryCache, "sentinel.txt"), "generated complete Unity cache\n");
  writeFileSync(join(moduleCache, "sentinel.txt"), "generated dependency cache\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "rennerdo30");
  git("config", "user.email", "9086097+rennerdo30@users.noreply.github.com");
  git("add", ".");
  git("-c", "user.name=rennerdo30", "-c", "user.email=9086097+rennerdo30@users.noreply.github.com", "commit", "-qm", "Create synthetic cache fixture");
  const context: RunContext = { agent: "claude", cfg: { ...DEFAULT_CONFIG }, home, log: nullLogger, me: () => "parent", cwd: () => repo };
  let turns = 0;
  vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, request) => {
    expect(request.prompt).toContain("only for read-only access to Git-ignored caches");
    const library = join(request.cwd, "Game", "Library"), modules = join(request.cwd, "node_modules");
    if (!turns++) {
      symlinkSync(libraryCache, library, "junction"); links.push(library);
      symlinkSync(moduleCache, modules, "junction"); links.push(modules);
    }
    for (const path of [library, modules]) expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(library, "sentinel.txt"), "utf8")).toBe("generated complete Unity cache\n");
    expect(readFileSync(join(modules, "sentinel.txt"), "utf8")).toBe("generated dependency cache\n");
    return { sessionId: "cache-session", text: "Checked cache reads", isError: false, details: {} };
  });
  const signal = new AbortController().signal;
  const first = await runDelegate(context, "codex", { title: "cache fixture", prompt: "Read cached data", access: "read", worktree: true }, signal, undefined, true);
  const wt = first.worktree!;
  const before = links.map(path => ({ path, target: readlinkSync(path) }));
  expect(first.text).toContain("Read-only ignored cache links");
  for (const link of before) expect(first.text).toContain(`${link.path} -> `);
  // A mocked target launches no processes; provide the same shutdown proof as a real runner.
  const state = readWorktreeState(home, wt)!;
  saveWorktreeState(home, wt, { ...state, processesStopped: true, lastContinuation: Date.now() - 25 * 60 * 60 * 1_000 });
  const close = await closeJobWorktree({ home, job: { name: "codex-job-cachefixture", status: "done", worktree: wt }, enabled: true, log: nullLogger });
  expect(close).toEqual({ action: "kept", reason: "Linked or shared contents are kept." });
  const second = await runDelegate(context, "codex", { title: "continue cache fixture", prompt: "Continue checking caches", access: "read", session_id: "cache-session", _worktree: wt }, signal, undefined, true);
  expect(second.sessionId).toBe("cache-session");
  expect(turns).toBe(2);
  expect(links.map(path => ({ path, target: readlinkSync(path) }))).toEqual(before);
  expect(readFileSync(join(libraryCache, "sentinel.txt"), "utf8")).toBe("generated complete Unity cache\n");
  expect(readFileSync(join(moduleCache, "sentinel.txt"), "utf8")).toBe("generated dependency cache\n");
});
