import { describe, expect, it } from "vitest";
import { entryMatches, knownFlakyEntries, knownFlakyMode, todayUtc, validateKnownFlaky, type KnownFlakyEntry } from "../scripts/known-flaky.mjs";

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

  it("requires file, one selector, issue, owner and both dates", () => {
    for (const field of ["file", "issue", "owner", "added", "recheckBy"] as const) {
      const { [field]: _omitted, ...rest } = valid;
      expect(validateKnownFlaky(doc(rest), { today: "2026-10-16" }).length, field).toBeGreaterThan(0);
    }
    const { test: _test, ...noSelector } = valid;
    expect(validateKnownFlaky(doc(noSelector))[0]).toContain("exactly one");
    expect(validateKnownFlaky(doc({ ...valid, wholeFile: true }))[0]).toContain("exactly one");
    expect(validateKnownFlaky(doc({ ...valid, file: "test/missing-file.test.ts" }))[0]).toContain("does not exist");
    expect(validateKnownFlaky(doc({ ...valid, extra: 1 }))[0]).toContain("unknown field");
    expect(validateKnownFlaky(doc(valid, valid))[0]).toContain("duplicate");
  });

  it("requires patterns to be anchored", () => {
    const { test: _test, ...base } = valid;
    expect(validateKnownFlaky(doc({ ...base, pattern: "listed" }))[0]).toContain("anchored");
    expect(validateKnownFlaky(doc({ ...base, pattern: "^known-flaky list > .*$" }))).toEqual([]);
  });

  it("matches only the exact listed name", () => {
    expect(entryMatches(valid, valid.file, valid.test!)).toBe(true);
    expect(entryMatches(valid, valid.file, `${valid.test!} (variant)`)).toBe(false);
    expect(entryMatches(valid, valid.file, "known-flaky list")).toBe(false);
    expect(entryMatches(valid, "test/other.test.ts", valid.test!)).toBe(false);
    const { test: _test, ...base } = valid;
    const pattern = { ...base, pattern: "^a > b \\(n=\\d+\\)$" };
    expect(entryMatches(pattern, valid.file, "a > b (n=12)")).toBe(true);
    expect(entryMatches(pattern, valid.file, "a > b (n=12) extra")).toBe(false);
    expect(entryMatches({ ...base, wholeFile: true }, valid.file, "anything")).toBe(true);
    expect(entryMatches({ ...base, wholeFile: true }, "test/other.test.ts", "anything")).toBe(false);
  });

  it("parses the mode and the UTC date", () => {
    expect(knownFlakyMode(undefined)).toBe("exclude");
    expect(knownFlakyMode("only")).toBe("only");
    expect(() => knownFlakyMode("all")).toThrow();
    expect(todayUtc(new Date("2026-10-16T23:59:59Z"))).toBe("2026-10-16");
  });
});
