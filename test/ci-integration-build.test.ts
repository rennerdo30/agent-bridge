import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it.each(["test", "windows"])("%s integration requires fresh bundles but survives fast-test failure", name => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const job = workflow.split(new RegExp(`\\r?\\n  ${name}:\\r?\\n`))[1]!.split(/\r?\n  [\w-]+:\r?\n/)[0]!;
  const steps = job.split(/\r?\n(?=      - )/);
  const build = steps.findIndex(step => /- run: npm run build(?:\r?\n|$)/.test(step));
  const integration = steps.findIndex(step => step.includes("- name: Integration tests"));
  expect(build).toBeGreaterThan(-1);
  expect(integration).toBeGreaterThan(build);
  const condition = steps[integration]!.match(/^\s+if: (.+)$/m)![1]!.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  // Evaluate the actual workflow condition with mocked Actions status functions.
  // Without an explicit status function, Actions implicitly requires success().
  for (const outcome of ["skipped", "failure", "cancelled", "success"]) {
    for (const failed of [false, true]) {
      for (const cancelled of [false, true]) {
        const status = { success: () => !failed && !cancelled, failure: () => failed, always: () => true,
          cancelled: () => cancelled, steps: { build: { outcome } } };
        const explicitStatus = /\b(?:success|failure|cancelled|always)\(/.test(condition);
        const runs = (!explicitStatus ? status.success() : true) &&
          Boolean(runInNewContext(condition, status, { timeout: 50 }));
        expect(runs, JSON.stringify({ outcome, failed, cancelled })).toBe(outcome === "success" && !cancelled);
      }
    }
  }
  expect(steps[build]).toMatch(/\bid: build\b/);
});
