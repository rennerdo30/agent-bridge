import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localMailbox } from "../src/core/recipient-ownership.js";
import { nullLogger } from "../src/core/logger.js";
import { JobManager, readStore, type Run } from "../src/mcp/jobs.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv, jobs: JobManager | undefined;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { jobs?.setDormant(true); jobs?.cancelAll(); jobs = undefined; vi.restoreAllMocks(); await env.cleanup(); });

it("delivers the durable pre-admission remote cancellation only to its original local supervisor, with exact replay", async () => {
  const source = env.node("supervisor", "codex", false, "original-supervisor"); await source.start();
  const broker = (source as any).broker, store = broker.store;
  jobs = new JobManager(source, nullLogger, join(env.home, "jobs.json"));
  jobs.runners = { state: () => null, alive: () => false, send() {}, kill() {} };
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const inline = vi.fn(async () => ({ text: "must not launch inline", sessionId: null, isError: false, details: {} }));
  const run: Run = Object.assign(inline, { hosted: (_job: unknown, gate: any) => new Promise<null>((_resolve, reject) => {
    entered(); gate.signal.addEventListener("abort", () => reject(new Error("cancelled before runner startup")), { once: true });
  }) });
  const report = source.reportInlineJob.bind(source);
  let attempts = 0;
  const errors: string[] = [];
  vi.spyOn(source, "reportInlineJob").mockImplementation(async message => {
    let result;
    try { result = await report(message); } catch (error) { errors.push(String(error)); throw error; }
    if (++attempts === 1) throw new Error("lost successful storage response");
    return result;
  });
  const job = jobs.start("claude", null, "retained original remote task", run, undefined, { host: "paired", title: "Cancel startup" });
  await ready; expect(jobs.cancel(job.name)).toBe(true);
  try { await until(() => attempts === 2); } catch { expect(errors).toEqual([]); throw new Error(`Successful report replay did not settle: ${JSON.stringify({ status: job.status, envelopes: job.deliveryHistory?.length, pending: (jobs as any).pendingReports.size, attempts })}`); }
  const saved = readStore(join(env.home, "jobs.json")).find(row => row.id === job.id)!;
  expect(saved).toMatchObject({ status: "cancelled", prompt: job.prompt, args: { host: "paired" }, host: null });
  expect(saved.deliveryHistory).toHaveLength(1);
  const message = saved.deliveryHistory![0]!;
  expect(source.unread().filter(m => m.id === message.id)).toHaveLength(1);
  expect(store.messagesById(message.id)).toEqual([expect.objectContaining({ body: message.body, senderOwner: source.mailboxOwner(), recipientMailbox: localMailbox(store.namespace) })]);
  expect(store.jobRoutingGrant(message.id)).toBeNull(); // A remote proxy never acquires local succession authority.
  expect(inline).not.toHaveBeenCalled();
  const rejected = [
    { ...message, body: "forged result" },
    { ...message, id: randomUUID() },
    { ...message, from: { ...message.from, id: "job:another" } },
    { ...message, recipientMailbox: localMailbox("f".repeat(64)) },
    { ...message, senderMailbox: { kind: "remote" as const, hostId: randomUUID(), hostFingerprint: "a".repeat(64) } },
    { ...message, senderOwner: "native:unproven" },
  ];
  for (const forged of rejected) await expect(report(forged)).rejects.toMatchObject({ code: "unauthorized" });
  jobs.setDormant(true);
  await source.stop();
  const reconnect = env.node("supervisor", "codex", false, "original-supervisor"); await reconnect.start();
  const reopened = (reconnect as any).broker.store;
  await expect(reconnect.reportInlineJob(message)).resolves.toEqual({ saved: true });
  expect(reconnect.unread().filter(m => m.id === message.id)).toHaveLength(1);
  reconnect.markRead([message.id]);
  await expect.poll(() => reopened.receipts(message.id)[0]?.readAt).toBeTypeOf("number");
  await expect(reconnect.reportInlineJob(message)).resolves.toEqual({ saved: true });
  expect(reconnect.unread().some(m => m.id === message.id)).toBe(false);
  const accepted = reopened.messagesById(message.id);
  await reconnect.stop();
  const replacement = env.node("supervisor", "codex", false, "different-supervisor"); await replacement.start();
  await expect(replacement.reportInlineJob(message)).rejects.toMatchObject({ code: "unauthorized" });
  expect(replacement.unread().some(m => m.id === message.id)).toBe(false);
  expect((replacement as any).broker.store.messagesById(message.id)).toEqual(accepted);
});
