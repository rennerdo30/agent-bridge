import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

// Vitest 5 IDs bind the project-relative module and nested registration order.
// Names can contain runtime parameters (including worker PIDs); keep them as data.
export function fileIdentity(file) {
  assert(typeof file.file === "string" && file.file.length > 0, "Missing file path");
  assert(typeof file.project === "string", "Missing project scope");
  assert(typeof file.id === "string" && file.id.length > 0, "Missing module ID");
  return JSON.stringify([file.file, file.project, file.id]);
}
export function caseIdentity(file, test) {
  assert(typeof test.id === "string" && test.id.length > 0, "Missing case ID");
  return JSON.stringify([fileIdentity(file), test.id]);
}
export function censusDigest(unsharded) {
  return createHash("sha256").update(JSON.stringify(Object.entries(unsharded).sort(([a], [b]) => a.localeCompare(b)).map(([lane, files]) => [lane,
    files.map(file => [fileIdentity(file), file.tests.map(test => [caseIdentity(file, test), test.state])
      .sort(([a], [b]) => a.localeCompare(b))]).sort(([a], [b]) => a.localeCompare(b)),
  ]))).digest("hex");
}

export function censusMetadata() {
  return {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(),
    node: process.version, platform: process.platform,
    vitest: JSON.parse(readFileSync(new URL("../node_modules/vitest/package.json", import.meta.url), "utf8")).version,
    runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
  };
}

export function collectionCacheProof(ctx, fixtureRoot, lane) {
  assert(["all", "fast", "integration"].includes(lane), "Invalid collection cache lane");
  const base = resolve(fixtureRoot, "collection-cache", lane);
  const physicalRoot = realpathSync.native(fixtureRoot);
  const projects = [...new Set([ctx.getRootProject(), ...ctx.projects])];
  const proof = { base, root: physicalRoot, projects: [] };
  for (const project of projects) {
    const name = project.name;
    assert.equal(typeof name, "string", "Unknown collection project name");
    // Pinned5.0.2 resolveTestCacheDir / VitestCache.resolveCacheDir contract.
    const hash = createHash("sha1").update(name || "").digest("hex");
    const configRoot = resolve(project.config.root);
    const expected = resolve(configRoot, base, "vitest", hash);
    const actual = resolve(project.viteConfig.cacheDir);
    assert.equal(actual, expected, `${lane}: derived project collection cache differs`);
    const executionCache = resolve(configRoot, ".agent-bridge-test/vite", "vitest", hash);
    assert.notEqual(actual, executionCache, `${lane}: collection reused the execution cache`);
    mkdirSync(actual, { recursive: true });
    const physical = realpathSync.native(actual);
    const expectedPhysical = resolve(physicalRoot, "collection-cache", lane, "vitest", hash);
    assert.equal(physical, expectedPhysical, `${lane}: project collection cache escaped the exact marked-root path`);
    proof.projects.push({ name, hash, configRoot, expected, resolved: actual, physical, expectedPhysical, executionCache });
  }
  assert(proof.projects.length > 0, "No collection project cache proof");
  return proof;
}

function moduleScope(module) {
  return { file: relative(realpathSync.native(process.cwd()), realpathSync.native(module.moduleId)).replaceAll("\\", "/"),
    project: module.project.name, id: module.id };
}

export function moduleCensus(module, hookEvidence) {
  // Suite hook errors do not necessarily appear on the module or on a case.
  // Retain deterministic scope/count only, never arbitrary hook message/stack.
  const suiteErrors = [];
  function visit(entity) {
    const count = entity.errors().length;
    if (count > 0) suiteErrors.push({ id: entity.id, count });
    for (const suite of entity.children.suites()) visit(suite);
  }
  for (const suite of module.children.suites()) visit(suite);
  const moduleErrors = module.errors().length;
  return {
    ...moduleScope(module),
    state: module.state(), diagnostic: module.diagnostic(),
    errors: moduleErrors > 0 ? [{ id: module.id, count: moduleErrors }] : [], suiteErrors,
    tests: [...module.children.allTests()].map(test => {
      const hooks = hookEvidence ? hookEvidence(test) : {
        id: caseIdentity(moduleScope(module), test), status: "not-executed", entries: [],
      };
      const result = test.result();
      return { id: test.id, name: test.fullName, state: result.state, note: result.note, hooks,
        // An uncertain hook case can carry hook secrets in the ordinary error array.
        // Keep count here; the original Vitest job/results still retain the failure.
        errorCount: result.errors?.length ?? 0,
        errors: ["unknown", "incomplete"].includes(hooks.status) ? undefined : result.errors,
        ...test.diagnostic() };
    }),
  };
}

// Keep failures visible; report configured retries without introducing retries.
export default class CiReporter {
  collected = new Map();
  metadata = censusMetadata();
  hookEvents = new Map();
  ctx;

  onInit(ctx) { this.ctx = ctx; }

  recordHook(hook, field) {
    if (hook.entity.type !== "test" || !["beforeEach", "afterEach"].includes(hook.name)) return;
    const id = caseIdentity(moduleScope(hook.entity.module), hook.entity);
    let evidence = this.hookEvents.get(id);
    if (!evidence) this.hookEvents.set(id, evidence = {});
    const counts = evidence[hook.name] ??= { starts: 0, ends: 0 };
    counts[field]++;
  }

  onHookStart(hook) { this.recordHook(hook, "starts"); }
  onHookEnd(hook) { this.recordHook(hook, "ends"); }

  caseHooks(test) {
    const id = caseIdentity(moduleScope(test.module), test);
    const proof = { id, status: "unknown", entries: [] };
    if (this.metadata.vitest !== "5.0.2") return proof;
    // Documented experimental state API, pinned to the declared TaskResult.hooks
    // reporting contract. Do not read @internal TestCase.task or error text.
    const state = this.ctx?.state;
    if (typeof state?.idMap?.get !== "function" || typeof state?.getReportedEntity !== "function") return proof;
    const raw = state.idMap.get(test.id);
    if (!raw || raw.type !== "test" || raw.file?.id !== test.module.id || state.getReportedEntity(raw) !== test) return proof;
    if ((!raw.result && test.result().state !== "skipped") ||
      (raw.result && !["pass", "fail", "skip", "todo"].includes(raw.result.state))) return proof;
    const hooks = raw.result?.hooks === undefined ? {} : raw.result.hooks;
    if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks) ||
      Object.keys(hooks).some(name => !["beforeEach", "afterEach"].includes(name))) return proof;
    const events = this.hookEvents.get(id) ?? {};
    for (const name of ["beforeEach", "afterEach"]) {
      const { starts = 0, ends = 0 } = events[name] ?? {};
      const actual = hooks[name];
      if (actual === undefined && starts === 0 && ends === 0) continue;
      // run survives an interrupted/failed awaited hook. pass is genuine serialized
      // runner state, not an inference from onHookEnd or from the overall case.
      const complete = actual === "pass" && starts > 0 && ends === starts;
      const reportedState = ["run", "pass"].includes(actual) ? actual : "unknown";
      proof.entries.push({ name, reportedState, status: complete ? "passed" : "incomplete", starts, ends });
    }
    proof.status = proof.entries.some(entry => entry.status !== "passed") ? "incomplete"
      : test.result().state === "skipped" && proof.entries.length === 0 ? "not-executed" : "complete";
    return proof;
  }

  onTestModuleCollected(module) {
    const file = moduleCensus(module);
    this.collected.set(file.file, file);
    const root = process.env.AGENT_BRIDGE_CI_RESULTS_DIR;
    if (!root) return;
    mkdirSync(root, { recursive: true });
    // A crash before onTestRunEnd retains a partial census, never a coverage pass.
    writeFileSync(join(root, `${process.env.AGENT_BRIDGE_TEST_LANE ?? "all"}-census.json`),
      JSON.stringify({ metadata: this.metadata, complete: false, files: [...this.collected.values()] }, null, 2) + "\n");
  }

  onTestRunEnd(modules, errors, reason) {
    const root = process.env.AGENT_BRIDGE_CI_RESULTS_DIR;
    if (!root) return;
    const lane = process.env.AGENT_BRIDGE_TEST_LANE ?? "all";
    const files = modules.map(module => moduleCensus(module, test => this.caseHooks(test)));
    const flaky = files.flatMap(file => file.tests.filter(test => test.flaky || test.retryCount > 0).map(test => ({ file: file.file, ...test })));
    mkdirSync(root, { recursive: true });
    const metadata = this.metadata;
    writeFileSync(join(root, `${lane}-diagnostics.json`), JSON.stringify({ metadata, complete: true, lane, reason, files, flaky, unhandledErrors: errors }, null, 2) + "\n");
    writeFileSync(join(root, `${lane}-census.json`), JSON.stringify({ metadata, complete: true, files }, null, 2) + "\n");
    const summary = `### ${lane} test diagnostics\n\n${files.length} files; ${flaky.length} retried/flaky tests; ${errors.length} unhandled errors.\n\n`;
    console.log(summary.trim());
    for (const test of flaky) console.log(`FLAKY/RETRIED: ${test.file}: ${test.name} (${test.retryCount} retries, ${test.state})`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}
