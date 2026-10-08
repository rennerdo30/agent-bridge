import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let runner: BridgeNode | undefined;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => {
  vi.restoreAllMocks();
  await runner?.stop();
  runner = undefined;
  await env.cleanup();
});

it("an established eligible host immediately elects after listener loss and retains queued mail", async () => {
  const previous = env.node("previous");
  const replacement = env.node("replacement");
  await previous.start(); await replacement.start();
  const sent = await replacement.send({ to: "later", body: "retained across listener replacement" });
  const schedule = vi.spyOn(replacement as unknown as { scheduleReconnect(delay: number): void }, "scheduleReconnect");
  vi.spyOn(Math, "random").mockReturnValue(0.999);
  await previous.stop();
  await until(() => replacement.isBroker && replacement.isConnected);
  expect(schedule).toHaveBeenCalledWith(0);
  const later = env.node("later");
  await later.start();
  await until(() => later.unread().length === 1);
  expect(later.unread()[0]!.id).toBe(sent.messages[0]!.id);
});

it("a non-hosting runner retains jitter and never opens a broker on listener loss", async () => {
  const previous = env.node("previous");
  await previous.start();
  runner = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home),
    name: "retained-runner", agent: "other", cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
  await runner.start();
  const schedule = vi.spyOn(runner as unknown as { scheduleReconnect(delay: number): void }, "scheduleReconnect");
  vi.spyOn(Math, "random").mockReturnValue(0.999);
  await previous.stop();
  await until(() => schedule.mock.calls.length > 0);
  expect(schedule.mock.calls[0]![0]).toBeGreaterThanOrEqual(100);
  expect(runner.isBroker).toBe(false);
});
