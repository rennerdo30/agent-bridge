import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { jsonSnapshotCacheUsage, readJsonSnapshot } from "../src/core/file-cache.js";
it("bounds resident snapshot bytes while oversized retained context remains readable and unchanged", () => {
  const home = mkdtempSync(join(tmpdir(), "idle-cache-"));
  const small = join(home, "small.json"), large = join(home, "large.json");
  writeFileSync(small, '{"retained":"small context"}');
  const before = readJsonSnapshot(small);
  const context = "retained-context:" + "x".repeat(33 * 1024 * 1024);
  writeFileSync(large, JSON.stringify({ context }));
  expect(readJsonSnapshot(large).value).toEqual({ context });
  expect(readJsonSnapshot(small)).toBe(before);
  const usage = jsonSnapshotCacheUsage();
  expect(usage.bytes).toBeLessThanOrEqual(usage.maxBytes);
  expect(readFileSync(large, "utf8")).toBe(JSON.stringify({ context }));
});
