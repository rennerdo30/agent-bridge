import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

it("tracks pending storage under a real writer lock and concurrent retries queue once", async () => {
  const sender = env.node("sender"), recipient = env.node("recipient");
  await sender.start(); await recipient.start();
  const lock = new DatabaseSync(env.db), id = randomUUID();
  lock.exec("BEGIN IMMEDIATE");
  try {
    const args = { to: recipient.name, body: "Waiting for writer", messageId: id };
    const first = sender.send(args), second = sender.send(args);
    // The lookup runs on the broker independently of the waiting writer retry.
    let state = await sender.sendState(id);
    if (state.state === "not_stored") state = await sender.sendState(id);
    expect(state.state).toBe("pending");
    expect(state.message).toBeNull();
    lock.exec("COMMIT");
    const results = await Promise.all([first, second]);
    expect(results.every(r => r.storage?.id === id && r.storage.state === "stored")).toBe(true);
    await until(() => recipient.unread().length === 1);
    expect((await sender.sendState(id)).receipts).toHaveLength(1);
  } finally { if (lock.isTransaction) lock.exec("ROLLBACK"); lock.close(); }
});
