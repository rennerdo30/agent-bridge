import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { JOBS_FILE, PROTOCOL_VERSION } from "../src/core/constants.js";
import { ProjectGroups } from "../src/core/project-groups.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, until } from "./helpers.js";

it("accepts a fresh hook connection between synchronous request starts in a burst", async () => {
  const env = makeEnv(), token = loadOrCreateToken(env.home);
  let slow = false, probe: Promise<BridgeClient[]> | undefined;
  const evidence = { starts: 0, completed: 0, connected: 0, probeSetupMs: 0, maxHandlerMs: 0, firstConnectAtStart: -1 };
  const hooks: BridgeClient[] = [];
  const clock = () => {
    if (slow) {
      if (!probe) {
        const setup = performance.now();
        probe = Promise.all(Array.from({ length: 6 }, () => BridgeClient.connect(env.pipe, nullLogger, 500)
          .then((client) => { if (!evidence.connected) evidence.firstConnectAtStart = evidence.starts; evidence.connected++; hooks.push(client); return client; })));
        evidence.probeSetupMs = performance.now() - setup;
        void probe.catch(() => {});
      }
      const end = performance.now() + 40;
      while (performance.now() < end) { /* Model bounded synchronous filesystem work. */ }
    }
    return Date.now();
  };
  const broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, token);
  const handlers = (broker as unknown as { handlers: { send: (...args: any[]) => unknown } }).handlers;
  const send = handlers.send;
  handlers.send = (...args) => {
    const began = performance.now(); evidence.starts++;
    try { clock(); return Promise.resolve(send(...args)).finally(() => { evidence.completed++; }); }
    finally { evidence.maxHandlerMs = Math.max(evidence.maxHandlerMs, performance.now() - began); }
  };
  let sender: BridgeClient | undefined, receiver: BridgeClient | undefined;
  try {
    await broker.listen();
    sender = await BridgeClient.connect(env.pipe, nullLogger);
    await sender.request("hello", { protocol: PROTOCOL_VERSION, token, peer: {
      id: "sender", name: "sender", agent: "other", cwd: env.home, pid: process.pid,
      agentPid: null, sessionId: "sender-session", startedAt: Date.now(), autoWake: false,
    } });
    receiver = await BridgeClient.connect(env.pipe, nullLogger);
    await receiver.request("hello", { protocol: PROTOCOL_VERSION, token, peer: {
      id: "receiver", name: "receiver", agent: "other", cwd: env.home, pid: process.pid,
      agentPid: null, sessionId: "receiver-session", startedAt: Date.now(), autoWake: false,
    } });
    slow = true;
    const burst = Array.from({ length: 24 }, (_, i) => sender!.request("send", { to: "receiver", body: `retained-${i}` }));
    const completed = Promise.all(burst); void completed.catch(() => {});
    await until(() => Boolean(probe));
    await Promise.all((await probe!).map((hook) => hook.request("auth", { protocol: PROTOCOL_VERSION, token })));
    expect((await completed).every((result) => result.messages.length === 1)).toBe(true);
    slow = false;
    expect((await receiver.request("pending", {}))).toHaveLength(24);
  } catch (error) {
    console.error(`Fresh-hook admission evidence: ${JSON.stringify({ ...evidence, deadlineMs: 500, expectedBurst: 24, expectedHooks: 6 })}`);
    throw error;
  } finally {
    slow = false;
    sender?.close(); receiver?.close(); for (const hook of hooks) hook.close();
    await broker.close(); await env.cleanup();
  }
});

it("checks only the exact sibling recipient in a fifty-job registry", async () => {
  const env = makeEnv(), token = loadOrCreateToken(env.home), clients: BridgeClient[] = [];
  const jobs = Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: `codex-job-${i}`, agent: "codex",
    status: "running", supervisor: "family", owner: "supervisor", rootSession: "family", rootName: "supervisor",
    projectRoot: env.home, workdir: env.home, startedAt: Date.now(), args: {} }));
  writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ version: 4, jobs }));
  const broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, token, Date.now, join(env.home, JOBS_FILE));
  try {
    await broker.listen();
    for (const i of [0, 1]) {
      const client = await BridgeClient.connect(env.pipe, nullLogger); clients.push(client);
      await client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: {
        id: `job:${i}`, name: `codex-job-${i}`, agent: "other", jobAgent: "codex", jobOwner: "family", jobParent: "supervisor",
        cwd: env.home, pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false,
      } });
    }
    await broker.routePendingJobMail();
    const roots = vi.spyOn(ProjectGroups.prototype, "jobRoot");
    const sent = await clients[0]!.request("sendSibling", { to: "codex-job-1", body: "exact recipient", maxHops: 3 });
    expect(roots.mock.calls.length).toBeLessThan(12);
    expect(sent.messages[0]?.recipient).toBe("codex-job-1");
    expect((await clients[1]!.request("pending", {})).some((message) => message.id === sent.messages[0]?.id)).toBe(true);
  } finally {
    vi.restoreAllMocks(); for (const client of clients) client.close();
    await broker.close(); await env.cleanup();
  }
});
