import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { readConversation } from "../src/core/conversations.js";
import { conversationProject } from "../src/core/project-store.js";
import { CLAUDE_SESSION } from "./transcript-fixtures.js";
import { fixture } from "./conversation-test-fixture.js";

it("retains large Claude sidechains and connects nested native jobs through their parent sessions", () => {
  const f = fixture(true);
  f.db
    .prepare(
      "INSERT INTO conversation_bindings(session,agent,cwd,job) VALUES(?,?,?,?)",
    )
    .run(CLAUDE_SESSION, "claude", f.project, "claude-job-deep");
  const inline =
    JSON.stringify({
      isSidechain: true,
      agentId: "inline-large",
      cwd: f.project,
      message: { content: "x".repeat(160_000) + " large_sidechain_tail 🐈" },
    }) + "\n";
  appendFileSync(f.files.claude, inline);
  let parent = join(dirname(f.files.claude), CLAUDE_SESSION);
  for (const child of ["child1", "child2", "child3"]) {
    const dir = join(parent, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `agent-${child}.jsonl`),
      JSON.stringify({
        sessionId: CLAUDE_SESSION,
        type: "user",
        message: { content: `native_depth_${child}` },
      }) + "\n",
    );
    parent = join(dir, child);
  }
  f.tick();
  const inlinePage = readConversation(f.db, {
    id: `claude:${CLAUDE_SESSION}:native:inline-large`,
  });
  expect(
    Buffer.concat(
      inlinePage.records.map((r) => Buffer.from(r.raw, "base64")),
    ).toString("utf8"),
  ).toBe(inline);
  expect(
    f.index.search({
      query: "large_sidechain_tail",
      filters: { job: "claude-job-deep" },
    }).hits.length,
  ).toBeGreaterThan(0);
  const grandchild = f.db
    .prepare("SELECT * FROM conversations WHERE session='child3'")
    .get()!;
  expect(grandchild.job).toBe("claude-job-deep");
  expect(grandchild.project).toBe(conversationProject(f.project));
  expect(
    f.index.search({
      query: "native_depth_child3",
      filters: { job: "claude-job-deep", project: f.project },
    }).hits.length,
  ).toBeGreaterThan(0);
});
