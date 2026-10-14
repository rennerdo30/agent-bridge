import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const caseIdentity = (file, test) => JSON.stringify([file, test.id, test.name]);
export function censusDigest(unsharded) {
  return createHash("sha256").update(JSON.stringify(Object.entries(unsharded).map(([lane, files]) => [lane,
    files.map(file => [file.file, file.tests.map(test => [test.id, test.name, test.state])]).sort((a, b) => a[0].localeCompare(b[0])),
  ]))).digest("hex");
}

export function censusMetadata() {
  return {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(),
    node: process.version, platform: process.platform,
    vitest: JSON.parse(readFileSync(new URL("../node_modules/vitest/package.json", import.meta.url), "utf8")).version,
    runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
  };
}

export function moduleCensus(module) {
  return {
    file: relative(realpathSync.native(process.cwd()), realpathSync.native(module.moduleId)).replaceAll("\\", "/"),
    state: module.state(), diagnostic: module.diagnostic(), errors: module.errors(),
    tests: [...module.children.allTests()].map(test => ({
      id: test.id, name: test.fullName, state: test.result().state,
      note: test.result().note, errors: test.result().errors, ...test.diagnostic(),
    })),
  };
}

// Keep failures visible; report configured retries without introducing retries.
export default class CiReporter {
  collected = new Map();
  metadata = censusMetadata();

  onTestModuleCollected(module) {
    const file = moduleCensus(module);
    this.collected.set(file.file, file);
    const root = process.env.AGENT_BRIDGE_CI_RESULTS_DIR;
    if (!root) return;
    mkdirSync(root, { recursive: true });
    // A crash before onTestRunEnd retains a partial census, never a coverage pass.
    writeFileSync(join(root, `${process.env.AGENT_BRIDGE_TEST_LANE ?? "all"}-census.json`),
      JSON.stringify({ metadata: this.metadata, complete: false, files: [...this.collected.values()] }, null, 2) + "\n");
  }

  onTestRunEnd(modules, errors, reason) {
    const root = process.env.AGENT_BRIDGE_CI_RESULTS_DIR;
    if (!root) return;
    const lane = process.env.AGENT_BRIDGE_TEST_LANE ?? "all";
    const files = modules.map(moduleCensus);
    const flaky = files.flatMap(file => file.tests.filter(test => test.flaky || test.retryCount > 0).map(test => ({ file: file.file, ...test })));
    mkdirSync(root, { recursive: true });
    const metadata = this.metadata;
    writeFileSync(join(root, `${lane}-diagnostics.json`), JSON.stringify({ metadata, complete: true, lane, reason, files, flaky, unhandledErrors: errors }, null, 2) + "\n");
    writeFileSync(join(root, `${lane}-census.json`), JSON.stringify({ metadata, complete: true, files }, null, 2) + "\n");
    const summary = `### ${lane} test diagnostics\n\n${files.length} files; ${flaky.length} retried/flaky tests; ${errors.length} unhandled errors.\n\n`;
    console.log(summary.trim());
    for (const test of flaky) console.log(`FLAKY/RETRIED: ${test.file}: ${test.name} (${test.retryCount} retries, ${test.state})`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}
