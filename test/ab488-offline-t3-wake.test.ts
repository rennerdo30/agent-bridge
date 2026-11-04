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
import { formatDelivery } from "../src/mcp/format.js";
import type { AgentKind } from "../src/core/protocol.js";

// AB-488: a T3 Code chat has no running session between turns. Mail queued for it must wake the chat through T3.
let env: TestEnv;
let broker: Broker;
const clients: BridgeClient[] = [];
let sent: { thread: string; text: string }[];

beforeEach(async () => {
  env = makeEnv();
  broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, loadOrCreateToken(env.home));
  sent = [];
  broker.setT3OfflineWake({
    chat: (sessionId) => sessionId === "coordinator-session" ? "coordinator-chat" : undefined,
    send: async (thread, text) => { sent.push({ thread, text }); return { state: "accepted", delivery: "queued", runId: null }; },
  });
  await broker.listen();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await broker.close();
  await env.cleanup();
});

async function session(name: string, sessionId: string, agent: AgentKind = "claude"): Promise<BridgeClient> {
  const client = await BridgeClient.connect(env.pipe, nullLogger);
  clients.push(client);
  await client.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: {
    id: `${name}-${sessionId}`, name, agent, cwd: env.home, pid: process.pid, agentPid: null, sessionId, startedAt: Date.now(), autoWake: false, activity: "idle" } });
  return client;
}

async function goOffline(client: BridgeClient, sender: BridgeClient, name: string): Promise<void> {
  client.close();
  for (const end = Date.now() + 5_000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    if (!(await sender.request("peers", {})).some((p) => p.name === name)) return;
  }
  throw new Error(`${name} did not leave`);
}

it("wakes the T3 chat of an offline recipient once per offline stretch, and says so in the receipt", async () => {
  const sender = await session("claude-sender", "sender-session");
  await goOffline(await session("claude-coordinator", "coordinator-session"), sender, "claude-coordinator");

  const first = await sender.request("send", { to: "claude-coordinator", body: "P0: queue holder is dead" });
  expect(first.queuedFor).toEqual(["claude-coordinator"]);
  expect(first.t3WakeFor).toEqual(["claude-coordinator"]);
  expect(formatDelivery(first).join("\n")).toContain("Sent a wake-up into the T3 Code chat of: claude-coordinator");
  await new Promise((r) => setTimeout(r, 20));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.thread).toBe("coordinator-chat");
  expect(sent[0]!.text).toContain(first.messages[0]!.id);
  expect(sent[0]!.text).toContain("claude-sender");

  // More mail while the chat is still waking: queued, no second chat message.
  expect((await sender.request("send", { to: "claude-coordinator", body: "follow-up" })).t3WakeFor).toBeUndefined();
  expect(sent).toHaveLength(1);

  // Once the chat's session ran and left again, new mail wakes it again.
  await goOffline(await session("claude-coordinator", "coordinator-session"), sender, "claude-coordinator");
  expect((await sender.request("send", { to: "claude-coordinator", body: "next round" })).t3WakeFor).toEqual(["claude-coordinator"]);
  await new Promise((r) => setTimeout(r, 20));
  expect(sent).toHaveLength(2);
});

it("does not wake for a note or for an offline session that is no T3 chat", async () => {
  const sender = await session("claude-sender", "sender-session");
  await goOffline(await session("claude-coordinator", "coordinator-session"), sender, "claude-coordinator");
  await goOffline(await session("claude-plain", "plain-session"), sender, "claude-plain");

  expect((await sender.request("send", { to: "claude-coordinator", body: "fyi", conversationId: "status:note" })).t3WakeFor).toBeUndefined();
  expect((await sender.request("send", { to: "claude-plain", body: "hello" })).t3WakeFor).toBeUndefined();
  await new Promise((r) => setTimeout(r, 20));
  expect(sent).toEqual([]);
});

it("never wakes the chat of a T3 delegated task (a subagent, AB-460)", async () => {
  // A synthetic T3 store: the child's session is a chat whose lineage names a parent as a subagent.
  const home = join(env.home, "t3"); mkdirSync(join(home, "userdata"), { recursive: true });
  const db = new DatabaseSync(join(home, "userdata", "statev2.sqlite"));
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, payload_json TEXT)`);
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL)").run("child-chat", JSON.stringify({ lineage: { parentThreadId: "lead", relationshipToParent: "subagent" } }));
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?)").run("child-chat", JSON.stringify({ nativeThreadRef: { nativeId: "coordinator-session" } }));
  db.close();
  broker.setT3Home(home);
  broker.setT3OfflineWake({
    chat: () => "child-chat",
    send: async (thread, text) => { sent.push({ thread, text }); return { state: "accepted", delivery: "queued", runId: null }; },
  });
  const sender = await session("claude-sender", "sender-session");
  await goOffline(await session("claude-coordinator", "coordinator-session"), sender, "claude-coordinator");
  expect((await sender.request("send", { to: "claude-coordinator", body: "status?" })).t3WakeFor).toBeUndefined();
  await new Promise((r) => setTimeout(r, 20));
  expect(sent).toEqual([]);
});
