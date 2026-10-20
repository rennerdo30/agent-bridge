import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Pick the collect-once inventory for this Node version from downloaded artifacts
// (one directory per run attempt) and place it where check-shard-results.mjs reads it.
// Run with the runner's bootstrap Node before setup-node or dependency installation.
// Only validated metadata may select the exact runtime; the result checker still proves
// runtime equality, membership and hashes after execution.
const [root, node, output] = process.argv.slice(2);
assert(root && /^[1-9]\d*$/.test(node ?? "") && output, "Usage: select-shard-inventory.mjs <download dir> <node> <shards.json>");
const { GITHUB_RUN_ATTEMPT: currentText, GITHUB_RUN_ID: runId, GITHUB_SHA: revision,
  GITHUB_EVENT_NAME: event, AGENT_BRIDGE_CI_SOURCE_HEAD: sourceHead, GITHUB_OUTPUT: githubOutput } = process.env;
assert(/^[1-9]\d*$/.test(currentText ?? "") && Number.isSafeInteger(Number(currentText)), "Missing/invalid current run attempt");
assert(/^[1-9]\d*$/.test(runId ?? ""), "Missing/invalid current run ID");
assert(/^[a-f0-9]{40}$/.test(revision ?? ""), "Missing/invalid current revision");
assert(/^[a-f0-9]{40}$/.test(sourceHead ?? ""), "Missing/invalid current source head");
assert(event && githubOutput, "Missing current event or GitHub output path");
const current = Number(currentText);
const prefix = `shard-inventory-windows-node-${node}-attempt-`;
const attempts = (existsSync(root) ? readdirSync(root) : [])
  .filter(name => name.startsWith(prefix) && /^[1-9]\d*$/.test(name.slice(prefix.length)))
  .map(name => ({ name, attempt: Number(name.slice(prefix.length)) }))
  .filter(({ attempt }) => Number.isSafeInteger(attempt))
  .filter(({ name }) => existsSync(join(root, name, "shards.json")))
  .sort((a, b) => b.attempt - a.attempt);
assert(attempts.length > 0, `No ${prefix}* inventory was downloaded`);
const chosen = attempts.find(({ attempt }) => attempt <= current);
assert(chosen, `No inventory from attempt ${current} or earlier`);
mkdirSync(dirname(resolve(output)), { recursive: true });
copyFileSync(join(root, chosen.name, "shards.json"), output);
console.log(`Using ${chosen.name}/shards.json for run attempt ${current}.`);
// Keep rejected inventory for the coverage verdict, but expose no runtime on failure.
const inventory = JSON.parse(readFileSync(output, "utf8"));
assert.equal(inventory.complete, true, "Unsharded collection incomplete; coverage unknown");
const metadata = inventory.metadata;
assert(metadata && typeof metadata === "object", "Missing inventory metadata");
assert.equal(metadata.revision, revision, "Inventory revision differs from this job");
assert.equal(metadata.sourceHead, sourceHead, "Inventory source head differs from this job");
assert.equal(metadata.runId, runId, "Inventory run ID differs from this job");
assert.equal(metadata.platform, "win32", "Inventory is not from Windows");
assert.equal(metadata.event, event, "Inventory event differs from this job");
assert.equal(metadata.attempt, String(chosen.attempt), "Inventory attempt differs from selected artifact");
const vitest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).devDependencies.vitest;
assert.equal(metadata.vitest, vitest, "Inventory Vitest differs from this source");
const exact = typeof metadata.node === "string" && /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(metadata.node);
assert(exact && exact[1] === node, "Inventory Node must be an exact stable version of the matrix major");
appendFileSync(githubOutput, `node-version=${metadata.node.slice(1)}\n`);
