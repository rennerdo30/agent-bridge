import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateReport, productionTest, suspendedTerminationTest, mutations, mutationSelection, treeHash } from './gate.mjs';

const report = (failed = false) => ({
  success: !failed, numRuntimeErrorTestSuites: 0, numTotalTests: 1, numFailedTests: failed ? 1 : 0,
  testResults: [{ assertionResults: [{ fullName: productionTest, status: failed ? 'failed' : 'passed',
    failureMessages: failed ? ['AssertionError: AB458_WIRE_RESULT'] : [] }] }],
});
const options = { expectedTest: productionTest, marker: 'AB458_WIRE_RESULT', mutation: true };
test('accepts executed baseline and exact intended assertion red', () => {
  validateReport(report(), { expectedTest: productionTest }); validateReport(report(true), options);
});
for (const [name, change] of [
  ['empty collection', (r) => { r.testResults = []; }],
  ['runtime error', (r) => { r.numRuntimeErrorTestSuites = 1; }],
  ['missing production test', (r) => { r.testResults[0].assertionResults[0].fullName = 'unrelated'; }],
  ['wrong assertion', (r) => { r.testResults[0].assertionResults[0].failureMessages = ['AssertionError: unrelated']; }],
  ['timeout despite marker', (r) => { r.testResults[0].assertionResults[0].failureMessages.push('Test timed out'); }],
  ['import failure despite marker', (r) => { r.testResults[0].assertionResults[0].failureMessages.push('Cannot find package effect'); }],
  ['syntax failure despite marker', (r) => { r.testResults[0].assertionResults[0].failureMessages.push('SyntaxError'); }],
  ['setup failure despite marker', (r) => { r.testResults[0].assertionResults[0].failureMessages.push('beforeAll hook failed'); }],
  ['unexpected second failing test', (r) => { r.numFailedTests = 2; r.testResults[0].assertionResults.push({ fullName: 'other', status: 'failed', failureMessages: ['other'] }); }],
]) test(`rejects ${name}`, () => { const r = report(true); change(r); assert.throws(() => validateReport(r, options)); });
test('passing mutation cannot satisfy red gate', () => assert.throws(() => validateReport(report(), options)));
test('baseline rejects skipped selected test', () => {
  const r = report(); r.testResults[0].assertionResults.push({ fullName: 'extra', status: 'pending' });
  assert.throws(() => validateReport(r, { expectedTest: productionTest }));
});
test('effective tree hash binds paths and content independent of order', () => {
  const files = [{ path: 'a', sha256: 'one' }, { path: 'b', sha256: 'two' }];
  assert.equal(treeHash(files), treeHash([...files].reverse()));
  assert.notEqual(treeHash(files), treeHash([{ path: 'c', sha256: 'one' }, files[1]]));
});
test('each production mutation refuses absent preimage', () => {
  for (const mutation of mutations()) assert.throws(() => mutation.change('unrelated source'));
});

// Small projection of actual bd1ab33 hosted reports, not declared test names
// scraped/reimplemented from source and not a substitute for production tests.
const census = JSON.parse(fs.readFileSync(new URL('./selector-census.json', import.meta.url)));
const suspendedMutation = mutations().find((mutation) => mutation.name === 'suspended-terminal-publication');
test('all five mutation selectors resolve real executed hosted baseline targets', () => {
  assert.equal(mutations().length, 5);
  for (const mutation of mutations()) {
    const selection = mutationSelection(census.baseline, mutation);
    const suite = census.baseline.testResults.find((suite) => suite.name.endsWith('/'+selection.file));
    const hits = suite.assertionResults.filter((task) =>
      new RegExp(selection.testNamePattern).test([...task.ancestorTitles, task.title].join(' > ')));
    assert.equal(hits.length, 1); assert.equal(hits[0].fullName, selection.expectedTest);
  }
});
test('nested mutation CLI selector differs from the JSON reporter fullName', () => {
  const selection = mutationSelection(census.baseline, suspendedMutation);
  const task = census.baseline.testResults.flatMap((suite) => suite.assertionResults)
    .find((task) => task.fullName === suspendedTerminationTest);
  const runtimeName = [...task.ancestorTitles, task.title].join(' > ');
  assert.equal(new RegExp(suspendedTerminationTest).test(runtimeName), false);
  assert.equal(new RegExp(selection.testNamePattern).test(runtimeName), true);
});
test('mutation CLI patterns escape metacharacters and anchor the exact task', () => {
  const baseline = structuredClone(census.baseline);
  const task = baseline.testResults.flatMap((suite) => suite.assertionResults)
    .find((task) => task.fullName === suspendedTerminationTest);
  task.title = 'publishes (root+child) [scope].';
  task.fullName = [...task.ancestorTitles, task.title].join(' ');
  const { testNamePattern } = mutationSelection(baseline, { ...suspendedMutation, test: task.fullName });
  const pattern = new RegExp(testNamePattern), runtimeName = [...task.ancestorTitles, task.title].join(' > ');
  assert.equal(pattern.test(runtimeName), true);
  assert.equal(pattern.test(runtimeName.replace('(root+child)', 'rootttchild')), false);
  assert.equal(pattern.test('prefix '+runtimeName), false);
  assert.equal(pattern.test(runtimeName+' suffix'), false);
});
for (const [name, change] of [
  ['skipped baseline target', (suite, task) => { task.status = 'skipped'; }],
  ['missing baseline target', (suite, task) => { suite.assertionResults = suite.assertionResults.filter((other) => other !== task); }],
  ['duplicated baseline target', (suite, task) => { suite.assertionResults.push(structuredClone(task)); }],
  ['wrong baseline file', (suite) => { suite.name = '/other.test.ts'; }],
  ['inconsistent reporter name', (suite, task) => { task.ancestorTitles.push('unexpected'); }],
]) test(`mutation selector rejects ${name}`, () => {
  const baseline = structuredClone(census.baseline);
  const suite = baseline.testResults.find((suite) => suite.name.endsWith('/'+suspendedMutation.file));
  const task = suite.assertionResults.find((task) => task.fullName === suspendedTerminationTest);
  change(suite, task);
  assert.throws(() => mutationSelection(baseline, suspendedMutation));
});
test('actual hosted all-skipped mutation cannot satisfy the assertion-qualified red gate', () => {
  assert.throws(() => validateReport(census.skippedMutation, {
    expectedTest: suspendedTerminationTest, marker: suspendedMutation.marker, mutation: true,
  }));
});
