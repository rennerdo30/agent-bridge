import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createVitest } from "vitest/node";
import { caseIdentity, censusDigest, censusMetadata, collectionCacheProof, moduleCensus } from "./ci-reporter.mjs";
import { testFixtureRoot } from "./test-fixture-root.mjs";

// Use Vitest's configured sequencer (duration packing, scripts/test-shards.mjs), not a copy of it.
// `vitest list --filesOnly` does not apply --shard in Vitest 5.
const count = Number(process.argv[2] ?? 6);
assert(Number.isInteger(count) && count >= 1, "Expected a positive shard count");
const output = resolve(process.argv[3] ?? ".agent-bridge-test/ci/shards.json");
const collect = process.argv[4] === "--collect";
let fixtureRoot;
if (collect) {
  assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true", "Collect in hosted Windows CI");
  fixtureRoot = testFixtureRoot();
  const temporary = join(fixtureRoot, "temp");
  mkdirSync(temporary, { recursive: true });
  Object.assign(process.env, { TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    AGENT_BRIDGE_HOME: join(fixtureRoot, "default-home"), GIT_CEILING_DIRECTORIES: fixtureRoot });
  delete process.env.AGENT_BRIDGE_PIPE;
}
const inventory = { count, metadata: censusMetadata(), complete: false, lanes: {}, unsharded: {} };
function save() {
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, JSON.stringify(inventory, null, 2) + "\n");
}
save();
const repository = realpathSync.native(process.cwd());
const normalize = specs => specs.map(spec => relative(repository, realpathSync.native(spec.moduleId)).replaceAll("\\", "/")).sort();
async function specifications(lane, visit) {
  process.env.AGENT_BRIDGE_TEST_LANE = lane;
  const cache = collect ? resolve(fixtureRoot, "collection-cache", lane) : undefined;
  // Pinned createVitest(options, viteOverrides): cacheDir belongs to Vite.
  const ctx = await createVitest({ watch: false, reporters: [] }, cache ? { cacheDir: cache } : {});
  try {
    if (collect) {
      (inventory.collectionCaches ??= {})[lane] = collectionCacheProof(ctx, fixtureRoot, lane);
      save();
    }
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
    ctx.config.shard = undefined;
    if (collect) {
      // Runtime collection imports setup/module code and evaluates describe/each/runIf.
      // It does not execute test callbacks or hooks. Keep the configured isolation.
      const result = await ctx.collectTests(specs);
      inventory.unsharded[lane] = result.testModules.map(module => moduleCensus(module)).sort((a, b) => a.file.localeCompare(b.file));
      inventory.collectionErrors = result.unhandledErrors;
      save();
      assert.equal(result.unhandledErrors.length, 0, `${lane}: collection errors; coverage unknown`);
      assert(inventory.unsharded[lane].every(file => file.errors.length === 0 && file.suiteErrors.length === 0),
        `${lane}: module/nested suite collection failed`);
      assert(inventory.unsharded[lane].every(file => file.tests.every(test => ["pending", "skipped"].includes(test.state))),
        `${lane}: collect-only unexpectedly executed a case`);
      assert.deepEqual(inventory.unsharded[lane].map(file => file.file).sort(), normalize(specs), `${lane}: incomplete collection`);
      const cases = inventory.unsharded[lane].flatMap(file => file.tests.map(test => caseIdentity(file, test)));
      assert.equal(new Set(cases).size, cases.length, `${lane}: duplicate case identities`);
      const partition = shards.flatMap(files => inventory.unsharded[lane].filter(file => files.includes(file.file)));
      assert.deepEqual(partition.flatMap(file => file.tests.map(test => caseIdentity(file, test))).sort(),
        cases.slice().sort(), `${lane}: missing or repeated cases`);
    }
    save();
  });
}
const flattened = Object.values(inventory.lanes).flat(2).sort();
assert.equal(new Set(flattened).size, flattened.length, "A file appears in multiple lanes/shards");
assert.deepEqual(flattened, all, "Shards must cover every unfiltered test file exactly once");
inventory.totalFiles = all.length;
inventory.totalCases = Object.values(inventory.unsharded).flat().reduce((sum, file) => sum + file.tests.length, 0);
inventory.complete = collect;
inventory.censusSha256 = censusDigest(inventory.unsharded);
save();
console.log(`Verified: ${all.length} files, each exactly once across ${count} shards per lane.`);
