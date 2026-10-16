import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listRuns, RUN_SUMMARY_CACHE_MIN } from "../src/core/dashboard-read.js";
import * as preview from "../src/core/run-log-preview.js";
import * as history from "../src/core/message-history.js";
import { recentMessages } from "../src/cli/ui.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

it("keeps every run summary of a listing larger than the old fixed cache cap", () => {
  const runs = join(env.home, "runs");
  mkdirSync(runs, { recursive: true });
  const count = RUN_SUMMARY_CACHE_MIN + 52;
  for (let i = 0; i < count; i++) {
    const name = `2026-10-01-12-00-00-codex-${String(i).padStart(5, "0")}`;
    writeFileSync(join(runs, `${name}.log`), "12:00:00 codex\n         task\n         ---\n12:00:01 finished after 1s · done\n");
  }
  const reads = vi.spyOn(preview, "readRunLogPreview");
  expect(listRuns(env.home)).toHaveLength(count);
  expect(reads).toHaveBeenCalledTimes(count);
  // With a 2048 cap the second listing evicted what it needed and re-read every preview.
  reads.mockClear();
  expect(listRuns(env.home)).toHaveLength(count);
  expect(reads).not.toHaveBeenCalled();
});

it("reuses recent dashboard messages until a message database changes", () => {
  const store = new MessageStore(env.db, nullLogger);
  const message = (id: string, createdAt: number) => ({ id, from: { id: "a", name: "sender", agent: "codex" as const }, to: "receiver", recipient: "receiver",
    conversationId: `c-${id}`, replyTo: null, hop: 0, body: `body ${id}`, createdAt, readAt: null });
  try {
    store.insert(message("m1", 1_000));
    const search = vi.spyOn(history, "searchMessages");
    expect(recentMessages(env.db).map((row) => row.id)).toEqual(["m1"]);
    expect(recentMessages(env.db).map((row) => row.id)).toEqual(["m1"]);
    expect(search).toHaveBeenCalledTimes(1);
    // A returned row is a copy: a caller's change never alters the cached answer.
    recentMessages(env.db)[0]!.body = "changed by a caller";
    expect(recentMessages(env.db)[0]!.body).toBe("body m1");
    store.insert(message("m2", 2_000));
    expect(recentMessages(env.db).map((row) => row.id)).toEqual(["m2", "m1"]);
    expect(search).toHaveBeenCalledTimes(2);
  } finally { store.close(); }
});
