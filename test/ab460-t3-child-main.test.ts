import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import type { AgentKind, PeerInfo } from "../src/core/protocol.js";

// AB-460: a session T3 Code started for a delegated task (a chat with a parent chat) connects like any session.
// It must never become its project's main, nor receive project-address mail, even when it is the oldest member.
let env: TestEnv;
let broker: Broker;
const clients: BridgeClient[] = [];

/** A synthetic T3 store with the two tables Bridge reads: provider sessions and chats with their lineage. */
function t3Home(chats: { thread: string; nativeId: string; parent?: string; relation?: "subagent" | "fork" }[]): string {
  const home = join(env.home, "t3");
  mkdirSync(join(home, "userdata"), { recursive: true });
  const db = new DatabaseSync(join(home, "userdata", "statev2.sqlite"));
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, payload_json TEXT)`);
  for (const c of chats) {
    db.prepare(`INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL)`)
      .run(c.thread, JSON.stringify({ lineage: c.parent ? { parentThreadId: c.parent, relationshipToParent: c.relation ?? "subagent" } : {} }));
    db.prepare(`INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?)`)
      .run(c.thread, JSON.stringify({ nativeThreadRef: { nativeId: c.nativeId } }));
  }
  db.close();
  return home;
}

beforeEach(async () => {
  env = makeEnv();
  broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, loadOrCreateToken(env.home));
  await broker.listen();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await broker.close();
  await env.cleanup();
});

async function session(peer: Partial<PeerInfo> & { id: string; name: string; agent: AgentKind; startedAt: number }): Promise<BridgeClient> {
  const client = await BridgeClient.connect(env.pipe, nullLogger);
  clients.push(client);
  await client.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: {
    cwd: env.home, pid: process.pid, agentPid: null, sessionId: `${peer.id}-session`, autoWake: false, activity: "idle", ...peer } });
  return client;
}

describe("AB-460 T3 delegated children", () => {
  it("never makes a T3 delegated child the project main or a project-mail recipient", async () => {
    broker.setT3Home(t3Home([
      { thread: "parent-chat", nativeId: "lead-session" },
      { thread: "child-chat", nativeId: "child-session", parent: "parent-chat" },
    ]));
    const now = Date.now();
    // The child connected first: without AB-460 it is the oldest member and takes the main role.
    await session({ id: "child", name: "codex-t3-child", agent: "codex", startedAt: now - 60_000 });
    const lead = await session({ id: "lead", name: "claude-lead", agent: "claude", startedAt: now });
    const sender = await session({ id: "other", name: "claude-other", agent: "claude", startedAt: now + 1 });

    const peers = await lead.request("peers", {});
    const child = peers.find((p) => p.name === "codex-t3-child");
    expect(peers.find((p) => p.name === "claude-lead")?.projectMain).toBe(true);
    expect(child?.projectMain).not.toBe(true);
    expect(child?.t3Child).toBe(true);

    const address = peers.find((p) => p.name === "claude-lead")!.projectAddress!;
    const sent = await sender.request("send", { to: address, body: "for the team", conversationId: "ab460" });
    expect(sent.deliveredTo).toContain("claude-lead");
    expect(sent.deliveredTo).not.toContain("codex-t3-child");
  });

  it("keeps a fork the user made of a chat as an ordinary member that can be main", async () => {
    broker.setT3Home(t3Home([
      { thread: "parent-chat", nativeId: "lead-session" },
      { thread: "fork-chat", nativeId: "fork-session", parent: "parent-chat", relation: "fork" },
    ]));
    const now = Date.now();
    const fork = await session({ id: "fork", name: "claude-fork", agent: "claude", startedAt: now - 60_000 });
    await session({ id: "lead", name: "claude-lead", agent: "claude", startedAt: now });
    const peers = await fork.request("peers", {});
    expect(peers.find((p) => p.name === "claude-fork")?.projectMain).toBe(true);
    expect(peers.find((p) => p.name === "claude-fork")?.t3Child).toBeUndefined();
  });

  it("does not elect a session T3 has not recorded yet while a resolved member is available", async () => {
    // The child connected before T3 recorded its provider session: its place is pending, not "ordinary".
    broker.setT3Home(t3Home([{ thread: "parent-chat", nativeId: "lead-session" }]));
    const now = Date.now();
    await session({ id: "child", name: "codex-t3-child", agent: "codex", startedAt: now - 60_000 });
    const lead = await session({ id: "lead", name: "claude-lead", agent: "claude", startedAt: now });
    const sender = await session({ id: "other", name: "claude-other", agent: "claude", startedAt: now + 1 });
    const peers = await lead.request("peers", {});
    expect(peers.find((p) => p.name === "claude-lead")?.projectMain).toBe(true);
    expect(peers.find((p) => p.name === "codex-t3-child")?.projectMain).toBe(false);
    const address = peers.find((p) => p.name === "claude-lead")!.projectAddress!;
    const sent = await sender.request("send", { to: address, body: "for the team", conversationId: "ab460" });
    expect(sent.deliveredTo).toContain("claude-lead");
    expect(sent.deliveredTo).not.toContain("codex-t3-child");
  });
});
