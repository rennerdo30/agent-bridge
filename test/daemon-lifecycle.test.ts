import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { launchDaemon, type LateDaemonLaunch } from "../src/core/daemon-launcher.js";
import { Broker } from "../src/core/broker.js";
import { BridgeClient, CLIENT_TRANSPORT_DIAGNOSTIC_COUNT_LIMIT, CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT,
  type ClientConnectionClosedDiagnostic } from "../src/core/client.js";
import { APP_VERSION, PROTOCOL_VERSION } from "../src/core/constants.js";
import type { Op, RequestMap } from "../src/core/protocol.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { readProcessIdentity } from "../src/core/process-identity.js";
import { startWindowsJobScope, type WindowsJobScope } from "../src/core/windows-job-scope.js";
import { fixtureProcessGeneration, fixtureProcessExists } from "./fixture-process-generation.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { retainFixtureNode } from "./owned-mail.js";
import { startUi, type UiOptions } from "../src/cli/ui.js";
import { readDashboardInfo } from "../src/cli/dashboard.js";
import { deliveryFailure } from "../src/mcp/delivery-evidence.js";
import { httpFailureEvidence } from "./http-failure-evidence.js";

const cli = join(import.meta.dirname, "../plugins/codex/dist/cli.mjs");
let env: TestEnv, nodes: BridgeNode[], children: ChildProcess[], owned: Map<number, string>;
let startupEvidence: Array<Array<{ phase: string; code?: string | number; stage?: string; elapsedMs: number; count: number }>>;
let dashboards: Array<() => Promise<void>>;
const CLIENT_COUNT_CAPTURE_LIMIT = 129;
type ClientCount = number | "unavailable";
type ClientObservationFlag = boolean | "unavailable";
type ClientCountSnapshot = {
  stage: "original_core_status_reply"; parent_capture: "partial"; server_connection_origin: "unattributed";
  server_authenticated_count: ClientCount; returned_known_clients: ClientCount;
  auth_returned: ClientCount; hello_returned: ClientCount; close_requested_not_observed: ClientCount;
  close_observed: ClientCount; connect_attempt_unconfirmed: ClientCount; overflow: boolean;
  known_auth_hello_no_close_observed: ClientCount; known_auth_no_hello_no_close_observed: ClientCount;
  known_auth_close_observed: ClientCount; known_no_auth_close_observed: ClientCount; known_no_auth_no_close_observed: ClientCount;
  requester_auth_returned: ClientObservationFlag; requester_hello_returned: ClientObservationFlag;
  requester_close_requested: ClientObservationFlag; requester_close_observed: ClientObservationFlag;
};
type KnownClientObservation = { auth: boolean; hello: boolean; closeRequested: boolean; closeObserved: boolean; closed: () => void };
type ClientCountFixture = { pipe: string; active: boolean; incomplete: boolean; overflow: boolean;
  attempts: Array<{ returned: boolean }>; clients: Map<BridgeClient, KnownClientObservation>;
  restore: Array<() => void>; snapshot?: ClientCountSnapshot };
let clientCountFixture: ClientCountFixture | undefined;
function observeClientCount(fixture: ClientCountFixture, observation: () => void): void {
  if (!fixture.active) return;
  try { observation(); } catch { fixture.incomplete = true; fixture.overflow = true; }
}
function boundedClientCount(fixture: ClientCountFixture, value: unknown): ClientCount {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) return "unavailable";
  if (value > CLIENT_COUNT_CAPTURE_LIMIT) fixture.overflow = true;
  return Math.min(value, CLIENT_COUNT_CAPTURE_LIMIT);
}
function cacheClientCountReply(fixture: ClientCountFixture, response: unknown, requester: BridgeClient): void {
  if (fixture.snapshot) return; // One original response; never sample again during teardown.
  // Cache only the original response's own primitive count, without invoking a
  // getter or retaining any response identity, PID, name or accepted content.
  const count = response !== null && typeof response === "object"
    ? Object.getOwnPropertyDescriptor(response, "connectedClients")?.value : undefined;
  const serverCount = boundedClientCount(fixture, count), known = [...fixture.clients.values()];
  const capturedCount = (value: number): ClientCount => fixture.incomplete ? "unavailable" : boundedClientCount(fixture, value);
  // Cross-tabs of ORIGINAL auth/hello settlements and parent client close events
  // only. An observed parent close never proves server removal or retirement.
  const requesting = fixture.clients.get(requester);
  const capturedFlag = (value: boolean | undefined): ClientObservationFlag => fixture.incomplete || value === undefined ? "unavailable" : value;
  fixture.snapshot = { stage: "original_core_status_reply", parent_capture: "partial", server_connection_origin: "unattributed",
    server_authenticated_count: serverCount, returned_known_clients: capturedCount(known.length),
    auth_returned: capturedCount(known.filter(value => value.auth).length), hello_returned: capturedCount(known.filter(value => value.hello).length),
    close_requested_not_observed: capturedCount(known.filter(value => value.closeRequested && !value.closeObserved).length),
    close_observed: capturedCount(known.filter(value => value.closeObserved).length),
    connect_attempt_unconfirmed: capturedCount(fixture.attempts.filter(value => !value.returned).length),
    known_auth_hello_no_close_observed: capturedCount(known.filter(value => value.auth && value.hello && !value.closeObserved).length),
    known_auth_no_hello_no_close_observed: capturedCount(known.filter(value => value.auth && !value.hello && !value.closeObserved).length),
    known_auth_close_observed: capturedCount(known.filter(value => value.auth && value.closeObserved).length),
    known_no_auth_close_observed: capturedCount(known.filter(value => !value.auth && value.closeObserved).length),
    known_no_auth_no_close_observed: capturedCount(known.filter(value => !value.auth && !value.closeObserved).length),
    requester_auth_returned: capturedFlag(requesting?.auth), requester_hello_returned: capturedFlag(requesting?.hello),
    requester_close_requested: capturedFlag(requesting?.closeRequested), requester_close_observed: capturedFlag(requesting?.closeObserved),
    overflow: fixture.overflow };
}
function restoreClientCountObservation(): void {
  const fixture = clientCountFixture;
  if (!fixture) return;
  fixture.active = false; // Late original settlements cannot attach new listeners.
  for (const restore of [...fixture.restore].reverse()) { try { restore(); } catch { /* Private adapter restoration only. */ } }
  fixture.restore.length = 0;
  for (const [client, observation] of fixture.clients) {
    try { client.removeListener("close", observation.closed); } catch { /* Remove only our own listener, never close a client. */ }
  }
}
function observeConcurrentClientCount(): void {
  const fixture: ClientCountFixture = { pipe: env.pipe, active: true, incomplete: false, overflow: false,
    attempts: [], clients: new Map(), restore: [] };
  clientCountFixture = fixture;
  const connect = BridgeClient.connect, request = BridgeClient.prototype.request, close = BridgeClient.prototype.close;
  try {
    // Private forwarders keep no mock call/argument history. Restore only these
    // exact fixture adapters; all unrelated clients retain native pass-through.
    fixture.restore.push(() => { BridgeClient.connect = connect; });
    BridgeClient.connect = function(this: typeof BridgeClient, ...args: Parameters<typeof connect>) {
      let attempt: { returned: boolean } | undefined;
      observeClientCount(fixture, () => {
        if (args[0] !== fixture.pipe) return;
        if (fixture.attempts.length >= CLIENT_COUNT_CAPTURE_LIMIT) { fixture.overflow = true; return; }
        attempt = { returned: false }; fixture.attempts.push(attempt);
      });
      const originalPromise = connect.apply(this, args);
      if (attempt) observeClientCount(fixture, () => {
        // Observe settlement without replacing the ORIGINAL promise or error.
        void originalPromise.then(client => observeClientCount(fixture, () => {
          attempt!.returned = true;
          if (fixture.clients.has(client)) return;
          if (fixture.clients.size >= CLIENT_COUNT_CAPTURE_LIMIT) { fixture.overflow = true; return; }
          const observation: KnownClientObservation = { auth: false, hello: false, closeRequested: false, closeObserved: false,
            closed: () => observeClientCount(fixture, () => { observation.closeObserved = true; }) };
          fixture.clients.set(client, observation);
          client.on("close", observation.closed); // Actual source client close event only; no isClosed/socket probe.
        }), () => { /* No returned client: keep the attempt unconfirmed; original rejection is untouched. */ });
      });
      return originalPromise;
    };
    fixture.restore.push(() => { BridgeClient.prototype.request = request; });
    BridgeClient.prototype.request = function<O extends Op>(this: BridgeClient,
      ...args: [op: O, args: RequestMap[O][0], timeoutMs?: number]): Promise<RequestMap[O][1]> {
      const originalPromise = request.apply(this, args) as Promise<RequestMap[O][1]>;
      observeClientCount(fixture, () => {
        const observation = fixture.clients.get(this);
        if (!observation || (args[0] !== "auth" && args[0] !== "hello" && args[0] !== "coreStatus")) return;
        void originalPromise.then(response => observeClientCount(fixture, () => {
          if (args[0] === "auth") observation.auth = true;
          else if (args[0] === "hello") observation.hello = true;
          else cacheClientCountReply(fixture, response, this);
        }), () => { /* Observation of rejected auth/hello/status grants no success or resource state. */ });
      });
      return originalPromise;
    };
    fixture.restore.push(() => { BridgeClient.prototype.close = close; });
    BridgeClient.prototype.close = function(this: BridgeClient, ...args: Parameters<typeof close>) {
      observeClientCount(fixture, () => { const observation = fixture.clients.get(this); if (observation) observation.closeRequested = true; });
      return close.apply(this, args);
    };
  } catch {
    // An unavailable observer never prevents the original case or grants cleanup.
    fixture.incomplete = true; fixture.overflow = true; restoreClientCountObservation();
  }
}
function publishClientCountObservation(): void {
  const snapshot = clientCountFixture?.snapshot; clientCountFixture = undefined;
  if (!snapshot) return;
  try {
    const sourceHead = process.env.SOURCE_HEAD, runId = process.env.GITHUB_RUN_ID, runAttempt = process.env.GITHUB_RUN_ATTEMPT;
    if (process.env.GITHUB_ACTIONS !== "true" || typeof sourceHead !== "string" || !/^[a-f0-9]{40}$/.test(sourceHead) ||
      typeof runId !== "string" || !/^\d{1,20}$/.test(runId) || typeof runAttempt !== "string" || !/^\d{1,6}$/.test(runAttempt)) return;
    if (typeof snapshot.stage !== "string" || snapshot.stage !== "original_core_status_reply" ||
      typeof snapshot.parent_capture !== "string" || snapshot.parent_capture !== "partial" ||
      typeof snapshot.server_connection_origin !== "string" || snapshot.server_connection_origin !== "unattributed" || typeof snapshot.overflow !== "boolean") return;
    const fields = ["server_authenticated_count", "returned_known_clients", "auth_returned", "hello_returned",
      "close_requested_not_observed", "close_observed", "connect_attempt_unconfirmed", "known_auth_hello_no_close_observed",
      "known_auth_no_hello_no_close_observed", "known_auth_close_observed", "known_no_auth_close_observed", "known_no_auth_no_close_observed"] as const;
    for (const field of fields) {
      const value = snapshot[field];
      if (value !== "unavailable" && (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0 || value > CLIENT_COUNT_CAPTURE_LIMIT)) return;
    }
    const flags = ["requester_auth_returned", "requester_hello_returned", "requester_close_requested", "requester_close_observed"] as const;
    for (const field of flags) {
      const value = snapshot[field];
      if (value !== "unavailable" && typeof value !== "boolean") return;
    }
    const directory = join(process.cwd(), ".agent-bridge-test", "ab325-artifact"), stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const destination = join(directory, "client-count-diagnostics.json");
    if (existsSync(destination)) { const previous = lstatSync(destination); if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1) return; }
    // Original coreStatus count is not a parent census. In particular, remote
    // child/startup connections outside this map remain unattributed, not probes.
    writeFileSync(destination, JSON.stringify({ schema: 2, sourceHead, runId, runAttempt,
      fixture: "concurrent_start_client_count", countLimit: CLIENT_COUNT_CAPTURE_LIMIT, observations: [snapshot] }) + "\n");
  } catch { /* Only post-teardown diagnostic output failure is swallowed. */ }
}
beforeEach(() => {
  restoreClientCountObservation(); clientCountFixture = undefined;
  env = makeEnv(); nodes = []; children = []; owned = new Map();
  startupEvidence = [];
  dashboards = [];
  writeFileSync(join(env.home, "config.json"), JSON.stringify({ dashboard: false }));
});
async function client(token = loadOrCreateToken(env.home)) {
  const c = await BridgeClient.connect(env.pipe, nullLogger);
  try { await c.request("auth", { protocol: PROTOCOL_VERSION, token }); return c; }
  catch (error) { c.close(); throw error; }
}
async function remember() {
  const c = await client();
  try {
    const ping = await c.request("ping", {}), identity = await readProcessIdentity(ping.brokerPid);
    expect(identity).toBeTruthy(); owned.set(ping.brokerPid, identity!); return ping.brokerPid;
  } finally { c.close(); }
}
async function stopOwned(pid: number) {
  const identity = owned.get(pid)!;
  if (await fixtureProcessGeneration(pid, identity, "fixture broker identity changed")) process.kill(pid, "SIGTERM");
  await until(() => !fixtureProcessExists(pid, "fixture broker visibility unknown"), 5_000);
  owned.delete(pid);
}
afterEach(async () => {
  try {
    // Fixture-only fixed categories. No raw stderr, commands, peer names, paths,
    // authentication material or request/accepted content enters this evidence.
    if (startupEvidence.length) process.stderr.write("AB325 fixture startup evidence " + JSON.stringify(startupEvidence) + "\n");
    for (const close of dashboards) await close();
    await Promise.all(nodes.map(node => node.stop()));
    for (const child of children) { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; } }
    for (const pid of owned.keys()) await stopOwned(pid);
    await env.cleanup();
  } finally { restoreClientCountObservation(); }
  publishClientCountObservation(); // Only after the original owned teardown succeeds.
});
// Only the unknown-UI case opts in. All times share one fixture-relative clock;
// they are markers, not additive stage durations. Never retain request/error data.
type UiUnknownStage = "http" | "start" | "launch";
type UiUnknownError = "none" | "TimeoutError" | "AbortError" | "TypeError" | "Error" | "other";
function uiUnknownDiagnostics() {
  const started = performance.now(), limit = 32, countLimit = 255;
  type Context = { request: number; start: number; node: number };
  const events: Array<Context & { stage: UiUnknownStage | "constructor_logger"; boundary: "entry" | "return" | "fulfilled" | "rejected" | "threw";
    atMs: number; errorClass: UiUnknownError }> = [];
  const discovery: Array<Context & { code: string; firstMs: number; lastMs: number; count: number }> = [];
  let request = 0, start = 0, node = 0, launches = 0, constructors = 0, overflow = false, incomplete = false, active = true;
  let caseBodyOutcome: "incomplete" | "fulfilled" | "rejected" = "incomplete", caseErrorClass: UiUnknownError = "none";
  let counts: { constructorLogger: number; start: number; node: number; launch: number; listen: number } | undefined;
  const guard = (record: () => void): void => {
    if (!active) return;
    try { record(); } catch { incomplete = true; } // Diagnostic work only; never wraps a fixture action.
  };
  const bounded = (value: number, max = countLimit) => {
    if (!Number.isSafeInteger(value) || value < 0) { incomplete = true; return 0; }
    if (value > max) overflow = true;
    return Math.min(value, max);
  };
  const now = () => bounded(Math.max(0, Math.round(performance.now() - started)), 120_000);
  const context = (): Context => ({ request, start, node });
  const classify = (error: unknown): UiUnknownError => {
    const name = error instanceof Error || error instanceof DOMException ? error.name : "";
    return name === "TimeoutError" || name === "AbortError" || name === "TypeError" || name === "Error" ? name : "other";
  };
  const record = (captured: Context, stage: typeof events[number]["stage"], boundary: typeof events[number]["boundary"], error?: unknown) => guard(() => {
    if (events.length >= limit) { overflow = true; return; }
    const errorClass = boundary !== "rejected" && boundary !== "threw" ? "none" : classify(error);
    events.push({ ...captured, stage, boundary, atMs: now(), errorClass });
  });
  return {
    observe<T>(stage: UiUnknownStage, action: () => Promise<T>): Promise<T> {
      guard(() => {
        if (stage === "http") request = bounded(request + 1, 3); // 1=initial GET, 2=send1, 3=send2.
        if (stage === "launch") launches = bounded(launches + 1);
      });
      const captured = context(); record(captured, stage, "entry");
      let originalPromise: Promise<T>;
      try { originalPromise = action(); }
      catch (error) { record(captured, stage, "threw", error); throw error; }
      record(captured, stage, "return");
      // Both handlers are guarded and return void: the observer promise cannot
      // reject. The caller receives the EXACT original promise and native error.
      guard(() => {
        void originalPromise.then(() => record(captured, stage, "fulfilled"), error => record(captured, stage, "rejected", error));
      });
      return originalPromise;
    },
    start(starts: BridgeNode[], current: BridgeNode) {
      guard(() => { start = bounded(start + 1); node = bounded(starts.indexOf(current) + 1); });
    },
    constructorLogger() {
      guard(() => { constructors = bounded(constructors + 1); });
      // node.ts calls child("node") BEFORE recordStorePresence/read-journal.
      // This is inside the constructor, not its exact call entry. The next start
      // entry proves it returned; no constructor/module/global mock is installed.
      record(context(), "constructor_logger", "entry");
    },
    discovery(code: unknown) {
      guard(() => {
        if (typeof code !== "string" || !["ENOENT", "ECONNREFUSED", "ETIMEDOUT", "EUNSAFESOCKETDIR"].includes(code)) return;
        const previous = discovery.find(value => value.request === request && value.start === start && value.node === node && value.code === code);
        const atMs = now();
        if (previous) { previous.lastMs = atMs; previous.count = bounded(previous.count + 1); }
        else if (discovery.length < limit) discovery.push({ ...context(), code, firstMs: atMs, lastMs: atMs, count: 1 });
        else overflow = true;
      });
    },
    outcome(settlement: "fulfilled" | "rejected", error?: unknown) {
      guard(() => { caseBodyOutcome = settlement; caseErrorClass = settlement === "rejected" ? classify(error) : "none"; });
    },
    captureCounts(starts: BridgeNode[], listens: () => number) {
      guard(() => { counts = { constructorLogger: constructors, start: bounded(starts.length), node: bounded(new Set(starts).size), launch: launches, listen: bounded(listens()) }; });
    },
    publish() {
      guard(() => {
        process.stderr.write("AB453 UI unknown evidence " + JSON.stringify({ schema: 1, fixture: "ui_unknown_retained", clock: "fixture_relative_ms",
          constructorBoundary: "logger_child_before_metadata_to_start_entry", events, discovery,
          counts, caseBodyOutcome, caseErrorClass, incomplete, overflow }) + "\n");
      });
      active = false; // No late original settlement can emit or attach further diagnostics.
    },
  };
}
type UiUnknownDiagnostics = ReturnType<typeof uiUnknownDiagnostics>;
function fixtureStartupLogger(diagnostics?: UiUnknownDiagnostics): typeof nullLogger {
  const evidence: typeof startupEvidence[number] = []; startupEvidence.push(evidence);
  const started = performance.now();
  const record = (phase: string, code?: string | number, stage?: string) => {
    const previous = evidence.find(event => event.phase === phase && event.code === code && event.stage === stage);
    if (previous) { previous.count++; previous.elapsedMs = Math.round(performance.now() - started); }
    else if (evidence.length < 31) evidence.push({ phase, ...(code === undefined ? {} : { code }), ...(stage ? { stage } : {}), elapsedMs: Math.round(performance.now() - started), count: 1 });
    else {
      const capped = evidence.find(event => event.phase === "diagnostic_overflow");
      if (capped) capped.count++; else evidence.push({ phase: "diagnostic_overflow", elapsedMs: Math.round(performance.now() - started), count: 1 });
    }
  };
  const fixtureLog: typeof nullLogger = { ...nullLogger, child: scope => { if (scope === "node") diagnostics?.constructorLogger(); return fixtureLog; },
    error: (message, data) => {
      if (message === "broker refused this peer" || message === "could not join the bridge") {
        const failure = deliveryFailure({ code: data?.code, message: data?.message ?? data?.err });
        record("admission_refused", failure.code, failure.protocol?.source ?? failure.reason);
      }
    },
    debug: (message, data) => { if (message === "connect attempt failed" && ["ENOENT", "ECONNREFUSED", "ETIMEDOUT", "EUNSAFESOCKETDIR"].includes(String(data?.code))) {
      record("discovery", String(data!.code)); diagnostics?.discovery(data?.code);
    } },
    info: (message, data) => {
      if (message === "connected to broker") record("authenticated_ready");
      else if (message === "client protocol refusal observation") {
        const protocol = deliveryFailure({ code: "protocol_mismatch", details: { protocolObservation: data?.protocolObservation } }).protocol;
        if (protocol?.connectionGeneration !== undefined) record("protocol_connection", protocol.connectionGeneration, protocol.operation);
        if (protocol?.clientProtocol !== undefined) record("client_protocol", protocol.clientProtocol);
        if (protocol?.brokerProtocol !== undefined) record("broker_protocol", protocol.brokerProtocol);
      }
      else if (message === "daemon creation observation; authenticated readiness still required" && ["created", "unknown", "unavailable"].includes(String(data?.kind))) {
        record("creation_" + String(data!.kind), Number.isSafeInteger(data?.errorCode) ? Number(data!.errorCode) : undefined,
          ["read", "startup", "create"].includes(String(data?.stage)) ? String(data!.stage) : undefined);
      }
    } };
  return fixtureLog;
}
function node(name: string, launch?: NonNullable<ConstructorParameters<typeof BridgeNode>[0]["daemon"]>["launch"]) {
  const n = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name, agent: "codex", cwd: env.home, autoWake: false, log: fixtureStartupLogger(),
    daemon: { cli, launch } });
  void n.setSessionId(randomUUID());
  nodes.push(n); return n;
}
async function port() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return value;
}
async function dashboard(options: Pick<UiOptions, "brokerDaemon" | "embeddedCompatibility"> = {}, diagnostics?: UiUnknownDiagnostics) {
  const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: fixtureStartupLogger(diagnostics), ...options }); dashboards.push(ui.close);
  const visitRequest = () => fetch(ui.url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const visit = await (diagnostics ? diagnostics.observe("http", visitRequest) : visitRequest());
  const cookie = visit.headers.get("set-cookie")!.split(";")[0]!;
  return dashboardSender(ui.url, cookie, diagnostics);
}
function dashboardSender(url: string, cookie: string, diagnostics?: UiUnknownDiagnostics) {
  const origin = new URL(url).origin;
  return (body: string, extra: Record<string, unknown> = {}) => {
    const sendRequest = () => fetch(origin + "/api/send", { method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { cookie, "x-agent-bridge": "1", "content-type": "application/json" }, body: JSON.stringify({ to: "ui-retained", body, ...extra }) });
    return diagnostics ? diagnostics.observe("http", sendRequest) : sendRequest();
  };
}
function observeUiSender(diagnostics?: UiUnknownDiagnostics) {
  const starts: BridgeNode[] = [], metadataAtStart: boolean[] = [];
  const original = BridgeNode.prototype.start;
  const start = vi.spyOn(BridgeNode.prototype, "start").mockImplementation(function (this: BridgeNode) {
    // The existing constructor records metadata/read state before election.
    // Presence here is evidence about that path, not an elected broker.
    starts.push(this); metadataAtStart.push(existsSync(env.db));
    diagnostics?.start(starts, this);
    return diagnostics ? diagnostics.observe("start", () => original.call(this)) : original.call(this);
  });
  // Pass through every attempted listen, including attempts that reject.
  const listen = vi.spyOn(Broker.prototype, "listen");
  return { starts, metadataAtStart, listen, close: () => { start.mockRestore(); listen.mockRestore(); } };
}
// Parser-only fixtures use synthetic lines below. This helper provides no
// ownership authority; the actual reader brackets it with creation checks.
function parseCliCreationEvidence(text: string, ownedPid: number) {
  const events: Array<{ kind: string; stage?: string; code?: number; count: number }> = [];
  const transport: Array<ClientConnectionClosedDiagnostic & { count: number; overflow: boolean }> = [];
  let transportOverflow = false;
    for (const line of text.split("\n")) {
      const closed = line.match(/^\d{4}-\d\d-\d\dT[^ ]+ INFO +\[cli:node(?::client)?\] pid=(\d+) client connection closure observation (\{.*\})$/);
      if (closed && Number(closed[1]) === ownedPid) {
        let data: Record<string, unknown>;
        try { data = JSON.parse(closed[2]!); } catch { continue; }
        if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 7 ||
          !Object.keys(data).every(key => ["phase", "operation", "frame_encoded", "write_call_boundary", "write_returned", "count", "overflow"].includes(key)) ||
          typeof data.phase !== "string" || !["prewrite_closed", "pending_close"].includes(data.phase) ||
          typeof data.operation !== "string" || !["tracked_send", "legacy_send", "auth_hello", "ack", "status_read", "other"].includes(data.operation) ||
          typeof data.frame_encoded !== "boolean" || typeof data.write_returned !== "boolean" || typeof data.overflow !== "boolean" ||
          typeof data.write_call_boundary !== "string" || !["not_reached", "reached"].includes(data.write_call_boundary) ||
          !Number.isSafeInteger(data.count) || Number(data.count) < 1 || Number(data.count) > CLIENT_TRANSPORT_DIAGNOSTIC_COUNT_LIMIT) continue;
        if ((data.write_returned && (!data.frame_encoded || data.write_call_boundary !== "reached")) ||
          (data.frame_encoded !== (data.write_call_boundary === "reached")) ||
          (data.phase === "prewrite_closed" && (data.frame_encoded || data.write_returned || data.write_call_boundary !== "not_reached"))) continue;
        const record = data as unknown as ClientConnectionClosedDiagnostic & { count: number; overflow: boolean };
        const existing = transport.find(value => value.phase === record.phase && value.operation === record.operation &&
          value.frame_encoded === record.frame_encoded && value.write_call_boundary === record.write_call_boundary && value.write_returned === record.write_returned);
        if (existing) { existing.count = Math.max(existing.count, record.count); existing.overflow ||= record.overflow; }
        else if (transport.length < CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT) transport.push({ ...record });
        else transportOverflow = true;
        transportOverflow ||= record.overflow;
        continue;
      }
      const match = line.match(/^\d{4}-\d\d-\d\dT[^ ]+ INFO +\[cli:node\] pid=(\d+) daemon creation observation; authenticated readiness still required (\{.*\})$/);
      if (!match || Number(match[1]) !== ownedPid) continue;
      let data: Record<string, unknown>;
      try { data = JSON.parse(match[2]!); } catch { continue; }
      if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.kind !== "string" ||
        !["created", "unknown", "unavailable"].includes(data.kind) ||
        (data.stage !== undefined && (typeof data.stage !== "string" || !["read", "startup", "create"].includes(data.stage)))) continue;
      const kind = data.kind, stage = data.stage as string | undefined;
      const code = Number.isSafeInteger(data.errorCode) ? Number(data.errorCode) : undefined;
      const existing = events.find(event => event.kind === kind && event.stage === stage && event.code === code);
      if (existing) existing.count = Math.min(existing.count + 1, CLIENT_TRANSPORT_DIAGNOSTIC_COUNT_LIMIT);
      else if (events.length < CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT) events.push({ kind, ...(stage ? { stage } : {}), ...(code === undefined ? {} : { code }), count: 1 });
    }
    return { events, transport, transportSource: transport.length ? "observed" as const : "unavailable" as const, transportOverflow };
}
async function cliCreationEvidence(child: ChildProcess, identity: string | null) {
  const unavailable = () => ({ verifiedOwner: false, events: [], transport: [], transportSource: "unavailable" as const, transportOverflow: false });
  if (!child.pid || !identity || await readProcessIdentity(child.pid) !== identity) return unavailable();
  // Only this test's exact isolated home; no logs are exported or printed.
  const file = join(env.home, "logs", "agent-bridge.log");
  try {
    for (const path of [env.home, join(env.home, "logs"), file]) if (lstatSync(path).isSymbolicLink()) return unavailable();
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return unavailable();
    const bytes = readFileSync(file);
    if (bytes.length > 1024 * 1024) return unavailable();
    const evidence = parseCliCreationEvidence(bytes.toString("utf8"), child.pid);
    if (await readProcessIdentity(child.pid) !== identity) return unavailable();
    return { verifiedOwner: true, ...evidence };
  } catch { return unavailable(); }
}
async function httpFailureCategory(response: Response): Promise<string> {
  return (await httpFailureEvidence(response)).category;
}
function copyFixtureRuntime(source: string, target: string): void {
  // Node's native cpSync has Windows Unicode regressions (nodejs/node#59636).
  // Set up the fixture with ordinary file APIs, then prove every copied byte.
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) copyFixtureRuntime(from, to);
    else {
      expect(entry.isFile(), "fixture runtime must contain regular files only").toBe(true);
      copyFileSync(from, to);
      expect(readFileSync(to).equals(readFileSync(from)), "fixture runtime bytes must match hosted bundle").toBe(true);
    }
  }
}

describe("SIMULATED fixed log parser inputs (no process ownership authority)", () => {
  const pid = 1234;
  const transportLine = (data: unknown, sourcePid = pid) => `2026-10-14T00:00:00.000Z INFO  [cli:node:client] pid=${sourcePid} client connection closure observation ${JSON.stringify(data)}`;
  const creationLine = (data: unknown) => `2026-10-14T00:00:00.000Z INFO  [cli:node] pid=${pid} daemon creation observation; authenticated readiness still required ${JSON.stringify(data)}`;
  const prewrite = { phase: "prewrite_closed", operation: "tracked_send", frame_encoded: false, write_call_boundary: "not_reached", write_returned: false, count: 1, overflow: false };
  it("rejects coerced enum/boolean fields and impossible phase/write combinations without exporting evidence", () => {
    const malformed: unknown[] = [null, [], 1];
    for (const field of ["phase", "operation", "write_call_boundary"] as const) {
      for (const value of [[prewrite[field]], { value: prewrite[field] }, 1, null]) malformed.push({ ...prewrite, [field]: value });
    }
    for (const field of ["frame_encoded", "write_returned", "overflow"] as const) {
      for (const value of [[], {}, "false", 0, null]) malformed.push({ ...prewrite, [field]: value });
    }
    malformed.push(
      { ...prewrite, phase: ["prewrite_closed"], frame_encoded: true, write_call_boundary: "reached", write_returned: true },
      { ...prewrite, frame_encoded: true, write_call_boundary: "reached", write_returned: true },
      { ...prewrite, phase: "pending_close", frame_encoded: true },
      { ...prewrite, phase: "pending_close", write_call_boundary: "reached" },
      { ...prewrite, phase: "pending_close", write_returned: true },
      { ...prewrite, count: "1" }, { ...prewrite, count: 0 }, { ...prewrite, extra: "unsupported" },
    );
    for (const data of malformed) expect(parseCliCreationEvidence(transportLine(data), pid)).toMatchObject({ transport: [], transportSource: "unavailable" });
    expect(parseCliCreationEvidence(transportLine(prewrite), pid).transport).toEqual([prewrite]);
    const pending = { ...prewrite, phase: "pending_close", frame_encoded: true, write_call_boundary: "reached", write_returned: true };
    expect(parseCliCreationEvidence(transportLine(pending), pid).transport).toEqual([pending]);
  });
  it("rejects coerced creation kind/stage while preserving valid optional stages", () => {
    for (const data of [null, [], { kind: ["created"] }, { kind: { value: "created" } }, { kind: 1 }, { kind: null },
      ...[["create"], { value: "create" }, 1, null].map(stage => ({ kind: "created", stage }))]) {
      expect(parseCliCreationEvidence(creationLine(data), pid).events).toEqual([]);
    }
    expect(parseCliCreationEvidence([creationLine({ kind: "created" }), creationLine({ kind: "created", stage: "create" })].join("\n"), pid).events)
      .toEqual([{ kind: "created", count: 1 }, { kind: "created", stage: "create", count: 1 }]);
  });
  it("caps distinct reader records at sixteen, aggregates bounded counts and ignores another source PID", () => {
    const lines: string[] = [];
    for (const operation of ["tracked_send", "legacy_send", "auth_hello", "ack", "status_read", "other"]) {
      for (const disposition of [
        { frame_encoded: false, write_call_boundary: "not_reached", write_returned: false },
        { frame_encoded: true, write_call_boundary: "reached", write_returned: false },
        { frame_encoded: true, write_call_boundary: "reached", write_returned: true },
      ]) lines.push(transportLine({ ...prewrite, phase: "pending_close", operation, ...disposition }));
    }
    const first = { ...prewrite, phase: "pending_close" };
    lines.push(transportLine({ ...first, count: CLIENT_TRANSPORT_DIAGNOSTIC_COUNT_LIMIT, overflow: true }));
    lines.push(transportLine({ ...first, count: CLIENT_TRANSPORT_DIAGNOSTIC_COUNT_LIMIT + 1 }));
    lines.push(transportLine(prewrite, pid + 1));
    const evidence = parseCliCreationEvidence(lines.join("\n"), pid);
    expect(evidence.transport).toHaveLength(CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT);
    expect(evidence.transport[0]).toEqual({ ...first, count: CLIENT_TRANSPORT_DIAGNOSTIC_COUNT_LIMIT, overflow: true });
    expect(evidence.transportOverflow).toBe(true);
    expect(evidence.transportSource).toBe("observed");
    expect(evidence.transport.some(record => record.phase === "prewrite_closed")).toBe(false);
  });
});

describe("standalone demand-start broker", () => {
  it.each([false, true])("actual CLI ui authorized sends use a daemon before/after crash (mobile-configured=%s)", async mobile => {
    const recipient = node("ui-retained"); await recipient.setSessionId(randomUUID()); retainFixtureNode(env.home, recipient, "codex");
    const selected = await port();
    if (mobile) writeFileSync(join(env.home, "config.json"), JSON.stringify({ dashboard: false, mobile: { enabled: true } }));
    const child = spawn(process.execPath, [cli, "ui", "--no-open", `--port=${selected}`], { cwd: env.home, windowsHide: true, stdio: "ignore",
      env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_PIPE: env.pipe, AGENT_BRIDGE_HISTORY_INGEST: "0", AGENT_BRIDGE_DAEMON: "1" } }); children.push(child);
    let info: ReturnType<typeof readDashboardInfo> = null;
    await until(() => !!(info = readDashboardInfo(env.home)), 10_000);
    const childIdentity = mobile ? null : await readProcessIdentity(child.pid!);
    const visit = await fetch(info!.url, { redirect: "manual", signal: AbortSignal.timeout(10_000) }), cookie = visit.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(new URL("/api/send", info!.url), { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "x-agent-bridge": "1", "content-type": "application/json" }, body: '{"to":"ui-retained","body":"unauthorized"}' })).status).toBe(403);
    const send = dashboardSender(info!.url, cookie);
    const replies = await Promise.all(Array.from({ length: 5 }, (_, index) => send(`before-crash-${index}`)));
    expect(replies.map(reply => reply.status)).toEqual([200, 200, 200, 200, 200]);
    const accepted = await replies[0]!.json() as { id: string }, first = await remember(); expect(first).not.toBe(child.pid);
    const status = await client(); try { expect(await status.request("coreStatus", {})).toMatchObject({ mode: "daemon", pid: first }); } finally { status.close(); }
    await stopOwned(first);
    // A configured mobile desktop was owned by the daemon; re-open the SAME
    // configured CLI path. The nonmobile desktop remains in the original CLI.
    if (mobile) {
      const next = spawn(process.execPath, [cli, "ui", "--no-open", `--port=${selected}`], { cwd: env.home, windowsHide: true, stdio: "ignore",
        env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_PIPE: env.pipe, AGENT_BRIDGE_HISTORY_INGEST: "0", AGENT_BRIDGE_DAEMON: "1" } }); children.push(next);
      await until(() => { const current = readDashboardInfo(env.home); return !!current && current.pid !== first; }, 10_000);
      info = readDashboardInfo(env.home);
    }
    const after = await dashboardSender(info!.url, cookie)("after-crash");
    if (!mobile) process.stderr.write("AB325 CLI UI fixture evidence " + JSON.stringify({
      ...await cliCreationEvidence(child, childIdentity), afterError: await httpFailureCategory(after),
    }) + "\n");
    expect(after.status).toBe(200);
    const nextPid = await remember(); expect(nextPid).not.toBe(first); expect(nextPid).not.toBe(child.pid);
    await recipient.start();
    await until(() => recipient.unread().some(message => message.id === accepted.id));
    expect(recipient.unread().find(message => message.id === accepted.id)!.body).toBe("before-crash-0");
  });
  it("default UI sender hosts an embedded broker and HTTP data cannot opt into the daemon", async () => {
    const observed = observeUiSender();
    try {
      const send = await dashboard();
      const response = await send("embedded-by-default", { brokerDaemon: { cli }, daemon: { enabled: true } });
      if (response.status !== 200) process.stderr.write("Embedded UI admission diagnostics " + JSON.stringify({
        ...await httpFailureEvidence(response), stages: startupEvidence, startCount: observed.starts.length,
        embedded: observed.starts.map(node => node.isBroker), listenCount: observed.listen.mock.calls.length,
      }) + "\n");
      expect(response.status).toBe(200);
      expect(observed.starts).toHaveLength(1); expect(observed.starts[0]!.isBroker).toBe(true);
      expect(observed.listen).toHaveBeenCalledOnce();
      process.stderr.write("AB325 UI pre-election metadata evidence " + JSON.stringify(observed.metadataAtStart) + "\n");
      const status = await client();
      try { expect(await status.request("coreStatus", {})).toMatchObject({ mode: "embedded", pid: process.pid }); }
      finally { status.close(); }
    } finally { observed.close(); }
  });
  it("UI unknown creation remains in one retained node across authorized sends", async () => {
    const diagnostics = uiUnknownDiagnostics(), observed = observeUiSender(diagnostics);
    try {
      const launch = vi.fn(() => diagnostics.observe("launch", async () => ({ kind: "unknown" as const }))), send = await dashboard({ brokerDaemon: { cli, launch } }, diagnostics);
      expect((await send("unconfirmed-1")).status).toBe(500);
      expect((await send("unconfirmed-2")).status).toBe(500);
      expect(launch).toHaveBeenCalledOnce(); expect(observed.starts).toHaveLength(2);
      expect(observed.starts[1]).toBe(observed.starts[0]); expect(observed.starts[0]!.isBroker).toBe(false);
      expect(observed.listen).not.toHaveBeenCalled();
      process.stderr.write("AB325 UI pre-election metadata evidence " + JSON.stringify(observed.metadataAtStart) + "\n");
      await expect(client()).rejects.toMatchObject({ code: "ENOENT" });
      diagnostics.outcome("fulfilled");
    } catch (error) {
      diagnostics.outcome("rejected", error); throw error;
    } finally {
      diagnostics.captureCounts(observed.starts, () => observed.listen.mock.calls.length);
      // The original restore still runs first. Diagnostic failure cannot replace
      // an assertion, fetch rejection, original start error or restore failure.
      try { observed.close(); } finally { diagnostics.publish(); }
    }
  });
  it("UI definitive unavailable creation preserves explicit degraded compatibility only", async () => {
    const launch = vi.fn(async () => ({ kind: "unavailable" as const, reason: "windows_wmi_unavailable" as const }));
    const send = await dashboard({ brokerDaemon: { cli, launch } });
    expect((await send("degraded-ui")).status).toBe(200); expect(launch).toHaveBeenCalledOnce();
    const status = await client();
    try { expect(await status.request("coreStatus", {})).toMatchObject({ mode: "embedded_degraded", pid: process.pid, reason: "windows_wmi_unavailable" }); }
    finally { status.close(); }
  });
  it("UI authentication rejection never creates or degrades a competing broker", async () => {
    const host = env.node("existing-authority"); await host.start();
    const token = join(env.home, "token"), saved = join(env.home, "fixture-original-token"); renameSync(token, saved);
    writeFileSync(token, "wrong-fixture-token");
    const launch = vi.fn(async () => ({ kind: "unavailable" as const, reason: "windows_wmi_unavailable" as const }));
    try {
      const send = await dashboard({ brokerDaemon: { cli, launch } });
      expect((await send("rejected-ui")).status).toBe(500); expect(launch).not.toHaveBeenCalled(); expect(host.isBroker).toBe(true);
    } finally { writeFileSync(token, readFileSync(saved)); }
  });
  it("core status inspects an absent or serving daemon without demand start or peer registration", async () => {
    const inspect = () => JSON.parse(execFileSync(process.execPath, [cli, "core", "status"], { encoding: "utf8", windowsHide: true,
      env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_PIPE: env.pipe, AGENT_BRIDGE_DAEMON: "1" } }));
    expect(inspect()).toEqual({ available: false });
    expect(existsSync(join(env.home, "token"))).toBe(false);
    expect(existsSync(join(env.home, "logs"))).toBe(false);
    const a = node("status-main"); await a.start(); const pid = await remember();
    expect(inspect()).toMatchObject({ mode: "daemon", pid, version: APP_VERSION, runningJobsEvidence: "legacy_registry_labels_not_execution" });
    expect((await a.peers()).map(peer => peer.name)).toEqual(["status-main"]);
    const token = join(env.home, "token"), retainedToken = join(env.home, "fixture-retained-token");
    renameSync(token, retainedToken);
    try {
      expect(inspect).toThrow("Core status authentication material is unavailable");
      expect(existsSync(token)).toBe(false);
      expect((await a.health()).brokerPid).toBe(pid);
    } finally { renameSync(retainedToken, token); }
  });
  it("ten concurrent starts share one broker, keep accepted mail and reject wrong credentials", async () => {
    const later = node("offline-retained"); await later.setSessionId(randomUUID()); retainFixtureNode(env.home, later, "codex");
    observeConcurrentClientCount();
    const peers = Array.from({ length: 10 }, (_, i) => node(`daemon-${i}`));
    await Promise.all(peers.map(peer => peer.start()));
    // Inspect through an existing authenticated peer: a throwaway connection's
    // asynchronous close can still be counted by the next exact status sample.
    const pid = (await peers[0]!.health()).brokerPid;
    const identity = await readProcessIdentity(pid);
    expect(identity).toBeTruthy(); owned.set(pid, identity!); expect(pid).not.toBe(process.pid);
    const statusClient = await client();
    try {
      // Every node that saw ENOENT spawned its own demand-start process; each loser that
      // finds the winner authenticates once and exits (src/cli/broker-daemon.ts). That
      // probe is briefly authenticated, so only a count ABOVE our ten peers plus this
      // client may settle. A missing client is never awaited, and exactly 11 must be seen.
      let status = await statusClient.request("coreStatus", {});
      for (const end = performance.now() + 5_000; status.connectedClients > 11 && performance.now() < end;) {
        await delay(20); status = await statusClient.request("coreStatus", {});
      }
      expect(status).toMatchObject({ mode: "daemon", pid, version: APP_VERSION, connectedClients: 11, runningJobsEvidence: "legacy_registry_labels_not_execution" });
    } finally { statusClient.close(); }
    expect(peers.every(peer => !peer.isBroker)).toBe(true);
    expect(await peers[0]!.peers()).toHaveLength(10);
    const ids = await Promise.all(peers.map(peer => peer.health().then(health => health.brokerPid)));
    expect(new Set(ids)).toEqual(new Set([pid]));
    const accepted = await peers[0]!.send({ to: "offline-retained", body: "accepted fixture bytes" });
    expect(accepted.messages[0]!.body).toBe("accepted fixture bytes");
    await expect(client("wrong-fixture-token")).rejects.toMatchObject({ code: "unauthorized" });
    for (const peer of peers) await peer.stop();
    await later.start();
    await until(() => later.unread().some(message => message.id === accepted.messages[0]!.id));
    expect((await later.health()).brokerPid).toBe(pid);
    expect(later.unread()[0]!.body).toBe("accepted fixture bytes");
    expect(existsSync(join(env.home, "state-core.db"))).toBe(false);
  });
  it("verified broker crash re-elects without losing accepted offline mail", async () => {
    const recipient = node("after-crash"); await recipient.setSessionId(randomUUID()); retainFixtureNode(env.home, recipient, "codex");
    const a = node("crash-client"); await a.start(); const first = await remember();
    const accepted = await a.send({ to: "after-crash", body: "retained across process loss" });
    expect(await fixtureProcessGeneration(first, owned.get(first)!, "wrong crash fixture")).toBe(true);
    const disconnected = once(a, "disconnected");
    process.kill(first, "SIGKILL");
    await disconnected;
    await until(() => !fixtureProcessExists(first, "crash visibility unknown")); owned.delete(first);
    await until(() => a.isConnected, 8_000); const next = await remember(); expect(next).not.toBe(first);
    await recipient.start();
    await until(() => recipient.unread().some(message => message.id === accepted.messages[0]!.id));
    expect(recipient.unread()[0]!.body).toBe("retained across process loss");
  });
  it("preserves disabled dashboard startup, forced opening and atomic conflicting-port refusal", async () => {
    const a = node("dashboard-client"); await a.start(); await remember();
    expect(await a.ensureDashboard(false)).toBeNull();
    expect(existsSync(join(env.home, "dashboard.json"))).toBe(false);
    const selected = await port();
    const infos = await Promise.all(Array.from({ length: 5 }, () => a.ensureDashboard(true, selected)));
    expect(new Set(infos.map(info => info!.port))).toEqual(new Set([selected]));
    expect(new Set(infos.map(info => info!.pid)).size).toBe(1);
    await expect(a.ensureDashboard(true, await port())).rejects.toMatchObject({ code: "bad_request" });
    expect((await a.ensureDashboard(true, selected))!.port).toBe(selected);
    const c = await client();
    try { await expect(c.request("ensureDashboard", { force: "yes" as unknown as boolean, port: selected })).rejects.toMatchObject({ code: "bad_request" }); }
    finally { c.close(); }
  });
  it("only definitive unavailable creation allows honest degraded legacy hosting", async () => {
    const launch = vi.fn(async () => ({ kind: "unavailable" as const, reason: "windows_wmi_unavailable" as const }));
    const a = node("degraded", launch); await a.start();
    expect(a.isBroker).toBe(true); expect(a.hostingEvidence()).toEqual({ hostingMode: "embedded_degraded", reason: "windows_wmi_unavailable" });
    expect(launch).toHaveBeenCalledOnce();
    const c = await client();
    try { expect(await c.request("coreStatus", {})).toMatchObject({ mode: "embedded_degraded", reason: "windows_wmi_unavailable" }); }
    finally { c.close(); }
    const b = node("later", launch); await b.start();
    expect(launch).toHaveBeenCalledOnce(); expect(b.isBroker).toBe(false);
    await b.send({ to: a.name, body: "legacy behavior preserved" }); await until(() => a.unread().length === 1);
  });
  it("ambiguous creation stays latched until an authenticated registration settles it, without embedded fallback", async () => {
    const launch = vi.fn(async () => ({ kind: "unknown" as const })), a = node("unconfirmed", launch);
    await expect(a.start()).rejects.toThrow("could not connect");
    await expect(a.ensureConnected()).rejects.toThrow("could not connect");
    expect(launch).toHaveBeenCalledOnce(); expect(a.isBroker).toBe(false);
    expect(existsSync(join(env.home, "state-core.db"))).toBe(false);
    const host = env.node("real-host"); await host.start(); await a.ensureConnected();
    expect(a.isBroker).toBe(false); expect(launch).toHaveBeenCalledOnce();
    // The registration settled the attempt: losing that broker permits demand start again.
    await host.stop();
    await until(() => launch.mock.calls.length === 2, 10_000);
    expect(a.isBroker).toBe(false);
  });
  it("late definite failures un-latch an unknown attempt only after a doubling backoff", async () => {
    // Only the clock is fake: elections, sockets and timers run for real.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_000_000);
    try {
      const reports: LateDaemonLaunch[] = [];
      const daemonHost = env.node("late-host");
      const launch = vi.fn<NonNullable<NonNullable<ConstructorParameters<typeof BridgeNode>[0]["daemon"]>["launch"]>>()
        .mockImplementationOnce(async (_options, report) => { reports.push(report!); return { kind: "unknown" }; })
        .mockImplementationOnce(async (_options, report) => { reports.push(report!); return { kind: "unknown" }; })
        .mockImplementationOnce(async () => { await daemonHost.start(); return { kind: "created" }; });
      const a = node("late-failure", launch);
      await expect(a.start()).rejects.toThrow("could not connect");
      expect(launch).toHaveBeenCalledOnce();
      const first = Date.now();
      reports[0]!({ kind: "unavailable", reason: "windows_wmi_create_rejected" });
      vi.setSystemTime(first + 4_999);
      await expect(a.ensureConnected()).rejects.toThrow("could not connect");
      expect(launch).toHaveBeenCalledOnce(); // Un-latched, but still inside the 5 s backoff.
      vi.setSystemTime(first + 5_000);
      await expect(a.ensureConnected()).rejects.toThrow("could not connect");
      expect(launch).toHaveBeenCalledTimes(2);
      const second = Date.now();
      reports[1]!({ kind: "unavailable", reason: "windows_wmi_create_rejected" });
      vi.setSystemTime(second + 9_999);
      await expect(a.ensureConnected()).rejects.toThrow("could not connect");
      expect(launch).toHaveBeenCalledTimes(2); // The second backoff doubled to 10 s.
      vi.setSystemTime(second + 10_000);
      await a.ensureConnected();
      expect(launch).toHaveBeenCalledTimes(3); expect(a.isBroker).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("an unknown creation that did start a daemon is relaunched after that daemon crashes", async () => {
    // The real creation runs, but its receipt is reported after the decision budget ("unknown").
    const launch = vi.fn<NonNullable<NonNullable<ConstructorParameters<typeof BridgeNode>[0]["daemon"]>["launch"]>>(async (options, late) => {
      await launchDaemon(options, late); return { kind: "unknown" };
    });
    const a = node("unknown-crash", launch); await a.start(); const first = await remember();
    expect(launch).toHaveBeenCalledOnce();
    expect(await fixtureProcessGeneration(first, owned.get(first)!, "wrong crash fixture")).toBe(true);
    const disconnected = once(a, "disconnected");
    process.kill(first, "SIGKILL");
    await disconnected;
    await until(() => !fixtureProcessExists(first, "crash visibility unknown")); owned.delete(first);
    await until(() => a.isConnected, 15_000); const next = await remember(); expect(next).not.toBe(first);
    expect(launch).toHaveBeenCalledTimes(2);
  });
  it("hands over to a newer release's client: drains, releases the endpoint, keeps accepted mail", async () => {
    const recipient = node("after-handover"); await recipient.setSessionId(randomUUID()); retainFixtureNode(env.home, recipient, "codex");
    const launch = vi.fn(launchDaemon);
    const a = node("handover-old", launch); await a.start(); const first = await remember();
    const accepted = await a.send({ to: "after-handover", body: "kept across the handover" });
    const newer = await client();
    try {
      await expect(newer.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), canHost: true, peer: { id: "fixture-newer", name: "newer-release",
        agent: "codex", cwd: env.home, pid: 424242, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false, version: "999.0.0" } }))
        .rejects.toMatchObject({ code: "protocol_mismatch", details: { handover: true } });
    } finally { newer.close(); }
    await until(() => !fixtureProcessExists(first, "handover visibility unknown"), 15_000); owned.delete(first);
    // The newer release demand-starts after the old daemon is gone. The old-release client
    // received the handover event and leaves demand start to it, but reconnects to its daemon.
    const successor = node("newer-release-host"); await successor.start(); const next = await remember();
    expect(next).not.toBe(first);
    await until(() => a.isConnected, 15_000);
    expect((await a.health()).brokerPid).toBe(next);
    expect(launch).toHaveBeenCalledOnce();
    await recipient.start();
    await until(() => recipient.unread().some(message => message.id === accepted.messages[0]!.id));
    expect(recipient.unread()[0]!.body).toBe("kept across the handover");
  });
  it("exits after its idle period once no client is connected", async () => {
    vi.stubEnv("AGENT_BRIDGE_DAEMON_IDLE_EXIT_MS", "1000");
    try {
      const a = node("idle-client"); await a.start(); const pid = await remember();
      await new Promise(resolve => setTimeout(resolve, 2_000));
      expect(fixtureProcessExists(pid, "idle visibility unknown")).toBe(true); // A connected client keeps it.
      await a.stop();
      await until(() => !fixtureProcessExists(pid, "idle visibility unknown"), 15_000); owned.delete(pid);
      await expect(client()).rejects.toMatchObject({ code: expect.stringMatching(/^(ENOENT|ECONNREFUSED)$/) });
    } finally { vi.unstubAllEnvs(); }
  });
  it("an authenticated discovery rejection never invokes creation or fallback", async () => {
    const host = env.node("existing"); await host.start();
    const launch = vi.fn(async () => ({ kind: "unavailable" as const, reason: "windows_wmi_unavailable" as const }));
    const a = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: "wrong-fixture-token", name: "rejected", agent: "codex", cwd: env.home, autoWake: false, log: nullLogger, daemon: { cli, launch } }); nodes.push(a);
    await expect(a.start()).rejects.toMatchObject({ code: "unauthorized" });
    expect(launch).not.toHaveBeenCalled(); expect(a.isBroker).toBe(false); expect(host.isBroker).toBe(true);
  });
  it("parent exit and Windows prohibiting Job Object close leave the same authenticated daemon alive", async () => {
    const runtime = join(env.home, "runtime with spaces-日本"); copyFixtureRuntime(join(import.meta.dirname, "../plugins/codex/dist"), runtime);
    const parentCli = join(runtime, "cli.mjs");
    expect(existsSync(parentCli), "copied Unicode fixture entry must exist before parent launch").toBe(true);
    const gate = String.raw`
      process.send('ready');
      process.on('message', message => {
        const cli = process.argv[1];
        process.send({event:'path_check', matches:cli === message.cli, exists:require('node:fs').existsSync(cli)});
        const child = require('node:child_process').spawn(process.execPath,[cli,'tail'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
        let stderr = '';
        child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(0,4096); });
        child.on('error', error => process.send({event:'spawn_error',code:error.code}));
        child.on('exit', code => {
          process.send({event:'loader_check', codes:stderr.match(/\b(?:ERR_[A-Z_]+|MODULE_NOT_FOUND|SyntaxError|TypeError)\b/g) ?? [], namesCli:stderr.includes(cli), replacement:stderr.includes('\uFFFD')});
          process.send({event:'child_exit',code});
        });
      });
      setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ["-e", gate, parentCli], { cwd: env.home, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_PIPE: env.pipe, AGENT_BRIDGE_DASHBOARD: "false", AGENT_BRIDGE_HISTORY_INGEST: "0", AGENT_BRIDGE_DAEMON: "1" } });
    children.push(parent);
    const fixtureEvents: string[] = [];
    parent.on("message", message => {
      const event = message as { event?: string; code?: string | number; codes?: string[]; matches?: boolean; exists?: boolean; namesCli?: boolean; replacement?: boolean };
      if (event.event === "path_check") fixtureEvents.push(`argv_matches:${event.matches},file_exists:${event.exists}`);
      else if (event.event === "loader_check") fixtureEvents.push(...(event.codes ?? []), `error_names_cli:${event.namesCli},replacement_character:${event.replacement}`);
      else if (event.event === "spawn_error" || event.event === "child_exit") fixtureEvents.push(`${event.event}:${event.code}`);
    });
    let scope: WindowsJobScope | undefined;
    try {
      await once(parent, "message");
      if (process.platform === "win32") scope = await startWindowsJobScope(nullLogger, parent.pid!);
      parent.send({ cli: parentCli });
      let pid: number | undefined;
      for (const deadline = Date.now() + 10_000; !pid && Date.now() < deadline;) {
        try { pid = await remember(); }
        catch (error) {
          if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      const observations = () => {
        try { return readFileSync(join(env.home, "logs", "agent-bridge.log"), "utf8").split("\n")
          .filter(line => line.includes("daemon creation observation"))
          .map(line => line.slice(line.indexOf("daemon creation observation"))).join("\n"); }
        catch { return "no fixture creation observation"; }
      };
      expect(pid, observations() + "; fixture codes: " + fixtureEvents.join(",")).toBeDefined();
      const a = node("observer", async () => { throw new Error("observer must not launch the tested daemon"); });
      await a.start();
      expect((await a.health()).history).toBeNull();
      if (process.platform === "win32") {
        const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const actual = execFileSync(bin, ["-NoProfile", "-NonInteractive", "-Command", `(Invoke-CimMethod -InputObject (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}') -MethodName GetOwnerSid).Sid`], { encoding: "utf8", windowsHide: true }).trim();
        const expected = execFileSync(bin, ["-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { encoding: "utf8", windowsHide: true }).trim();
        expect(actual).toBe(expected);
      }
      const closed = once(parent, "close");
      const scopeClosed = scope ? once(scope.guardian, "close") : undefined;
      if (scope) { const result = await scope.cleanup(); expect(result.stopped).not.toContain(pid); expect(result.remaining).toEqual([]); scope.detach(); parent.kill(); }
      else process.kill(-parent.pid!, "SIGKILL");
      await closed; await scopeClosed;
      expect((await a.health()).brokerPid).toBe(pid);
      await a.send({ to: "parent-exit-offline", body: "post-parent accepted" });
    } finally { scope?.detach(); }
  });
});
