import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// Keep failures visible; report configured retries without introducing retries.
export default class CiReporter {
  onTestRunEnd(modules, errors, reason) {
    const root = process.env.AGENT_BRIDGE_CI_RESULTS_DIR;
    if (!root) return;
    const lane = process.env.AGENT_BRIDGE_TEST_LANE ?? "all";
    const files = modules.map(module => ({
      file: relative(realpathSync.native(process.cwd()), realpathSync.native(module.moduleId)).replaceAll("\\", "/"),
      state: module.state(), diagnostic: module.diagnostic(),
      tests: [...module.children.allTests()].map(test => ({
        name: test.fullName, state: test.result().state, ...test.diagnostic(),
      })),
    }));
    const flaky = files.flatMap(file => file.tests.filter(test => test.flaky || test.retryCount > 0).map(test => ({ file: file.file, ...test })));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${lane}-diagnostics.json`), JSON.stringify({ lane, reason, files, flaky, unhandledErrors: errors }, null, 2) + "\n");
    const summary = `### ${lane} test diagnostics\n\n${files.length} files; ${flaky.length} retried/flaky tests; ${errors.length} unhandled errors.\n\n`;
    console.log(summary.trim());
    for (const test of flaky) console.log(`FLAKY/RETRIED: ${test.file}: ${test.name} (${test.retryCount} retries, ${test.state})`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}
