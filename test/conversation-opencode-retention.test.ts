

import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { CONVERSATION_BYTES } from "../src/core/conversations.js";
import { conversationProject } from "../src/core/project-store.js";
import { fixture } from "./conversation-test-fixture.js";

it("retains OpenCode messages, huge parts, native grandchildren and observed revisions", () => {
  const f = fixture('opencode'),
    cli = new DatabaseSync(f.files.sqlite);
  const data = JSON.stringify({
    type: "text",
    text: "q".repeat(CONVERSATION_BYTES * 3) + " opencode_full_tail",
  });
  cli.prepare("UPDATE part SET data=? WHERE id='prt_0'").run(data);
  cli.close();
  f.tick();
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
  f.tick();
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
