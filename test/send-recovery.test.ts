import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient, brokerConnectionClosedError } from "../src/core/client.js";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
const jobs: BridgeNode[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const job of jobs.splice(0)) await job.stop();
  await env.cleanup();
});

it.each(["claude", "codex", "opencode", "antigravity"] as const)("recovers a lost %s send response with one durable message", async (agent) => {
  const sender = env.node("sender", agent), recipient = env.node("recipient", agent);
  await sender.start(); await recipient.start();
  const client = (sender as unknown as { client: BridgeClient }).client;
  const request = client.request.bind(client);
  let lost = false;
  const attempts: string[] = [];
  vi.spyOn(client, "request").mockImplementation(async (op, args: any) => {
    if (op !== "trackedSend") return request(op, args);
    attempts.push(args.dedupeKey);
    const result = await request(op, args);
    if (!lost) { lost = true; throw new Error("broker request timed out: trackedSend"); }
    return result;
  });
  const sent = await sender.send({ to: recipient.name, body: "RESPONSE_LOST" });
  expect(sent.storage).toMatchObject({ id: sent.messages[0]!.id, state: "stored", recovered: true });
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBeTruthy(); expect(attempts[1]).toBe(attempts[0]);
  await until(() => recipient.unread().length === 1);
  expect(recipient.unread()[0]!.id).toBe(sent.messages[0]!.id);
  expect(await sender.messageReceipt(sent.messages[0]!.id)).toHaveLength(1);
});

it("recovers a sibling response without another note or supervisor observer copy", async () => {
  const owner = env.node("owner"); await owner.start();
  const records = ["one", "two"].map((id) => ({ id, name: `opencode-job-${id}`, agent: "opencode", status: "running", owner: "owner", rootName: "owner", rootSession: "root", supervisor: "root", workdir: env.home }));
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: records }));
  for (const record of records) {
    const node = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home),
      id: `job:${record.id}`, name: record.name, agent: "other", jobAgent: "opencode", jobOwner: "root", jobParent: owner.name,
      cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
    jobs.push(node); await node.start();
  }
  const sender = jobs[0]!, recipient = jobs[1]!;
  const client = (sender as unknown as { client: BridgeClient }).client, request = client.request.bind(client);
  let lost = false;
  vi.spyOn(client, "request").mockImplementation(async (op, args: any) => {
    const result = await request(op, args);
    if (op === "sendSibling" && !lost) { lost = true; throw new Error("broker request timed out: sendSibling"); }
    return result;
  });
  const sent = await sender.sendSibling({ to: recipient.name, body: "SIBLING_RESPONSE_LOST" }, 32);
  expect(sent.deliveredTo).toEqual([recipient.name]);
  await until(() => recipient.unread().length === 1 && owner.unread().length === 1);
  expect(owner.unread()[0]!.conversationId).toMatch(/:note$/);
  expect(recipient.unread()[0]!.body).toBe("SIBLING_RESPONSE_LOST");
});

it("reports unconfirmed delivery after two timeouts and does not retry permanent failures", async () => {
  const sender = env.node("sender"); await sender.start();
  const client = (sender as unknown as { client: BridgeClient }).client;
  const request = vi.spyOn(client, "request").mockRejectedValue(new Error("broker request timed out: trackedSend"));
  await expect(sender.send({ to: "offline", body: "uncertain" })).rejects.toThrow("Storage cannot be confirmed for message");
  expect(request.mock.calls.filter(([op]) => op === "trackedSend")).toHaveLength(2);
  expect(request.mock.calls.filter(([op]) => op === "sendState")).toHaveLength(1);
  request.mockClear().mockRejectedValue(new Error("unauthorized target"));
  await expect(sender.send({ to: "offline", body: "denied" })).rejects.toThrow("unauthorized target");
  expect(request.mock.calls.filter(([op]) => op === "trackedSend")).toHaveLength(1);
});

it.each(["after_store", "before_store"] as const)("retries a send whose actual connection closed (%s) once on the re-elected connection with the same message id", async (when) => {
  const sender = env.node("sender"), recipient = env.node("recipient");
  await sender.start(); await recipient.start();
  const first = (sender as unknown as { client: BridgeClient }).client, request = first.request.bind(first);
  const attempts: string[] = [];
  vi.spyOn(first, "request").mockImplementation(async (op, args: any) => {
    if (op !== "trackedSend") return request(op, args);
    attempts.push(args.messageId);
    if (when === "after_store") await request(op, args);
    // The actual connection is gone; its outcome is unknown to the caller.
    const closed = new Promise<void>(resolve => first.once("close", () => resolve())); first.close(); await closed;
    throw brokerConnectionClosedError();
  });
  const retried = vi.spyOn(BridgeClient.prototype, "request");
  const sent = await sender.send({ to: recipient.name, body: `CONNECTION_CLOSED_${when}` });
  const second = (sender as unknown as { client: BridgeClient }).client;
  expect(second).not.toBe(first); expect(second.isClosed).toBe(false);
  const retries = retried.mock.calls.filter(([op]) => op === "trackedSend").map(([, args]) => (args as { messageId: string }).messageId);
  expect(attempts).toHaveLength(1); expect(retries).toEqual([attempts[0]]);
  expect(sent.messages[0]!.id).toBe(attempts[0]);
  if (when === "after_store") expect(sent.storage).toMatchObject({ id: attempts[0], state: "stored", recovered: true });
  await until(() => recipient.unread().length === 1);
  expect(recipient.unread()[0]!.id).toBe(attempts[0]);
  expect(await sender.messageReceipt(attempts[0]!)).toHaveLength(1);
});

it("does not retry a closed-connection send a second time when the re-elected connection also closes", async () => {
  const sender = env.node("sender"); await sender.start();
  const close = (client: BridgeClient) => {
    const request = client.request.bind(client);
    return vi.spyOn(client, "request").mockImplementation(async (op, args: any) => {
      if (op !== "trackedSend") return request(op, args);
      const closed = new Promise<void>(resolve => client.once("close", () => resolve())); client.close(); await closed;
      throw brokerConnectionClosedError();
    });
  };
  const first = (sender as unknown as { client: BridgeClient }).client; close(first);
  const connected = sender.ensureConnected.bind(sender);
  let second: BridgeClient | undefined;
  vi.spyOn(sender, "ensureConnected").mockImplementation(async () => {
    await connected();
    const current = (sender as unknown as { client: BridgeClient }).client;
    if (current !== first && !second) { second = current; close(current); }
  });
  await expect(sender.send({ to: "offline", body: "twice-closed" })).rejects.toThrow("Storage cannot be confirmed for message");
  expect(second).toBeDefined();
});

// Shared fixture: the first connection closes under trackedSend; the re-elected
// connection's trackedSend answers with `second` (pass-through for other ops).
async function closeThenReconnect(sender: BridgeNode, second: (op: string) => Error, lookup: () => Promise<void> = async () => {}) {
  // Reconnect arms the same 100 ms inbox recovery as start(). Keep that unrelated
  // producer off, including any already admitted refresh, before observing sends.
  const pending = sender as unknown as { pendingRefreshTimer: NodeJS.Timeout | null; refreshingPending: Promise<void> | null; schedulePendingRefresh(): void };
  vi.spyOn(pending, "schedulePendingRefresh").mockImplementation(() => {});
  if (pending.pendingRefreshTimer) clearTimeout(pending.pendingRefreshTimer);
  pending.pendingRefreshTimer = null;
  await pending.refreshingPending;
  const first = (sender as unknown as { client: BridgeClient }).client, firstRequest = first.request.bind(first);
  vi.spyOn(first, "request").mockImplementation(async (op, args: any) => {
    if (op !== "trackedSend") return firstRequest(op, args);
    const closed = new Promise<void>(resolve => first.once("close", () => resolve())); first.close(); await closed;
    throw brokerConnectionClosedError();
  });
  const ops: string[] = [];
  const connected = sender.ensureConnected.bind(sender);
  vi.spyOn(sender, "ensureConnected").mockImplementation(async () => {
    await connected();
    const current = (sender as unknown as { client: BridgeClient }).client;
    if (current === first || ops.length) return;
    ops.push("connected");
    const request = current.request.bind(current);
    vi.spyOn(current, "request").mockImplementation(async (op, args: any) => {
      ops.push(op);
      if (op === "trackedSend") throw second(op);
      if (op === "sendState") await lookup();
      return request(op, args);
    });
  });
  return ops;
}

it("never falls back to a fresh-id legacy send when the re-elected broker rejects trackedSend", async () => {
  const sender = env.node("sender"); await sender.start();
  const ops = await closeThenReconnect(sender, op => new Error(`unknown op: ${op}`));
  const error = await sender.send({ to: "offline", body: "no-legacy-after-reconnect" }).catch(failure => failure);
  expect(error).toBeInstanceOf(Error); expect(String(error.message)).toContain("Storage cannot be confirmed for message");
  expect(error.details).toMatchObject({ state: "unknown" }); expect(error.details.messageId).toMatch(/^[0-9a-f-]{36}$/);
  expect(ops).toEqual(["connected", "trackedSend"]); expect(ops).not.toContain("send");
});

it("after the reconnect retry a transient error takes only the read-only lookup, never a third trackedSend", async () => {
  const sender = env.node("sender"); await sender.start();
  let release!: () => void, entered!: () => void;
  const lookup = new Promise<void>(resolve => { release = resolve; });
  const reachedLookup = new Promise<void>(resolve => { entered = resolve; });
  const ops = await closeThenReconnect(sender, op => new Error(`broker request timed out: ${op}`), () => { entered(); return lookup; });
  // Re-arm only the reconnect producer under the controlled clock, so even a
  // pre-existing real timer cannot make this regression depend on wall time.
  const startTimer = Reflect.get(sender, "pendingRefreshTimer") as NodeJS.Timeout | null;
  if (startTimer) clearTimeout(startTimer);
  Reflect.set(sender, "pendingRefreshTimer", null);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const send = sender.send({ to: "offline", body: "lookup-only" }).catch(error => error);
  try {
    await reachedLookup;
    // Deterministically cross reconnect's 100 ms background-poll boundary while
    // the send-state response is held. Every send operation remains asserted.
    await vi.advanceTimersByTimeAsync(101);
    expect(ops).toEqual(["connected", "trackedSend", "sendState"]);
  } finally { release(); vi.useRealTimers(); }
  expect(await send).toMatchObject({ message: expect.stringContaining("storage state is unknown") });
  expect(ops).toEqual(["connected", "trackedSend", "sendState"]);
});

it("a failed reconnect reports the combined unknown-state error", async () => {
  const sender = env.node("sender"); await sender.start();
  const first = (sender as unknown as { client: BridgeClient }).client, request = first.request.bind(first);
  vi.spyOn(first, "request").mockImplementation(async (op, args: any) => {
    if (op !== "trackedSend") return request(op, args);
    const closed = new Promise<void>(resolve => first.once("close", () => resolve())); first.close(); await closed;
    throw brokerConnectionClosedError();
  });
  const connected = sender.ensureConnected.bind(sender);
  let calls = 0;
  vi.spyOn(sender, "ensureConnected").mockImplementation(async () => {
    if (++calls === 1) return connected(); // The original send's own connection.
    throw new Error("SIMULATED election failure");
  });
  const error = await sender.send({ to: "offline", body: "reconnect-fails" }).catch(failure => failure);
  expect(String(error.message)).toContain("storage state is unknown: connection to broker closed; reconnect failed: SIMULATED election failure");
  expect(error.details).toMatchObject({ state: "unknown", messageId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect(calls).toBe(2);
});

it("a non-close send error does not reconnect or retry", async () => {
  const sender = env.node("sender"); await sender.start();
  const client = (sender as unknown as { client: BridgeClient }).client;
  const request = vi.spyOn(client, "request").mockRejectedValue(new Error("SIMULATED permanent failure"));
  const ensure = vi.spyOn(sender, "ensureConnected");
  await expect(sender.send({ to: "offline", body: "no-reconnect" })).rejects.toThrow("Storage cannot be confirmed for message");
  expect(ensure).toHaveBeenCalledTimes(1); // Only the original send's own connection check.
  expect(request.mock.calls.filter(([op]) => op === "trackedSend")).toHaveLength(1);
  expect((sender as unknown as { client: BridgeClient }).client).toBe(client); expect(client.isClosed).toBe(false);
});
