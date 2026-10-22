import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import { fixtureJobReport, fixtureOwner, fixturePeer, ownedMessage, unreadOwned } from "./owned-mail.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv } from "./helpers.js";

it("answers hello and peers while a durable supervisor backlog route is blocked", async () => {
  const env = makeEnv(), store = new MessageStore(env.db, nullLogger), token = loadOrCreateToken(env.home);
  const registry = join(env.home, "jobs.json");
  const broker = new Broker(env.pipe, store, nullLogger, token, Date.now, registry);
  const reader = fixturePeer(store, "reader", { id: "reader", agent: "opencode", sessionId: "reader-session" });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let client: BridgeClient | undefined;
  let routed: Promise<void> | undefined;
  try {
    await broker.listen(); await broker.routePendingJobMail();
    const message = ownedMessage(store, reader, { id: randomUUID(), from: { id: "job:retained", name: "opencode-job-retained", agent: "opencode" },
      to: "reader", recipient: "reader", conversationId: "job-retained", replyTo: null, hop: 0, body: "RETAINED_COMPLETION", createdAt: Date.now(), readAt: null });
    const job = { id: "retained", name: message.from.name, agent: "opencode", startedAt: Date.now(),
      status: "done", owner: "reader", rootName: "reader", rootSession: "root", supervisor: "root", workdir: env.home, projectRoot: env.home,
      deliveryOwner: fixtureOwner(store, reader), deliveryOwners: { reader: fixtureOwner(store, reader) } };
    const report = fixtureJobReport(store, job, reader, reader, message);
    writeFileSync(registry, JSON.stringify({ version: 4, jobs: [{ ...job, deliveryHistory: [report.message], reportRouting: { [message.id]: report.draft } }] }));
    const retry = store.retryWrite.bind(store);
    vi.spyOn(store, "retryWrite").mockImplementationOnce(async (operation) => { await blocked; return retry(operation); });
    routed = broker.routePendingJobMail();
    client = await BridgeClient.connect(env.pipe, nullLogger);
    const hello = await client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: reader });
    expect(hello.name).toBe("reader");
    expect((await client.request("peers", {})).map((p) => p.name)).toContain("reader");
    expect(store.byId(message.id)).toBeNull();
    release(); await routed;
    expect(unreadOwned(store, reader, 10)).toEqual([{ ...report.message, jobRoute: { grant: message.id, generation: 0 } }]);
  } finally {
    release(); await routed?.catch(() => {});
    vi.restoreAllMocks(); client?.close(); await broker.close(); await env.cleanup();
  }
});
