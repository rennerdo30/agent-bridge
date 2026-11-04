import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeEnv, type TestEnv } from "./helpers.js";
import { BridgeClient } from "../src/core/client.js";
import { nullLogger } from "../src/core/logger.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { MessageStore } from "../src/core/store.js";
import { Broker } from "../src/core/broker.js";

// AB-496: the peer list says which sessions are T3 chats, so an agent can reach them with T3's own tools.
let env: TestEnv;
let broker: Broker;
const clients: BridgeClient[] = [];
beforeEach(async () => {
  env = makeEnv();
  broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, loadOrCreateToken(env.home));
  await broker.listen();
});
afterEach(async () => { for (const c of clients.splice(0)) c.close(); await broker.close(); await env.cleanup(); });

it("reports the T3 chat a local session runs in, and none for a plain session", async () => {
  const home = join(env.home, "t3"); mkdirSync(join(home, "userdata"), { recursive: true });
  const db = new DatabaseSync(join(home, "userdata", "statev2.sqlite"));
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT, deleted_at TEXT, archived_at TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, payload_json TEXT, updated_at TEXT)`);
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL, NULL)").run("coordinator-chat", JSON.stringify({ lineage: {} }));
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)").run("coordinator-chat", JSON.stringify({ nativeThreadRef: { nativeId: "chat-session" } }), "2026-11-05");
  db.close();
  broker.setT3Home(home);
  for (const [name, sessionId] of [["claude-coordinator", "chat-session"], ["claude-plain", "plain-session"]] as const) {
    const client = await BridgeClient.connect(env.pipe, nullLogger); clients.push(client);
    await client.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: {
      id: name, name, agent: "claude", cwd: env.home, pid: process.pid, agentPid: null, sessionId, startedAt: Date.now(), autoWake: false } });
  }
  const peers = await clients[0]!.request("peers", {});
  expect(peers.find((p) => p.name === "claude-coordinator")?.t3Chat).toBe("coordinator-chat");
  expect(peers.find((p) => p.name === "claude-plain")?.t3Chat).toBeUndefined();
});
