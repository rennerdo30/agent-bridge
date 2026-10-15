import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseSequencer } from "vitest/node";

// Duration-balanced shard assignment for `vitest --shard=i/n`.
// Greedy longest-processing-time packing over a checked-in table of median Windows
// file times. Files missing from the table get its default weight. The plan depends
// only on the file list, the table and the shard count, so every job and the
// collect-once inventory (check-test-shards.mjs) compute the same partition.
// Only shard() changes; execution order inside a shard stays Vitest's default.

export function loadShardTimings() {
  const table = JSON.parse(readFileSync(new URL("./test-shard-timings.json", import.meta.url), "utf8"));
  assert(table.files && typeof table.files === "object", "Shard timing table has no files");
  assert(Number.isFinite(table.defaultSeconds) && table.defaultSeconds > 0, "Shard timing table has no default weight");
  return table;
}

/** Integer deciseconds, so the packing never depends on floating-point sums. */
function weightOf(file, timings) {
  const seconds = timings.files[file];
  return Math.max(1, Math.round((Number.isFinite(seconds) ? seconds : timings.defaultSeconds) * 10));
}

/**
 * items: [{ key, tieBreak?, value? }]; key is the repository-relative test path.
 * Returns `count` shards: { items, deciseconds } in shard order.
 */
export function planShards(items, count, timings = loadShardTimings()) {
  assert(Number.isInteger(count) && count >= 1, "Expected a positive shard count");
  const shards = Array.from({ length: count }, () => ({ items: [], deciseconds: 0 }));
  const weighted = items.map(item => ({ item, weight: weightOf(item.key, timings), order: `${item.key}\0${item.tieBreak ?? ""}` }))
    .sort((a, b) => b.weight - a.weight || (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  for (const { item, weight } of weighted) {
    let target = shards[0];
    for (const shard of shards) if (shard.deciseconds < target.deciseconds) target = shard;
    target.items.push(item);
    target.deciseconds += weight;
  }
  return shards;
}

export class DurationShardSequencer extends BaseSequencer {
  async shard(files) {
    const { config } = this.ctx;
    const { index, count } = config.shard;
    const items = files.map(spec => ({
      key: relative(config.root, spec.moduleId).replaceAll("\\", "/"),
      tieBreak: spec.project?.name ?? "",
      value: spec,
    }));
    return planShards(items, count)[index - 1].items.map(item => item.value);
  }
}

// `node scripts/test-shards.mjs [count...]` prints the plan for each lane and proves that
// every test file is assigned exactly once. No tests run.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { fastTests, integrationTests } = await import("./test-lanes.mjs");
  const timings = loadShardTimings();
  const counts = process.argv.slice(2).map(Number);
  for (const count of counts.length ? counts : [6]) {
    const lanes = { fast: fastTests, integration: integrationTests };
    const plans = Object.fromEntries(Object.entries(lanes).map(([lane, files]) =>
      [lane, planShards(files.map(key => ({ key })), count, timings)]));
    const assigned = Object.values(plans).flat().flatMap(shard => shard.items.map(item => item.key)).sort();
    const all = [...fastTests, ...integrationTests].sort();
    assert.equal(new Set(assigned).size, assigned.length, "A file is assigned more than once");
    assert.deepEqual(assigned, all, "A file is unassigned");
    console.log(`\n${count} shards (identical on Node 22 and 24); estimated serial file seconds, median Windows table:`);
    for (let index = 0; index < count; index++) {
      const fast = plans.fast[index], integration = plans.integration[index];
      const heaviest = integration.items.map(item => item.key).filter(key => key in timings.files)
        .sort((a, b) => timings.files[b] - timings.files[a]).slice(0, 4)
        .map(key => `${key.slice(5, -8)} ${timings.files[key]}`).join(", ");
      console.log(`  shard ${index + 1}/${count}: integration ${integration.items.length} files ${(integration.deciseconds / 10).toFixed(1)} s` +
        ` | fast ${fast.items.length} files ${(fast.deciseconds / 10).toFixed(1)} s | heaviest: ${heaviest}`);
    }
    const unknown = all.filter(key => !(key in timings.files));
    console.log(`  ${all.length} files assigned exactly once; ${unknown.length} without timing use ${timings.defaultSeconds} s: ${unknown.join(", ") || "none"}`);
  }
}
