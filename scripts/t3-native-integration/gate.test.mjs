import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, productionTest, mutations, treeHash } from './gate.mjs';

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
