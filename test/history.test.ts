import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECISIONS_SCHEMA } from "../src/core/decisions.js";
import { DEFAULT_CONFIG, loadConfig, saveConfigValue } from "../src/core/config.js";
import { HistoryIndex, HISTORY_CHUNK_BYTES, HISTORY_ROWS_PER_SOURCE, readHistory } from "../src/core/history.js";
import { answerHistory, type HistoryAnswerDependencies } from "../src/core/history-answer.js";
import { historySchema, supportsHistoryFts } from "../src/core/history-schema.js";
import { nullLogger } from "../src/core/logger.js";
import { migrateSqlite } from "../src/core/sqlite-migrations.js";
import { BridgeClient } from "../src/core/client.js";
import { MessageStore } from "../src/core/store.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { makeEnv, type TestEnv } from "./helpers.js";
import { installTranscriptFixtures } from "./transcript-fixtures.js";
import { runReindex } from "../src/cli/reindex.js";
import { startUi } from "../src/cli/ui.js";

const OLD_SCHEMA = `CREATE TABLE messages (
  id TEXT NOT NULL, recipient TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL,
  from_agent TEXT NOT NULL, to_target TEXT NOT NULL, conversation_id TEXT NOT NULL, reply_to TEXT,
  hop INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER, PRIMARY KEY(id,recipient));`;
let env: TestEnv;
const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => { env = makeEnv(); vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0"); vi.stubEnv("CLAUDE_CONFIG_DIR", join(env.home, "claude")); vi.stubEnv("CODEX_HOME", join(env.home, "codex")); vi.stubEnv("XDG_DATA_HOME", env.home); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); await env.cleanup(); vi.unstubAllEnvs(); });
function store(): MessageStore { const s = new MessageStore(env.db, nullLogger); cleanups.push(() => s.close()); return s; }
function message(id: string, body = "walnut history needle", recipient = "claude-main", at = 100): BridgeMessage {
  return { id, body, recipient, from: { id: "session-one", name: "codex-job-example", agent: "codex" }, to: recipient, conversationId: "conversation-one", replyTo: null, hop: 0, createdAt: at, readAt: null };
}
function fixtureIndex(s: MessageStore): HistoryIndex {
  const fixtures = installTranscriptFixtures(env.home), db = new DatabaseSync(env.db);
  cleanups.push(() => db.close());
  const index = new HistoryIndex(db, env.home, fixtures.paths); cleanups.push(() => index.close());
  return index;
}
function drain(index: HistoryIndex): void {
  for (let n = 0; n < 100; n++) { const result = index.tick(); if (!result.work && !result.discovering) return; }
  throw new Error("Index did not finish bounded backlog");
}

describe("history migration", () => {
  it.each([0, 1, 2, 3])("backs up v%i before v4 and preserves source data and read state", (version) => {
    const db = new DatabaseSync(env.db); db.exec(OLD_SCHEMA);
    if (version >= 2) db.exec("CREATE TABLE archived_messages AS SELECT *, '' AS archive_reason, 0 AS archived_at FROM messages WHERE 0");
    if (version >= 3) db.exec(DECISIONS_SCHEMA);
    db.exec(`PRAGMA user_version=${version}`);
    db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("original", "claude-main", "session-one", "codex-job-example", "codex", "claude-main", "c", null, 0, "original walnut", 100, 200);
    db.close();
    const s = store(); s.history.tick();
    expect(s.byId("original")).toMatchObject({ body: "original walnut", readAt: 200 });
    const backupFile = readdirSync(env.home).find((name) => name.startsWith("bridge.db.backup-"))!;
    const backup = new DatabaseSync(join(env.home, backupFile), { readOnly: true });
    expect(backup.prepare("PRAGMA user_version").get()!.user_version).toBe(version);
    expect(backup.prepare("SELECT body,read_at FROM messages").get()).toMatchObject({ body: "original walnut", read_at: 200 }); backup.close();
    expect(readHistory(env.db, { query: "walnut" }).hits).toHaveLength(1);
  });
  it("retains v4 FTS rowids and matches when a future migration rolls back", () => {
    const s = store(); s.insert(message("one")); s.insert(message("two", "walnut second")); s.history.tick();
    const db = new DatabaseSync(env.db); cleanups.push(() => db.close());
    db.prepare("DELETE FROM history_documents WHERE id='message:one'").run();
    const rows = db.prepare("SELECT rowid,id FROM history_documents ORDER BY rowid").all();
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    expect(() => migrateSqlite(db, env.db, true, version + 1, [{ version: version + 1, sql: `ALTER TABLE messages ADD COLUMN future TEXT; UPDATE history_documents SET body='changed'; SELECT invalid FROM missing; PRAGMA user_version=${version + 1};` }], nullLogger)).toThrow();
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(version);
    expect(db.prepare("SELECT rowid,id FROM history_documents ORDER BY rowid").all()).toEqual(rows);
    expect(s.history.search({ query: "walnut second" }).hits).toMatchObject([{ message: "two" }]);
    expect(s.byId("two")!.body).toBe("walnut second");
  });
  it("probes real FTS5 and supports a documented plain fallback schema", () => {
    expect(typeof supportsHistoryFts()).toBe("boolean");
    const db = new DatabaseSync(":memory:"); db.exec(`${OLD_SCHEMA} CREATE TABLE decisions (revision INTEGER, id TEXT, scope TEXT); ${historySchema(false)}`);
    const index = new HistoryIndex(db, null);
    db.prepare("INSERT INTO history_documents VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("plain", "run", "other", 1, "Café walnut", "cafe walnut", "/plain", null, null, null, null, null);
    expect(index.search({ query: "CAFÉ walnut" })).toMatchObject({ engine: "plain", hits: [{ id: "plain" }] });
    expect(index.search({ query: "' OR 1=1 --" }).hits).toEqual([]); db.close();
  });
});

describe("incremental source indexing", () => {
  it("indexes bounded message batches, duplicate recipients, live inserts and archived rows", () => {
    const s = store();
    for (let n = 0; n < HISTORY_ROWS_PER_SOURCE * 3; n++) s.insert(message(`m${n}`));
    s.history.tick();
    const db = new DatabaseSync(env.db); cleanups.push(() => db.close());
    expect(Number(db.prepare("SELECT count(*) AS n FROM history_documents").get()!.n)).toBeLessThanOrEqual(HISTORY_ROWS_PER_SOURCE * 2);
    s.history.tick(); s.history.tick();
    s.insert(message("m0", "walnut history needle", "another-session")); s.history.tick();
    expect(s.history.search({ query: "walnut", filters: { session: "another-session" } }).hits).toHaveLength(1);
    s.purgeOlderThan(101); s.history.reset();
    for (let n = 0; n < 4; n++) s.history.tick();
    expect(s.history.search({ query: "walnut", limit: 50 }).hits).toHaveLength(50);
    s.insert(message("new", "fresh walnut")); s.history.tick();
    expect(s.history.search({ query: "fresh" }).hits).toMatchObject([{ message: "new" }]);
    expect(s.byId("new")!.readAt).toBeNull();
  });
  it("captures claimed recipients after the primary cursor has already passed the message", () => {
    const s = store(); s.insert(message("claim", "walnut queue", "agent:claude")); s.history.tick();
    expect(s.history.search({ query: "walnut", filters: { session: "claimed-peer" } }).hits).toEqual([]);
    expect(s.claim("agent:claude", "claimed-peer")).toBe(1); s.history.tick();
    expect(s.history.search({ query: "walnut", filters: { session: "claimed-peer" } }).hits).toHaveLength(1);
    expect(s.unread("claimed-peer", 10)).toHaveLength(1);
  });
  it("resumes persisted cursors, indexes decisions and rebuilds without altering sources", () => {
    const s = store(); s.insert(message("one"));
    const decision = s.decisions.record({ topic: "walnut", text: "Keep the source safe", scope: { sessions: ["scoped-session"] } }, { id: "owner", name: "you", agent: "other" }, 500);
    s.history.tick();
    const db = new DatabaseSync(env.db); cleanups.push(() => db.close());
    const resumed = new HistoryIndex(db, null);
    expect(resumed.tick().work).toBe(0);
    expect(resumed.search({ query: "walnut", filters: { kind: "decision", session: "scoped-session" } }).hits).toMatchObject([{ id: `decision:${decision.id}` }]);
    const before = db.prepare("SELECT * FROM messages").all();
    resumed.reset(); expect(resumed.search({ query: "walnut" }).hits).toEqual([]); resumed.tick();
    expect(db.prepare("SELECT * FROM messages").all()).toEqual(before);
    expect(resumed.search({ query: "walnut" }).hits).toHaveLength(2);
  });
  it("indexes all three CLI readers and native children, then only appended JSONL", () => {
    const s = store(), index = fixtureIndex(s); drain(index);
    const hits = index.search({ query: "module", limit: 50 }).hits;
    expect(new Set(hits.map((h) => h.agent))).toEqual(new Set(["claude", "codex", "opencode"]));
    expect(hits.every((h) => h.session && h.cursor && h.link.includes("session="))).toBe(true);
    const file = join(env.home, "claude", "projects", "project-example", "session-example.jsonl");
    appendFileSync(file, JSON.stringify({ type: "user", timestamp: "2026-10-06T09:20:00Z", message: { content: "appended pineapple" } }) + "\n");
    drain(index);
    const added = index.search({ query: "pineapple" }).hits;
    expect(added).toHaveLength(1); expect(added[0]!.cursor).toMatch(/^j:\d+:0$/);
    drain(index); expect(index.search({ query: "pineapple" }).hits).toEqual(added);
    const db = new DatabaseSync(join(env.home, "opencode", "opencode.db"));
    db.prepare("UPDATE part SET data=?,time_updated=time_updated+10000 WHERE id='prt_0'").run(JSON.stringify({ type: "text", text: "updated cranberry" })); db.close();
    drain(index); expect(index.search({ query: "cranberry" }).hits).toHaveLength(1);
  });
  it("maps late run metadata to transcript jobs without rewriting source files", () => {
    const s = store(), index = fixtureIndex(s), run = "2026-10-06-09-00-00-codex-late.log", file = join(env.home, "runs", run);
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "09:00:00 walnut metadata\n");
    const metaFile = file.replace(/\.log$/, ".json"); writeFileSync(metaFile, "{corrupt");
    drain(index);
    expect(readFileSync(metaFile, "utf8")).toBe("{corrupt");
    expect(readdirSync(dirname(file)).some((name) => name.includes("corrupt-"))).toBe(false);
    writeFileSync(metaFile, JSON.stringify({ job: "codex-job-linked", session: "00000000-0000-4000-8000-000000000000", jobStartedAt: 1234 }));
    drain(index);
    expect(index.search({ query: "module", filters: { kind: "transcript", job: "codex-job-linked" } }).hits).toEqual(expect.arrayContaining([expect.objectContaining({ agent: "codex", job: "codex-job-linked" })]));
    expect(index.search({ query: "walnut", filters: { session: "00000000-0000-4000-8000-000000000000" } }).hits).toHaveLength(1);
    writeFileSync(metaFile, JSON.stringify({ job: "codex-job-linked", session: "00000000-0000-4000-8000-000000000000", model: "metadata-model-cantaloupe", futureField: "preserved" }));
    drain(index);
    const metadata = index.search({ query: "cantaloupe", filters: { kind: "run" } }).hits;
    expect(metadata).toHaveLength(1); expect(metadata[0]!.id).toBe(`run:${run}:metadata`);
    drain(index); expect(index.search({ query: "cantaloupe" }).hits).toEqual(metadata);
    expect(readFileSync(file, "utf8")).toBe("09:00:00 walnut metadata\n");
  });
  it("indexes run chunks and metadata, retries partial lines and includes archived logs", () => {
    const s = store(), index = fixtureIndex(s), run = "2026-10-06-09-00-00-codex-example.log", file = join(env.home, "runs", "archive", run);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "09:00:00 walnut run\n" + "x".repeat(HISTORY_CHUNK_BYTES) + "\npartial pineapple");
    writeFileSync(file.replace(/\.log$/, ".json"), JSON.stringify({ job: "codex-job-example", session: "run-session", title: "run walnut", by: "claude-main" }));
    drain(index);
    expect(index.search({ query: "walnut", filters: { kind: "run", job: "codex-job-example" } }).hits).toEqual(expect.arrayContaining([expect.objectContaining({ run, session: "run-session", cursor: "0" })]));
    expect(index.search({ query: "pineapple" }).hits).toEqual([]);
    appendFileSync(file, "\n"); drain(index);
    expect(index.search({ query: "pineapple", filters: { session: "run-session" } }).hits).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toContain("partial pineapple\n");
  });
});

describe("search query and filters", () => {
  it("uses FTS terms, bounds snippets and applies every filter with inclusive time limits", () => {
    const s = store(); s.insert(message("one", "unique WALNUT café " + "detail ".repeat(100), "claude-main", 100)); s.insert(message("two", "walnut only", "claude-main", 200)); s.history.tick();
    expect(s.history.search({ query: "WALNUT café" }).hits.map((h) => h.message)).toEqual(["one"]);
    expect(s.history.search({ query: 'unique " OR walnut' }).hits).toEqual([]);
    const result = s.history.search({ query: "walnut", filters: { session: "session-one", job: "codex-job-example", agent: "codex", kind: "message", since: 100, until: 100 } });
    expect(result.hits).toHaveLength(1); expect(result.hits[0]!.snippet.length).toBeLessThanOrEqual(320);
    expect(s.history.search({ query: "walnut", filters: { since: "1970-01-01T00:00:00.200Z" } }).hits[0]!.message).toBe("two");
    expect(() => s.history.search({ query: "walnut", filters: { since: 200, until: 100 } })).toThrow();
    expect(() => s.history.search({ query: "walnut", limit: 51 })).toThrow();
    expect(s.history.search({ query: "walnut", filters: { job: "unknown" } }).hits).toEqual([]);
  });
});

const fake = (): HistoryAnswerDependencies => ({
  available: () => true,
  usage: async (agent) => ({ agent, lines: [], limits: [], maxUsedPercent: 10 }),
  models: async (agent) => ({ agent, models: agent === "codex" ? ["gpt-6-luna"] : ["opencode/example-free"], defaultModel: null, lines: [] }),
  costs: async () => [{ id: "opencode/example-free", input: 0, output: 0 }],
  run: vi.fn(async () => "It mentions walnut. [message:one]"),
});
describe("answer mode", () => {
  it("selects cheap models by availability and usage and sends only bounded hits", async () => {
    const s = store(); s.insert(message("one")); s.history.tick(); const deps = fake();
    const answer = await answerHistory("walnut", s.history.search({ query: "walnut" }), DEFAULT_CONFIG, env.home, nullLogger, deps);
    expect(answer).toMatchObject({ agent: "codex", model: "gpt-6-luna", sources: [{ id: "message:one" }] });
    expect(deps.run).toHaveBeenCalledWith("codex", "gpt-6-luna", expect.stringContaining("untrusted quoted data"));
    deps.usage = async (agent) => ({ agent, lines: [], limits: [{ name: "daily", usedPercent: agent === "codex" ? 100 : 1, resets: null }], maxUsedPercent: null });
    expect(await answerHistory("walnut", s.history.search({ query: "walnut" }), DEFAULT_CONFIG, env.home, nullLogger, deps)).toMatchObject({ agent: "claude", model: "haiku" });
    deps.available = (agent) => agent === "opencode";
    expect(await answerHistory("walnut", s.history.search({ query: "walnut" }), DEFAULT_CONFIG, env.home, nullLogger, deps)).toMatchObject({ agent: "opencode", model: "opencode/example-free" });
  });
  it("requires zero catalog prices rather than trusting a free-looking model name", async () => {
    const s = store(); s.insert(message("one")); s.history.tick(); const deps = fake();
    deps.available = (agent) => agent === "opencode";
    deps.costs = async () => [{ id: "opencode/example-free", input: 2, output: 4 }];
    expect(await answerHistory("walnut", s.history.search({ query: "walnut" }), DEFAULT_CONFIG, env.home, nullLogger, deps)).toMatchObject({ agent: null, error: expect.stringContaining("No configured cheap") });
    expect(deps.run).not.toHaveBeenCalled();
    deps.models = async (agent) => ({ agent, models: ["opencode/plan-model"], defaultModel: null, lines: [] });
    deps.costs = async () => [{ id: "opencode/plan-model", input: 0, output: 0 }];
    expect(await answerHistory("walnut", s.history.search({ query: "walnut" }), DEFAULT_CONFIG, env.home, nullLogger, deps)).toMatchObject({ agent: "opencode", model: "opencode/plan-model" });
  });
  it("returns source-preserving errors for missing capacity, uncited answers and runner errors", async () => {
    const s = store(); s.insert(message("one")); s.history.tick(); const result = s.history.search({ query: "walnut" }), deps = fake();
    deps.available = () => false;
    expect(await answerHistory("walnut", result, DEFAULT_CONFIG, env.home, nullLogger, deps)).toMatchObject({ error: expect.stringContaining("No configured cheap"), sources: [{ id: "message:one" }] });
    deps.available = () => true; deps.run = vi.fn(async () => "No citations.");
    expect(await answerHistory("walnut", result, DEFAULT_CONFIG, env.home, nullLogger, deps)).toMatchObject({ error: expect.stringContaining("did not cite") });
    deps.run = vi.fn(async () => { throw new Error("fake runner failed"); });
    expect(await answerHistory("walnut", result, DEFAULT_CONFIG, env.home, nullLogger, deps)).toMatchObject({ error: expect.stringContaining("fake runner failed") });
    deps.run = vi.fn(); await answerHistory("unknown", { engine: "fts5", hits: [] }, DEFAULT_CONFIG, env.home, nullLogger, deps); expect(deps.run).not.toHaveBeenCalled();
  });
  it("loads answer configuration without changing ordinary delegate defaults", () => {
    saveConfigValue(env.home, "historyAnswer", { preference: ["opencode", "codex"], codexModel: "gpt-6-luna", opencodeModel: "opencode/example-free" });
    const config = loadConfig(env.home, "codex", nullLogger);
    expect(config.historyAnswer.preference).toEqual(["opencode", "codex"]); expect(config.codexModel).toBeNull();
  });
});

describe("authenticated history endpoint and broker API", () => {
  it("rejects unauthenticated requests and invalid queries and calls a model only for answer=true", async () => {
    const s = store(); s.insert(message("one")); s.history.tick(); const deps = fake();
    const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger, historyAnswer: deps }); cleanups.push(() => ui.close());
    const base = ui.url.replace(/\/\?t=.*$/, "");
    expect((await fetch(`${base}/api/search?q=walnut`)).status).toBe(403);
    const response = await fetch(ui.url, { redirect: "manual" }), cookie = String(response.headers.get("set-cookie")).split(";")[0]!;
    const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie } });
    expect((await (await get("/api/search?q=walnut&kind=message&since=100&until=100")).json()).hits).toHaveLength(1);
    expect(deps.run).not.toHaveBeenCalled();
    expect((await fetch(`${base}/api/history/message%3Aone`)).status).toBe(403);
    expect((await (await get("/api/history/message%3Aone")).json()).body).toContain("walnut");
    expect((await get("/api/history/missing")).status).toBe(404);
    for (const query of ["", "?q=walnut&limit=0", "?q=walnut&answer=yes", "?q=walnut&kind=invalid", "?q=walnut&since=bad", "?q=walnut&q=other", "?q=walnut&unknown=yes"]) expect((await get(`/api/search${query}`)).status).toBe(400);
    expect((await (await get("/api/search?q=walnut&answer=true")).json()).answer).toMatchObject({ model: "gpt-6-luna", sources: [{ id: "message:one" }] });
    expect(deps.run).toHaveBeenCalledTimes(1);
  });
  it("reindexes offline without joining a peer or altering source rows", async () => {
    const s = new MessageStore(env.db, nullLogger); s.insert(message("standalone")); s.close();
    const db = new DatabaseSync(env.db, { readOnly: true }); const before = db.prepare("SELECT * FROM messages").all(); db.close();
    const out = vi.fn(); expect(await runReindex(env.home, env.pipe, nullLogger, out)).toBe(0);
    const after = new DatabaseSync(env.db, { readOnly: true });
    expect(after.prepare("SELECT * FROM messages").all()).toEqual(before); after.close();
    expect(readHistory(env.db, { query: "walnut" }).hits).toMatchObject([{ message: "standalone" }]);
    expect(out).toHaveBeenCalledWith(expect.stringContaining("History index rebuilt"));
  });
  it("exposes broker-owned search and bounded rebuild to clients", async () => {
    const node = env.node("claude-main"); await node.start(); await node.send({ to: "offline", body: "walnut broker" });
    await node.setSessionId("cli-session-example");
    const unauthenticated = await BridgeClient.connect(env.pipe, nullLogger);
    try { await expect(unauthenticated.request("searchHistory", { query: "walnut" })).rejects.toMatchObject({ code: "unauthorized" }); }
    finally { unauthenticated.close(); }
    await node.reindexHistory();
    expect((await node.searchHistory({ query: "walnut", filters: { session: "cli-session-example" } })).hits).toMatchObject([{ session: "cli-session-example" }]);
    expect((await node.searchHistory({ query: "walnut" })).hits).toMatchObject([{ kind: "message" }]);
    await node.reindexHistory(true);
    expect((await node.searchHistory({ query: "walnut" })).hits).toHaveLength(1);
    expect(existsSync(env.db)).toBe(true);
  });
});
