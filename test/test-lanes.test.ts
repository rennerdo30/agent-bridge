import { readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { integrationTests, fastTests } from "../scripts/test-lanes.mjs";

it("keeps fast and integration gates disjoint and covers every test file", () => {
  const all = readdirSync(import.meta.dirname).filter(file => file.endsWith(".test.ts")).map(file => `test/${file}`);
  expect(new Set([...fastTests, ...integrationTests]).size).toBe(all.length);
  expect([...fastTests, ...integrationTests].sort()).toEqual(all.sort());
  expect(fastTests.some(file => integrationTests.includes(file))).toBe(false);
  expect(integrationTests).toEqual(expect.arrayContaining(["test/job-runner.test.ts", "test/worktree.test.ts", "test/history-budget.test.ts"]));
  expect(fastTests).toContain("test/request-retry.test.ts");
});
