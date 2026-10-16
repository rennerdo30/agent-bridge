import { relative } from "node:path";
import { TestRunner } from "vitest";
import { entryMatches, knownFlakyEntries, knownFlakyMode } from "./known-flaky.mjs";

// Applies test/known-flaky.json inside every Vitest worker (vitest.config.ts `runner`).
// AGENT_BRIDGE_KNOWN_FLAKY selects the mode:
//   exclude (default): listed tests are skipped; every other test runs and blocks as before;
//   only:              only listed tests run (the non-blocking known-flaky CI lane);
//   off:               the list is ignored (local reproduction).
// It uses Vitest's own name filter (the same path as --testNamePattern), set per file just
// before Vitest decides each case's mode. So the decision is made at collection: a skipped
// case is reported as skipped by collect-only and by execution alike, a describe block or
// file whose cases are all skipped runs no hooks, and other files are untouched.
export default class KnownFlakyRunner extends TestRunner {
  constructor(config) {
    super(config);
    this.knownFlakyMode = knownFlakyMode(process.env.AGENT_BRIDGE_KNOWN_FLAKY);
    this.knownFlaky = this.knownFlakyMode === "off" ? [] : knownFlakyEntries(config.root);
    this.userNamePattern = config.testNamePattern;
  }

  onCollectStart(file) {
    super.onCollectStart(file);
    const mode = this.knownFlakyMode;
    const user = this.userNamePattern;
    const path = relative(this.config.root, file.filepath).replaceAll("\\", "/");
    const entries = this.knownFlaky.filter(entry => entry.file === path);
    if (mode === "off" || (mode === "exclude" && entries.length === 0)) {
      this.config.testNamePattern = user;
      return;
    }
    const listed = name => entries.some(entry => entryMatches(entry, path, name));
    // Vitest calls fullTestName.match(pattern); a Symbol.match object keeps the comparison exact.
    this.config.testNamePattern = {
      [Symbol.match]: name => (!user || name.match(user)) && (mode === "only" ? listed(name) : !listed(name)) ? [name] : null,
      toString: () => `known-flaky ${mode}${user ? ` and ${user}` : ""}`,
    };
  }
}
