import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { BridgeClient } from "../src/core/client.js";
import { MessageStore } from "../src/core/store.js";
import { APP_VERSION, PROTOCOL_VERSION, CONNECT_TIMEOUT_MS, ELECTION_RETRY_MAX_MS, RECONNECT_BACKOFF_MIN_MS } from "../src/core/constants.js";
import { newestBrokerSuccessor, compareBrokerVersions, BROKER_SUCCESSOR_GRACE_MS } from "../src/core/broker-upgrade.js";
import * as upgrade from "../src/core/broker-upgrade.js";
import { formatHealth } from "../src/core/health.js";
import { recordStorePeer } from "../src/core/store-compatibility.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { cmdlineIsInteractiveAgent } from "../src/core/procinfo.js";

let env: TestEnv;
const extra: BridgeNode[] = [];
const HANDOVER_RECONNECT_BUDGET_MS = BROKER_SUCCESSOR_GRACE_MS + RECONNECT_BACKOFF_MIN_MS + ELECTION_RETRY_MAX_MS + 2 * CONNECT_TIMEOUT_MS;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); for (const node of extra.splice(0)) await node.stop(); await env.cleanup(); });
const internals = (node: BridgeNode) => node as unknown as { broker: { version: string; checkUpgrade(): Promise<void>; store: MessageStore; requests: Set<Promise<void>>; handlers: Record<string, (...args: any[]) => any> }; version: string };
async function oldHost() {
  const old = env.node("old"); internals(old).version = "0.30.12";
  await old.start(); internals(old).broker.version = "0.30.12";
  return old;
}
const candidate = (id: string, version = APP_VERSION, overrides: Partial<PeerInfo> = {}): PeerInfo => ({ id, name: id, agent: "codex", cwd: env.home, pid: 1, agentPid: null, sessionId: null, startedAt: 1, autoWake: false, brokerEligible: true, version, storeCapabilities: { json: 4, sqlite: 9, jobArchive: 1 }, ...overrides });

it("selects the newest compatible interactive local host and never equal, older or unknown releases", () => {
  expect(newestBrokerSuccessor([candidate("equal", "0.30.12"), candidate("older", "0.30.11")], "0.30.12")).toBeUndefined();
  expect(newestBrokerSuccessor([candidate("new", "0.30.13"), candidate("newest", "0.30.14")], "0.30.12")?.id).toBe("newest");
  for (const version of [undefined, "unknown", "0.30.14-rc.1", "0.30.14+dev", "00.30.14"]) expect(compareBrokerVersions(version, APP_VERSION)).toBeNull();
  for (const overrides of [{ brokerEligible: false }, { brokerEligible: undefined }, { jobAgent: "codex" as const }, { subagent: true }, { agent: "other" as const }, { host: "remote" }, { storeCapabilities: undefined }]) {
    expect(newestBrokerSuccessor([candidate("excluded", "0.30.14", overrides)], "0.30.12")).toBeUndefined();
  }
});

it("requires interactive executable evidence for opencode and Antigravity", () => {
  expect(cmdlineIsInteractiveAgent('"C:\\tools\\opencode.exe" --dir E:\\project', "opencode")).toBe(true);
  expect(cmdlineIsInteractiveAgent("agy --continue", "antigravity")).toBe(true);
  for (const command of ["opencode run task", "opencode serve --port 1234", "opencode web", "opencode acp", "node fixture.js opencode", "opencode --headless"]) expect(cmdlineIsInteractiveAgent(command, "opencode")).toBe(false);
  for (const command of ["agy -p task", "agy --output-format=stream-json", "node fixture.js agy"]) expect(cmdlineIsInteractiveAgent(command, "antigravity")).toBe(false);
});

it.each(["0.30.12", "0.30.11"])("retains the broker when the connected session is %s", async version => {
  const old = await oldHost(), other = env.node("other"); internals(other).version = version;
  await other.start(); await internals(old).broker.checkUpgrade();
  expect(old.isBroker).toBe(true); expect(other.isBroker).toBe(false);
  expect((await old.health()).handoverPending).toBeNull();
});

it("never chooses a connected runner or headless host", async () => {
  const old = await oldHost();
  for (const kind of ["runner", "headless"] as const) {
    const node = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), agent: "codex", name: kind, cwd: env.home, autoWake: false, canHostBroker: false, brokerEligible: true, ...(kind === "runner" ? { jobAgent: "codex" } as const : {}), log: nullLogger });
    extra.push(node); await node.start();
  }
  await internals(old).broker.checkUpgrade(); expect(old.isBroker).toBe(true);
  expect((await old.peers()).find(p => p.name === "headless")?.brokerEligible).toBe(false);
});

it("waits for legacy election hosts rather than let them race the successor with older code", async () => {
  const old = await oldHost(), legacy = await BridgeClient.connect(env.pipe, nullLogger);
  try {
    const peer = candidate("legacy", "0.30.12", { pid: process.pid, brokerEligible: undefined });
    await legacy.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer });
    const next = env.node("next"); await next.start();
    await internals(old).broker.checkUpgrade();
    expect(old.isBroker).toBe(true); expect(next.isBroker).toBe(false);
    expect((await old.health()).handoverPending).toContain("legacy v0.30.12 lacks broker election handover support");
    await old.send({ to: next.name, body: "serving while legacy host stays" });
    legacy.close();
    await until(() => next.isBroker && old.isConnected && !old.isBroker, HANDOVER_RECONNECT_BUDGET_MS);
  } finally { legacy.close(); }
});

it("drains an admitted send, rejects new writes, retains mail and reconnects the old session", async () => {
  const old = await oldHost(), broker = internals(old).broker;
  const original = broker.handlers.trackedSend!;
  let release!: () => void, started = false;
  const held = new Promise<void>(resolve => release = resolve);
  broker.handlers.trackedSend = async (...args) => { started = true; await held; return original(...args); };
  const send = old.send({ to: "later", body: "admitted before drain" });
  await until(() => started);
  const next = env.node("next"); await next.start();
  const timeline: unknown[] = [];
  for (const [name, node] of [["old", old], ["next", next]] as const) {
    node.on("connected", value => timeline.push({ name, event: "connected", at: Date.now(), value }));
    node.on("disconnected", () => timeline.push({ name, event: "disconnected", at: Date.now() }));
  }
  const waitPhase = async (phase: string, predicate: () => boolean, budget?: number) => {
    try { await until(predicate, budget); }
    catch (error) {
      const states = [old, next].map(node => ({ name: node.name, broker: node.isBroker, connected: node.isConnected }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const health = await Promise.race([
        Promise.allSettled([old.health(), next.health()]),
        new Promise(resolve => { timer = setTimeout(() => resolve("diagnostic health probe timed out"), 1_000); }),
      ]).finally(() => clearTimeout(timer));
      throw new Error(JSON.stringify({ phase, states, health, timeline }), { cause: error });
    }
  };
  const change = broker.checkUpgrade();
  await waitPhase("drain", () => (broker as any).draining);
  expect(formatHealth(await old.health())).toContain("Handover pending: draining requests");
  await expect((internals(old) as any).client.request("send", { to: "later", body: "must retry" })).rejects.toMatchObject({ code: "timeout" });
  await expect((internals(old) as any).client.request("peers", {})).rejects.toMatchObject({ code: "timeout", message: expect.stringContaining("Broker v0.30.12. Handover pending: draining requests") });
  release(); const sent = await send; await change;
  await waitPhase("reconnect", () => next.isBroker && next.isConnected && old.isConnected && !old.isBroker, HANDOVER_RECONNECT_BUDGET_MS);
  const later = env.node("later"); await later.start(); await waitPhase("retained-mail", () => later.unread().length === 1);
  expect(later.unread()[0]?.id).toBe(sent.messages[0]?.id);
  await old.send({ to: next.name, body: "old session still works" }); await waitPhase("old-session-send", () => next.unread().some(m => m.body === "old session still works"));
});

it("a drain timeout keeps ownership and lets the admitted request finish", async () => {
  const old = await oldHost(), broker = internals(old).broker;
  let release!: () => void;
  const held = new Promise<void>(resolve => release = resolve); broker.requests.add(held);
  const next = env.node("next"); await next.start();
  await broker.checkUpgrade();
  expect(old.isBroker).toBe(true); expect(next.isBroker).toBe(false);
  expect((await old.health()).handoverPending).toContain("drain timed out");
  broker.requests.delete(held); release();
  await old.send({ to: next.name, body: "serving after bounded drain" });
});

it.each(["deferred", "reader"])("a %s store blocks handover without losing ownership", async kind => {
  const warning = vi.spyOn(nullLogger, "warn");
  const old = await oldHost(), broker = internals(old).broker;
  const next = env.node("next"); await next.start();
  if (kind === "deferred") (broker.store as any).db.exec("PRAGMA user_version=8");
  else recordStorePeer(env.home, { pid: process.pid, name: "retained-reader", version: APP_VERSION, storeCapabilities: { json: 4, sqlite: 8, jobArchive: 1 } });
  await broker.checkUpgrade();
  expect(old.isBroker).toBe(true); expect(next.isBroker).toBe(false);
  expect(formatHealth(await old.health())).toContain("store upgrade deferred / reader floor");
  expect(warning).toHaveBeenCalledWith("broker upgrade deferred; data and ownership retained", expect.objectContaining({ err: expect.any(String) }));
});

it("an fsync failure retains the endpoint and reports the pending failure", async () => {
  const old = await oldHost(), next = env.node("next"); await next.start();
  vi.spyOn(upgrade, "syncBrokerStores").mockRejectedValue(new Error("fixture sync failure"));
  await internals(old).broker.checkUpgrade();
  expect(old.isBroker).toBe(true); expect(next.isBroker).toBe(false);
  expect((await old.health()).handoverPending).toContain("flush or handover failed");
});
