import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const treeHash = (files) => sha256(files.toSorted((a, b) => a.path.localeCompare(b.path, 'en'))
  .map((file) => `${file.path}\0${file.sha256}\n`).join(''));

export function verifyFiles(root, records) {
  for (const record of records) {
    if (record.path.includes('\\') || record.path.split('/').includes('..') || path.isAbsolute(record.path)) {
      throw new Error('Manifest path escapes package');
    }
    if (sha256(fs.readFileSync(path.join(root, record.path))) !== record.sha256) {
      throw new Error(`Hash mismatch: ${record.path}`);
    }
  }
}

// An exit code is evidence only when the focused test actually ran and failed
// on the deliberately broken invariant. Tool/setup/collection failures are red.
export function validateReport(report, { expectedTest, marker, mutation = false, requiredFiles = [] }) {
  if (!report || !Array.isArray(report.testResults) || !report.testResults.length ||
      (report.numRuntimeErrorTestSuites ?? 0) !== 0 || !Number.isInteger(report.numTotalTests) || report.numTotalTests < 1) {
    throw new Error('Inconclusive report: collection/runtime failure');
  }
  const suites = report.testResults;
  if (suites.some((suite) => !Array.isArray(suite.assertionResults) || suite.assertionResults.length === 0 ||
      suite.message)) {
    throw new Error('Inconclusive report: empty or failed collection');
  }
  const tests = suites.flatMap((suite) => suite.assertionResults);
  if (report.numTotalTests !== tests.length || requiredFiles.some((file) =>
    !suites.some((suite) => suite.name?.replaceAll('\\', '/').endsWith('/'+file)))) {
    throw new Error('Required focused test collection incomplete');
  }
  const target = tests.filter((test) => test.fullName === expectedTest);
  if (target.length !== 1) throw new Error('Required production test missing/duplicated');
  const failed = tests.filter((test) => test.status === 'failed');
  const infrastructure = /timed?\s*out|timeout|cannot (find|resolve)|failed to (load|resolve|collect)|syntaxerror|referenceerror|unhandled|beforeall|afterall|hook failed|worker exited/i;
  for (const test of failed) {
    const messages = (test.failureMessages ?? []).join('\n');
    if (infrastructure.test(messages)) throw new Error('Inconclusive report: timeout/setup/import/worker failure');
  }
  if (!mutation) {
    if (report.success !== true || report.numFailedTests !== 0 || failed.length ||
        target[0].status !== 'passed' || tests.some((test) => test.status !== 'passed')) {
      throw new Error('Baseline did not pass every selected test');
    }
  } else if (report.success !== false || report.numFailedTests !== 1 || failed.length !== 1 ||
      failed[0] !== target[0] || !(target[0].failureMessages ?? []).some((message) => message.includes(marker))) {
    throw new Error('Mutation did not produce its required assertion failure');
  }
  return { total: tests.length, executed: tests.filter((test) => ['passed', 'failed'].includes(test.status)).length,
    target: target[0].fullName, status: target[0].status, marker: mutation ? marker : null };
}

export const productionTest = 'AB458 production admission: actual adapter registration, 32-limit warm replay, roots, fault and close';
export const suspendedTerminationTest = 'AB458 real protocol lifecycle publishes suspended-handler termination before owned cleanup completes';
const productionTestFile = 'apps/server/src/orchestration-v2/Adapters/CodexBridgeDynamicTools.adapter.test.ts';

// Vitest 5.0.5's JSON reporter uses space-separated fullName, while -t
// matches fullTestName produced by createTaskName with " > " separators.
// Resolve against the successfully executed baseline, never a handwritten
// copy of a test declaration or an assumed reporter/runtime name equivalence.
export function mutationSelection(baseline, mutation) {
  const file = mutation.file ?? productionTestFile;
  const expectedTest = mutation.test ?? productionTest;
  const suites = baseline?.testResults?.filter((suite) =>
    suite.name?.replaceAll(path.win32.sep, '/').endsWith('/'+file)) ?? [];
  const tests = suites.flatMap((suite) => suite.assertionResults ?? []);
  const targets = tests.filter((test) => test.fullName === expectedTest);
  if (baseline.success !== true || targets.length !== 1 || targets[0].status !== 'passed') {
    throw new Error('Mutation selector needs one executed passing baseline target in its exact file');
  }
  const parts = (test) => {
    if (!Array.isArray(test.ancestorTitles) || typeof test.title !== 'string' || !test.title ||
        test.ancestorTitles.some((title) => typeof title !== 'string' || !title)) {
      throw new Error('Mutation selector lacks structured baseline ancestry/title');
    }
    const names = [...test.ancestorTitles, test.title];
    if (names.join(' ') !== test.fullName) throw new Error('Unexpected JSON reporter name encoding');
    return names;
  };
  const escape = (name) => RegExp.escape(name); // Available in pinned Node 24.
  const testNamePattern = '^'+parts(targets[0]).map(escape).join(' > ')+'$';
  const matching = tests.filter((test) => new RegExp(testNamePattern).test(parts(test).join(' > ')));
  if (matching.length !== 1 || matching[0] !== targets[0]) throw new Error('Mutation selector is ambiguous');
  return { file, expectedTest, testNamePattern };
}

export function mutations() {
  const adapter = 'apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts';
  const protocol = 'packages/effect-codex-app-server/src/protocol.ts';
  const once = (text, from, to) => {
    if (text.split(from).length !== 2) throw new Error('Mutation preimage changed');
    return text.replace(from, to);
  };
  return [
    { name: 'production-handler', path: adapter, marker: 'AB458_HANDLER_MUST_SUSPEND32', change: (text) => {
      const start = text.indexOf('        yield* client.handleServerRequest("item/tool/call",');
      const end = text.indexOf('        yield* client.handleServerRequest("item/commandExecution/requestApproval",', start);
      if (start < 0 || end < start) throw new Error('Handler mutation preimage changed');
      return text.slice(0, start) + text.slice(end);
    } },
    { name: 'production-registration', path: adapter, marker: 'AB458_REGISTRATION', change: (text) =>
      once(text, '...params, dynamicTools: bridgeDynamicTools,', '...params, /* mutation: registration absent */') },
    { name: 'cap-order', path: 'packages/effect-codex-app-server/src/PrivateRequestAdmission.ts',
      marker: 'AB458_REPLAY_MUST_REMAIN_PENDING', change: (text) =>
        once(text, '    if (existing) return', '    if (active >= maxActive) return { kind: "overloaded" };\n    if (existing) return') },
    { name: 'encoded-response', path: protocol, marker: 'AB458_WIRE_RESULT', change: (text) =>
      once(text, 'const encoded = yield* encodeWireMessage(message);', `const encoded = yield* encodeWireMessage(
          message.id === 100 && "result" in message ? { id: 100, result: { success: false, contentItems: [] } } : message,
        );`) },
    { name: 'suspended-terminal-publication', path: protocol, marker: 'AB458_SUSPENDED_TERMINAL_PUBLICATION',
      test: suspendedTerminationTest, file: 'packages/effect-codex-app-server/src/PrivateProtocolLifecycle.test.ts', change: (text) => {
        const start = text.indexOf('    const handleTermination = '), end = text.indexOf('    const offerOutgoing =', start);
        if (start < 0 || end < start) throw new Error('Terminal publication mutation preimage changed');
        // Reintroduce the reviewed 430e scope/notification order, leaving the
        // current typed Crypto/clock/error corrections intact for collection.
        const previous = `    const handleTermination = (classify: () => Effect.Effect<CodexError.CodexAppServerError>) =>
      Ref.modify(terminationHandled, (handled) => {
        if (handled) return [Effect.void, true] as const;
        return [Effect.gen(function* () {
          requestAdmission.close();
          const error = yield* classify().pipe(Effect.timeoutOrElse({ duration: "2 seconds",
            orElse: () => Effect.succeed(new CodexError.CodexAppServerInputStreamEndedError({})) }));
          yield* Ref.set(terminationFailure, Option.some(error));
          yield* failAllPending(error);
          yield* Queue.end(outgoing);
          yield* Deferred.succeed(terminationSignal, undefined);
          yield* Scope.close(requestHandlerScope, Exit.void).pipe(
            Effect.forkIn(protocolScope, { startImmediately: true }), Effect.asVoid);
          if (options.onTermination) yield* options.onTermination(error);
        }), true] as const;
      }).pipe(Effect.flatten);

`;
        return text.slice(0, start)+previous+text.slice(end);
      } },
  ];
}
