import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createVitest } from "vitest/node";

// Use Vitest's configured sequencer, not a second implementation of its hash.
// `vitest list --filesOnly` does not apply --shard in Vitest 5.
const count = Number(process.argv[2] ?? 4);
assert(Number.isInteger(count) && count >= 1, "Expected a positive shard count");
const output = resolve(process.argv[3] ?? ".agent-bridge-test/ci/shards.json");
const inventory = { count, lanes: {} };
const repository = realpathSync.native(process.cwd());
const normalize = specs => specs.map(spec => relative(repository, realpathSync.native(spec.moduleId)).replaceAll("\\", "/")).sort();
async function specifications(lane, visit) {
  process.env.AGENT_BRIDGE_TEST_LANE = lane;
  const ctx = await createVitest({ watch: false, reporters: [] });
  try {
    await ctx.standalone();
    await visit(ctx, await ctx.globTestSpecifications());
  } finally { await ctx.close(); }
}
let all;
await specifications("all", async (_ctx, specs) => { all = normalize(specs); });
for (const lane of ["fast", "integration"]) {
  await specifications(lane, async (ctx, specs) => {
    assert(specs.length >= count, `Not enough ${lane} files for ${count} shards`);
    const shards = [];
    for (let index = 1; index <= count; index++) {
      ctx.config.shard = { index, count };
      const files = normalize(await new ctx.config.sequence.sequencer(ctx).shard([...specs]));
      shards.push(files);
      console.log(`${lane} shard ${index}/${count}: ${files.length} files\n${files.join("\n")}\n`);
    }
    assert.deepEqual(shards.flat().sort(), normalize(specs), `${lane}: missing or repeated files`);
    inventory.lanes[lane] = shards;
  });
}
const flattened = Object.values(inventory.lanes).flat(2).sort();
assert.equal(new Set(flattened).size, flattened.length, "A file appears in multiple lanes/shards");
assert.deepEqual(flattened, all, "Shards must cover every unfiltered test file exactly once");
mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(output, JSON.stringify({ ...inventory, totalFiles: all.length }, null, 2) + "\n");
console.log(`Verified: ${all.length} files, each exactly once across ${count} shards per lane.`);
