import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Known-flaky list (owner rule 2026-10-16): listed tests are reported in a separate,
// non-blocking CI lane and skipped in the normal lanes. Everything else still blocks.
// Each entry names one test file plus ONE selector:
//   test:      the exact Vitest full name ("describe > nested describe > test name");
//   pattern:   an anchored regular expression (^...$) over that full name;
//   wholeFile: true, which lists every test in the file (only when explicitly wanted).
// The list is applied by scripts/known-flaky-runner.mjs (vitest.config.ts `runner`).

export const KNOWN_FLAKY_PATH = "test/known-flaky.json";
export const RECHECK_MAX_DAYS = 7;
export const MODES = ["exclude", "only", "off"];

const ENTRY_KEYS = new Set(["file", "test", "pattern", "wholeFile", "issue", "owner", "added", "recheckBy", "seen"]);
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
  const selector = entry?.wholeFile === true ? "(whole file)" : entry?.test ?? (entry?.pattern !== undefined ? `/${entry.pattern}/` : "(no selector)");
  return `${entry?.file ?? "(no file)"} > ${selector}`;
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
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) problems.push(`${at}: unknown field "${key}"`);
    if (typeof entry.file !== "string" || !/^test\/[^\\]+\.test\.ts$/.test(entry.file)) {
      problems.push(`${at}: "file" must be a repository-relative test path such as test/example.test.ts`);
    } else if (!existsSync(resolve(root, entry.file))) {
      problems.push(`${at}: file ${entry.file} does not exist; remove the entry or fix the path`);
    }
    const selectors = ["test", "pattern", "wholeFile"].filter(key => entry[key] !== undefined);
    if (selectors.length !== 1) problems.push(`${at}: needs exactly one of "test", "pattern" or "wholeFile"`);
    if (entry.test !== undefined && (typeof entry.test !== "string" || entry.test.trim() !== entry.test || entry.test === "")) {
      problems.push(`${at}: "test" must be the exact, non-empty full test name`);
    }
    if (entry.pattern !== undefined) {
      if (typeof entry.pattern !== "string" || !entry.pattern.startsWith("^") || !entry.pattern.endsWith("$")) {
        problems.push(`${at}: "pattern" must be a string anchored with ^ and $ so it cannot match other tests by accident`);
      } else {
        try { new RegExp(entry.pattern); } catch (error) { problems.push(`${at}: "pattern" is not a valid regular expression: ${error.message}`); }
      }
    }
    if (entry.wholeFile !== undefined && entry.wholeFile !== true) problems.push(`${at}: "wholeFile" may only be true`);
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
    const key = JSON.stringify([entry.file, entry.test ?? null, entry.pattern ?? null, entry.wholeFile ?? null]);
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
  return doc.entries.map(entry => ({ ...entry, regex: entry.pattern === undefined ? undefined : new RegExp(entry.pattern) }));
}

/** `file` is repository-relative with forward slashes; `name` is the Vitest full test name. */
export function entryMatches(entry, file, name) {
  if (entry.file !== file) return false;
  if (entry.wholeFile === true) return true;
  if (entry.test !== undefined) return entry.test === name;
  const regex = entry.regex ?? new RegExp(entry.pattern);
  return regex.test(name);
}

export function listedFiles(entries) {
  return [...new Set(entries.map(entry => entry.file))].sort();
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
    console.error("Usage: node scripts/known-flaky.mjs validate [YYYY-MM-DD] | files | report [dir]");
    process.exitCode = 2;
  }
}
