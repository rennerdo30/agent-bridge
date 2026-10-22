import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { sha256, treeHash, verifyFiles } from './gate.mjs';

const root = import.meta.dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
verifyFiles(root, manifest.artifacts);
const workflowBytes = fs.readFileSync(path.resolve(root, '../../.github/workflows/t3-native-integration.yml'));
assert.equal(sha256(workflowBytes), manifest.workflowSha256);
const workflow = JSON.parse(workflowBytes); // JSON is a YAML 1.2 subset.
assert.deepEqual(Object.keys(workflow.on), ['pull_request']);
assert.deepEqual(workflow.on.pull_request.paths, ['scripts/t3-native-integration/**', '.github/workflows/t3-native-integration.yml']);
assert.deepEqual(workflow.permissions, { contents: 'read' });
assert.equal(Object.keys(workflow.jobs).length, 1);
const job = workflow.jobs['pinned-mocked-integration'];
assert.equal(job['runs-on'], 'ubuntu-24.04'); assert.equal(job['timeout-minutes'], 25);
assert.equal(job.steps[0].with['persist-credentials'], false);
assert.equal(job.steps[1].with['node-version'], manifest.tools.node);
for (const step of job.steps) {
  if (step.uses) assert.match(step.uses, /^actions\/(checkout|setup-node|upload-artifact)@[0-9a-f]{40}$/);
}
assert.equal(treeHash(manifest.effectiveFiles), manifest.effectiveTreeSha256);
assert.equal(manifest.artifacts.find((file) => file.path === manifest.patchOrder[0]).sha256, manifest.historicalArtifact.sha256);
assert.equal(manifest.patchOrder.length, 3);
assert.equal(fs.existsSync(path.join(root, 'ci.vitest.config.ts')), false);
const template = manifest.materializedConfigs.find((config) => config.path === '.ab458-ci.vitest.config.ts');
assert.equal(template.source, 'ci.vitest.config.ts.template');
assert.equal(template.sha256, '43b4ab80ef6e94cc2b4306acc4975f59602314b35ad008066cf499da7a5b6ac3');
assert.equal(sha256(fs.readFileSync(path.join(root, template.source))), template.sha256);
console.log(JSON.stringify({ pid: process.pid, validation: 'offline package/workflow JSON-subset YAML semantics',
  manifestSha256: sha256(fs.readFileSync(path.join(root, 'manifest.json'))), effectiveTreeSha256: manifest.effectiveTreeSha256 }));
