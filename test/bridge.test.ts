import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeMetadataDb } from "../src/core/metadata-db.js";
import { maxSocketPathBytes, resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION, QUEUED_MAIL_MAX_AGE_MS } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import { BridgeError, type BridgeMessage } from "../src/core/protocol.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

describe("broker election", () => {
  it("first node becomes broker, second connects as client", async () => {
    const a = env.node("claude-proj", "claude");
    const b = env.node("codex-proj", "codex");
    await a.start();
    await b.start();
    expect(a.isBroker).toBe(true);
    expect(b.isBroker).toBe(false);
    const peers = await b.peers();
    expect(peers.map((p) => p.name).sort()).toEqual(["claude-proj", "codex-proj"]);
  });

  it.skipIf(process.platform === "win32")("elects a broker for a home too deep for a Unix socket path", async () => {
    const home = join(env.home, "a-home-directory-nested-deep-enough".repeat(3));
    mkdirSync(home, { recursive: true });
    expect(Buffer.byteLength(join(home, `bridge-p${PROTOCOL_VERSION}.sock`))).toBeGreaterThan(maxSocketPathBytes());
    const pipe = resolvePipePath(home, {});
    expect(Buffer.byteLength(pipe)).toBeLessThanOrEqual(maxSocketPathBytes());
    const opts = { pipePath: pipe, token: loadOrCreateToken(home), dbPath: resolveDbPath(home), cwd: home, autoWake: false, log: nullLogger };
    const a = new BridgeNode({ ...opts, agent: "claude", name: "deep-a" });
    const b = new BridgeNode({ ...opts, agent: "codex", name: "deep-b" });
    try {
      await a.start();
      await b.start();
      expect([a.isBroker, b.isBroker]).toEqual([true, false]);
      expect((await b.peers()).map((p) => p.name).sort()).toEqual(["deep-a", "deep-b"]);
      const dir = statSync(dirname(pipe));
      expect(dir.mode & 0o777).toBe(0o700);
      expect(dir.uid).toBe(process.getuid!());
    } finally {
      await b.stop().catch(() => {});
      await a.stop().catch(() => {});
      closeMetadataDb(home);
    }
  });

  it("concurrent starts elect exactly one broker", async () => {
    const nodes = [0, 1, 2, 3].map((i) => env.node(`n${i}`, "other"));
    await Promise.all(nodes.map((n) => n.start()));
    expect(nodes.filter((n) => n.isBroker)).toHaveLength(1);
    expect(await nodes[0]!.peers()).toHaveLength(4);
  });

  it("disambiguates duplicate names", async () => {
    const a = env.node("same");
    const b = env.node("same");
    await a.start();
    await b.start();
    expect(a.name).toBe("same");
    expect(b.name).toBe("same-2");
  });

  it("survives broker loss: a client takes over and keeps queued mail", async () => {
    const broker = env.node("claude-a", "claude");
    const codex = env.node("codex-a", "codex");
    await broker.start();
    await codex.start();

    // Queue a message for an offline peer, then kill the broker.
    await codex.send({ to: "later", body: "hello later" });
    await broker.stop();
    await until(() => codex.isConnected && codex.isBroker, 8_000);

    const later = env.node("later", "other");
    await later.start();
    await until(() => later.unread().length === 1);
    expect(later.unread()[0]!.body).toBe("hello later");
  });
});

describe("background re-election", () => {
  it("keeps retrying with backoff after a failed start and joins once it can", async () => {
    const good = env.node("good");
    await good.start();
    // The running broker refuses this node (other token): start fails, but the node keeps trying.
    const other = new BridgeNode({ pipePath: env.pipe, token: "other-token", dbPath: env.db, agent: "other", name: "other", cwd: env.home, autoWake: false, log: nullLogger });
    try {
      await expect(other.start()).rejects.toMatchObject({ code: "unauthorized" });
      await good.stop();
      await until(() => other.isConnected && other.isBroker, 8_000);
    } finally {
      await other.stop();
    }
  });

  it("stops retrying once the node is stopped", async () => {
    const good = env.node("good");
    await good.start();
    const other = new BridgeNode({ pipePath: env.pipe, token: "other-token", dbPath: env.db, agent: "other", name: "other", cwd: env.home, autoWake: false, log: nullLogger });
    await expect(other.start()).rejects.toMatchObject({ code: "unauthorized" });
    await other.stop();
    await good.stop();
    await new Promise((r) => setTimeout(r, 1_500));
    expect(other.isConnected).toBe(false);
  });
});

describe("queued mail age limit", () => {
  const queued = (id: string, recipient: string, createdAt: number): BridgeMessage => ({
    id,
    recipient,
    from: { id: "x", name: "old-sender", agent: "claude" },
    to: recipient,
    conversationId: id,
    replyTo: null,
    hop: 0,
    body: id,
    createdAt,
    readAt: null,
  });

  it("a session claiming a name gets recent queued mail, not a day-old backlog meant for an earlier session", async () => {
    const now = Date.now();
    const stale = now - QUEUED_MAIL_MAX_AGE_MS - 60_000;
    const store = new MessageStore(env.db, nullLogger);
    store.insert(queued("old-by-name", "codex-app", stale));
    store.insert(queued("old-by-kind", "agent:codex", stale));
    store.insert(queued("fresh-by-name", "codex-app", now - 60_000));
    store.insert(queued("fresh-by-kind", "agent:codex", now - 60_000));
    store.close();

    const codex = env.node("codex-app", "codex");
    await codex.start();
    await until(() => codex.unread().length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(codex.unread().map((m) => m.body).sort()).toEqual(["fresh-by-kind", "fresh-by-name"]);
  });
});

describe("authentication", () => {
  it("rejects peers with a wrong token and does not retry forever", async () => {
    const good = env.node("good");
    await good.start();
    const bad = new BridgeNode({ pipePath: env.pipe, token: "wrong", dbPath: env.db, agent: "other", name: "bad", cwd: env.home, autoWake: false, log: nullLogger });
    try {
      const started = Date.now();
      await expect(bad.start()).rejects.toMatchObject({ code: "unauthorized" });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect((await good.peers()).map((p) => p.name)).toEqual(["good"]);
    } finally {
      // A failed start still arms background re-election: without a stop it retries
      // forever and can open this home's store after teardown (AB-255).
      await bad.stop();
    }
  });

  it("refuses requests on connections that never authenticated", async () => {
    const good = env.node("good2");
    await good.start();
    const raw = await BridgeClient.connect(env.pipe, nullLogger);
    try {
      expect(await raw.request("ping", {})).toMatchObject({ protocol: PROTOCOL_VERSION });
      await expect(raw.request("peers", {})).rejects.toMatchObject({ code: "unauthorized" });
      await expect(raw.request("auth", { protocol: PROTOCOL_VERSION, token: "nope" })).rejects.toMatchObject({ code: "unauthorized" });
      await raw.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home) });
      expect(await raw.request("peers", {})).toHaveLength(1);
    } finally {
      raw.close();
    }
  });

  it("creates one token per home and reuses it", () => {
    expect(loadOrCreateToken(env.home)).toBe(loadOrCreateToken(env.home));
    expect(loadOrCreateToken(env.home)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("messaging", () => {
  it("delivers live messages and threads replies with hop counts", async () => {
    const claude = env.node("claude-x", "claude");
    const codex = env.node("codex-x", "codex");
    await claude.start();
    await codex.start();

    const sent = await claude.send({ to: "codex", body: "please review" });
    expect(sent.deliveredTo).toEqual(["codex-x"]);
    const got = await codex.waitForMessage(2_000);
    expect(got?.body).toBe("please review");
    expect(got?.hop).toBe(0);
    codex.markRead([got!.id]);

    await codex.send({ to: got!.from.name, body: "looks good", replyTo: got!.id });
    const reply = await claude.waitForMessage(2_000);
    expect(reply?.replyTo).toBe(got!.id);
    expect(reply?.conversationId).toBe(got!.conversationId);
    expect(reply?.hop).toBe(1);
  });

  it("queues for an agent kind when none is online and hands it to the first one that joins", async () => {
    const claude = env.node("claude-q", "claude");
    await claude.start();
    const res = await claude.send({ to: "codex", body: "whenever you are up" });
    expect(res.queuedFor).toEqual(["agent:codex"]);

    const codex = env.node("codex-q", "codex");
    await codex.start();
    await until(() => codex.unread().length === 1);
    expect(codex.unread()[0]!.body).toBe("whenever you are up");
  });

  it("does not redeliver read messages after reconnect", async () => {
    const a = env.node("a", "claude");
    await a.start();
    await a.send({ to: "b", body: "one" });
    const b = env.node("b", "codex");
    await b.start();
    await until(() => b.unread().length === 1);
    b.markRead(b.unread().map((m) => m.id));
    await b.stop();

    const b2 = env.node("b", "codex");
    await b2.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(b2.unread()).toHaveLength(0);
  });

  it("broadcasts to everyone except the sender", async () => {
    const [a, b, c] = [env.node("a"), env.node("b", "codex"), env.node("c", "other")];
    await a.start();
    await b.start();
    await c.start();
    const res = await a.send({ to: "*", body: "all hands" });
    expect(res.deliveredTo.sort()).toEqual(["b", "c"]);
    await until(() => b.unread().length === 1 && c.unread().length === 1);
    expect(a.unread()).toHaveLength(0);
  });

  it("rejects ambiguous agent-kind targets and self-sends", async () => {
    const a = env.node("claude-1", "claude");
    const b = env.node("codex-1", "codex");
    const c = env.node("codex-2", "codex");
    await Promise.all([a.start(), b.start(), c.start()]);
    await expect(a.send({ to: "codex", body: "hi" })).rejects.toMatchObject({ code: "ambiguous_target" });
    await expect(a.send({ to: "claude-1", body: "hi" })).rejects.toBeInstanceOf(BridgeError);
  });

  it("relocate renames the peer and hands over mail waiting under the new name", async () => {
    const a = env.node("claude-z", "claude");
    await a.start();
    await a.send({ to: "codex-realproject", body: "waiting for you" });
    const b = env.node("codex-plugin-dir", "codex");
    await b.start();
    await b.relocate("/work/realproject", "codex-realproject");
    expect(b.name).toBe("codex-realproject");
    expect(b.cwd).toBe("/work/realproject");
    await until(() => b.unread().length === 1);
    const peers = await a.peers();
    expect(peers.find((p) => p.id === b.id)?.cwd).toBe("/work/realproject");
  });

  it("peers report busy/idle, session id and version", async () => {
    const a = env.node("claude-s", "claude");
    const b = env.node("codex-s", "codex");
    await a.start();
    await b.start();
    b.setActivity("busy");
    await b.setSessionId("thread-1");
    await until(() => false, 200).catch(() => {});
    const seen = (await a.peers()).find((p) => p.name === "codex-s")!;
    expect(seen).toMatchObject({ activity: "busy", sessionId: "thread-1", version: expect.any(String) });
    b.setActivity("idle");
    await new Promise((r) => setTimeout(r, 100));
    expect((await a.peers()).find((p) => p.name === "codex-s")!.activity).toBe("idle");
  });

  it("wait_for_message honours its predicate and timeout", async () => {
    const a = env.node("a");
    const b = env.node("b", "codex");
    await a.start();
    await b.start();
    const waiting = b.waitForMessage(2_000, (m) => m.body === "second");
    await a.send({ to: "b", body: "first" });
    await a.send({ to: "b", body: "second" });
    expect((await waiting)?.body).toBe("second");
    expect(await b.waitForMessage(100, (m) => m.body === "never")).toBeNull();
  });
});

describe("job runner peers", () => {
  it("are reached by name only, never take a session's mail and speak as the job's agent", async () => {
    const claude = env.node("claude-j", "claude");
    await claude.start();
    // Mail for "any codex" waits for a real Codex session.
    await claude.send({ to: "codex", body: "for a codex session" });
    const runner = new BridgeNode({ pipePath: env.pipe, token: loadOrCreateToken(env.home), dbPath: env.db, agent: "other", jobAgent: "codex", id: "job:1a2b3c4d", name: "codex-job-1a2b3c4d", cwd: env.home, autoWake: false, log: nullLogger });
    const got: BridgeMessage[] = [];
    runner.on("message", (m) => got.push(m));
    await runner.start();
    try {
      expect((await claude.peers()).map((p) => p.name)).toEqual(["claude-j"]);
      await expect(claude.send({ to: "codex", body: "anyone?" })).resolves.toMatchObject({ deliveredTo: [], queuedFor: ["agent:codex"] });
      await claude.send({ to: "codex-job-1a2b3c4d", body: "{}", conversationId: "jobctl-1a2b3c4d" });
      await until(() => got.length === 1);
      expect(got[0]!.body).toBe("{}");
      await runner.send({ to: "claude-j", body: "result", conversationId: "job-1a2b3c4d" });
      await until(() => claude.unread().some((m) => m.body === "result"));
      expect(claude.unread().find((m) => m.body === "result")!.from).toEqual({ id: "job:1a2b3c4d", name: "codex-job-1a2b3c4d", agent: "codex" });
      const codex = env.node("codex-j", "codex");
      await codex.start();
      await until(() => codex.unread().length === 2);
      expect(codex.unread().map((m) => m.body)).toEqual(["for a codex session", "anyone?"]);
    } finally {
      await runner.stop();
    }
  });
});
