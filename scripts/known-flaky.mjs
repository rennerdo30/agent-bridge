import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Known-flaky list (owner rule 2026-10-16): listed tests are reported in a separate,
// non-blocking CI lane and skipped in the normal lanes. Everything else still blocks.
// Each entry names one test file and the exact Vitest full name of ONE test
// ("describe > nested describe > test name"). Patterns and whole files are not allowed,
// so an entry can never cover a test it does not name (owner: never hide a new failure).
// The list is applied by scripts/known-flaky-runner.mjs (vitest.config.ts `runner`).

export const KNOWN_FLAKY_PATH = "test/known-flaky.json";
export const RECHECK_MAX_DAYS = 7;
export const MODES = ["exclude", "only", "off"];
/** String form of the runner's name filter: if the filter is ever turned into a string, everything runs (fails open). */
export const MATCH_EVERYTHING_SOURCE = "(?:)";
/** Subdirectory of AGENT_BRIDGE_CI_RESULTS_DIR where the runner records what it skipped. */
export const SKIPS_DIR = "known-flaky-skips";

const ENTRY_KEYS = new Set(["file", "test", "issue", "owner", "added", "recheckBy", "seen"]);
const FORBIDDEN_SELECTORS = ["pattern", "wholeFile"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function knownFlakyMode(value) {
  const mode = value === undefined || value === "" ? "exclude" : value;
  if (!MODES.includes(mode)) throw new Error(`AGENT_BRIDGE_KNOWN_FLAKY must be one of ${MODES.join(", ")}; got "${value}"`);
  return mode;
}

export function readKnownFlaky(root = process.cwd()) {
  return JSON.parse(readFileSync(resolve(root, KNOWN_FLAKY_PATH), "utf8"));
}

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function parseDate(text) {
  if (typeof text !== "string" || !DATE.test(text)) return undefined;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text ? time : undefined;
}

export function describeEntry(entry) {
  return `${entry?.file ?? "(no file)"} > ${entry?.test ?? "(no test name)"}`;
}

/**
 * Returns a list of problems; an empty list means the document is valid.
 * Without `today` only the structure is checked (the test runner uses this, so an
 * expired date never changes which tests run; the cheap CI check fails instead).
 */
export function validateKnownFlaky(doc, { root = process.cwd(), today } = {}) {
  const problems = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.entries)) {
    return [`${KNOWN_FLAKY_PATH} must be an object with an "entries" array`];
  }
  for (const key of Object.keys(doc)) if (!["comment", "entries"].includes(key)) problems.push(`Unknown top-level field "${key}"`);
  const todayTime = today === undefined ? undefined : parseDate(today);
  if (today !== undefined && todayTime === undefined) problems.push(`Invalid check date "${today}"`);
  const seen = new Set();
  doc.entries.forEach((entry, index) => {
    const at = `Entry ${index + 1} (${describeEntry(entry)})`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { problems.push(`${at}: must be an object`); return; }
    for (const key of Object.keys(entry)) {
      if (FORBIDDEN_SELECTORS.includes(key)) problems.push(`${at}: "${key}" is not allowed; only exact test names are allowed (use "test")`);
      else if (!ENTRY_KEYS.has(key)) problems.push(`${at}: unknown field "${key}"`);
    }
    if (typeof entry.file !== "string" || !/^test\/[^\\]+\.test\.ts$/.test(entry.file)) {
      problems.push(`${at}: "file" must be a repository-relative test path such as test/example.test.ts`);
    } else if (!existsSync(resolve(root, entry.file))) {
      problems.push(`${at}: file ${entry.file} does not exist; remove the entry or fix the path`);
    }
    if (typeof entry.test !== "string" || entry.test.trim() !== entry.test || entry.test === "") {
      problems.push(`${at}: "test" must be the exact, non-empty full test name`);
    }
    if (typeof entry.issue !== "string" || !/^AB-\d+$/.test(entry.issue)) problems.push(`${at}: "issue" must be a Pair Desk issue such as AB-410`);
    if (typeof entry.owner !== "string" || entry.owner.trim() === "") problems.push(`${at}: "owner" (who re-checks it) is required`);
    if (entry.seen !== undefined && typeof entry.seen !== "string") problems.push(`${at}: "seen" must be a string`);
    const added = parseDate(entry.added);
    const recheckBy = parseDate(entry.recheckBy);
    if (added === undefined) problems.push(`${at}: "added" must be a date YYYY-MM-DD`);
    if (recheckBy === undefined) problems.push(`${at}: "recheckBy" must be a date YYYY-MM-DD`);
    if (added !== undefined && recheckBy !== undefined && recheckBy < added) problems.push(`${at}: "recheckBy" is before "added"`);
    if (todayTime !== undefined && added !== undefined && added > todayTime) problems.push(`${at}: "added" is in the future`);
    if (todayTime !== undefined && recheckBy !== undefined) {
      if (recheckBy < todayTime) {
        problems.push(`${at}: re-check date ${entry.recheckBy} has passed (issue ${entry.issue}, owner ${entry.owner}). ` +
          `Re-check it: remove the entry if the test is fixed or no longer flakes; if it still flakes, record the re-check on ${entry.issue} ` +
          `and move "recheckBy" forward by at most ${RECHECK_MAX_DAYS} days.`);
      } else if (recheckBy - todayTime > RECHECK_MAX_DAYS * DAY_MS) {
        problems.push(`${at}: "recheckBy" ${entry.recheckBy} is more than ${RECHECK_MAX_DAYS} days away; entries are re-checked weekly`);
      }
    }
    const key = JSON.stringify([entry.file, entry.test ?? null]);
    if (seen.has(key)) problems.push(`${at}: duplicate entry`);
    seen.add(key);
  });
  return problems;
}

/** Structurally valid entries, for the test runner. Dates are not checked here. */
export function knownFlakyEntries(root = process.cwd()) {
  const doc = readKnownFlaky(root);
  const problems = validateKnownFlaky(doc, { root });
  if (problems.length) throw new Error(`Invalid ${KNOWN_FLAKY_PATH}:\n${problems.join("\n")}`);
  return doc.entries;
}

/** `file` is repository-relative with forward slashes; `name` is the Vitest full test name. Exact comparison only. */
export function entryMatches(entry, file, name) {
  return entry.file === file && entry.test === name;
}

export function listedFiles(entries) {
  return [...new Set(entries.map(entry => entry.file))].sort();
}

/**
 * The per-file name filter the runner hands to Vitest (config.testNamePattern). Vitest calls
 * fullTestName.match(filter), which uses Symbol.match, so the comparison stays exact. Every
 * decision is recorded for verifyFileDecisions. Its string form (toString, source) matches
 * everything: if anything turns the filter into a string or RegExp, every test runs.
 * Returns undefined when the file needs no filter (the user's own pattern applies unchanged).
 */
export function createFileFilter(entries, file, mode, user) {
  const listedNames = new Set(entries.filter(entry => entry.file === file).map(entry => entry.test));
  if (mode === "off" || (mode === "exclude" && listedNames.size === 0)) return undefined;
  const decisions = [];
  const matcher = {
    [Symbol.match]: name => {
      const userAllows = !user || name.match(user) !== null;
      const listed = listedNames.has(name);
      const run = userAllows && (mode === "only" ? listed : !listed);
      decisions.push({ name, userAllows, listed, run });
      return run ? [name] : null;
    },
    source: MATCH_EVERYTHING_SOURCE,
    toString: () => MATCH_EVERYTHING_SOURCE,
  };
  return { file, mode, user, listedNames, decisions, matcher };
}

const willRun = mode => mode === "run" || mode === "queued" || mode === "only";

/**
 * Checks a file filter's recorded decisions against the tests Vitest collected for that file.
 * `tests` is [{ name, mode }] after Vitest applied its modes. Returns a list of problems:
 * every test that will run must have been decided by this filter; every decision must belong
 * to a test of this file; in exclude mode no listed test may run, an entry names at most one
 * test, and the number of tests the filter skipped equals the number of listed tests it saw.
 */
export function verifyFileDecisions(filter, tests) {
  const problems = [];
  const pending = new Map();
  for (const decision of filter.decisions) {
    if (!pending.has(decision.name)) pending.set(decision.name, []);
    pending.get(decision.name).push(decision);
  }
  const counts = new Map();
  let expectedSkips = 0;
  for (const test of tests) {
    counts.set(test.name, (counts.get(test.name) ?? 0) + 1);
    const listed = filter.listedNames.has(test.name);
    const runs = willRun(test.mode);
    if (filter.mode === "exclude" && listed && runs) problems.push(`listed test "${test.name}" will run in exclude mode`);
    const decision = pending.get(test.name)?.shift();
    if (!decision) {
      if (runs) problems.push(`test "${test.name}" will run but the known-flaky filter never decided it`);
      continue;
    }
    if (runs && !decision.run) problems.push(`test "${test.name}" will run although the known-flaky filter skipped it`);
    if (filter.mode === "only" && !listed && runs) problems.push(`unlisted test "${test.name}" will run in only mode`);
    const userAllows = !filter.user || test.name.match(filter.user) !== null;
    if (filter.mode === "exclude" && listed && userAllows) expectedSkips++;
  }
  for (const [name, left] of pending) {
    if (left.length) problems.push(`the filter decided "${name}" ${left.length} more time(s) than this file has such a test (applied to the wrong file?)`);
  }
  if (filter.mode === "exclude") {
    for (const name of filter.listedNames) {
      if ((counts.get(name) ?? 0) > 1) problems.push(`entry "${name}" names ${counts.get(name)} tests in this file; an entry must name exactly one test`);
    }
    const skipped = skippedByList(filter).length;
    if (skipped !== expectedSkips) problems.push(`the filter skipped ${skipped} listed test(s) but ${expectedSkips} listed test(s) were collected`);
  }
  return problems;
}

/** Names the filter skipped because they are listed (exclude mode). */
export function skippedByList(filter) {
  return filter.decisions.filter(decision => decision.userAllows && decision.listed && !decision.run).map(decision => decision.name);
}

/** Written by the runner per file and lane (under AGENT_BRIDGE_CI_RESULTS_DIR) for `known-flaky.mjs skips`. */
export function writeSkipRecord(dir, lane, file, skipped) {
  const target = join(dir, SKIPS_DIR, lane);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `${file.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), JSON.stringify({ lane, file, skipped }) + "\n");
}

/**
 * Per lane in `dir` (ci-reporter diagnostics plus the runner's skip records): N, the tests the
 * runner skipped because they are listed, must equal the collected tests that match an entry,
 * and each of those must be reported as skipped. A lane without diagnostics did not finish
 * (its test step has already failed) and is not checked.
 */
export function checkSkips(entries, dir) {
  const lanes = [];
  const problems = [];
  const names = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith("-diagnostics.json")).sort() : [];
  for (const name of names) {
    const diagnostics = JSON.parse(readFileSync(join(dir, name), "utf8"));
    const lane = diagnostics.lane ?? name.slice(0, -"-diagnostics.json".length);
    const listed = [];
    for (const file of diagnostics.files ?? []) {
      for (const test of file.tests ?? []) {
        if (entries.some(entry => entryMatches(entry, file.file, test.name))) listed.push({ file: file.file, name: test.name, state: test.state });
      }
    }
    const recordDir = join(dir, SKIPS_DIR, lane);
    const skipped = [];
    if (existsSync(recordDir)) {
      for (const record of readdirSync(recordDir).filter(entry => entry.endsWith(".json")).sort()) {
        const data = JSON.parse(readFileSync(join(recordDir, record), "utf8"));
        for (const test of data.skipped) skipped.push({ file: data.file, name: test });
      }
    }
    for (const test of listed) {
      if (test.state !== "skipped") problems.push(`${lane}: listed test ${test.file} > ${test.name} was ${test.state}, not skipped`);
    }
    for (const test of skipped) {
      if (!entries.some(entry => entryMatches(entry, test.file, test.name))) problems.push(`${lane}: the runner skipped ${test.file} > ${test.name}, which is not listed`);
    }
    if (skipped.length !== listed.length) problems.push(`${lane}: skipped by known-flaky: ${skipped.length}, but ${listed.length} listed test(s) were collected`);
    lanes.push({ lane, skipped: skipped.length, expected: listed.length });
  }
  return { lanes, problems };
}

/** Summarise a known-flaky lane from the ci-reporter diagnostics in `dir`. Never fails on test results. */
export function reportKnownFlaky(entries, dir) {
  const results = [];
  const lanes = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith("-diagnostics.json")).sort() : [];
  for (const name of lanes) {
    const diagnostics = JSON.parse(readFileSync(join(dir, name), "utf8"));
    for (const file of diagnostics.files ?? []) {
      for (const test of file.tests ?? []) results.push({ lane: diagnostics.lane, file: file.file, name: test.name, state: test.state });
    }
  }
  const rows = entries.map(entry => {
    const matched = results.filter(result => entryMatches(entry, result.file, result.name));
    const ran = matched.filter(result => result.state === "passed" || result.state === "failed");
    const failed = matched.filter(result => result.state === "failed");
    const outcome = failed.length ? "failed" : ran.length ? "passed" : matched.length ? "skipped" : "not found";
    return { entry, matched, outcome };
  });
  return { lanes, rows };
}

function formatReport({ lanes, rows }, label) {
  const lines = [`### Known-flaky tests (non-blocking)${label ? `: ${label}` : ""}`, ""];
  if (!lanes.length) lines.push("No lane diagnostics were written; the listed tests did not run to completion.", "");
  lines.push("| Result | Test | Issue | Owner | Re-check by |", "| --- | --- | --- | --- | --- |");
  for (const { entry, matched, outcome } of rows) {
    const detail = matched.length > 1 ? ` (${matched.filter(result => result.state === "failed").length}/${matched.length} failed)` : "";
    lines.push(`| ${outcome}${detail} | ${describeEntry(entry).replaceAll("|", "\\|")} | ${entry.issue} | ${entry.owner} | ${entry.recheckBy} |`);
  }
  return lines.join("\n") + "\n";
}

function formatSkips({ lanes, problems }, label) {
  const lines = [`### Known-flaky skips (blocking lane)${label ? `: ${label}` : ""}`, ""];
  if (!lanes.length) lines.push("No lane diagnostics were written; nothing to compare (the test steps did not finish).");
  for (const { lane, skipped, expected } of lanes) lines.push(`- ${lane}: skipped by known-flaky: ${skipped} (listed tests collected: ${expected})`);
  if (problems.length) lines.push("", "**Mismatch, failing this job:**", ...problems.map(problem => `- ${problem}`));
  return lines.join("\n") + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, argument] = process.argv.slice(2);
  if (command === "validate") {
    const today = argument ?? todayUtc();
    let problems;
    try { problems = validateKnownFlaky(readKnownFlaky(), { today }); } catch (error) { problems = [`Cannot read ${KNOWN_FLAKY_PATH}: ${error.message}`]; }
    if (problems.length) {
      for (const problem of problems) console.log(`::error file=${KNOWN_FLAKY_PATH}::${problem}`);
      console.error(`\n${KNOWN_FLAKY_PATH} needs attention (checked on ${today}, UTC). See CONTRIBUTING.md "Known-flaky tests".`);
      process.exitCode = 1;
    } else {
      console.log(`${KNOWN_FLAKY_PATH}: ${readKnownFlaky().entries.length} entries valid and current on ${today} (UTC).`);
    }
  } else if (command === "files") {
    console.log(listedFiles(knownFlakyEntries()).join(" "));
  } else if (command === "skips") {
    const result = checkSkips(knownFlakyEntries(), argument ?? ".agent-bridge-test/ci");
    const text = formatSkips(result, process.env.KNOWN_FLAKY_LABEL);
    console.log(text);
    for (const problem of result.problems) console.log(`::error title=Known-flaky skips do not match the list::${problem}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
    if (result.problems.length) process.exitCode = 1;
  } else if (command === "report") {
    const report = reportKnownFlaky(knownFlakyEntries(), argument ?? ".agent-bridge-test/known-flaky");
    const text = formatReport(report, process.env.KNOWN_FLAKY_LABEL);
    console.log(text);
    for (const { entry, outcome } of report.rows) {
      if (outcome === "failed") console.log(`::warning title=Known-flaky test failed (non-blocking)::${describeEntry(entry)} (${entry.issue}, owner ${entry.owner})`);
      if (outcome === "not found") console.log(`::warning title=Known-flaky entry matched no test::${describeEntry(entry)} (${entry.issue}); check the name or remove the entry`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  } else {
    console.error("Usage: node scripts/known-flaky.mjs validate [YYYY-MM-DD] | files | skips [dir] | report [dir]");
    process.exitCode = 2;
  }
}
