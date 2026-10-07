import { appendFileSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ConversationIngestor } from "../src/core/conversations.js";
import { MAX_TRANSCRIPT_CHUNK_BYTES } from "../src/core/transcripts/common.js";
import { CLAUDE_SESSION } from "./transcript-fixtures.js";
import { env, close, fixture } from "./conversation-test-fixture.js";

it("retains oversized JSONL and skipped content exactly, deduplicates and resumes offsets", () => {
  const f = fixture(true),
    text =
      JSON.stringify({
        type: "system",
        content: "a".repeat(MAX_TRANSCRIPT_CHUNK_BYTES + 1) + " oversized_retained_tail 🐈",
      }) + "\n";
  appendFileSync(f.files.claude, text);
  const original = readFileSync(f.files.claude);
  f.tick();
  const rows = f.db
    .prepare(
      "SELECT raw FROM conversation_records WHERE source=? ORDER BY generation,offset",
    )
    .all(f.files.claude);
  expect(
    Buffer.concat(rows.map((r) => Buffer.from(r.raw as Uint8Array))),
  ).toEqual(original);
  expect(
    f.index.search({ query: "oversized_retained_tail" }).hits,
  ).toMatchObject([{ conversation: `claude:${CLAUDE_SESSION}` }]);
  const count = f.db
    .prepare("SELECT count(*) n FROM conversation_records")
    .get()!.n;
  f.tick(25);
  expect(
    f.db.prepare("SELECT count(*) n FROM conversation_records").get()!.n,
  ).toBe(count);
  const resumed = new ConversationIngestor(f.db, env.home, f.paths);
  close.push(() => resumed.close());
  resumed.tick();
  expect(
    f.db.prepare("SELECT count(*) n FROM conversation_records").get()!.n,
  ).toBe(count);
  expect(readFileSync(f.files.claude)).toEqual(original);
  expect(() => f.db.exec("DELETE FROM conversation_records")).toThrow(
    "append-only",
  );
});
