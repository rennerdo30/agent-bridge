import { afterEach, beforeEach, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./helpers.js";

// AB-493: a send interrupted before it returned an id must be checkable without re-sending (and duplicating) it.
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

it("lists the caller's own latest sends to an address, newest first, with read state", async () => {
  const sender = env.node("sender", "claude"), receiver = env.node("receiver", "codex"), other = env.node("other", "claude");
  await sender.start(); await receiver.start(); await other.start();
  const first = await sender.send({ to: "receiver", body: "first report" });
  const second = await sender.send({ to: "receiver", body: "second report" });
  await other.send({ to: "receiver", body: "not mine" });

  const listed = await sender.sentTo("receiver");
  expect(listed.messages.map((m) => m.id)).toEqual([second.messages[0]!.id, first.messages[0]!.id]);
  expect(listed.messages[0]!.preview).toBe("second report");
  expect(listed.messages[0]!.receipts).toEqual([{ recipient: "receiver", readAt: null }]);
  expect((await sender.sentTo("receiver", 1)).messages).toHaveLength(1);
  expect((await sender.sentTo("nobody")).messages).toEqual([]);
});
