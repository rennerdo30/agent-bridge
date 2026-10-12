import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [root, shardText] = process.argv.slice(2);
const shard = Number(shardText);
const inventory = JSON.parse(readFileSync(join(root, "shards.json"), "utf8"));
assert(Number.isInteger(shard) && shard >= 1 && shard <= inventory.count, "Invalid shard");
for (const lane of ["fast", "integration"]) {
  const results = JSON.parse(readFileSync(join(root, `${lane}-diagnostics.json`), "utf8"));
  assert.deepEqual(results.files.map(file => file.file).sort(), inventory.lanes[lane][shard - 1].slice().sort(),
    `${lane}: executed files differ from the shard inventory`);
}
console.log(`Executed files match shard ${shard}/${inventory.count}, with no missing or repeated files.`);
