import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// Rebuild scripts/test-shard-timings.json from downloaded hosted Windows CI artifacts:
//   gh run download <run> -p 'tests-windows-*' -D <dir>/<run>   (one or more runs)
//   node scripts/update-test-shard-timings.mjs <dir> [<dir> ...]
// Each Vitest JSON result contributes endTime - startTime per file. The table keeps the
// median per file over every Windows execution (both Node versions, every shard).
const roots = process.argv.slice(2);
if (roots.length === 0) throw new Error("Usage: update-test-shard-timings.mjs <artifact dir> [...]");
const samples = new Map();
const runs = new Set();
function visit(path) {
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (statSync(child).isDirectory()) { visit(child); continue; }
    if (!/^(fast|integration)-results\.json$/.test(entry) || !/tests-windows-/.test(path)) continue;
    runs.add(basename(join(path, "..")));
    for (const result of JSON.parse(readFileSync(child, "utf8")).testResults) {
      const file = result.name.replaceAll("\\", "/").replace(/^.*?\/(test\/[^/]+\.test\.ts)$/, "$1");
      if (!file.startsWith("test/") || !(result.endTime > result.startTime)) continue;
      (samples.get(file) ?? samples.set(file, []).get(file)).push((result.endTime - result.startTime) / 1000);
    }
  }
}
for (const root of roots) visit(root);
if (samples.size === 0) throw new Error("No Windows Vitest results found");
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const files = Object.fromEntries([...samples].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([file, values]) => [file, Math.round(median(values) * 10) / 10]));
const table = {
  description: "Median Windows file wall time (s) per test file from hosted CI artifacts. " +
    "Used only to balance Windows shards; regenerate with scripts/update-test-shard-timings.mjs.",
  runs: runs.size,
  // Files missing from the table (new tests) get the median of all measured files.
  defaultSeconds: Math.round(median(Object.values(files)) * 10) / 10,
  files,
};
const output = fileURLToPath(new URL("./test-shard-timings.json", import.meta.url));
writeFileSync(output, JSON.stringify(table, null, 2) + "\n");
console.log(`Wrote ${Object.keys(files).length} file medians from ${runs.size} runs; default ${table.defaultSeconds} s.`);
