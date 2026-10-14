import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { caseIdentity, censusDigest, censusMetadata, fileIdentity } from "./ci-reporter.mjs";

export function checkShardResults(root, shard, metadata) {
  mkdirSync(root, { recursive: true });
  const proof = { metadata: null, shard, coverage: "unknown", lanes: {}, problems: [] };
  try {
    metadata ??= censusMetadata();
    proof.metadata = metadata;
    const read = name => JSON.parse(readFileSync(join(root, name), "utf8"));
    const inventory = read("shards.json");
    assert(Number.isInteger(shard) && shard >= 1 && shard <= inventory.count, "Invalid shard");
    assert.equal(inventory.complete, true, "Unsharded collection incomplete; coverage unknown");
    assert.deepEqual(inventory.metadata, metadata, "Unsharded source/runtime differs from this job");
    assert.equal(inventory.censusSha256, censusDigest(inventory.unsharded), "Unsharded census digest changed");
    proof.censusSha256 = inventory.censusSha256;
    const allFiles = Object.values(inventory.lanes).flat(2);
    assert.equal(allFiles.length, inventory.totalFiles, "Unsharded file total changed");
    assert.equal(new Set(allFiles).size, allFiles.length, "Duplicate files across lanes/shards");
    for (const lane of ["fast", "integration"]) {
      try {
        const unsharded = inventory.unsharded[lane];
        assert.equal(inventory.lanes[lane].length, inventory.count, `${lane}: missing shard inventory`);
        assert.deepEqual(inventory.lanes[lane].flat().sort(), unsharded.map(file => file.file).sort(),
          `${lane}: shard union differs from unsharded files`);
        const allCases = unsharded.flatMap(file => file.tests.map(test => caseIdentity(file, test)));
        assert.equal(new Set(allCases).size, allCases.length, `${lane}: duplicate unsharded cases`);
        assert(unsharded.every(file => file.errors.length === 0 && file.suiteErrors.length === 0 &&
          file.tests.every(test => ["pending", "skipped"].includes(test.state))),
          `${lane}: invalid unsharded collection`);
        const expected = unsharded.filter(file => inventory.lanes[lane][shard - 1].includes(file.file));
        const census = read(`${lane}-census.json`);
        proof.lanes[lane] = { complete: census.complete, files: census.files };
        assert.equal(census.complete, true, `${lane}: only partial collection survived; coverage unknown`);
        const results = read(`${lane}-diagnostics.json`);
        assert.equal(results.complete, true, `${lane}: execution did not finish`);
        assert.deepEqual(census.metadata, metadata, `${lane}: collected source/runtime mismatch`);
        assert.deepEqual(results.metadata, metadata, `${lane}: executed source/runtime mismatch`);
        assert.deepEqual(census.files, results.files, `${lane}: final census differs from diagnostics`);
        assert.equal(results.unhandledErrors.length, 0, `${lane}: unhandled errors; coverage unknown`);
        assert.deepEqual(results.files.map(file => file.file).sort(), expected.map(file => file.file).sort(),
          `${lane}: executed files differ from the shard inventory`);
        assert.deepEqual(results.files.map(fileIdentity).sort(), expected.map(fileIdentity).sort(),
          `${lane}: executed project/module scope differs from collection`);
        for (const file of results.files) {
          const baseline = expected.find(item => item.file === file.file);
          assert.equal(file.errors.length, 0, `${lane}: ${file.file}: module/hook error`);
          assert.equal(file.suiteErrors.length, 0, `${lane}: ${file.file}: nested suite/hook error; execution unknown`);
          assert.deepEqual(file.tests.map(test => caseIdentity(file, test)).sort(),
            baseline.tests.map(test => caseIdentity(baseline, test)).sort(), `${lane}: ${file.file}: missing or repeated cases`);
          for (const test of file.tests) {
            assert(["passed", "failed", "skipped"].includes(test.state), `${lane}: ${test.name}: execution pending`);
            assert.equal(test.hooks?.id, caseIdentity(file, test), `${lane}: per-case hook scope is missing/changed`);
            assert(test.hooks.status === "complete" || (test.state === "skipped" && test.hooks.status === "not-executed"),
              `${lane}: per-case hook failure/incomplete/unknown execution`);
            assert(Array.isArray(test.hooks.entries) && test.hooks.entries.every(entry =>
              ["beforeEach", "afterEach"].includes(entry.name) && entry.reportedState === "pass" && entry.status === "passed" &&
              Number.isInteger(entry.starts) && entry.starts > 0 && entry.ends === entry.starts),
            `${lane}: per-case hook groups did not all pass`);
            const collected = baseline.tests.find(item => item.id === test.id);
            if (collected.state === "skipped") assert.equal(test.state, "skipped", `${lane}: collection skip changed`);
          }
        }
        const tests = results.files.flatMap(file => file.tests);
        proof.lanes[lane] = { coverage: "known", files: results.files, totalFiles: results.files.length,
          collectionNames: expected.map(file => ({ file: file.file, project: file.project, id: file.id,
            tests: file.tests.map(test => ({ id: test.id, name: test.name })) })),
          totalCases: tests.length, passed: tests.filter(test => test.state === "passed").length,
          failed: tests.filter(test => test.state === "failed").length, skipped: tests.filter(test => test.state === "skipped").length };
      } catch (error) { proof.problems.push(error.message); }
    }
    if (proof.problems.length === 0) proof.coverage = "known";
  } catch (error) { proof.problems.push(error.message); }
  // Publish disposition and missing evidence even when an assertion or test failed.
  writeFileSync(join(root, "shard-coverage.json"), JSON.stringify(proof, null, 2) + "\n");
  assert.equal(proof.coverage, "known", proof.problems.join("\n"));
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, shardText] = process.argv.slice(2);
  const proof = checkShardResults(root, Number(shardText));
  console.log(`Exact file/case membership matches shard ${proof.shard}; census ${proof.censusSha256}. Test failures remain failures.`);
}
