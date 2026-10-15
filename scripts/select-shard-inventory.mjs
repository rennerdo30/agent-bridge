import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Pick the collect-once inventory for this Node version from downloaded artifacts
// (one directory per run attempt) and place it where check-shard-results.mjs reads it.
// check-shard-results.mjs still binds it to this job's source, runtime, run and census.
const [root, node, output] = process.argv.slice(2);
assert(root && /^\d+$/.test(node ?? "") && output, "Usage: select-shard-inventory.mjs <download dir> <node> <shards.json>");
const prefix = `shard-inventory-windows-node-${node}-attempt-`;
const attempts = (existsSync(root) ? readdirSync(root) : [])
  .filter(name => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
  .map(name => ({ name, attempt: Number(name.slice(prefix.length)) }))
  .filter(({ name }) => existsSync(join(root, name, "shards.json")))
  .sort((a, b) => b.attempt - a.attempt);
assert(attempts.length > 0, `No ${prefix}* inventory was downloaded`);
const current = Number(process.env.GITHUB_RUN_ATTEMPT ?? attempts[0].attempt);
const chosen = attempts.find(({ attempt }) => attempt <= current);
assert(chosen, `No inventory from attempt ${current} or earlier`);
mkdirSync(dirname(resolve(output)), { recursive: true });
copyFileSync(join(root, chosen.name, "shards.json"), output);
console.log(`Using ${chosen.name}/shards.json for run attempt ${current}.`);
// Keep an incomplete inventory for the coverage verdict, but do not run integration on it.
assert.equal(JSON.parse(readFileSync(output, "utf8")).complete, true, "Unsharded collection incomplete; coverage unknown");
