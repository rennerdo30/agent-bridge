import { relative, resolve } from "node:path";
import { TestRunner } from "vitest";
import { createFileFilter, knownFlakyEntries, knownFlakyMode, skippedByList, verifyFileDecisions, writeSkipRecord } from "./known-flaky.mjs";

// Applies test/known-flaky.json inside every Vitest worker (vitest.config.ts `runner`).
// AGENT_BRIDGE_KNOWN_FLAKY selects the mode:
//   exclude (default): listed tests are skipped; every other test runs and blocks as before;
//   only:              only listed tests run (the non-blocking known-flaky CI lane);
//   off:               the list is ignored (diagnostic workflows, local reproduction).
// It uses Vitest's own name filter (the same path as --testNamePattern), installed per file in
// importFile(filepath, "collect"). Pinned Vitest 5.0.2 collectTests awaits that call, collects the
// file's tests, and only then runs interpretTaskModes, which reads config.testNamePattern; so the
// filter in place is always the one for the file being collected (onCollectStart is not awaited
// there and could race the import). The decision is made at collection: a skipped case is
// reported as skipped by collect-only and by execution alike, and other files are untouched.
//
// Fail open, loudly: the filter's string form matches everything, and onCollected checks every
// file's recorded decisions against the collected tests (verifyFileDecisions); any mismatch
// throws an error naming the file, which fails the run.
export default class KnownFlakyRunner extends TestRunner {
  constructor(config) {
    super(config);
    this.knownFlakyMode = knownFlakyMode(process.env.AGENT_BRIDGE_KNOWN_FLAKY);
    this.knownFlaky = this.knownFlakyMode === "off" ? [] : knownFlakyEntries(config.root);
    this.userNamePattern = config.testNamePattern;
    this.knownFlakyFilters = new Map();
  }

  knownFlakyPath(filepath) {
    return relative(this.config.root, filepath).replaceAll("\\", "/");
  }

  applyKnownFlaky(filepath) {
    const filter = createFileFilter(this.knownFlaky, this.knownFlakyPath(filepath), this.knownFlakyMode, this.userNamePattern);
    if (filter) this.knownFlakyFilters.set(filepath, filter);
    else this.knownFlakyFilters.delete(filepath);
    this.config.testNamePattern = filter ? filter.matcher : this.userNamePattern;
  }

  async importFile(filepath, source) {
    if (source === "collect") this.applyKnownFlaky(filepath);
    return super.importFile(filepath, source);
  }

  async onCollected(files) {
    this.config.testNamePattern = this.userNamePattern;
    const failures = [];
    const resultsDir = process.env.AGENT_BRIDGE_CI_RESULTS_DIR;
    for (const file of files) {
      const path = this.knownFlakyPath(file.filepath);
      const filter = this.knownFlakyFilters.get(file.filepath);
      this.knownFlakyFilters.delete(file.filepath);
      if (!filter) {
        if (createFileFilter(this.knownFlaky, path, this.knownFlakyMode, this.userNamePattern)) {
          failures.push(`${path}: the known-flaky filter was never installed for this file`);
        }
        continue;
      }
      const tests = [];
      const visit = task => {
        if (task.type === "test") tests.push({ name: task.fullTestName, mode: task.mode });
        for (const child of task.tasks ?? []) visit(child);
      };
      visit(file);
      const problems = verifyFileDecisions(filter, tests);
      if (problems.length) failures.push(`${path}:\n  ${problems.join("\n  ")}`);
      if (resultsDir && this.knownFlakyMode === "exclude") {
        writeSkipRecord(resolve(this.config.root, resultsDir), process.env.AGENT_BRIDGE_TEST_LANE ?? "all", path, skippedByList(filter));
      }
    }
    if (failures.length) {
      throw new Error(`Known-flaky filter check failed (${this.knownFlakyMode} mode); the list must never hide a test it does not name:\n${failures.join("\n")}`);
    }
  }
}
