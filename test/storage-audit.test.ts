import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, lstatSync, readFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { runStorage } from "../src/cli/storage.js";

const io = vi.hoisted(() => ({ enabled: false, opened: [] as string[], denied: "" }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    openSync: new Proxy(fs.openSync, { apply(target, self, args) {
      if (io.enabled) io.opened.push(String(args[0]));
      return Reflect.apply(target, self, args);
    } }),
    readFileSync: new Proxy(fs.readFileSync, { apply(target, self, args) {
      if (io.enabled) io.opened.push(String(args[0]));
      return Reflect.apply(target, self, args);
    } }),
    opendirSync: new Proxy(fs.opendirSync, { apply(target, self, args) {
      if (String(args[0]) === io.denied) throw Object.assign(new Error("private diagnostic"), { code: "EACCES" });
      return Reflect.apply(target, self, args);
    } }),
  };
});
const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "storage-audit-")); roots.push(root); return root; }
afterEach(() => { vi.restoreAllMocks(); io.enabled = false; io.opened = []; io.denied = ""; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function audit(root: string, args: string[] = []) {
  const lines: string[] = [];
  const code = runStorage(["audit", "--root", root, "--json", ...args], join(root, "unused-home"), s => lines.push(s));
  return { code, value: JSON.parse(lines.join("\n")) };
}
function snapshot(root: string): unknown[] {
  return readdirSync(root).sort().map(name => {
    const file = join(root, name), st = lstatSync(file);
    return [name, st.mode, st.mtimeMs, st.isDirectory() ? snapshot(file) : st.isSymbolicLink() ? "link" : readFileSync(file).toString("hex")];
  });
}

it("inventories sizes and dates without writes or exposing content", () => {
  const root = fixture(), folder = join(root, ".agent-bridge"); mkdirSync(folder);
  writeFileSync(join(folder, "token"), "SECRET-CANARY");
  writeFileSync(join(folder, "conversations-test.db"), "invalid db");
  const before = snapshot(root); io.enabled = true;
  const result = audit(root); io.enabled = false;
  expect(result.code).toBe(0);
  expect(result.value.directories[0]).toMatchObject({ path: folder, directBytes: 23, bytes: 23, complete: true, historicalCause: "unknown" });
  expect(result.value.directories[0].createdAt).toMatch(/^\d{4}-/);
  expect(JSON.stringify(result)).not.toContain("SECRET-CANARY");
  expect(io.opened).toEqual([]);
  expect(snapshot(root)).toEqual(before);
});

it("distinguishes filesystem nesting from nesting under the same Git root", () => {
  const root = fixture(), repo = join(root, "repo"), sub = join(repo, "sub"), separate = join(repo, "separate");
  for (const dir of [repo, separate]) {
    mkdirSync(join(dir, ".git", "objects"), { recursive: true }); mkdirSync(join(dir, ".git", "refs"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(dir, ".git", "config"), "[core]\n bare = false\n");
  }
  for (const dir of [sub, separate, join(root, "no-git")]) mkdirSync(join(dir, ".agent-bridge"), { recursive: true });
  const result = audit(root).value;
  const byParent = (p: string) => result.directories.find((d: any) => d.path === join(p, ".agent-bridge")).project;
  expect(byParent(sub)).toMatchObject({ nestedUnderSameGitRoot: true });
  expect(byParent(sub).canonicalRoot.toLowerCase()).toBe(repo.toLowerCase());
  expect(byParent(separate)).toMatchObject({ nestedUnderSameGitRoot: false });
  expect(byParent(join(root, "no-git"))).toMatchObject({ nestedUnderSameGitRoot: null });
});

it("bounds time, metadata rows and JSON reads while preserving inputs", () => {
  const root = fixture(), folder = join(root, ".agent-bridge"); mkdirSync(folder);
  writeFileSync(join(folder, "jobs.json"), JSON.stringify([{ name: "job-1", sessionId: "s1", prompt: "PROMPT-CANARY" }, { name: "job-2" }]));
  const limited = audit(root, ["--max-records", "1"]);
  expect(limited.value.directories[0].attribution).toMatchObject({ status: "partial", records: [{ job: "job-1", session: "s1", source: join(folder, "jobs.json") }] });
  expect(JSON.stringify(limited)).not.toContain("PROMPT-CANARY");
  writeFileSync(join(folder, "jobs.json"), " ".repeat(256 * 1024 + 1));
  expect(audit(root).value.directories[0].attribution.status).toBe("partial");
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(1000);
  const timed = audit(root, ["--max-ms", "1"]);
  expect(timed.code).toBe(1); expect(timed.value.entries).toBe(0);
  expect(timed.value.problems[0].code).toBe("TIME_LIMIT");
});

it("reads run metadata but never secret/config files, transcripts or linked metadata", () => {
  const root = fixture(), folder = join(root, ".agent-bridge"), runs = join(folder, "runs"); mkdirSync(runs, { recursive: true });
  const run = join(runs, "2026-11-03-14-00-00-codex-job-abc.json");
  writeFileSync(run, JSON.stringify({ job: "codex-job-abc", session: "session-abc", by: "owner", prompt: "PROMPT-CANARY" }));
  for (const file of [join(folder, "auth.json"), join(folder, "config.json"), join(runs, "token.json"), run.replace(".json", ".log")]) writeFileSync(file, "SECRET-CANARY");
  const outside = join(root, "metadata.json"); writeFileSync(outside, '{"name":"foreign-job"}');
  // A junction exercises root safety elsewhere; this file link covers metadata admission.
  symlinkSync(outside, join(folder, "jobs.json"), "file");
  const before = snapshot(root); io.enabled = true;
  const result = audit(root); io.enabled = false;
  expect(result.code).toBe(1);
  expect(result.value.directories[0].attribution.records).toContainEqual({ source: run, job: "codex-job-abc", session: "session-abc", owner: "owner" });
  expect(io.opened).toEqual([run]);
  expect(JSON.stringify(result)).not.toMatch(/SECRET-CANARY|PROMPT-CANARY|foreign-job/);
  expect(snapshot(root)).toEqual(before);
});

it("the actual CLI dispatch leaves a missing home absent for audit and help", () => {
  const root = fixture(), bundle = join(root, "cli.mjs"), scan = join(root, "scan"), home = join(root, "missing-home"); mkdirSync(scan);
  // Source bundle is an isolated test artifact, never plugins/*/dist.
  buildSync({ entryPoints: ["src/cli/main.ts"], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  // Resolve shared dependencies without installing or changing the owner's environment.
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const before = readdirSync(root).sort();
  for (const args of [["--root", scan, "--json"], ["--help"], []]) {
    const child = spawnSync(process.execPath, [bundle, "storage", "audit", ...args], { encoding: "utf8", timeout: 10_000, windowsHide: true, env: { ...process.env, AGENT_BRIDGE_HOME: home } });
    console.log(`Owned CLI PID ${child.pid}, exited ${child.status}`);
    expect(child.status, child.stderr).toBe(args.length ? 0 : 2);
    expect(child.stdout).toContain(args.includes("--json") ? '"readOnly": true' : "Usage:");
  }
  expect(readdirSync(root).sort()).toEqual(before);
});

it("deduplicates overlapping explicit roots without losing recursive bytes", () => {
  const root = fixture(), folder = join(root, ".agent-bridge"), child = join(folder, "child"); mkdirSync(child, { recursive: true });
  writeFileSync(join(child, "payload"), "1234567");
  const lines: string[] = [];
  expect(runStorage(["audit", "--root", child, "--root", root, "--root", folder, "--json"], fixture(), s => lines.push(s))).toBe(0);
  const result = JSON.parse(lines.join("\n"));
  expect(result.directories).toHaveLength(1); expect(result.directories[0]).toMatchObject({ bytes: 7, directBytes: 0, complete: true });
  expect(result.entries).toBe(audit(root).value.entries);
});

it.each(["included config", "separate Git directory"])("keeps a missing home absent with %s in the actual CLI", layout => {
  const root = fixture(), repo = join(root, "repo"), git = layout === "included config" ? join(repo, ".git") : join(root, "git-data");
  mkdirSync(join(repo, "sub", ".agent-bridge"), { recursive: true });
  mkdirSync(join(git, "objects"), { recursive: true }); mkdirSync(join(git, "refs"));
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(git, "config"), "[core]\n bare = false\n" + (layout === "included config" ? "[include]\n path = extra-config\n" : ""));
  if (layout === "included config") writeFileSync(join(git, "extra-config"), "[core]\n logAllRefUpdates = true\n");
  else writeFileSync(join(repo, ".git"), `gitdir: ${git.replace(/\\/g, "/")}\n`);
  const env = { ...process.env, AGENT_BRIDGE_HOME: join(root, "missing-home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-global-config") };
  const probe = spawnSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8", env, timeout: 10_000, windowsHide: true });
  console.log(`Owned Git fixture PID ${probe.pid}, exited ${probe.status}`);
  expect(probe.status, probe.stderr).toBe(0); // Both are valid layouts that previously triggered the writable fallback.
  const bundle = join(root, "cli.mjs");
  buildSync({ entryPoints: ["src/cli/main.ts"], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const before = snapshot(repo);
  expect(existsSync(env.AGENT_BRIDGE_HOME)).toBe(false);
  const child = spawnSync(process.execPath, [bundle, "storage", "audit", "--root", repo, "--json"], { encoding: "utf8", env, timeout: 10_000, windowsHide: true });
  console.log(`Owned fallback CLI PID ${child.pid}, exited ${child.status}`);
  expect(child.status, child.stderr).toBe(0);
  expect(existsSync(env.AGENT_BRIDGE_HOME)).toBe(false);
  const result = JSON.parse(child.stdout);
  expect(result.directories[0].project).toMatchObject({ canonicalRoot: null, nestedUnderSameGitRoot: null });
  expect(result.directories[0].project.reason).toMatch(/unavailable|unknown/i);
  expect(snapshot(repo)).toEqual(before);
});

it.each(["missing", "file"])("validates an explicit %s root even after its parent was scanned", kind => {
  const root = fixture(), explicit = join(root, kind);
  if (kind === "file") writeFileSync(explicit, "payload");
  const result = audit(root, ["--root", explicit]);
  const code = kind === "missing" ? "ENOENT" : "ROOT_NOT_DIRECTORY";
  expect(result.code).toBe(1);
  expect(result.value.roots.find((r: any) => r.path === explicit)).toMatchObject({ complete: false, problems: [{ path: explicit, code }] });
  expect(result.value.problems).toContainEqual({ path: explicit, code });
});

it("gives a deep explicit root its own depth budget after a shallow ancestor scan", () => {
  const root = fixture(), folder = join(root, "a", "b", ".agent-bridge"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "payload"), "1234567");
  const result = audit(root, ["--root", folder, "--max-depth", "1"]);
  expect(result.code).toBe(1); // Ancestor discovery is still partial.
  expect(result.value.roots.find((r: any) => r.path === folder)).toMatchObject({ complete: true, problems: [] });
  expect(result.value.directories).toEqual([expect.objectContaining({ path: folder, bytes: 7, directBytes: 7, files: 1, complete: true })]);
});

it("extends partial storage coverage without double-counting recursive totals or attribution", () => {
  const root = fixture(), folder = join(root, ".agent-bridge"), child = join(folder, "child"), nested = join(child, ".agent-bridge");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(folder, "direct"), "123");
  writeFileSync(join(child, "payload"), "1234567");
  const metadata = JSON.stringify([{ name: "job-1" }]); writeFileSync(join(nested, "jobs.json"), metadata);
  const result = audit(folder, ["--root", child, "--root", nested, "--root", folder, "--max-depth", "1"]);
  expect(result.code).toBe(1);
  expect(result.value.directories).toHaveLength(2);
  expect(result.value.directories.find((d: any) => d.path === folder)).toMatchObject({ bytes: 10 + metadata.length, directBytes: 3, files: 3, complete: false });
  expect(result.value.directories.find((d: any) => d.path === nested)).toMatchObject({ bytes: metadata.length, directBytes: metadata.length, files: 1, attribution: { records: [{ source: join(nested, "jobs.json"), job: "job-1" }] } });
  expect(result.value.roots.find((r: any) => r.path === nested)).toMatchObject({ complete: true, problems: [] });
});

it("marks unreadable storage partial without leaking raw exception messages", () => {
  const root = fixture(), folder = join(root, ".agent-bridge"); mkdirSync(folder); io.denied = folder;
  const result = audit(root);
  expect(result.code).toBe(1); expect(result.value.directories[0].complete).toBe(false);
  expect(result.value.problems).toContainEqual({ path: folder, code: "EACCES" });
  expect(JSON.stringify(result)).not.toContain("private diagnostic");
});

it("requires explicit roots and rejects malformed or excessive limits", () => {
  for (const args of [["audit"], ["audit", "--root", ".", "--max-entries", "0"], ["audit", "--root", ".", "--max-depth", "999"]]) {
    expect(runStorage(args, fixture(), () => {})).toBe(2);
  }
});

it("reports bounded partial discovery and missing roots honestly", () => {
  const root = fixture(); mkdirSync(join(root, "child", ".agent-bridge"), { recursive: true });
  expect(audit(root, ["--max-depth", "0"]).value.complete).toBe(false);
  expect(audit(root, ["--max-entries", "1"]).code).toBe(1);
  const missing = audit(join(root, "missing"));
  expect(missing.code).toBe(1); expect(missing.value.problems.some((p: any) => p.code === "ENOENT")).toBe(true);
});

it("refuses root and child links including junctions and does not count their targets", () => {
  const root = fixture(), outside = fixture(), target = join(outside, ".agent-bridge"); mkdirSync(target);
  writeFileSync(join(target, "hidden"), "outside");
  const link = join(root, ".agent-bridge"); symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  const result = audit(root);
  expect(result.code).toBe(1); expect(result.value.directories).toEqual([]);
  expect(audit(link).code).toBe(1);
  expect(audit(join(link, "child")).code).toBe(1);
  expect(readFileSync(join(target, "hidden"), "utf8")).toBe("outside");
});

it("projects only job/session metadata from preserved databases and marks WAL unknown", () => {
  const root = fixture(), folder = join(root, ".agent-bridge"); mkdirSync(folder);
  const file = join(folder, "conversations-abc.db"), db = new DatabaseSync(file);
  db.exec("CREATE TABLE conversations(job TEXT, session TEXT, agent TEXT, project TEXT); CREATE TABLE conversation_records(body TEXT); INSERT INTO conversations VALUES('job-1','session-1','codex','project-1'); INSERT INTO conversation_records VALUES('PROMPT-CANARY')"); db.close();
  const before = snapshot(root), result = audit(root);
  expect(result.value.directories[0].attribution.records).toContainEqual(expect.objectContaining({ job: "job-1", session: "session-1" }));
  expect(JSON.stringify(result)).not.toContain("PROMPT-CANARY"); expect(snapshot(root)).toEqual(before);
  writeFileSync(file + "-wal", "held");
  const walBefore = snapshot(root), wal = audit(root);
  expect(wal.value.directories[0].attribution.problems.length).toBeGreaterThan(0);
  expect(snapshot(root)).toEqual(walBefore);
});
