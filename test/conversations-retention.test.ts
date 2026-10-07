import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageStore } from "../src/core/store.js";
import {
  ConversationIngestor,
  readConversation,
  CONVERSATION_BYTES,
} from "../src/core/conversations.js";
import { HistoryIndex } from "../src/core/history.js";
import { MAX_TRANSCRIPT_CHUNK_BYTES } from "../src/core/transcripts/common.js";
import {
  conversationProject,
  ensureProjectFolder,
  projectDatabasePath,
} from "../src/core/project-store.js";
import { loadConfig } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import {
  installTranscriptFixtures,
  CLAUDE_SESSION,
} from "./transcript-fixtures.js";
import { makeEnv, type TestEnv } from "./helpers.js";

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
it("retains large Claude sidechains and connects nested native jobs through their parent sessions", () => {
  const f = fixture();
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
it("retains OpenCode messages, huge parts, native grandchildren and observed revisions", () => {
  const f = fixture(),
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
