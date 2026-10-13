import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { migrateSqlite } from "../src/core/sqlite-migrations.js";
import { Broker } from "../src/core/broker.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import { BridgeClient } from "../src/core/client.js";
import { makeEnv, type TestEnv } from "./helpers.js";

// AB-223 / AB-239: a throw after the pipe is bound must neither hang listen() nor become an unhandled rejection.
let env: TestEnv;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
beforeEach(() => { env = makeEnv(); unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });
afterEach(async () => { process.off("unhandledRejection", onUnhandled); await env.cleanup(); });

const settle = (p: Promise<void>, ms: number) => Promise.race([
  p.then(() => "resolved", (err: Error) => `rejected: ${err.message}`),
  new Promise<string>((r) => setTimeout(() => r("pending"), ms)),
]);

it("keeps a broker whose optional startup step throws (handoff replay) and still settles listen()", async () => {
  const store = new MessageStore(env.db, nullLogger);
  const broker = new Broker(env.pipe, store, nullLogger, "t");
  (broker as unknown as { applyHandoffs: () => void }).applyHandoffs = () => { throw new Error("database is locked"); };
  try {
    expect(await settle(broker.listen(), 3000)).toBe("resolved");
    expect(unhandled).toEqual([]);
  } finally { await broker.close(); }
});

it("rejects listen() and releases the pipe when a required startup step throws", async () => {
  const store = new MessageStore(env.db, nullLogger);
  const broker = new Broker(env.pipe, store, nullLogger, "t");
  (broker as unknown as { purge: () => void }).purge = () => { throw new Error("purge exploded"); };
  try {
    expect(await settle(broker.listen(), 3000)).toBe("rejected: purge exploded");
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
    // The endpoint is free again, so election can retry.
    await expect(BridgeClient.connect(env.pipe, nullLogger, 300)).rejects.toThrow();
  } finally { store.close(); }
});

it("opens an already-current SQLite store without waiting on another process's migration lock", async () => {
  const file = join(env.home, "current.db");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA user_version = 3");
    // A live owner (this very process, another nonce) holds the lock, as a migrating session would.
    writeFileSync(`${file}.migration-lock`, JSON.stringify({ pid: process.pid, nonce: "other" }));
    const started = Date.now();
    migrateSqlite(db, file, true, 3, [], nullLogger);
    expect(Date.now() - started).toBeLessThan(1000);
  } finally { db.close(); }
});
