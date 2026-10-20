import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const selector = join(repository, "scripts/select-shard-inventory.mjs");
const pids: number[] = [];
let revision: string;
let fixtures: string;

beforeAll(() => {
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repository, encoding: "utf8", windowsHide: true, timeout: 5_000,
  });
  if (git.pid) pids.push(git.pid);
  expect(git.status).toBe(0);
  revision = git.stdout.trim();
  fixtures = join(repository, ".agent-bridge-test", "ci-node-runtime");
  mkdirSync(fixtures, { recursive: true });
});

afterAll(() => console.info(`Completed fixture child PIDs: ${pids.join(", ")}`));

function inventory(attempt: number, metadata: Record<string, unknown> = {}) {
  return {
    complete: true,
    metadata: {
      revision, sourceHead: "a".repeat(40), node: "v24.21.0", platform: "win32",
      vitest: "5.0.2", runId: "39448924404", attempt: String(attempt), event: "pull_request",
      ...metadata,
    },
  };
}

function select(entries: [number, unknown][], env: Record<string, string> = {}) {
  const root = mkdtempSync(join(fixtures, "case-"));
  const download = join(root, "download");
  for (const [attempt, contents] of entries) {
    const directory = join(download, `shard-inventory-windows-node-24-attempt-${attempt}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "shards.json"), JSON.stringify(contents));
  }
  const output = join(root, "shards.json");
  const githubOutput = join(root, "github-output");
  writeFileSync(githubOutput, "");
  const child = spawnSync(process.execPath, [selector, download, "24", output], {
    cwd: repository, encoding: "utf8", windowsHide: true, timeout: 5_000,
    env: {
      ...process.env, GITHUB_RUN_ID: "39448924404", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: revision,
      GITHUB_EVENT_NAME: "pull_request", AGENT_BRIDGE_CI_SOURCE_HEAD: "a".repeat(40),
      GITHUB_OUTPUT: githubOutput, ...env,
    },
  });
  if (child.pid) pids.push(child.pid);
  return { child, output, version: readFileSync(githubOutput, "utf8") };
}

describe("Windows shards use the collector's exact Node runtime", () => {
  test("selects before setup, dependencies and tests, and gates integration on the build", () => {
    const workflow = readFileSync(join(repository, ".github/workflows/ci.yml"), "utf8");
    const windows = workflow.split(/\r?\n  windows:\r?\n/)[1]!;
    const download = windows.indexOf("- name: Download shard inventory");
    const select = windows.indexOf("- name: Select shard inventory");
    const setup = windows.indexOf("- uses: actions/setup-node@");
    const install = windows.indexOf("- run: npm ci");
    expect(download).toBeGreaterThan(0);
    expect(select).toBeGreaterThan(download);
    expect(setup).toBeGreaterThan(select);
    expect(install).toBeGreaterThan(setup);
    expect(windows.slice(select, setup)).toContain("id: collect");
    expect(windows.slice(setup, install)).toContain("node-version: ${{ steps.collect.outputs.node-version }}");
    expect(windows.slice(install)).toMatch(/- run: npm run build\r?\n\s+id: build/);
    expect(windows.slice(windows.indexOf("- name: Integration tests")))
      .toContain("if: ${{ !cancelled() && steps.build.outcome == 'success' }}");
  });

  test("uses an earlier successful collection on rerun even if floating Node would be 24.22.0", () => {
    const collected = inventory(1);
    const result = select([[1, collected], [3, inventory(3, { node: "v24.22.0" })]]);
    expect(result.child.status, result.child.stderr).toBe(0);
    expect(result.version).toBe("node-version=24.21.0\n");
    expect(result.version).not.toContain("24.22.0");
    expect(JSON.parse(readFileSync(result.output, "utf8"))).toEqual(collected);
  });

  test("prefers the current attempt and exposes its exact patch", () => {
    const result = select([[1, inventory(1)], [2, inventory(2, { node: "v24.22.0" })]]);
    expect(result.child.status, result.child.stderr).toBe(0);
    expect(result.version).toBe("node-version=24.22.0\n");
  });

  test.each([
    ["missing Node", { node: undefined }], ["floating Node", { node: "24" }],
    ["Node range", { node: "^24.21.0" }], ["prerelease Node", { node: "v24.21.0-rc.1" }],
    ["injected output", { node: "v24.21.0\nnode-version=24.22.0" }],
    ["leading zero", { node: "v24.021.0" }], ["wrong major", { node: "v26.0.0" }],
    ["wrong revision", { revision: "b".repeat(40) }], ["missing revision", { revision: undefined }],
    ["wrong source", { sourceHead: "b".repeat(40) }], ["missing source", { sourceHead: undefined }],
    ["wrong run", { runId: "39448924405" }], ["missing run", { runId: undefined }],
    ["wrong platform", { platform: "linux" }], ["missing platform", { platform: undefined }],
    ["wrong event", { event: "push" }], ["missing event", { event: undefined }],
    ["missing Vitest", { vitest: undefined }], ["invalid Vitest", { vitest: "latest" }],
    ["wrong Vitest", { vitest: "5.0.1" }],
    ["future attempt", { attempt: "3" }], ["mismatched attempt", { attempt: "1" }],
    ["missing attempt", { attempt: undefined }], ["invalid attempt", { attempt: "0" }],
  ] as [string, Record<string, unknown>][])("refuses %s without exposing a runtime or falling back", (_name, metadata) => {
    const result = select([[1, inventory(1)], [2, inventory(2, metadata)]]);
    expect(result.child.status).not.toBe(0);
    expect(result.version).toBe("");
  });

  test("refuses missing metadata and incomplete collection without exposing a runtime", () => {
    for (const invalid of [{ complete: true }, { ...inventory(2), complete: false }]) {
      const result = select([[1, inventory(1)], [2, invalid]]);
      expect(result.child.status).not.toBe(0);
      expect(result.version).toBe("");
    }
  });

  test.each(["GITHUB_RUN_ATTEMPT", "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_EVENT_NAME", "AGENT_BRIDGE_CI_SOURCE_HEAD", "GITHUB_OUTPUT"])
    ("refuses missing current-job binding %s", key => {
      const result = select([[1, inventory(1)]], { [key]: "" });
      expect(result.child.status).not.toBe(0);
      expect(result.version).toBe("");
    });

  test("refuses missing inventories and future-only inventories", () => {
    for (const entries of [[], [[3, inventory(3)]]] as [number, unknown][][]) {
      const result = select(entries);
      expect(result.child.status).not.toBe(0);
      expect(result.version).toBe("");
    }
  });
});
