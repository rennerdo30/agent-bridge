import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadMobileIdentity } from "../src/mobile/identity.js";

function descriptor(path: string) {
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $a=Get-Acl -LiteralPath ([Console]::In.ReadLine()); [pscustomobject]@{protected=$a.AreAccessRulesProtected; owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; caller=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {[pscustomobject]@{sid=$_.IdentityReference.Value; inherited=$_.IsInherited; allow=$_.AccessControlType -eq 'Allow'; rights=[int]$_.FileSystemRights}})} | ConvertTo-Json -Depth 4 -Compress";
  return JSON.parse(execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", input: path + "\n", windowsHide: true }));
}

it.runIf(process.platform === "win32")("removes inherited ACLs from newly created identity key and state files", async () => {
  const home = mkdtempSync(join(tmpdir(), "ci-identity-"));
  const identity = await loadMobileIdentity(home, ["https://fixture.private.test:8443"]);
  for (const child of ["keys", "states"]) {
    const directory = join(home, "mobile-identity", child);
    for (const name of readdirSync(directory)) {
      const file = join(directory, name), acl = descriptor(file);
      expect(acl.protected).toBe(true);
      expect(acl.owner).toBe(acl.caller);
      expect(acl.rules).toHaveLength(1);
      expect(acl.rules[0]).toMatchObject({ sid: acl.caller, inherited: false, allow: true });
      if (child === "keys") expect(readFileSync(file)).toEqual(identity.key);
    }
  }
}, 30_000);

it.runIf(process.platform === "win32" && process.env.AGENT_BRIDGE_CI_WINDOWS === "1")("uses a protected runner-like fixture root and a fresh test home", () => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!, acl = descriptor(root);
  expect(acl.protected).toBe(true);
  expect(acl.rules.every((rule: { inherited: boolean; allow: boolean }) => !rule.inherited && rule.allow)).toBe(true);
  expect(acl.rules.map((rule: { sid: string }) => rule.sid).sort()).toEqual([...new Set([acl.caller, "S-1-5-18", "S-1-5-32-544"])].sort());
  expect(process.env.AGENT_BRIDGE_HOME).toBe(join(root, "default-home"));
  expect(tmpdir()).toBe(join(root, "temp"));
  expect(process.env.CI).toBe("true");
});

it.runIf(process.platform === "win32").each(["wrapper", "powershell", "powershell-abbreviation"])("refuses FreshVolume before any fixture or volume mutation (%s entry)", entry => {
  const parent = mkdtempSync(join(tmpdir(), "ci-vhd-refusal-"));
  const evidence = join(parent, "retained-evidence.json");
  writeFileSync(evidence, '{"retained":true}\n');
  const before = readdirSync(parent).sort();
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const env: NodeJS.ProcessEnv = { ...process.env, TEMP: parent, TMP: parent, TMPDIR: parent,
    // If the refusal regresses, no real diskpart executable can be launched.
    // The wrapper also cannot launch a real child through this test-only root.
    SystemRoot: join(parent, "unavailable-windows"), AGENT_BRIDGE_CI_RESULTS_DIR: parent };
  delete env.PSModulePath;
  const script = fileURLToPath(new URL(`../scripts/test-ci-windows.${entry === "wrapper" ? "mjs" : "ps1"}`, import.meta.url));
  const result = entry === "wrapper"
    ? spawnSync(process.execPath, [script, "-FreshVolume"], { env, encoding: "utf8", windowsHide: true })
    : spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      entry === "powershell-abbreviation" ? "-Fresh" : "-FreshVolume"],
      { env, encoding: "utf8", windowsHide: true });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  const stderr = (result.stderr ?? "").replace(/\s+/g, " ");
  expect(stderr).toContain("FreshVolume unavailable");
  expect(stderr).toContain("owned-handle mechanism");
  expect(readdirSync(parent).sort()).toEqual(before);
  expect(readFileSync(evidence, "utf8")).toBe('{"retained":true}\n');
});

it("discriminates actual Vitest project caches from wrong lane and outside derived caches", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-cache-contract-"));
  const api = new URL("../node_modules/vitest/dist/node.js", import.meta.url).href;
  const reporter = new URL("../scripts/ci-reporter.mjs", import.meta.url).href;
  const input = `
import { createVitest } from ${JSON.stringify(api)};
import { collectionCacheProof } from ${JSON.stringify(reporter)};
import { resolve } from 'node:path';
const root = ${JSON.stringify(root)};
const rows = [];
for (const [name, lane, override, admitted] of [
  ['', 'all', resolve(root, 'collection-cache', 'all'), true],
  ['ci-cache-named', 'fast', resolve(root, 'collection-cache', 'fast'), true],
  ['ci-cache-named', 'fast', resolve(root, 'collection-cache', 'integration'), false],
  ['ci-cache-named', 'fast', resolve(root, 'outside-cache'), false],
]) {
  const ctx = await createVitest({ watch: false, reporters: [] }, { root, configFile: false, cacheDir: override, test: { name, include: [] } });
  try {
    let proof, refused = false;
    try { proof = collectionCacheProof(ctx, root, lane); } catch { refused = true; }
    rows.push({ name, lane, admitted, refused, resolved: ctx.viteConfig.cacheDir, proof });
  } finally { await ctx.close(); }
}
console.log(JSON.stringify(rows));
`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-"], { input, encoding: "utf8", windowsHide: true });
  const rows = JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
  expect(rows.map((row: { refused: boolean }) => row.refused)).toEqual([false, false, true, true]);
  expect(rows[0].proof.projects[0].hash).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  for (const row of rows.slice(0, 2)) {
    expect(row.proof.projects[0].resolved).toBe(row.proof.projects[0].expected);
    expect(row.proof.projects[0].physical).toBe(row.proof.projects[0].expectedPhysical);
    expect(row.proof.projects[0].resolved).not.toBe(row.proof.projects[0].executionCache);
  }
});

function coverageFixture(fastFile = "test/fast.test.ts") {
  const root = mkdtempSync(join(tmpdir(), "ci-census-"));
  const metadata = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(),
    node: process.version, platform: process.platform,
    vitest: JSON.parse(readFileSync(new URL("../node_modules/vitest/package.json", import.meta.url), "utf8")).version,
    runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
  };
  const unsharded = {
    fast: [{ file: fastFile, project: "", id: "fast", errors: [], suiteErrors: [], tests: [
      { id: "fast_0", name: "same name", state: "pending" },
      { id: "fast_1", name: "same name", state: "skipped" },
    ] }],
    integration: [{ file: "test/integration.test.ts", project: "", id: "integration", errors: [], suiteErrors: [], tests: [
      { id: "integration_0", name: "runs", state: "pending" },
    ] }],
  };
  const censusSha256 = createHash("sha256").update(JSON.stringify(Object.entries(unsharded).map(([lane, files]) =>
    [lane, files.map(file => {
      const identity = JSON.stringify([file.file, file.project, file.id]);
      return [identity, file.tests.map(test => [JSON.stringify([identity, test.id]), test.state])];
    })]))).digest("hex");
  const inventory = { count: 4, metadata, complete: true, unsharded, censusSha256, totalFiles: 2,
    lanes: { fast: [[fastFile], [], [], []], integration: [["test/integration.test.ts"], [], [], []] } };
  const reports = {
    fast: { metadata, complete: true, unhandledErrors: [], files: structuredClone(unsharded.fast) },
    integration: { metadata, complete: true, unhandledErrors: [], files: structuredClone(unsharded.integration) },
  };
  reports.fast.files[0]!.tests[0]!.state = "failed";
  reports.integration.files[0]!.tests[0]!.state = "passed";
  for (const report of Object.values(reports)) {
    for (const file of report.files) {
      for (const test of file.tests) {
        Object.assign(test, { hooks: { id: JSON.stringify([JSON.stringify([file.file, file.project, file.id]), test.id]),
          status: test.state === "skipped" ? "not-executed" : "complete", entries: [] } });
      }
    }
  }
  function save() {
    writeFileSync(join(root, "shards.json"), JSON.stringify(inventory));
    for (const lane of ["fast", "integration"] as const) {
      writeFileSync(join(root, `${lane}-diagnostics.json`), JSON.stringify(reports[lane]));
      writeFileSync(join(root, `${lane}-census.json`), JSON.stringify({ metadata: reports[lane].metadata,
        complete: reports[lane].complete, files: reports[lane].files }));
    }
  }
  function check() {
    return execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/check-shard-results.mjs", import.meta.url)), root, "1"],
      { encoding: "utf8", windowsHide: true });
  }
  return { root, inventory, reports, save, check };
}

it("keeps failed and skipped cases in a known exact shard census", () => {
  const fixture = coverageFixture();
  fixture.save();
  fixture.check();
  const proof = JSON.parse(readFileSync(join(fixture.root, "shard-coverage.json"), "utf8"));
  expect(proof.coverage).toBe("known");
  expect(proof.lanes.fast).toMatchObject({ totalFiles: 1, totalCases: 2, passed: 0, failed: 1, skipped: 1 });
});

it("matches a source-bound case ID while retaining PID-varying display names", () => {
  const fixture = coverageFixture();
  fixture.inventory.unsharded.fast[0]!.tests[0]!.name = "recovers identity for PID 9852";
  fixture.reports.fast.files[0]!.tests[0]!.name = "recovers identity for PID 2768";
  // Names are informational: neither identity nor the inventory digest changes.
  fixture.save();
  fixture.check();
  const proof = JSON.parse(readFileSync(join(fixture.root, "shard-coverage.json"), "utf8"));
  expect(proof.coverage).toBe("known");
  expect(proof.lanes.fast.collectionNames[0].tests[0].name).toBe("recovers identity for PID 9852");
  expect(proof.lanes.fast.files[0].tests[0].name).toBe("recovers identity for PID 2768");
});

it.each(["beforeAll", "afterAll", "aroundAll"])("retains nested %s hook failure as unknown coverage without exporting error text", hook => {
  const fixture = coverageFixture("test/ci-windows.test.ts");
  const reporter = new URL("../scripts/ci-reporter.mjs", import.meta.url).href;
  const moduleId = fileURLToPath(import.meta.url);
  const input = `
import { moduleCensus } from ${JSON.stringify(reporter)};
const hookError = { hook: ${JSON.stringify(hook)}, message: 'do-not-export-hook-secret', stack: 'do-not-export-hook-stack' };
const leaf = { id: 'fast_suite_inner', errors: () => [hookError], children: { suites: () => [] } };
const parent = { id: 'fast_suite_outer', errors: () => [], children: { suites: () => [leaf] } };
const grandparent = { id: 'fast_suite_root', errors: () => [], children: { suites: () => [parent] } };
const subtree = ${JSON.stringify(hook)} === 'beforeAll' ? leaf : ${JSON.stringify(hook)} === 'afterAll' ? parent : grandparent;
const tests = [
  { id: 'fast_0', fullName: 'same name', result: () => ({ state: 'failed', errors: [{ message: 'original test failure' }] }), diagnostic: () => undefined },
  { id: 'fast_1', fullName: 'same name', result: () => ({ state: 'skipped' }), diagnostic: () => undefined },
];
console.log(JSON.stringify(moduleCensus({ moduleId: ${JSON.stringify(moduleId)}, project: { name: '' }, id: 'fast',
  state: () => 'failed', diagnostic: () => undefined, errors: () => [],
  children: { suites: () => [subtree], allTests: () => tests } })));
`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-"], { input, encoding: "utf8", windowsHide: true });
  const captured = JSON.parse(output);
  expect(captured.errors).toEqual([]);
  expect(captured.suiteErrors).toEqual([{ id: "fast_suite_inner", count: 1 }]);
  expect(output).not.toContain("do-not-export-hook-secret");
  expect(output).not.toContain("do-not-export-hook-stack");
  expect(captured.tests[0].errors[0].message).toBe("original test failure");
  // The case membership is exact even though a nested suite hook failed.
  fixture.reports.fast.files[0] = captured;
  fixture.save();
  expect(() => fixture.check()).toThrow();
  const proof = JSON.parse(readFileSync(join(fixture.root, "shard-coverage.json"), "utf8"));
  expect(proof.coverage).toBe("unknown");
  expect(proof.problems.join("\n")).toContain("nested suite/hook error");
  expect(proof.lanes.fast.files[0].tests[0].errors[0].message).toBe("original test failure");
});

it("distinguishes real beforeEach/afterEach failures from a failed assertion with passed hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-case-hooks-"));
  const api = new URL("../node_modules/vitest/dist/node.js", import.meta.url).href;
  const entry = fileURLToPath(new URL("../node_modules/vitest/dist/index.js", import.meta.url));
  const reporter = new URL("../scripts/ci-reporter.mjs", import.meta.url).href;
  const checker = new URL("../scripts/check-shard-results.mjs", import.meta.url).href;
  const input = `
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createVitest } from ${JSON.stringify(api)};
import CiReporter, { moduleCensus, censusDigest } from ${JSON.stringify(reporter)};
import { checkShardResults } from ${JSON.stringify(checker)};
const root = ${JSON.stringify(root)};
const rows = [];
for (const mode of ['beforeEach', 'afterEach', 'assertion']) {
  const directory = join(root, mode), results = join(directory, 'results'), marker = join(directory, 'callback-ran');
  mkdirSync(results, { recursive: true });
  const source = 'import { it, expect, beforeEach, afterEach } from "vitest";\\n'
    + 'import { writeFileSync } from "node:fs";\\n'
    + 'beforeEach(() => { if (' + JSON.stringify(mode) + ' === "beforeEach") throw new Error("private fixture hook failure"); });\\n'
    + 'afterEach(() => { if (' + JSON.stringify(mode) + ' === "afterEach") throw new Error("private fixture hook failure"); });\\n'
    + 'it("actual hook probe", () => { writeFileSync(' + JSON.stringify(marker) + ', "callback ran"); expect(' + JSON.stringify(mode) + ' !== "assertion").toBe(true); });\\n';
  writeFileSync(join(directory, 'probe.test.ts'), source);
  process.env.AGENT_BRIDGE_CI_RESULTS_DIR = results;
  process.env.AGENT_BRIDGE_TEST_LANE = 'fast';
  const report = new CiReporter();
  const ctx = await createVitest({ watch: false, reporters: [report] }, { root: directory, configFile: false,
    cacheDir: join(directory, 'cache'), resolve: { alias: { vitest: ${JSON.stringify(entry)} } },
    test: { name: 'ci-case-hook-discriminator', include: ['probe.test.ts'], setupFiles: [], maxWorkers: 1 } });
  try {
    await ctx.standalone();
    const specs = await ctx.globTestSpecifications();
    assert.equal(specs.length, 1);
    const collected = await ctx.collectTests(specs);
    assert.equal(collected.unhandledErrors.length, 0);
    const files = collected.testModules.map(module => moduleCensus(module));
    assert.equal(files.length, 1);
    assert.equal(files[0].tests.length, 1);
    const inventory = { count: 1, complete: true, metadata: report.metadata, totalFiles: 1,
      lanes: { fast: [[files[0].file]], integration: [[]] }, unsharded: { fast: files, integration: [] } };
    inventory.censusSha256 = censusDigest(inventory.unsharded);
    writeFileSync(join(results, 'shards.json'), JSON.stringify(inventory));
    await ctx.runTestSpecifications(specs);
    const diagnostics = JSON.parse(readFileSync(join(results, 'fast-diagnostics.json'), 'utf8'));
    const empty = { metadata: report.metadata, complete: true, files: [], unhandledErrors: [] };
    writeFileSync(join(results, 'integration-diagnostics.json'), JSON.stringify(empty));
    writeFileSync(join(results, 'integration-census.json'), JSON.stringify(empty));
    let refused = false;
    try { checkShardResults(results, 1, report.metadata); } catch { refused = true; }
    const proof = JSON.parse(readFileSync(join(results, 'shard-coverage.json'), 'utf8'));
    rows.push({ mode, callbackRan: existsSync(marker), reason: diagnostics.reason,
      state: diagnostics.files[0].tests[0].state, hooks: diagnostics.files[0].tests[0].hooks,
      errorCount: diagnostics.files[0].tests[0].errorCount, coverage: proof.coverage, refused });
  } finally { await ctx.close(); }
}
console.log('R2_PROBE=' + JSON.stringify(rows));
// Vitest's genuine failed-run exit code remains 1; never turn it into a pass.
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-"], { input, encoding: "utf8", windowsHide: true });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  const line = result.stdout.split(/\r?\n/).find(value => value.startsWith("R2_PROBE="));
  expect(line).toBeDefined();
  const rows = JSON.parse(line!.slice("R2_PROBE=".length));
  expect(rows.map((row: { mode: string }) => row.mode)).toEqual(["beforeEach", "afterEach", "assertion"]);
  expect(rows.map((row: { callbackRan: boolean }) => row.callbackRan)).toEqual([false, true, true]);
  expect(rows.map((row: { coverage: string }) => row.coverage)).toEqual(["unknown", "unknown", "known"]);
  expect(rows.map((row: { refused: boolean }) => row.refused)).toEqual([true, true, false]);
  for (const row of rows) {
    expect(row.reason).toBe("failed");
    expect(row.state).toBe("failed");
    expect(row.errorCount).toBeGreaterThan(0);
  }
  expect(rows[0].hooks.entries).toContainEqual({ name: "beforeEach", reportedState: "run", status: "incomplete", starts: 1, ends: 0 });
  expect(rows[1].hooks.entries).toContainEqual({ name: "afterEach", reportedState: "run", status: "incomplete", starts: 1, ends: 0 });
  expect(rows[2].hooks.status).toBe("complete");
  expect(rows[2].hooks.entries).toEqual([
    { name: "beforeEach", reportedState: "pass", status: "passed", starts: 1, ends: 1 },
    { name: "afterEach", reportedState: "pass", status: "passed", starts: 1, ends: 1 },
  ]);
});

it.each(["duplicate", "duplicate-id-different-name", "changed-id", "omitted", "pending", "skip-changed", "invalid-disposition",
  "partial", "source-drift", "runtime-drift", "project-drift", "module-id-drift", "duplicate-file"])(
  "refuses %s census evidence and publishes the coverage gap", scenario => {
    const fixture = coverageFixture();
    const tests = fixture.reports.fast.files[0]!.tests;
    if (scenario === "duplicate") tests[1] = { ...tests[0]! }; // Equal totals hide an omitted skipped case.
    if (scenario === "duplicate-id-different-name") tests[1]!.id = tests[0]!.id;
    if (scenario === "changed-id") tests[0]!.id = "fast_999";
    if (scenario === "omitted") tests.pop();
    if (scenario === "pending") tests[0]!.state = "pending";
    if (scenario === "skip-changed") tests[1]!.state = "passed";
    if (scenario === "invalid-disposition") tests[0]!.state = "unknown";
    if (scenario === "partial") fixture.reports.fast.complete = false;
    if (scenario === "source-drift") fixture.reports.fast.metadata = { ...fixture.reports.fast.metadata, revision: "other-head" };
    if (scenario === "runtime-drift") fixture.reports.fast.metadata = { ...fixture.reports.fast.metadata, node: "other-node" };
    if (scenario === "project-drift") fixture.reports.fast.files[0]!.project = "other-project";
    if (scenario === "module-id-drift") fixture.reports.fast.files[0]!.id = "other-module";
    if (scenario === "duplicate-file") fixture.inventory.lanes.integration[0] = ["test/fast.test.ts"];
    fixture.save();
    expect(() => fixture.check()).toThrow();
    const proof = JSON.parse(readFileSync(join(fixture.root, "shard-coverage.json"), "utf8"));
    expect(proof.coverage).toBe("unknown");
    expect(proof.problems.length).toBeGreaterThan(0);
  },
);
