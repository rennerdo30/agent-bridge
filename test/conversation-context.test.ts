import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageStore } from "../src/core/store.js";
import { HistoryIndex, readHistory } from "../src/core/history.js";
import {
  conversationProject,
  projectDatabasePath,
} from "../src/core/project-store.js";
import {
  ConversationIngestor,
  readConversation,
} from "../src/core/conversations.js";
import { appendContextEvent } from "../src/core/context-journal.js";
import { openArchive } from "../src/core/sqlite-maintenance.js";
import { migrateSqlite } from "../src/core/sqlite-migrations.js";
import { nullLogger } from "../src/core/logger.js";
import { installTranscriptFixtures } from "./transcript-fixtures.js";
import { makeEnv, type TestEnv } from "./helpers.js";
let env: TestEnv,
  closers: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  env = makeEnv();
  vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
});
afterEach(async () => {
  for (const close of closers.reverse()) await close();
  closers = [];
  await env.cleanup();
  vi.unstubAllEnvs();
});
function setup(withTranscripts = true) {
  const store = new MessageStore(env.db, nullLogger);
  closers.push(() => store.close());
  const paths = withTranscripts ? installTranscriptFixtures(env.home).paths : {
    claude: join(env.home, "empty-claude"),
    codex: join(env.home, "empty-codex"),
    opencode: join(env.home, "empty-opencode"),
  },
    db = new DatabaseSync(env.db);
  closers.push(() => db.close());
  const index = new HistoryIndex(db, env.home, paths);
  closers.push(() => index.close());
  const ingest = new ConversationIngestor(db, env.home, paths);
  closers.push(() => ingest.close());
  const tick = () => {
    let idleSweeps = 0;
    for (let i = 0; i < 60; i++) {
      const indexed = index.tick();
      const ingested = ingest.tick();
      // Keep the bounded full-sweep check while avoiding idle WAL commits.
      if (indexed.work || ingested) idleSweeps = 0;
      else if (!indexed.discovering && !ingest.discovering) idleSweeps++;
      if (idleSweeps >= 2)
        return;
    }
  };
  return { store, index, ingest, db, paths, tick };
}
it("retains every recipient envelope, quiet copies, decisions, reports and progress/approval events", async () => {
  const f = setup();
  const cache = join(env.home,".codex","plugins","cache","fixture","1");
  mkdirSync(cache,{recursive:true});
  f.index.rememberPeer({id:"cache-peer",name:"codex-session-cache",agent:"codex",sessionId:"cache-session",cwd:cache});
  for (const [id, conversationId, recipient] of [
    ["direct", "direct", "owner"],
    ["quiet", "siblings-thread:note", "observer"],
    ["broadcast", "broadcast", "one"],
    ["broadcast", "broadcast", "two"],
    ["report", "job-report", "owner"],
    ["cache", "cache", "owner"],
  ] as const) {
    f.store.insert({
      id,
      recipient,
      conversationId,
      body: id === "report"
        ? `Subagent opencode-job-example (opencode) done after 1s.\n\n${"x".repeat(160_000)} context_report_needle`
        : `context_${id}_needle`,
      from: {
        id: id === "cache" ? "cache-peer" : "ses_child",
        name: id === "cache" ? "codex-session-cache" : id === "report" ? "claude-coordinator" : "opencode-job-example",
        agent: id === "cache" ? "codex" : id === "report" ? "claude" : "opencode",
      },
      to: recipient,
      replyTo: null,
      hop: 0,
      createdAt: 1,
      readAt: null,
    });
  }
  f.store.decisions.record(
    { topic: "local_context", text: "context_decision_needle", scope: "all" },
    { id: "owner", name: "owner", agent: "other" },
    2,
  );
  // Delivery can archive/claim messages before the background worker gets its first turn.
  // The append-only envelope keys must survive SQLite reusing every old rowid.
  const archive = openArchive(join(env.home, "archive.db"));
  for (const row of f.db.prepare("SELECT * FROM messages").all()) {
    archive
      .prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        row.id!,
        row.recipient!,
        row.from_id!,
        row.from_name!,
        row.from_agent!,
        row.to_target!,
        row.conversation_id!,
        row.reply_to!,
        row.hop!,
        row.body!,
        row.created_at!,
        row.read_at!,
        "test-archive",
        3,
      );
  }
  archive.close();
  f.db.exec("DELETE FROM messages");
  f.store.insert({
    id: "new",
    recipient: "owner",
    conversationId: "new",
    body: "context_rowid_reuse_needle",
    from: { id: "new-session", name: "owner", agent: "codex" },
    to: "owner",
    replyTo: null,
    hop: 0,
    createdAt: 4,
    readAt: null,
  });
  await Promise.all([
    appendContextEvent(env.home, {
      kind: "progress",
      agent: "opencode",
      job: "opencode-job-example",
      payload: { note: "context_progress_needle" },
    }),
    appendContextEvent(env.home, {
      kind: "approval",
      agent: "opencode",
      job: "opencode-job-example",
      payload: { decision: "deny", reason: "context_approval_needle" },
    }),
    appendContextEvent(env.home, {
      kind: "approval",
      agent: "opencode",
      job: "opencode-job-example",
      payload: {
        detail: "x".repeat(160_000) + " context_large_approval_needle 🐈",
      },
    }),
  ]);
  f.tick();
  for (const word of [
    "direct",
    "quiet",
    "broadcast",
    "report",
    "decision",
    "progress",
    "approval",
    "rowid_reuse",
    "large_approval",
    "cache",
  ])
    expect(
      f.index.search({ query: `context_${word}_needle` }).hits.length,
    ).toBeGreaterThan(0);
  const broadcast = readConversation(f.db, { id: "bridge:broadcast" });
  expect(readConversation(f.db,{id:"bridge:cache"}).records.length).toBeGreaterThan(0);
  expect(existsSync(join(cache,".agent-bridge"))).toBe(false);
  expect(f.index.search({query:"context_report_needle",filters:{kind:"report",job:"opencode-job-example",agent:"opencode"}}).hits.length).toBeGreaterThan(0);
  expect(broadcast.records).toHaveLength(2);
  expect(broadcast.records.map((r) => JSON.parse(r.text).recipient)).toEqual([
    "one",
    "two",
  ]);
  expect(
    f.index.search({
      query: "context_approval_needle",
      filters: {
        kind: "approval",
        agent: "opencode",
        job: "opencode-job-example",
      },
    }).hits.length,
  ).toBeGreaterThan(0);
  const complete = readConversation(f.db, {
    id: "bridge:job:opencode-job-example",
  });
  expect(
    Buffer.concat(
      complete.records.map((r) => Buffer.from(r.raw, "base64")),
    ).toString("utf8"),
  ).toContain("context_large_approval_needle 🐈");
});
it("filters mixed-sender raw chunks correctly after a late job/project binding and reindex", () => {
  const f = setup(false),
    project = join(env.home, "late-project");
  mkdirSync(project);
  const firstProject = join(env.home, "first-project");
  mkdirSync(firstProject);
  f.index.rememberPeer({
    id: "peer-first",
    name: "claude-job-first",
    agent: "claude",
    sessionId: "native-first",
    cwd: firstProject,
  });
  for (const [id, agent, body] of [
    ["first", "claude", "first_sender_context"],
    ["second", "codex", "x".repeat(160_000) + " mixed_sender_tail"],
  ] as const) {
    f.store.insert({
      id,
      recipient: "owner",
      conversationId: "mixed",
      body,
      from: { id: `peer-${id}`, name: `${agent}-job-${id}`, agent },
      to: "owner",
      replyTo: null,
      hop: 0,
      createdAt: 1,
      readAt: null,
    });
  }
  f.tick();
  expect(
    f.index.search({ query: "mixed_sender_tail", filters: { agent: "codex" } })
      .hits.length,
  ).toBeGreaterThan(0);
  expect(
    f.index.search({ query: "mixed_sender_tail", filters: { agent: "claude" } })
      .hits,
  ).toHaveLength(0);
  f.index.rememberPeer({
    id: "peer-second",
    name: "codex-job-second",
    agent: "codex",
    sessionId: "native-second",
    cwd: project,
  });
  f.tick();
  expect(
    f.index.search({
      query: "mixed_sender_tail",
      filters: {
        agent: "codex",
        project,
        session: "native-second",
        job: "codex-job-second",
      },
    }).hits.length,
  ).toBeGreaterThan(0);
  const mirrorPath = projectDatabasePath(conversationProject(project), env.home);
  const mirror = new DatabaseSync(mirrorPath, { readOnly: true });
  try {
    expect(readConversation(mirror, { id: "bridge:mixed" }).records).toEqual(
      readConversation(f.db, { id: "bridge:mixed" }).records,
    );
  } finally {
    mirror.close();
  }
  expect(
    readHistory(mirrorPath, {
      query: "mixed_sender_tail",
      filters: {
        agent: "codex",
        project,
        job: "codex-job-second",
        session: "native-second",
      },
    }).hits.length,
  ).toBeGreaterThan(0);
  f.index.reset();
  f.tick();
  expect(
    f.index.search({
      query: "mixed_sender_tail",
      filters: { agent: "codex", project, job: "codex-job-second" },
    }).hits.length,
  ).toBeGreaterThan(0);
  // Restart fairness must use persisted mirror scheduling too when there are
  // no CLI sources whose checked counter could otherwise seed the worker.
  f.db.exec("UPDATE conversation_projects SET checked=checked+1000000");
  const beforeRestart = Number(f.db.prepare("SELECT max(checked) n FROM conversation_projects").get()!.n);
  f.ingest.close();
  const restarted = new ConversationIngestor(f.db, env.home, f.paths);
  closers.push(() => restarted.close());
  restarted.tick();
  expect(Number(f.db.prepare("SELECT max(checked) n FROM conversation_projects").get()!.n)).toBeGreaterThan(beforeRestart);
});
it("backfills oversized archived approvals without retaining their listening capabilities", () => {
  const f = setup(),
    dir = join(env.home, "archive", "approvals");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "legacy-large.json"),
    command = "x".repeat(160_000) + " legacy_approval_tail 🐈";
  const original = JSON.stringify({
    id: "legacy-large",
    owner: "owner",
    job: "opencode-job-legacy",
    agent: "opencode",
    tool: "edit",
    command,
    askedAt: 1,
    deadline: 2,
    pid: 123,
    port: 456,
    token: "local-capability-value",
  });
  writeFileSync(path, original);
  f.tick();
  const page = readConversation(f.db, { id: "bridge:job:opencode-job-legacy" });
  const copy = JSON.parse(
    Buffer.concat(
      page.records.map((r) => Buffer.from(r.raw, "base64")),
    ).toString("utf8"),
  );
  expect(copy.command).toBe(command);
  expect(copy.token).toBeUndefined();
  expect(copy.port).toBeUndefined();
  expect(copy.pid).toBeUndefined();
  expect(
    f.index.search({
      query: "legacy_approval_tail",
      filters: {
        kind: "approval",
        agent: "opencode",
        job: "opencode-job-legacy",
      },
    }).hits.length,
  ).toBeGreaterThan(0);
  expect(readFileSync(path, "utf8")).toBe(original);
});
it("upgrades the complete 0.29.10 disk layout without losing any old records", () => {
  const db = new DatabaseSync(env.db);
  db.exec(
    readFileSync(
      join(import.meta.dirname, "fixtures/upgrade/bridge-v6.sql"),
      "utf8",
    ),
  );
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "old",
    "owner",
    "old-session",
    "opencode-old",
    "opencode",
    "owner",
    "old-chat",
    null,
    0,
    "old_live_needle",
    1,
    2,
  );
  const old = db.prepare("SELECT * FROM messages").all();
  db.close();
  const archive = openArchive(join(env.home, "archive.db"));
  archive
    .prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "cold",
      "owner",
      "old-session",
      "opencode-old",
      "opencode",
      "owner",
      "old-chat",
      null,
      0,
      "old_archive_needle",
      1,
      2,
      "legacy",
      3,
    );
  const archived = archive.prepare("SELECT * FROM messages").all();
  archive.close();
  const files = {
    "jobs.json": JSON.stringify({
      version: 2,
      jobs: [
        {
          id: "old-job",
          name: "opencode-job-old",
          agent: "opencode",
          status: "done",
          sessionId: "ses_child",
          prompt: "old_prompt_needle",
          unknown: { keep: true },
        },
      ],
    }),
    "config.json": JSON.stringify({
      version: 2,
      opencodeModel: "provider/model",
      unknown: { keep: true },
    }),
    "runs/old.log": "old_run_needle\n",
    "runs/old.json": JSON.stringify({
      version: 2,
      job: "opencode-job-old",
      session: "ses_child",
      unknown: { keep: true },
    }),
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(env.home, file, ".."), { recursive: true });
    writeFileSync(join(env.home, file), text);
  }
  const f = setup();
  f.tick();
  expect(f.db.prepare("SELECT * FROM messages").all()).toEqual(old);
  const cold = new DatabaseSync(join(env.home, "archive.db"), {
    readOnly: true,
  });
  expect(cold.prepare("SELECT * FROM messages").all()).toEqual(archived);
  cold.close();
  for (const [file, text] of Object.entries(files))
    expect(readFileSync(join(env.home, file), "utf8")).toBe(text);
  for (const query of [
    "old_live_needle",
    "old_archive_needle",
    "old_prompt_needle",
    "old_run_needle",
  ])
    expect(f.index.search({ query }).hits.length).toBeGreaterThan(0);
  const backupPath = readdirSync(env.home).find((n) =>
    n.startsWith("bridge.db.backup-"),
  )!;
  const backup = new DatabaseSync(join(env.home, backupPath), {
    readOnly: true,
  });
  expect(backup.prepare("PRAGMA user_version").get()!.user_version).toBe(6);
  expect(backup.prepare("SELECT * FROM messages").all()).toEqual(old);
  backup.close();
  const before = f.db.prepare("SELECT * FROM conversation_records").all();
  const version = Number(
    f.db.prepare("PRAGMA user_version").get()!.user_version,
  );
  expect(() =>
    migrateSqlite(
      f.db,
      env.db,
      true,
      version + 1,
      [
        {
          version: version + 1,
          sql: "CREATE TABLE future_keep(id TEXT); SELECT * FROM missing;",
        },
      ],
      nullLogger,
    ),
  ).toThrow();
  expect(f.db.prepare("SELECT * FROM conversation_records").all()).toEqual(
    before,
  );
  expect(
    f.db
      .prepare("SELECT name FROM sqlite_master WHERE name='future_keep'")
      .get(),
  ).toBeUndefined();
  expect(() => migrateSqlite(f.db, env.db, true, 6, [], nullLogger)).toThrow(
    "unsupported",
  );
  expect(f.db.prepare("SELECT * FROM messages").all()).toEqual(old);
});
it("exposes context search and fetch to an OpenCode delegated MCP session", async () => {
  const f = setup();
  f.tick();
  const server = join(
    import.meta.dirname,
    "../plugins/opencode/dist/server.mjs",
  );
  expect(existsSync(server)).toBe(true);
  const client = new Client({ name: "context-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server, "--agent=opencode"],
    cwd: env.home,
    env: {
      ...(process.env as Record<string, string>),
      AGENT_BRIDGE_HOME: env.home,
      AGENT_BRIDGE_DELEGATE_DEPTH: "1",
      AGENT_BRIDGE_PARENT_URL: "http://127.0.0.1:1",
      AGENT_BRIDGE_PARENT_TOKEN: "fixture",
      AGENT_BRIDGE_PARENT_NAME: "owner",
      CLAUDE_CONFIG_DIR: join(env.home, "claude"),
      CODEX_HOME: join(env.home, "codex"),
      XDG_DATA_HOME: env.home,
    },
    stderr: "pipe",
  });
  closers.push(() => client.close());
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toContain("search_history");
  expect(names).toContain("get_conversation");
  const result = await client.callTool({
    name: "search_history",
    arguments: { query: "module", filters: { agent: "opencode" } },
  });
  expect(result.isError).not.toBe(true);
  const page = await client.callTool({
    name: "get_conversation",
    arguments: { id: "opencode:ses_child", limit: 1 },
  });
  expect(page.isError).not.toBe(true);
  const plugin = readFileSync(
    join(import.meta.dirname, "../src/opencode/plugin.ts"),
    "utf8",
  );
  expect(plugin).toContain('const TOOL_PREFIX = "bridge_"');
  expect(plugin).toContain("mcp.listTools()");
});
