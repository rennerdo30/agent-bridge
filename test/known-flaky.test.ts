import { describe, expect, it } from "vitest";
import {
  createFileFilter, entryMatches, knownFlakyEntries, knownFlakyMode, MATCH_EVERYTHING_SOURCE, skippedByList, todayUtc,
  validateKnownFlaky, verifyFileDecisions, type KnownFlakyEntry,
} from "../scripts/known-flaky.mjs";

const valid: KnownFlakyEntry = {
  file: "test/known-flaky.test.ts",
  test: "known-flaky list > matches only the exact listed name",
  issue: "AB-410",
  owner: "claude-claude-codex-comm",
  added: "2026-10-16",
  recheckBy: "2026-10-23",
};
const doc = (...entries: unknown[]) => ({ entries });

describe("known-flaky list", () => {
  it("accepts the checked-in list structurally", () => {
    expect(knownFlakyEntries().length).toBeGreaterThan(0);
  });

  it("accepts a complete entry that is due within a week", () => {
    expect(validateKnownFlaky(doc(valid), { today: "2026-10-16" })).toEqual([]);
    expect(validateKnownFlaky(doc(valid), { today: "2026-10-23" })).toEqual([]);
  });

  it("fails an expired re-check date and tells the reader to re-check or remove the entry", () => {
    const problems = validateKnownFlaky(doc(valid), { today: "2026-10-24" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("re-check date 2026-10-23 has passed");
    expect(problems[0]).toContain("remove the entry");
  });

  it("checks dates only when a check date is given", () => {
    expect(validateKnownFlaky(doc(valid))).toEqual([]);
  });

  it("rejects a re-check date more than a week away", () => {
    expect(validateKnownFlaky(doc({ ...valid, recheckBy: "2026-10-24" }), { today: "2026-10-16" })[0]).toContain("more than 7 days");
  });

  it("requires file, exact test name, issue, owner and both dates", () => {
    for (const field of ["file", "test", "issue", "owner", "added", "recheckBy"] as const) {
      const { [field]: _omitted, ...rest } = valid;
      expect(validateKnownFlaky(doc(rest), { today: "2026-10-16" }).length, field).toBeGreaterThan(0);
    }
    expect(validateKnownFlaky(doc({ ...valid, file: "test/missing-file.test.ts" }))[0]).toContain("does not exist");
    expect(validateKnownFlaky(doc({ ...valid, extra: 1 }))[0]).toContain("unknown field");
    expect(validateKnownFlaky(doc(valid, valid))[0]).toContain("duplicate");
  });

  it("allows only exact test names, never patterns or whole files", () => {
    const { test: _test, ...base } = valid;
    expect(validateKnownFlaky(doc({ ...base, pattern: "^known-flaky list > .*$" }))).toContain(
      `Entry 1 (${valid.file} > (no test name)): "pattern" is not allowed; only exact test names are allowed (use "test")`);
    expect(validateKnownFlaky(doc({ ...base, wholeFile: true })).join("\n")).toContain("only exact test names are allowed");
    expect(validateKnownFlaky(doc({ ...valid, wholeFile: true })).join("\n")).toContain("only exact test names are allowed");
  });

  it("matches only the exact listed name in the listed file", () => {
    expect(entryMatches(valid, valid.file, valid.test)).toBe(true);
    expect(entryMatches(valid, valid.file, `${valid.test} (variant)`)).toBe(false);
    expect(entryMatches(valid, valid.file, "known-flaky list")).toBe(false);
    expect(entryMatches(valid, "test/other.test.ts", valid.test)).toBe(false);
  });

  it("parses the mode and the UTC date", () => {
    expect(knownFlakyMode(undefined)).toBe("exclude");
    expect(knownFlakyMode("only")).toBe("only");
    expect(() => knownFlakyMode("all")).toThrow();
    expect(todayUtc(new Date("2026-10-16T23:59:59Z"))).toBe("2026-10-16");
  });
});

describe("known-flaky file filter", () => {
  const other = "known-flaky list > another test";

  it("needs no filter for an unlisted file in exclude mode or in off mode", () => {
    expect(createFileFilter([valid], "test/other.test.ts", "exclude")).toBeUndefined();
    expect(createFileFilter([valid], valid.file, "off")).toBeUndefined();
    expect(createFileFilter([valid], "test/other.test.ts", "only")).toBeDefined();
  });

  it("skips exactly the listed name in exclude mode and runs only it in only mode", () => {
    const exclude = createFileFilter([valid], valid.file, "exclude")!;
    expect(valid.test.match(exclude.matcher)).toBeNull();
    expect(other.match(exclude.matcher)).toEqual([other]);
    expect(`${valid.test} (variant)`.match(exclude.matcher)).not.toBeNull();
    const only = createFileFilter([valid], valid.file, "only")!;
    expect(valid.test.match(only.matcher)).toEqual([valid.test]);
    expect(other.match(only.matcher)).toBeNull();
  });

  it("keeps the user's own name pattern", () => {
    const filter = createFileFilter([valid], valid.file, "exclude", /another/)!;
    expect(other.match(filter.matcher)).toEqual([other]);
    expect("known-flaky list > third".match(filter.matcher)).toBeNull();
    expect(skippedByList(filter)).toEqual([]);
  });

  it("fails open: a string or RegExp round trip of the filter runs every test", () => {
    for (const mode of ["exclude", "only"] as const) {
      const filter = createFileFilter([valid], valid.file, mode)!;
      expect(String(filter.matcher)).toBe(MATCH_EVERYTHING_SOURCE);
      const roundTrip = new RegExp(String(filter.matcher));
      const viaSource = new RegExp(filter.matcher.source);
      for (const name of [valid.test, other, ""]) {
        expect(roundTrip.test(name)).toBe(true);
        expect(viaSource.test(name)).toBe(true);
      }
    }
  });

  it("verifies that the decisions match the collected tests", () => {
    const filter = createFileFilter([valid], valid.file, "exclude")!;
    valid.test.match(filter.matcher);
    other.match(filter.matcher);
    expect(skippedByList(filter)).toEqual([valid.test]);
    expect(verifyFileDecisions(filter, [{ name: valid.test, mode: "skip" }, { name: other, mode: "run" }])).toEqual([]);
  });

  it("reports a listed test that would still run", () => {
    const filter = createFileFilter([valid], valid.file, "exclude")!;
    valid.test.match(filter.matcher);
    expect(verifyFileDecisions(filter, [{ name: valid.test, mode: "run" }]).join("\n")).toContain("will run in exclude mode");
  });

  it("reports tests the filter never decided and decisions for tests the file does not have", () => {
    const filter = createFileFilter([valid], valid.file, "exclude")!;
    expect(verifyFileDecisions(filter, [{ name: other, mode: "run" }]).join("\n")).toContain("never decided");
    // A decision taken for another file's tests (the filter applied to the wrong file).
    "previous file > test".match(filter.matcher);
    const problems = verifyFileDecisions(filter, []).join("\n");
    expect(problems).toContain("applied to the wrong file");
  });

  it("reports a skip count that does not equal the listed tests collected", () => {
    const filter = createFileFilter([valid], valid.file, "exclude")!;
    valid.test.match(filter.matcher);
    valid.test.match(filter.matcher);
    const problems = verifyFileDecisions(filter, [{ name: valid.test, mode: "skip" }, { name: valid.test, mode: "skip" }]).join("\n");
    expect(problems).toContain("names 2 tests in this file");
  });

  it("reports an unlisted test that would run in only mode", () => {
    const filter = createFileFilter([valid], valid.file, "only")!;
    other.match(filter.matcher);
    expect(verifyFileDecisions(filter, [{ name: other, mode: "run" }]).join("\n")).toContain("will run");
  });
});
