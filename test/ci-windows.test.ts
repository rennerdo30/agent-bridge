import { execFileSync } from "node:child_process";
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

function coverageFixture() {
  const root = mkdtempSync(join(tmpdir(), "ci-census-"));
  const metadata = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(),
    node: process.version, platform: process.platform,
    vitest: JSON.parse(readFileSync(new URL("../node_modules/vitest/package.json", import.meta.url), "utf8")).version,
    runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
  };
  const unsharded = {
    fast: [{ file: "test/fast.test.ts", project: "", id: "fast", errors: [], tests: [
      { id: "fast_0", name: "same name", state: "pending" },
      { id: "fast_1", name: "same name", state: "skipped" },
    ] }],
    integration: [{ file: "test/integration.test.ts", project: "", id: "integration", errors: [], tests: [
      { id: "integration_0", name: "runs", state: "pending" },
    ] }],
  };
  const censusSha256 = createHash("sha256").update(JSON.stringify(Object.entries(unsharded).map(([lane, files]) =>
    [lane, files.map(file => {
      const identity = JSON.stringify([file.file, file.project, file.id]);
      return [identity, file.tests.map(test => [JSON.stringify([identity, test.id]), test.state])];
    })]))).digest("hex");
  const inventory = { count: 4, metadata, complete: true, unsharded, censusSha256, totalFiles: 2,
    lanes: { fast: [["test/fast.test.ts"], [], [], []], integration: [["test/integration.test.ts"], [], [], []] } };
  const reports = {
    fast: { metadata, complete: true, unhandledErrors: [], files: structuredClone(unsharded.fast) },
    integration: { metadata, complete: true, unhandledErrors: [], files: structuredClone(unsharded.integration) },
  };
  reports.fast.files[0]!.tests[0]!.state = "failed";
  reports.integration.files[0]!.tests[0]!.state = "passed";
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
