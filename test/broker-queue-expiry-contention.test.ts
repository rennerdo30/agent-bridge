import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION, QUEUED_MAIL_MAX_AGE_MS } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { archiveDbPath } from "../src/core/sqlite-maintenance.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const queued = (id: string, recipient: string, createdAt: number): BridgeMessage => ({
  id, recipient, from: { id: "sender", name: "sender", agent: "other" }, to: recipient,
  conversationId: id, replyTo: null, hop: 0, body: id, createdAt, readAt: null,
});
function seed() {
  const store = new MessageStore(env.db, nullLogger), now = Date.now();
  try {
    for (const recipient of ["codex-app", "agent:codex"]) {
      store.insert(queued(`old-${recipient}`, recipient, now - QUEUED_MAIL_MAX_AGE_MS - 60_000));
      store.insert(queued(`fresh-${recipient}`, recipient, now - 60_000));
    }
  } finally { store.close(); }
}
function witnessExpiry() {
  let calls = 0;
  const original = MessageStore.prototype.expireQueuedAsync;
  vi.spyOn(MessageStore.prototype, "expireQueuedAsync").mockImplementation(function (this: MessageStore, recipient, cutoff) {
    if (recipient === "codex-app") calls++;
    return original.call(this, recipient, cutoff);
  });
  return (minimum = 1) => calls >= minimum;
}
async function underOneSecond<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("broker blocked during queued-mail archival")), 1_000);
  })]); } finally { clearTimeout(timer); }
}

it.each(["hello", "rename"])("keeps requests responsive and expires before %s replay while archive storage is busy", async mode => {
  seed();
  const host = env.node("host", "other"); await host.start();
  const incoming = env.node(mode === "hello" ? "codex-app" : "initial", "codex");
  if (mode === "rename") await incoming.start();
  const waiting = witnessExpiry(), writer = new DatabaseSync(archiveDbPath(env.db));
  writer.exec("BEGIN IMMEDIATE");
  try {
    const connecting = mode === "hello" ? incoming.start() : incoming.relocate(env.home, "codex-app");
    await until(waiting);
    expect(await underOneSecond(host.peers())).toBeTruthy();
    expect((await underOneSecond(host.send({ to: "offline", body: "ordinary mail remains responsive" }))).messages).toHaveLength(1);
    expect(incoming.unread().some(message => message.body === "old-codex-app")).toBe(false);
    const primary = new DatabaseSync(env.db, { readOnly: true });
    try { expect(primary.prepare("SELECT body FROM messages WHERE id='old-codex-app'").get()!.body).toBe("old-codex-app"); }
    finally { primary.close(); }
    writer.exec("ROLLBACK"); await connecting;
    await until(() => incoming.unread().some(message => message.body === "fresh-codex-app"));
    expect(incoming.unread().some(message => message.body.startsWith("old-"))).toBe(false);
    expect(writer.prepare("SELECT body FROM messages WHERE id='old-codex-app'").get()!.body).toBe("old-codex-app");
  } finally { if (writer.isTransaction) writer.exec("ROLLBACK"); writer.close(); }
});

it("does not claim or replay queued mail for a registration whose authenticated session changed during expiry", async () => {
  seed(); const host = env.node("host", "other"); await host.start();
  const waiting = witnessExpiry(), writer = new DatabaseSync(archiveDbPath(env.db));
  const raw = await BridgeClient.connect(env.pipe, nullLogger);
  writer.exec("BEGIN IMMEDIATE");
  try {
    const hello = raw.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home),
      peer: { id: "pending-registration", name: "codex-app", agent: "codex", cwd: env.home,
        pid: process.pid, agentPid: null, sessionId: "old-sid", startedAt: Date.now(), autoWake: false } });
    const rejected = expect(hello).rejects.toMatchObject({ code: "unauthorized" });
    await until(waiting);
    const changed = raw.request("updatePeer", { sessionId: "replacement-sid" });
    await until(() => waiting(2));
    writer.exec("ROLLBACK"); await changed; await rejected;
    const primary = new DatabaseSync(env.db, { readOnly: true });
    try {
      expect(primary.prepare("SELECT recipient FROM messages WHERE id='fresh-agent:codex'").get()!.recipient).toBe("agent:codex");
      expect(primary.prepare("SELECT read_at FROM messages WHERE id='fresh-agent:codex'").get()!.read_at).toBeNull();
    } finally { primary.close(); }
  } finally { if (writer.isTransaction) writer.exec("ROLLBACK"); writer.close(); raw.close(); }
});

it("defers same-session reload replay until expired own-name mail is archived", async () => {
  const host = env.node("host", "other"); await host.start();
  const old = env.node("codex-app", "codex"); await old.setSessionId("same-session"); await old.start();
  seed();
  const replacement = env.node("codex-app", "codex"); await replacement.setSessionId("same-session");
  const waiting = witnessExpiry(), writer = new DatabaseSync(archiveDbPath(env.db)); writer.exec("BEGIN IMMEDIATE");
  try {
    const connected = replacement.start(); await until(waiting);
    await underOneSecond(host.send({ to: "offline", body: "reload still serves messages" }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(replacement.unread()).toEqual([]);
    writer.exec("ROLLBACK"); await connected;
    await until(() => replacement.unread().some(message => message.body === "fresh-codex-app"));
    expect(replacement.unread().some(message => message.body.startsWith("old-"))).toBe(false);
    expect(writer.prepare("SELECT body FROM messages WHERE id='old-codex-app'").get()!.body).toBe("old-codex-app");
  } finally { if (writer.isTransaction) writer.exec("ROLLBACK"); writer.close(); }
});

it("defers a combined availability/session/rename replay until final-name expiry finishes", async () => {
  const host = env.node("host", "other"); await host.start();
  const raw = await BridgeClient.connect(env.pipe, nullLogger), received: BridgeMessage[] = [];
  raw.on("event", (event, message) => { if (event === "message") received.push(message as BridgeMessage); });
  await raw.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home),
    peer: { id: "combined-update", name: "initial", agent: "other", cwd: env.home,
      pid: process.pid, agentPid: null, sessionId: "combined-old", startedAt: Date.now(), autoWake: false } });
  seed(); const waiting = witnessExpiry(), writer = new DatabaseSync(archiveDbPath(env.db)); writer.exec("BEGIN IMMEDIATE");
  try {
    const changed = raw.request("updatePeer", { unavailable: false, sessionId: "combined-new", name: "codex-app" });
    await until(waiting); await underOneSecond(host.peers());
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(received).toEqual([]);
    writer.exec("ROLLBACK"); await changed;
    await until(() => received.some(message => message.body === "fresh-codex-app"));
    expect(received.some(message => message.body.startsWith("old-"))).toBe(false);
  } finally { if (writer.isTransaction) writer.exec("ROLLBACK"); writer.close(); raw.close(); }
});
