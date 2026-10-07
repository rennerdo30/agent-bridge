import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
const jobs: BridgeNode[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const job of jobs.splice(0)) await job.stop();
  await env.cleanup();
});

it.each(["claude", "codex", "opencode", "antigravity"] as const)("recovers a lost %s send response with one durable message", async (agent) => {
  const sender = env.node("sender", agent), recipient = env.node("recipient", agent);
  await sender.start(); await recipient.start();
  const client = (sender as unknown as { client: BridgeClient }).client;
  const request = client.request.bind(client);
  let lost = false;
  const attempts: string[] = [];
  vi.spyOn(client, "request").mockImplementation(async (op, args: any) => {
    if (op !== "send") return request(op, args);
    attempts.push(args.dedupeKey);
    const result = await request(op, args);
    if (!lost) { lost = true; throw new Error("broker request timed out: send"); }
    return result;
  });
  const sent = await sender.send({ to: recipient.name, body: "RESPONSE_LOST" });
  expect(sent.deliveredTo).toEqual([recipient.name]);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBeTruthy(); expect(attempts[1]).toBe(attempts[0]);
  await until(() => recipient.unread().length === 1);
  expect(recipient.unread()[0]!.id).toBe(sent.messages[0]!.id);
  expect(await sender.messageReceipt(sent.messages[0]!.id)).toHaveLength(1);
});

it("recovers a sibling response without another note or supervisor observer copy", async () => {
  const owner = env.node("owner"); await owner.start();
  const records = ["one", "two"].map((id) => ({ id, name: `opencode-job-${id}`, agent: "opencode", status: "running", owner: "owner", rootName: "owner", rootSession: "root", supervisor: "root", workdir: env.home }));
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: records }));
  for (const record of records) {
    const node = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home),
      id: `job:${record.id}`, name: record.name, agent: "other", jobAgent: "opencode", jobOwner: "root", jobParent: owner.name,
      cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
    jobs.push(node); await node.start();
  }
  const sender = jobs[0]!, recipient = jobs[1]!;
  const client = (sender as unknown as { client: BridgeClient }).client, request = client.request.bind(client);
  let lost = false;
  vi.spyOn(client, "request").mockImplementation(async (op, args: any) => {
    const result = await request(op, args);
    if (op === "sendSibling" && !lost) { lost = true; throw new Error("broker request timed out: sendSibling"); }
    return result;
  });
  const sent = await sender.sendSibling({ to: recipient.name, body: "SIBLING_RESPONSE_LOST" }, 32);
  expect(sent.deliveredTo).toEqual([recipient.name]);
  await until(() => recipient.unread().length === 1 && owner.unread().length === 1);
  expect(owner.unread()[0]!.conversationId).toMatch(/:note$/);
  expect(recipient.unread()[0]!.body).toBe("SIBLING_RESPONSE_LOST");
});

it("reports unconfirmed delivery after two timeouts and does not retry permanent failures", async () => {
  const sender = env.node("sender"); await sender.start();
  const client = (sender as unknown as { client: BridgeClient }).client;
  const request = vi.spyOn(client, "request").mockRejectedValue(new Error("broker request timed out: send"));
  await expect(sender.send({ to: "offline", body: "uncertain" })).rejects.toThrow("Delivery is unconfirmed");
  expect(request).toHaveBeenCalledTimes(2);
  request.mockClear().mockRejectedValue(new Error("unauthorized target"));
  await expect(sender.send({ to: "offline", body: "denied" })).rejects.toThrow("unauthorized target");
  expect(request).toHaveBeenCalledTimes(1);
});
