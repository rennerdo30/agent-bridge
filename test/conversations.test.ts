import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { readConversation } from "../src/core/conversations.js";
import { conversationProject, ensureProjectFolder, projectDatabasePath } from "../src/core/project-store.js";
import { loadConfig } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { CLAUDE_SESSION } from "./transcript-fixtures.js";
import { env, fixture } from "./conversation-test-fixture.js";
import { fixturePeer, markOwned, ownedMessage } from "./owned-mail.js";

it("does not re-resolve and rewrite a conversation whose folder is no project on every tick", () => {
  const f = fixture(true);
  const changes = () => Number(f.db.prepare("SELECT total_changes() AS n").get()!.n);
  const idleWrites = () => { const start = changes(); for (let i = 0; i < 5; i++) f.ingest.tick(); return changes() - start; };
  f.tick();
  const baseline = idleWrites();
  // A leftover worktree folder whose git metadata was removed: it exists but resolves to no project.
  const plain = join(env.home, "plain-folder");
  mkdirSync(plain);
  writeFileSync(join(plain, ".git"), `gitdir: ${join(env.home, "removed-repo", ".git", "worktrees", "plain")}\n`);
  const transcript = join(f.paths.claude, "projects", "project-example", "session-plain.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", sessionId: "session-plain", cwd: plain, message: { content: "plain folder needle" } }) + "\n");
  f.index.registerChanged([transcript]);
  f.tick();
  expect(f.db.prepare("SELECT project FROM conversations WHERE id='claude:session-plain'").get()).toEqual({ project: "" });
  expect(idleWrites()).toBe(baseline);
});
it("refuses mismatched retained raw bytes during resumable import replay", () => {
  const f = fixture(true);
  f.tick();
  const row = f.db.prepare("SELECT * FROM conversation_records WHERE source=? ORDER BY offset LIMIT 1").get(f.files.claude)!;
  const source = readFileSync(f.files.claude);
  const retained = Buffer.from(row.raw as Uint8Array);
  const put = (f.ingest as unknown as { put(source: string, generation: number, offset: number, conversation: string, raw: Buffer, at: number): void }).put.bind(f.ingest);
  expect(() => put(String(row.source), Number(row.generation), Number(row.offset), String(row.conversation), Buffer.from("mismatched replay fixture"), Number(row.at)))
    .toThrow("History import verification failed");
  expect(Buffer.from(f.db.prepare("SELECT raw FROM conversation_records WHERE id=?").get(row.id!)!.raw as Uint8Array)).toEqual(retained);
  expect(readFileSync(f.files.claude)).toEqual(source);
});
it("retains mutable envelope versions and deduplicates the same replayed state", () => {
  const f = fixture(true);
  const owner = fixturePeer(f.s, "owner");
  f.s.insert(ownedMessage(f.s, owner, { id: "mutable", recipient: "owner", to: "owner", from: { id: "sender", name: "sender", agent: "codex" }, body: "retained envelope", conversationId: "mutable", replyTo: null, hop: 0, createdAt: 1, readAt: null }));
  f.tick();
  expect(markOwned(f.s, owner, ["mutable"], 20)).toBe(1);
  f.index.reset(); f.tick();
  const records = () => f.db.prepare("SELECT raw FROM conversation_records WHERE source='messages:mutable:owner'").all().map(row => JSON.parse(Buffer.from(row.raw as Uint8Array).toString()));
  expect(records().map(row => row.read_at)).toEqual(expect.arrayContaining([null, 20]));
  const count = records().length;
  f.index.reset(); f.tick();
  expect(records()).toHaveLength(count);
  expect(records().every(row => row.body === "retained envelope")).toBe(true);
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
it("mirrors only its project inside the custom home and rebuilds deleted mirrors", () => {
  const f = fixture();
  f.tick();
  const mirror = projectDatabasePath(conversationProject(f.project), env.home);
  expect(existsSync(mirror)).toBe(true);
  expect(existsSync(join(f.project, ".agent-bridge"))).toBe(false);
  expect(existsSync(join(f.project, ".gitignore"))).toBe(false);
  const read = new DatabaseSync(mirror, { readOnly: true });
  const rows = read.prepare("SELECT * FROM conversation_records").all();
  expect(rows.length).toBeGreaterThan(0);
  expect(
    read.prepare("SELECT DISTINCT project FROM conversations").all(),
  ).toEqual([{ project: conversationProject(f.project) }]);
  read.close();
  rmSync(join(env.home, "project-mirrors"), { recursive: true });
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
