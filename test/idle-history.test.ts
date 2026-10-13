import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { HistoryIndex } from "../src/core/history.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv } from "./helpers.js";

it("finishes idle file sweeps and discovers unwatched appends on the bounded fallback", async () => {
  const env = makeEnv();
  const store = new MessageStore(env.db, nullLogger);
  const db = new DatabaseSync(env.db);
  const empty = join(env.home, "empty-native");
  const index = new HistoryIndex(db, env.home, { claude: empty, codex: empty, opencode: empty });
  let now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const drain = () => {
    for (let n = 0; n < 200; n++) {
      const result = index.tick(true);
      if (!result.work && !result.discovering) return;
    }
    throw new Error("Idle sweep did not converge");
  };
  try {
    const runs = join(env.home, "runs"); mkdirSync(runs);
    for (let i = 0; i < 40; i++) writeFileSync(join(runs, `2026-10-07-00-00-00-codex-${i}.log`), "00:00:00 retained original\n");
    drain();
    const checked = db.prepare("SELECT sum(checked) n FROM history_files").get()!.n;
    for (let i = 0; i < 10; i++) expect(index.tick(true)).toEqual({ work: 0, discovering: false });
    expect(db.prepare("SELECT sum(checked) n FROM history_files").get()!.n).toBe(checked);
    appendFileSync(join(runs, "2026-10-07-00-00-00-codex-39.log"), "00:00:01 bounded_fallback_append\n");
    now += 30_001; drain();
    expect(index.search({ query: "bounded_fallback_append" }).hits).toHaveLength(1);
    expect(index.tick()).toBeDefined(); // Explicit maintenance preserves complete-sweep behavior.
  } finally {
    vi.restoreAllMocks(); index.close(); db.close(); store.close(); await env.cleanup();
  }
});
