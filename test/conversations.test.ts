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

let env: TestEnv;
let close: (() => void)[] = [];
beforeEach(() => {
  env = makeEnv();
  vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
});
afterEach(async () => {
  for (const f of close.reverse()) f();
  close = [];
  await env.cleanup();
  vi.unstubAllEnvs();
});
function fixture(claudeOnly = false) {
  const s = new MessageStore(env.db, nullLogger);
  close.push(() => s.close());
  const files = installTranscriptFixtures(env.home),
    db = new DatabaseSync(env.db);
  close.push(() => db.close());
  const project = join(env.home, "project");
  mkdirSync(project);
  execFileSync("git", ["init", project], {
    stdio: "ignore",
    windowsHide: true,
  });
  appendFileSync(
    files.claude,
    JSON.stringify({
      type: "user",
      cwd: project,
      message: { content: "durable_project_needle" },
    }) + "\n",
  );
  const cli = new DatabaseSync(files.sqlite);
  cli.exec("ALTER TABLE session ADD COLUMN directory TEXT");
  cli.prepare("UPDATE session SET directory=?").run(project);
  cli.close();
  // Byte retention and generation tests only exercise Claude. Keep unrelated
  // Codex/OpenCode fixtures outside discovery for those focused cases.
  const paths = claudeOnly ? {
    ...files.paths,
    codex: join(env.home, "empty-codex"),
    opencode: join(env.home, "empty-opencode"),
  } : files.paths;
  const index = new HistoryIndex(db, env.home, paths);
  close.push(() => index.close());
  const ingest = new ConversationIngestor(db, env.home, paths);
  close.push(() => ingest.close());
  const tick = (count = 80) => {
    let idleSweeps = 0;
    for (let i = 0; i < count; i++) {
      const indexed = index.tick();
      const ingested = ingest.tick();
      // Finish a complete idle source sweep instead of writing dozens of
      // redundant primary/mirror WAL batches after the fixture has converged.
      if (indexed.work || ingested) idleSweeps = 0;
      else if (!indexed.discovering && !ingest.discovering) idleSweeps++;
      if (idleSweeps >= 2)
        return;
    }
  };
  return { s, files, paths, db, project, index, ingest, tick };
}
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
it("pages complete context, keeps replaced generations and restores index from retained bytes", () => {
  const f = fixture(true);
  f.tick();
  const id = `claude:${CLAUDE_SESSION}`;
  const first = readConversation(f.db, { id, limit: 1 });
  expect(first.conversation?.project).toBe(conversationProject(f.project));
  const old = readFileSync(f.files.claude);
  renameSync(f.files.claude, `${f.files.claude}.old`);
  writeFileSync(
    f.files.claude,
    JSON.stringify({
      type: "user",
      message: { content: "replacement_retained_needle" },
    }) + "\n",
  );
  f.tick();
  expect(
    f.db
      .prepare(
        "SELECT DISTINCT generation FROM conversation_records WHERE source=?",
      )
      .all(f.files.claude),
  ).toHaveLength(2);
  expect(
    f.index.search({ query: "durable_project_needle" }).hits.length,
  ).toBeGreaterThan(0);
  f.index.reset();
  f.tick();
  expect(
    f.index.search({ query: "durable_project_needle" }).hits.length,
  ).toBeGreaterThan(0);
  let after = 0,
    records: ReturnType<typeof readConversation>["records"] = [];
  do {
    const page = readConversation(f.db, { id, after, limit: 1 });
    records.push(...page.records);
    if (page.next === null) break;
    expect(page.next).toBeGreaterThan(after);
    after = page.next;
  } while (true);
  expect(
    Buffer.concat(
      records
        .filter((r) => r.source === f.files.claude && r.generation === 0)
        .map((r) => Buffer.from(r.raw, "base64")),
    ),
  ).toEqual(old);
});
it("mirrors only its project, excludes via local Git config and rebuilds deleted mirrors", () => {
  const f = fixture();
  f.tick();
  const mirror = projectDatabasePath(conversationProject(f.project));
  expect(existsSync(mirror)).toBe(true);
  expect(
    readFileSync(join(f.project, ".git", "info", "exclude"), "utf8"),
  ).toContain("/.agent-bridge/");
  expect(existsSync(join(f.project, ".gitignore"))).toBe(false);
  const read = new DatabaseSync(mirror, { readOnly: true });
  const rows = read.prepare("SELECT * FROM conversation_records").all();
  expect(rows.length).toBeGreaterThan(0);
  expect(
    read.prepare("SELECT DISTINCT project FROM conversations").all(),
  ).toEqual([{ project: conversationProject(f.project) }]);
  read.close();
  rmSync(join(f.project, ".agent-bridge"), { recursive: true });
  f.tick();
  const rebuilt = new DatabaseSync(mirror, { readOnly: true });
  expect(rebuilt.prepare("SELECT * FROM conversation_records").all()).toEqual(
    rows,
  );
  rebuilt.close();
});
it("excludes an existing project folder when Git is initialized after mirroring starts", () => {
  const project = join(env.home, "late-git");
  mkdirSync(project);
  const folder = ensureProjectFolder(project)!;
  writeFileSync(join(folder, "config.json"), "{}");
  expect(ensureProjectFolder(project)).toBe(folder);
  execFileSync("git", ["init", project], { stdio: "ignore", windowsHide: true });
  expect(ensureProjectFolder(project)).toBe(folder);
  expect(ensureProjectFolder(project)).toBe(folder);
  const exclude = readFileSync(join(project, ".git", "info", "exclude"), "utf8");
  expect(exclude.split(/\r?\n/).filter((line) => line === "/.agent-bridge/")).toHaveLength(1);
  expect(execFileSync("git", ["-C", project, "check-ignore", ".agent-bridge/config.json"], { encoding: "utf8", windowsHide: true }).trim()).toBe(".agent-bridge/config.json");
  expect(existsSync(join(project, ".gitignore"))).toBe(false);
});
it("merges project settings over global and agent defaults without modifying either file", () => {
  const project = join(env.home, "project");
  mkdirSync(join(project, ".agent-bridge"), { recursive: true });
  const global = JSON.stringify({
      codexModel: "global",
      codex: { codexModel: "agent" },
      effort: { codex: "low" },
    }),
    local = JSON.stringify({
      codexModel: "project",
      effort: { codex: "high" },
      projectGroups: false,
      codexSubagents: 3,
    });
  writeFileSync(join(env.home, "config.json"), global);
  writeFileSync(join(project, ".agent-bridge", "config.json"), local);
  expect(loadConfig(env.home, "codex", nullLogger, {}, project)).toMatchObject({
    codexModel: "project",
    effort: { codex: "high" },
    projectGroups: false,
    codexSubagents: 3,
  });
  expect(readFileSync(join(env.home, "config.json"), "utf8")).toBe(global);
  expect(
    readFileSync(join(project, ".agent-bridge", "config.json"), "utf8"),
  ).toBe(local);
});
