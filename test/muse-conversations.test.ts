import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationIngestor, readConversation } from "../src/core/conversations.js";
import { HistoryIndex } from "../src/core/history.js";
import { migrateHistoryStore, openHistoryStore } from "../src/core/history-store.js";
import { nullLogger } from "../src/core/logger.js";
import { conversationProject, projectDatabasePath } from "../src/core/project-store.js";
import { MessageStore } from "../src/core/store.js";
import { type TranscriptPaths } from "../src/core/transcripts/common.js";
import { makeEnv, until } from "./helpers.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fixture(encoded = false) {
  vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
  const env = makeEnv(); cleanup.push(() => env.cleanup());
  const store = new MessageStore(env.db, nullLogger); cleanup.push(() => store.close());
  const source = new DatabaseSync(env.db); cleanup.push(() => source.close());
  const db = encoded ? openHistoryStore(join(env.home, "history.db")) : source;
  if (encoded) cleanup.push(() => db.close());
  if (encoded) await migrateHistoryStore(env.db, db);
  const project = join(env.home, "project"); mkdirSync(project);
  const paths: TranscriptPaths = { claude: join(env.home, "empty-claude"), codex: join(env.home, "empty-codex"),
    opencode: join(env.home, "empty-opencode"), muse: join(env.home, "muse") };
  const index = new HistoryIndex(db, env.home, paths, source); cleanup.push(() => index.close());
  const ingest = new ConversationIngestor(db, env.home, paths, source); cleanup.push(() => ingest.close());
  return { env, paths, project, store, source, db, index, ingest, drain: () => {
    let idle = 0;
    for (let n = 0; n < 200; n++) {
      const indexed = index.tick(true), ingested = ingest.tick();
      if (indexed.work || ingested || indexed.discovering || ingest.discovering) idle = 0;
      else if (++idle === 2) return;
    }
    throw new Error("Muse durable conversation backlog did not drain");
  } };
}
function record(session: string, sequence: number, payload_type: string, payload: Record<string, unknown>) {
  return { schema_version: 1, id: `${session}-record-${sequence}`, stream: { kind: "session", id: session }, sequence,
    recorded_at: 1_792_000_000_000_000 + sequence * 1_000, record_type: "event", durability: "durable",
    causation_id: "cmd-1", payload_type, payload_schema_version: 1, payload };
}
const user = (session: string, n: number, prompt: string) => record(session, n, "turn.input.user", { kind: "turn_input_user", prompt });
const answer = (session: string, n: number, text: string) => record(session, n, "run.terminal.completed", { kind: "run_terminal", terminal: "completed", text });
const bound = (session: string, n: number, child: string) => record(session, n, "subagent.control.child_session_bound",
  { kind: "subagent_control", record: { kind: "child_session_bound", subagent_id: `sub-${n}`, child_session_id: child } });
const frame = (...rows: unknown[]) => ({ retained_frame: "session_permission_transaction", frame_schema_version: 1,
  children: rows.map((row, child_index) => ({ child_index, record_json: JSON.stringify(row) })) });
function session(paths: TranscriptPaths, id: string, rows: unknown[], flat = false) {
  const file = join(paths.muse!, "sessions", ...(flat ? [] : ["2026", "10", "13"]), id, "session.jsonl");
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return file;
}
function retained(db: DatabaseSync, id: string, generation = 0) {
  const page = readConversation(db, { id, limit: 100 });
  return Buffer.concat(page.records.filter(row => row.generation === generation).map(row => Buffer.from(row.raw, "base64")));
}

describe("Muse durable native conversations", () => {
  it.each([false, true])("retains distinct flat/dated session bytes and reindexes retained frame text after source loss (encoded=%s)", async encoded => {
    const f = await fixture(encoded), first = "first-session", second = "second-session";
    const firstFile = session(f.paths, first, [frame(user(first, 1, "x".repeat(18_000) + " durable_orchid_tail 🐈"),
      record(first, 2, "tool_batch.effect.started", { kind: "tool_batch_effect", record: { kind: "started", effect_id: "effect", tool_name: "durable_muse_tool", call_id: "call" } })),
      answer(first, 3, "durable_orchid_answer")]);
    const secondFile = session(f.paths, second, [user(second, 1, "durable_marigold_question")], true);
    const originals = [readFileSync(firstFile), readFileSync(secondFile)];
    f.drain();
    expect(retained(f.db, `muse:${first}`)).toEqual(originals[0]);
    expect(retained(f.db, `muse:${second}`)).toEqual(originals[1]);
    expect(f.db.prepare("SELECT path,conversation FROM conversation_sources WHERE conversation LIKE 'muse:%' ORDER BY conversation").all())
      .toEqual([{ path: firstFile, conversation: `muse:${first}` }, { path: secondFile, conversation: `muse:${second}` }]);
    expect(f.index.search({ query: "durable_orchid_tail", filters: { agent: "muse", session: first } }).hits)
      .toMatchObject([{ id: expect.stringMatching(/^durable:/), agent: "muse" }]);
    const before = f.db.prepare("SELECT * FROM conversation_records").all();
    rmSync(firstFile); rmSync(secondFile); f.index.reset(); f.drain();
    expect(f.db.prepare("SELECT * FROM conversation_records").all()).toEqual(before);
    expect(f.index.search({ query: "durable_orchid_tail", filters: { agent: "muse", session: first } }).hits).toHaveLength(1);
    expect(f.index.search({ query: "durable_marigold_question", filters: { agent: "muse", session: second } }).hits).toHaveLength(1);
    expect(f.index.search({ query: "durable_muse_tool", filters: { agent: "muse", session: first } }).hits).toHaveLength(1);
    expect(() => f.db.exec("DELETE FROM conversation_records")).toThrow("append-only");
  });

  it("restores searchable Muse retained text from pre-support raw rows without changing the retained bytes", async () => {
    const f = await fixture(), id = "old-retained-session", file = session(f.paths, id, [frame(user(id, 1, "prior_support_lily"))]);
    f.db.prepare("INSERT INTO conversations(id,agent,session) VALUES(?,'muse',?)").run(`muse:${id}`, id);
    f.db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES(?,0,0,?,1,?,'')")
      .run(file, `muse:${id}`, readFileSync(file));
    const before = f.db.prepare("SELECT * FROM conversation_records").all(); rmSync(file);
    f.drain();
    expect(f.index.search({ query: "prior_support_lily", filters: { agent: "muse", session: id } }).hits).toHaveLength(1);
    expect(f.db.prepare("SELECT * FROM conversation_records").all()).toEqual(before);
  });

  it("connects retained native child bindings and backfills late project/job tags at every depth", async () => {
    const f = await fixture(), parent = "parent-session", child = "child-session", grandchild = "grandchild-session";
    const parentFile = session(f.paths, parent, [frame(bound(parent, 1, child)), bound(parent, 2, child), bound("foreign-ancestor", 3, "unclaimed-session"), bound(parent, 4, "../../escape")]);
    const childFile = session(f.paths, child, [user(child, 1, "durable_child_iris"), frame(bound(child, 2, grandchild))]);
    const grandchildFile = session(f.paths, grandchild, [user(grandchild, 1, "durable_grandchild_iris")]);
    f.drain();
    expect(f.db.prepare("SELECT parent FROM conversations WHERE id=?").get(`muse:${child}`)?.parent).toBe(`muse:${parent}`);
    expect(f.db.prepare("SELECT parent FROM conversations WHERE id=?").get(`muse:${grandchild}`)?.parent).toBe(`muse:${child}`);
    expect(f.db.prepare("SELECT 1 FROM conversations WHERE session='unclaimed-session'").get()).toBeUndefined();
    f.index.rememberPeer({ id: "muse-parent-peer", name: "muse-job-root", agent: "muse", sessionId: parent, cwd: f.project });
    f.drain();
    for (const id of [child, grandchild]) {
      expect(readConversation(f.db, { id: `muse:${id}` }).conversation).toMatchObject({ job: "muse-job-root", project: conversationProject(f.project) });
      expect(f.index.search({ query: `durable_${id === child ? "child" : "grandchild"}_iris`,
        filters: { agent: "muse", job: "muse-job-root", project: f.project, session: id } }).hits.length).toBeGreaterThan(0);
    }
    for (const [id, file] of [[parent, parentFile], [child, childFile], [grandchild, grandchildFile]]) {
      expect(retained(f.db, `muse:${id}`)).toEqual(readFileSync(file!));
    }
    // Existing mirrors recycle their metadata sweep after the five-minute idle interval.
    const now = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => now() + 5 * 60_000 + 1);
    f.drain();
    const mirror = new DatabaseSync(projectDatabasePath(conversationProject(f.project), f.env.home), { readOnly: true });
    try { expect(readConversation(mirror, { id: `muse:${grandchild}` }).conversation?.job).toBe("muse-job-root"); }
    finally { mirror.close(); }
  });

  it("keeps the first native parent and refuses self-links or cycles", async () => {
    const f = await fixture();
    session(f.paths, "a-parent", [bound("a-parent", 1, "b-child"), bound("a-parent", 2, "a-parent")]);
    session(f.paths, "b-child", [bound("b-child", 1, "a-parent")]);
    session(f.paths, "z-parent", [bound("z-parent", 1, "b-child")]);
    f.drain();
    expect(readConversation(f.db, { id: "muse:a-parent" }).conversation?.parent).toBeNull();
    expect(readConversation(f.db, { id: "muse:b-child" }).conversation?.parent).toBe("muse:a-parent");
  });

  it("wakes on native appends, preserves replacements as new generations, and rejects escaping files", async () => {
    const f = await fixture(), id = "watched-session", file = session(f.paths, id, [user(id, 1, "durable_initial_tulip")]);
    const original = readFileSync(file); f.drain();
    let wakes = 0; f.ingest.onChange = () => { wakes++; f.index.wake(); };
    const appended = JSON.stringify(frame(user(id, 2, "durable_appended_tulip"))) + "\n";
    appendFileSync(file, appended);
    await until(() => wakes > 0); f.drain();
    expect(retained(f.db, `muse:${id}`)).toEqual(Buffer.concat([original, Buffer.from(appended)]));
    renameSync(file, `${file}.old`); writeFileSync(file, JSON.stringify(user(id, 3, "durable_replaced_tulip")) + "\n");
    f.drain();
    expect(retained(f.db, `muse:${id}`, 0)).toEqual(Buffer.concat([original, Buffer.from(appended)]));
    expect(retained(f.db, `muse:${id}`, 1)).toEqual(readFileSync(file));
    const outside = join(f.env.home, "outside-session.jsonl"); writeFileSync(outside, JSON.stringify(user("escaped", 1, "private_outside_needle")) + "\n");
    const linked = join(f.paths.muse!, "sessions", "escaped", "session.jsonl"); mkdirSync(dirname(linked), { recursive: true }); symlinkSync(outside, linked);
    f.db.prepare("INSERT INTO conversation_sources(id,path,conversation,format) VALUES(?,?,?,'jsonl')").run(linked, linked, `muse:${id}`);
    f.drain();
    expect(f.db.prepare("SELECT 1 FROM conversation_records WHERE source=?").get(linked)).toBeUndefined();
    expect(f.index.search({ query: "private_outside_needle", filters: { agent: "muse" } }).hits).toHaveLength(0);
  });

  it("classifies Muse job messages without changing the source envelope or another sender's documents", async () => {
    const f = await fixture();
    const insert = (id: string, name: string) => f.store.insert({ id, recipient: "owner", to: "owner", from: { id, name, agent: "muse" },
      body: `durable_job_message_${id}`, conversationId: "mixed-muse", replyTo: null, hop: 0, createdAt: 1, readAt: null });
    insert("job-note", "muse-job-example"); insert("session-note", "muse-main");
    const before = f.source.prepare("SELECT * FROM messages ORDER BY id").all();
    f.drain();
    expect(f.index.search({ query: "durable_job_message_job-note", filters: { agent: "muse", job: "muse-job-example" } }).hits.length).toBeGreaterThan(0);
    expect(f.index.search({ query: "durable_job_message_session-note", filters: { agent: "muse", job: "muse-job-example" } }).hits).toHaveLength(0);
    const documents = f.db.prepare("SELECT job FROM history_documents WHERE id LIKE 'durable:%' ORDER BY id").all();
    expect(documents.map(doc => doc.job)).toEqual(expect.arrayContaining(["muse-job-example", null]));
    expect(f.source.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(before);
  });
});
