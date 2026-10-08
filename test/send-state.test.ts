import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { MessageStore } from "../src/core/store.js";
import { BridgeError } from "../src/core/protocol.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

it("recovers two lost replies through unindexed broker storage", async () => {
  const sender = env.node("sender"), recipient = env.node("recipient");
  await sender.start(); await recipient.start();
  const client = (sender as unknown as { client: BridgeClient }).client, request = client.request.bind(client);
  const attempts: string[] = [];
  vi.spyOn(client, "request").mockImplementation(async (op, args: any) => {
    const result = await request(op, args);
    if (op === "trackedSend") { attempts.push(args.messageId); throw new Error("broker request timed out: trackedSend"); }
    return result;
  });
  const result = await sender.send({ to: recipient.name, body: "Unindexed send" });
  expect(attempts).toEqual([result.messages[0]!.id, result.messages[0]!.id]);
  expect(result.storage).toMatchObject({ state: "stored", recovered: true, receipts: [{ recipient: recipient.name, readAt: null }] });
  await until(() => recipient.unread().length === 1);
  expect((await sender.sendState(attempts[0]!)).state).toBe("stored");
});

it("keeps one durable identity across broker restart and archival", async () => {
  const sender = env.node("sender"), recipient = env.node("recipient");
  await sender.start(); await recipient.start();
  const id = randomUUID(), args = { to: recipient.name, body: "Restart recovery", messageId: id };
  await sender.send(args);
  await recipient.stop(); await sender.stop();
  const restarted = env.node("sender"), receiver = env.node("recipient");
  await restarted.start(); await receiver.start();
  expect(restarted.name).toBe("sender");
  expect((await restarted.send(args)).storage).toMatchObject({ id, state: "stored", recovered: true });
  const broker = (restarted as unknown as { broker: { store: MessageStore } }).broker;
  broker.store.purgeOlderThan(Date.now() + 1);
  expect((await restarted.sendState(id)).state).toBe("stored");
  expect((await restarted.send({ ...args, messageId: id.toUpperCase() })).storage?.recovered).toBe(true);
  expect(broker.store.receipts(id)).toHaveLength(1);
  expect(broker.store.unread(receiver.name, 10)).toHaveLength(0);
});

it("rejects changed content or another sender's durable identity", async () => {
  const sender = env.node("sender"), other = env.node("other"); await sender.start(); await other.start();
  const args = { to: other.name, body: "Original", messageId: randomUUID() };
  await sender.send(args);
  await expect(sender.send({ ...args, body: "Changed" })).rejects.toThrow("different content");
  await expect(other.sendState(args.messageId)).rejects.toThrow("original sender");
  await expect(other.send(args)).rejects.toThrow("original sender");
  expect((await sender.sendState(randomUUID())).state).toBe("not_stored");
});

it("only falls back on explicit old-broker refusal, never silently discarding an explicit id", async () => {
  const sender = env.node("sender"); await sender.start();
  const client = (sender as unknown as { client: BridgeClient }).client, request = client.request.bind(client);
  const ops: string[] = [];
  vi.spyOn(client, "request").mockImplementation(async (op, args: any) => {
    ops.push(op);
    if (op === "trackedSend") throw new BridgeError("protocol_mismatch", "unsupported", { operation: op });
    return request(op, args);
  });
  await expect(sender.send({ to: "offline", body: "Legacy send" })).resolves.toBeTruthy();
  expect(ops).toEqual(["trackedSend", "send"]);
  ops.length = 0;
  await expect(sender.send({ to: "offline", body: "Durable send", messageId: randomUUID() })).rejects.toThrow("unsupported");
  expect(ops).toEqual(["trackedSend"]);
});

it("reports unknown storage when routing fails before a remote acknowledgement", async () => {
  const sender = env.node("sender"); await sender.start();
  const broker = (sender as any).broker;
  vi.spyOn(broker, "routeSend").mockRejectedValue(new BridgeError("timeout", "remote acknowledgement timed out"));
  const id = randomUUID();
  const error = await sender.send({ to: "paired/recipient", body: "Remote uncertain", messageId: id }).catch(error => error);
  expect(error).toBeInstanceOf(BridgeError);
  expect(error.details).toMatchObject({ messageId: id, state: "unknown" });
  expect(error.message).toContain("retry with the same message_id");
  expect(error.message).not.toContain("not_stored");
});

it("reports a guarded acknowledgement timeout before send submission without losing the retry identity", async () => {
  const sender = env.node("sender"); await sender.start();
  const client = (sender as unknown as { client: BridgeClient }).client;
  (sender as any).unflushedAcks.add(randomUUID());
  const request = vi.spyOn(client, "request").mockRejectedValue(new Error("broker request timed out: ack"));
  const id = randomUUID();
  const error = await sender.send({ to: "offline", body: "Guarded", ifNoNewerThan: randomUUID(), messageId: id }).catch(error => error);
  expect(error.details).toMatchObject({ messageId: id, state: "unknown", submitted: false });
  expect(error.message).toContain("not submitted");
  expect(request.mock.calls.map(call => call[0])).toEqual(["ack"]);
});

it("does not mistake a local absence observation after send timeout for remote absence", async () => {
  const sender = env.node("sender"); await sender.start();
  const client = (sender as unknown as { client: BridgeClient }).client;
  const id = randomUUID();
  vi.spyOn(client, "request").mockImplementation(async (op) => {
    if (op === "trackedSend") throw new Error("broker request timed out: trackedSend");
    return { id, state: "not_stored", checkedAt: Date.now(), message: null, receipts: [] } as any;
  });
  const error = await sender.send({ to: "paired/recipient", body: "No local mirror", messageId: id }).catch(error => error);
  expect(error.details).toMatchObject({ messageId: id, state: "unknown", localState: "not_stored" });
  expect(error.message).toContain("this local broker reports not_stored");
});
