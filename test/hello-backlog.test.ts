import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv } from "./helpers.js";

it("answers hello and peers while a durable supervisor backlog route is blocked", async () => {
  const env = makeEnv(), store = new MessageStore(env.db, nullLogger), token = loadOrCreateToken(env.home);
  const registry = join(env.home, "jobs.json");
  const broker = new Broker(env.pipe, store, nullLogger, token, Date.now, registry);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let client: BridgeClient | undefined;
  let routed: Promise<void> | undefined;
  try {
    await broker.listen(); await broker.routePendingJobMail();
    const message = { id: randomUUID(), from: { id: "job:retained", name: "opencode-job-retained", agent: "opencode" },
      to: "reader", recipient: "reader", conversationId: "job-retained", replyTo: null, hop: 0, body: "RETAINED_COMPLETION", createdAt: Date.now(), readAt: null };
    writeFileSync(registry, JSON.stringify({ version: 4, jobs: [{ id: "retained", name: message.from.name, agent: "opencode",
      status: "done", owner: "reader", rootName: "reader", rootSession: "root", supervisor: "root", workdir: env.home, projectRoot: env.home,
      deliveryHistory: [message] }] }));
    const retry = store.retryWrite.bind(store);
    vi.spyOn(store, "retryWrite").mockImplementationOnce(async (operation) => { await blocked; return retry(operation); });
    routed = broker.routePendingJobMail();
    client = await BridgeClient.connect(env.pipe, nullLogger);
    const hello = await client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: { id: "reader", name: "reader", agent: "opencode",
      cwd: env.home, pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false } });
    expect(hello.name).toBe("reader");
    expect((await client.request("peers", {})).map((p) => p.name)).toContain("reader");
    expect(store.byId(message.id)).toBeNull();
    release(); await routed;
    expect(store.unread("reader", 10)).toEqual([message]);
  } finally {
    release(); await routed?.catch(() => {});
    vi.restoreAllMocks(); client?.close(); await broker.close(); await env.cleanup();
  }
});
