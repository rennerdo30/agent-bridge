

import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { HISTORY_BATCH_MS } from "../src/core/history-store.js";
import { CONVERSATION_BYTES } from "../src/core/conversations.js";
import { conversationProject } from "../src/core/project-store.js";
import { fixture } from "./conversation-test-fixture.js";

it("retains OpenCode messages, huge parts, native grandchildren and observed revisions", () => {
  const f = fixture('opencode'),
    cli = new DatabaseSync(f.files.sqlite);
  // Retention semantics, independent of the wall-time slices exercised in the
  // scheduler tests. Keep all original byte/chunk bounds and convergence checks.
  const tick = () => {
    const phase = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try { f.tick(); } finally { phase.mockRestore(); }
  };
  const data = JSON.stringify({
    type: "text",
    text: "q".repeat(CONVERSATION_BYTES * 3) + " opencode_full_tail",
  });
  cli.prepare("UPDATE part SET data=? WHERE id='prt_0'").run(data);
  cli.close();
  tick();
  expect(
    f.index.search({
      query: "opencode_full_tail",
      filters: { agent: "opencode", project: conversationProject(f.project) },
    }).hits,
  ).toHaveLength(1);
  const c = f.db
    .prepare("SELECT * FROM conversations WHERE id='opencode:ses_grandchild'")
    .get()!;
  expect(c.parent).toBe("opencode:ses_child");
  expect(c.project).toBe(conversationProject(f.project));
  const before = f.db
    .prepare(
      "SELECT * FROM conversation_records WHERE conversation='opencode:ses_child'",
    )
    .all();
  const updated = new DatabaseSync(f.files.sqlite);
  updated
    .prepare(
      "UPDATE part SET data=?,time_updated=time_updated+1000 WHERE id='prt_0'",
    )
    .run(JSON.stringify({ type: "text", text: "later_opencode_revision" }));
  updated.close();
  // SIMULATED slow metadata work: consume the source slice before its first
  // read, without sleeping or adding load. Search can see the native revision
  // before ConversationIngestor retains it, so the row assertions below matter.
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const prepare = DatabaseSync.prototype.prepare;
  const slow = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql === "SELECT * FROM conversation_sources ORDER BY checked,id LIMIT 2") now += HISTORY_BATCH_MS;
    return prepare.call(this, sql);
  });
  try { tick(); } finally { slow.mockRestore(); clock.mockRestore(); }
  expect(
    f.index.search({
      query: "opencode_full_tail",
      filters: { agent: "opencode" },
    }).hits,
  ).toHaveLength(1);
  expect(
    f.index.search({
      query: "later_opencode_revision",
      filters: { agent: "opencode" },
    }).hits.length,
  ).toBeGreaterThan(0);
  const after = f.db
    .prepare(
      "SELECT * FROM conversation_records WHERE conversation='opencode:ses_child'",
    )
    .all();
  expect(after.length).toBeGreaterThan(before.length);
  for (const row of before)
    expect(after.find((r) => r.id === row.id)).toEqual(row);
  expect(after.some((r) => String(r.source).includes(":message:"))).toBe(true);
});
