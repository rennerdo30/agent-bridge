import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkSkips, SKIPS_DIR, type KnownFlakyEntry } from "../scripts/known-flaky.mjs";

// Runs the real runner (scripts/known-flaky-runner.mjs) in a child Vitest over a tiny fixture
// project: two files with a same-named test, one worker and no isolation, so a filter that
// leaked from one file to the next would show.
const repo = fileURLToPath(new URL("..", import.meta.url));
const vitestBin = join(repo, "node_modules", "vitest", "vitest.mjs");
const runnerPath = join(repo, "scripts", "known-flaky-runner.mjs").replaceAll("\\", "/");
const roots: string[] = [];

const entry = (file: string, test: string): KnownFlakyEntry =>
  ({ file, test, issue: "AB-410", owner: "fixture", added: "2026-10-16", recheckBy: "2026-10-23" });

const marker = (name: string) => `writeFileSync(join(process.env.KNOWN_FLAKY_FIXTURE_OUT, ${JSON.stringify(name)}), "");`;

function fixture(files: Record<string, string>, entries: KnownFlakyEntry[]) {
  const root = mkdtempSync(join(tmpdir(), "known-flaky-runner-"));
  roots.push(root);
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "test", "known-flaky.json"), JSON.stringify({ entries }, null, 2));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, "test", name), `import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\n${body}\n`);
  }
  writeFileSync(join(root, "vitest.config.mjs"), `export default ${JSON.stringify({
    cacheDir: ".vite-cache",
    test: { globals: true, include: ["test/*.test.ts"], isolate: false, maxWorkers: 1, fileParallelism: false, runner: runnerPath },
  })};\n`);
  return root;
}

function run(root: string, mode: string, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_BRIDGE_KNOWN_FLAKY: mode, KNOWN_FLAKY_FIXTURE_OUT: join(root, "out"), ...extraEnv };
  if (!extraEnv.AGENT_BRIDGE_CI_RESULTS_DIR) delete env.AGENT_BRIDGE_CI_RESULTS_DIR;
  return new Promise<{ code: number | null; output: string; ran: string[] }>(resolveRun => {
    execFile(process.execPath, [vitestBin, "run", "--root", root, "--config", join(root, "vitest.config.mjs")],
      { cwd: root, env, timeout: 90_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
        resolveRun({ code, output: `${stdout}\n${stderr}`, ran: readdirSync(join(root, "out")).sort() });
      });
  });
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("known-flaky runner", () => {
  const files = {
    "a.test.ts": `describe("shared", () => {\n  test("flaky", () => { ${marker("a-flaky")} });\n  test("stable", () => { ${marker("a-stable")} });\n});`,
    "b.test.ts": `describe("shared", () => {\n  test("flaky", () => { ${marker("b-flaky")} });\n});`,
  };
  const listed = [entry("test/a.test.ts", "shared > flaky")];

  it("exclude mode skips exactly the listed test, not a same-named test in another file, and records the skip", async () => {
    const root = fixture(files, listed);
    const result = await run(root, "exclude", { AGENT_BRIDGE_CI_RESULTS_DIR: "results", AGENT_BRIDGE_TEST_LANE: "fast" });
    expect(result.code, result.output).toBe(0);
    expect(result.ran).toEqual(["a-stable", "b-flaky"]);
    const record = JSON.parse(readFileSync(join(root, "results", SKIPS_DIR, "fast", "test_a.test.ts.json"), "utf8"));
    expect(record).toEqual({ lane: "fast", file: "test/a.test.ts", skipped: ["shared > flaky"] });
    expect(existsSync(join(root, "results", SKIPS_DIR, "fast", "test_b.test.ts.json"))).toBe(false);
  });

  it("only mode runs only the listed test", async () => {
    const root = fixture(files, listed);
    const result = await run(root, "only");
    expect(result.code, result.output).toBe(0);
    expect(result.ran).toEqual(["a-flaky"]);
  });

  it("off mode runs everything", async () => {
    const root = fixture(files, listed);
    const result = await run(root, "off");
    expect(result.code, result.output).toBe(0);
    expect(result.ran).toEqual(["a-flaky", "a-stable", "b-flaky"]);
  });

  it("fails the run loudly, naming the file, when an entry would cover more than the one test it names", async () => {
    const root = fixture({
      "c.test.ts": `test("dup", () => { ${marker("c-dup-1")} });\ntest("dup", () => { ${marker("c-dup-2")} });\ntest("other", () => { ${marker("c-other")} });`,
    }, [entry("test/c.test.ts", "dup")]);
    const result = await run(root, "exclude");
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Known-flaky filter check failed");
    expect(result.output).toContain("test/c.test.ts");
    expect(result.output).toContain("names 2 tests in this file");
  });
});

describe("known-flaky skip count check", () => {
  const listed = [entry("test/a.test.ts", "shared > flaky")];
  const lane = (root: string, tests: { name: string; state: string }[], skipped: string[] | undefined) => {
    writeFileSync(join(root, "fast-diagnostics.json"), JSON.stringify({ lane: "fast", files: [{ file: "test/a.test.ts", tests }] }));
    if (skipped) {
      mkdirSync(join(root, SKIPS_DIR, "fast"), { recursive: true });
      writeFileSync(join(root, SKIPS_DIR, "fast", "test_a.test.ts.json"), JSON.stringify({ lane: "fast", file: "test/a.test.ts", skipped }));
    }
  };
  const dir = () => {
    const root = mkdtempSync(join(tmpdir(), "known-flaky-skips-"));
    roots.push(root);
    return root;
  };

  it("passes when the runner skipped exactly the listed tests that were collected", () => {
    const root = dir();
    lane(root, [{ name: "shared > flaky", state: "skipped" }, { name: "shared > stable", state: "passed" }], ["shared > flaky"]);
    expect(checkSkips(listed, root)).toEqual({ lanes: [{ lane: "fast", skipped: 1, expected: 1 }], problems: [] });
  });

  it("fails when a listed test ran or the skip count differs", () => {
    const root = dir();
    lane(root, [{ name: "shared > flaky", state: "passed" }], undefined);
    const { lanes, problems } = checkSkips(listed, root);
    expect(lanes).toEqual([{ lane: "fast", skipped: 0, expected: 1 }]);
    expect(problems.join("\n")).toContain("was passed, not skipped");
    expect(problems.join("\n")).toContain("skipped by known-flaky: 0, but 1 listed test(s) were collected");
  });

  it("fails when the runner skipped a test that is not listed", () => {
    const root = dir();
    lane(root, [{ name: "shared > flaky", state: "skipped" }, { name: "shared > stable", state: "skipped" }], ["shared > flaky", "shared > stable"]);
    expect(checkSkips(listed, root).problems.join("\n")).toContain("shared > stable, which is not listed");
  });
});
