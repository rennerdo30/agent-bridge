import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP_VERSION } from "../src/core/constants.js";
import * as identities from "../src/core/process-identity.js";
import * as compatibility from "../src/core/store-compatibility.js";
import { readStore } from "../src/mcp/jobs.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { codexHost } from "./helpers.js";
import type { BridgeNode } from "../src/core/node.js";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { priorEndpoints } from "../src/core/prior-endpoints.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";

let env: TestEnv, source: BridgeNode, target: BridgeNode;
const clients: Client[] = [], releases: (() => void)[] = [];
beforeEach(async () => {
  env = makeEnv(); source = env.node("claude-source"); target = env.node("codex-target", "codex");
  await source.start(); await target.start();
});
afterEach(async () => {
  vi.useRealTimers(); for (const release of releases.splice(0)) release(); vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => {}))); await env.cleanup();
});
function seed() {
  const path = join(env.home, "jobs.json"), bytes = JSON.stringify({ version: 2, futureEnvelope: { keep: "exact original" }, jobs: [{
    id: "owned", name: "claude-job-owned", agent: "claude", model: null, prompt: "complete original context", startedAt: Date.now(), status: "done",
    sessionId: "native-context", workdir: env.home, worktree: null, owner: source.name, supervisor: "original-supervisor",
    rootName: source.name, rootSession: "original-supervisor", args: { title: "Retained task" }, futureJobField: { keep: [1, 2, 3] },
  }] }); writeFileSync(path, bytes); return { path, bytes };
}
function heldReadiness() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), ready = new Promise<void>(resolve => { release = resolve; });
  releases.push(release); vi.spyOn(compatibility, "refreshStorePeerIdentities").mockImplementation(() => { entered(); return ready; });
  return { started, release };
}
async function server(name: string, released = false, home = env.home) {
  const file = released ? join(env.home, "released-server.mjs") : join(import.meta.dirname, "../plugins/codex/dist/server.mjs");
  if (released) writeFileSync(file, execFileSync("git", ["show", "v0.29.12:plugins/codex/dist/server.mjs"], {
    cwd: join(import.meta.dirname, ".."), maxBuffer: 20 * 1024 * 1024,
  }));
  const childEnv = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(childEnv)) if (key.startsWith("AGENT_BRIDGE_")) delete childEnv[key];
  Object.assign(childEnv, { AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_DELIVERY: "hooks", AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_DAEMON: "0",
    CLAUDE_PROJECT_DIR: home, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), XDG_DATA_HOME: home });
  const client = new Client({ name: `fixture-${name}`, version: "1" }); clients.push(client);
  childEnv.CODEX_HOME = codexHost(client, home, "codex", name);
  const transport = new StdioClientTransport({ command: process.execPath, args: [file, "--agent=codex"], env: childEnv, stderr: "pipe" });
  let stderr = ""; transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  try { await client.connect(transport); await client.callTool({ name: "peers", arguments: {} }); }
  catch (error) { throw new Error(`isolated ${name} failed: ${stderr}`, { cause: error }); }
  expect(transport.pid).not.toBeNull(); expect(transport.pid).toBeGreaterThan(0);
  expect(client.getServerVersion()!.version).toBe(released ? "0.29.12" : APP_VERSION);
  return { client, transport };
}

it("waits for a genuine cold current process identity, preserves original bytes, then commits backup-first", async () => {
  const actual = identities.readProcessIdentities; let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  const probe = vi.spyOn(identities, "readProcessIdentities").mockImplementation(async pids => { await ready; return actual(pids); });
  const child = await server("current-reader");
  expect(compatibility.liveStorePeers(env.home).find(peer => peer.pid === child.transport.pid)).toMatchObject({ version: "unknown", json: 0 });
  const seeded = seed(), handoff = source.handoffSubagents({ to: target.name });
  await until(() => probe.mock.calls.length > 0);
  expect(readFileSync(seeded.path, "utf8")).toBe(seeded.bytes); expect(existsSync(`${seeded.path}.lock`)).toBe(false);
  release(); expect((await handoff).jobs).toHaveLength(1);
  expect(readStore(seeded.path)[0]).toMatchObject({ owner: target.name, prompt: "complete original context", futureJobField: { keep: [1, 2, 3] } });
  const backups = readdirSync(env.home).filter(name => name.startsWith("jobs.json.backup-"));
  expect(backups).toHaveLength(1); expect(readFileSync(join(env.home, backups[0]!), "utf8")).toBe(seeded.bytes);
  expect(JSON.parse(readFileSync(seeded.path, "utf8")).futureEnvelope).toEqual({ keep: "exact original" });
});

it("refuses the genuine released JSON3 broker before effects in an explicitly isolated home", async () => {
  // Protocol2 cannot be admitted to protocol5. Never launch it against the
  // already-running current broker's data home just to manufacture coexistence.
  const home = join(env.home, "isolated-old-release"); mkdirSync(home);
  const child = await server("old-reader", true, home); await compatibility.refreshStorePeerIdentities(home);
  expect(compatibility.liveStorePeers(home).find(peer => peer.pid === child.transport.pid)).toMatchObject({ name: "old-reader", version: "0.29.12", json: 3 });
  const seeded = seed(), file = join(home, "bridge.db"), before = readFileSync(file);
  const endpoint = priorEndpoints(home).find(path => /-p2(?:\.sock)?$/.test(path))!;
  const probe = await BridgeClient.connect(endpoint, nullLogger);
  try { await expect(probe.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) })).rejects.toMatchObject({ code: "protocol_mismatch" }); }
  finally { probe.close(); }
  expect(readFileSync(file).equals(before)).toBe(true);
  expect(readFileSync(seeded.path, "utf8")).toBe(seeded.bytes);
  expect(readdirSync(env.home).filter(name => name.startsWith("jobs.json.backup-"))).toEqual([]);
  expect(compatibility.liveStorePeers(env.home).some(peer => peer.pid === child.transport.pid)).toBe(false);
});

it("keeps peers and ordinary sends responsive while a slow identity query holds no metadata lock", async () => {
  // Establish the ordinary request path before measuring interference from the
  // held identity query. Cold storage/transport initialization is fixture setup.
  const send = target.send.bind(target);
  vi.spyOn(target, "send").mockImplementationOnce(async (...args) => { await realDelay(1_100); return send(...args); });
  await target.peers();
  await target.send({ to: source.name, body: "fixture request path ready" });
  const seeded = seed(), gate = heldReadiness();
  // Observe rejection immediately: a failed latency assertion must still drain
  // this request before fixture teardown closes its broker connection.
  const handoff = source.handoffSubagents({ to: target.name }).then(value => ({ value }), error => ({ error }));
  await gate.started;
  let failure: unknown;
  try {
    expect(existsSync(`${seeded.path}.lock`)).toBe(false);
    const begin = performance.now(); expect((await target.peers()).some(peer => peer.name === source.name)).toBe(true);
    const delivered = await target.send({ to: source.name, body: "ordinary request during handoff readiness" });
    expect(performance.now() - begin).toBeLessThan(1_000); expect(delivered.deliveredTo).toContain(source.name);
    expect(readFileSync(seeded.path, "utf8")).toBe(seeded.bytes);
  } catch (error) { failure = error; }
  gate.release();
  // Bound the drain on the real clock so a stuck handoff fails clearly instead of hanging to the test timeout.
  const deadline = new AbortController();
  try {
    const settled = await Promise.race([handoff, realDelay(10_000, undefined, { signal: deadline.signal }).then(
      () => { throw new Error("handoff did not settle after release"); }, () => new Promise<never>(() => {}))]);
    expect(settled).toMatchObject({ value: { jobs: [expect.objectContaining({ to: target.name })] } });
  } catch (error) {
    if (failure === undefined) throw error;
    // Keep the first assertion failure as the reported cause; surface this one alongside it.
    console.error("handoff readiness drain also failed after an earlier assertion failure:", error);
  } finally { deadline.abort(); }
  if (failure !== undefined) throw failure;
});

it.each(["source-session", "target-session", "target-name", "target-cwd"])("refuses changed %s registration before publishing ownership", async change => {
  const seeded = seed(), gate = heldReadiness(), outcome = source.handoffSubagents({ to: target.name }).then(value => ({ value }), error => ({ error }));
  await gate.started;
  if (change === "source-session") await source.setSessionId("new-source-session");
  if (change === "target-session") await target.setSessionId("new-target-session");
  if (change === "target-name") await target.relocate(env.home, "codex-renamed");
  if (change === "target-cwd") { const other = join(env.home, "other-project"); mkdirSync(other); await target.relocate(other); }
  gate.release(); expect(await outcome).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining("Session identity or project changed") }) });
  expect(readFileSync(seeded.path, "utf8")).toBe(seeded.bytes);
  expect(readdirSync(env.home).filter(name => name.startsWith("jobs.json.backup-"))).toEqual([]);
});

it("refuses a replaced target and never transfers ownership to its new connection", async () => {
  await target.setSessionId("target-session");
  const seeded = seed(), gate = heldReadiness(), outcome = source.handoffSubagents({ to: target.name }).then(value => ({ value }), error => ({ error }));
  await gate.started;
  const replacement = env.node(target.name, "codex"); await replacement.setSessionId("target-session"); await replacement.start();
  gate.release(); expect(await outcome).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/disconnected|identity or project changed/) }) });
  expect(readFileSync(seeded.path, "utf8")).toBe(seeded.bytes);
});

it("bounds a nonresolving readiness wait and prevents a late completion from committing", async () => {
  const seeded = seed(), gate = heldReadiness(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const outcome = source.handoffSubagents({ to: target.name }).then(value => ({ value }), error => ({ error }));
  await gate.started; await vi.advanceTimersByTimeAsync(5_500);
  expect(await outcome).toMatchObject({ error: expect.objectContaining({ code: "timeout", message: expect.stringContaining("no job ownership was changed") }) });
  vi.useRealTimers(); gate.release(); await new Promise<void>(resolve => setImmediate(resolve));
  expect(readFileSync(seeded.path, "utf8")).toBe(seeded.bytes); expect(existsSync(`${seeded.path}.lock`)).toBe(false);
});
