import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryIndex, HISTORY_CHUNK_BYTES } from "../src/core/history.js";
import { historyFiltersSchema } from "../src/core/history-query.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { MAX_TRANSCRIPT_CHUNK_BYTES, type TranscriptPaths } from "../src/core/transcripts/common.js";
import { listNativeSubagents, readTranscript } from "../src/core/transcripts/index.js";
import { museItems, museSessionIds } from "../src/core/transcripts/muse.js";
import { CODING_AGENTS } from "../src/core/protocol.js";
import { delegationTargets } from "../src/mcp/server.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const env = makeEnv(); cleanups.push(() => env.cleanup());
  const paths = { claude: join(env.home, "claude"), codex: join(env.home, "codex"), opencode: join(env.home, "opencode"), muse: join(env.home, "muse") };
  return { env, paths };
}

/** Muse 1.4.7 durable session records, with epoch microseconds and transaction frames. */
function record(session: string, sequence: number, payload_type: string, payload: Record<string, unknown>) {
  return { schema_version: 1, id: `${session}-record-${sequence}`, stream: { kind: "session", id: session }, sequence,
    recorded_at: 1_792_000_000_000_000 + sequence * 1_000, record_type: "event", durability: "durable",
    causation_id: "cmd-1", payload_type, payload_schema_version: 1, payload };
}
const user = (session: string, n: number, prompt: string) => record(session, n, "turn.input.user", { kind: "turn_input_user", prompt });
const answer = (session: string, n: number, text: string) => record(session, n, "run.terminal.completed", { kind: "run_terminal", command_id: "cmd-1", terminal: "completed", text, reason: null });
const bound = (session: string, n: number, child: string) => record(session, n, "subagent.control.child_session_bound", { kind: "subagent_control", record: { kind: "child_session_bound", subagent_id: "sub-1", child_session_id: child } });
const frame = (...records: unknown[]) => ({ retained_frame: "session_permission_transaction", frame_schema_version: 1,
  children: records.map((r, child_index) => ({ child_index, record_json: JSON.stringify(r) })) });
function writeSession(paths: TranscriptPaths, id: string, rows: unknown[], flat = false) {
  const file = join(paths.muse!, "sessions", ...(flat ? [] : ["2026", "10", "13"]), id, "session.jsonl");
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return file;
}
function indexFor(env: TestEnv, paths: TranscriptPaths): HistoryIndex {
  const store = new MessageStore(env.db, nullLogger); cleanups.push(() => store.close());
  const db = new DatabaseSync(env.db); cleanups.push(() => db.close());
  const index = new HistoryIndex(db, env.home, paths); cleanups.push(() => index.close());
  return index;
}
function drain(index: HistoryIndex) {
  for (let n = 0; n < 150; n++) { const tick = index.tick(); if (!tick.work && !tick.discovering) return; }
  throw new Error("Muse history backlog did not drain");
}

describe("Muse history and transcript discovery", () => {
  it("keeps same-day sessions distinct and opens search hits at their actual records", () => {
    const { env, paths } = fixture();
    const first = "019a-first-session", second = "019a-second-session";
    const firstFile = writeSession(paths, first, [frame(user(first, 1, "orchid first prompt")), answer(first, 2, "orchid first answer")]);
    const secondFile = writeSession(paths, second, [user(second, 1, "orchid second prompt"), answer(second, 2, "orchid second answer")]);
    writeFileSync(join(dirname(secondFile), "internal.jsonl"), JSON.stringify(user(second, 3, "orchid internal duplicate")) + "\n");
    const original = readFileSync(firstFile, "utf8"), index = indexFor(env, paths); drain(index);
    expect(historyFiltersSchema.parse({ agent: "muse" })).toEqual({ agent: "muse" });
    const hits = index.search({ query: "orchid", filters: { agent: "muse" }, limit: 50 }).hits;
    expect(hits).toHaveLength(4);
    expect(new Set(hits.map(hit => hit.session))).toEqual(new Set([first, second]));
    expect(index.search({ query: "orchid", filters: { agent: "muse", session: first } }).hits).toHaveLength(2);
    expect(index.search({ query: "orchid", filters: { agent: "muse", session: second } }).hits).toHaveLength(2);
    expect(index.database.prepare("SELECT session,path FROM history_files WHERE agent='muse' ORDER BY session").all()).toEqual([
      { session: first, path: firstFile }, { session: second, path: secondFile },
    ]);
    for (const hit of hits) {
      const url = new URL(hit.link, "http://fixture"), sessionId = url.searchParams.get("session")!;
      expect(sessionId).toBe(hit.session);
      expect(url.searchParams.get("agent")).toBe("muse");
      expect(url.searchParams.get("from")).toBe(hit.cursor);
      const page = readTranscript({ agent: "muse", cwd: env.home, sessionId }, hit.cursor!, undefined, paths)!;
      expect(page.items[0]!.text).toContain(hit.snippet);
      expect(page.items[0]!.at).toBeGreaterThan(1e12);
      expect(page.items[0]!.at).toBeLessThan(1e13);
    }
    expect(readFileSync(firstFile, "utf8")).toBe(original);
  });

  it("indexes retained retries once across history chunks and resumes appended records", () => {
    const { env, paths } = fixture(), id = "retry-session", prompt = user(id, 1, "marigold prompt");
    const file = writeSession(paths, id, [prompt, { padding: "x".repeat(HISTORY_CHUNK_BYTES - 100) }, frame(prompt), answer(id, 2, "marigold answer")]);
    const index = indexFor(env, paths); drain(index);
    expect(index.search({ query: "marigold", filters: { agent: "muse" } }).hits).toHaveLength(2);
    appendFileSync(file, JSON.stringify(frame(prompt, answer(id, 2, "marigold answer"), user(id, 3, "marigold appended"))) + "\n");
    drain(index);
    const hits = index.search({ query: "marigold", filters: { agent: "muse" } }).hits;
    expect(hits).toHaveLength(3);
    drain(index); expect(index.search({ query: "marigold", filters: { agent: "muse" } }).hits).toEqual(hits);
  });

  it("keeps the Muse agent when reindexing a packed finished run", () => {
    const { env, paths } = fixture(), store = new MessageStore(env.db, nullLogger); cleanups.push(() => store.close());
    const db = new DatabaseSync(env.db); cleanups.push(() => db.close());
    const file = join(env.home, "cold", "originals", "2026-10-13-09-00-00-muse-job-review.log");
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "09:00:00 packed daffodil output\n");
    db.exec("CREATE TABLE IF NOT EXISTS bridge_metadata (domain TEXT, key TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY(domain,key))");
    db.prepare("INSERT INTO bridge_metadata VALUES(?,?,?,?)").run("finished-runs", "2026-10-13-09-00-00-muse-job-review.log", JSON.stringify({ file }), Date.now());
    const source = new DatabaseSync(env.db, { readOnly: true }); cleanups.push(() => source.close());
    const index = new HistoryIndex(db, env.home, paths, source); cleanups.push(() => index.close()); drain(index);
    expect(index.search({ query: "daffodil", filters: { agent: "muse", kind: "run" } }).hits).toMatchObject([{ agent: "muse", run: "2026-10-13-09-00-00-muse-job-review.log" }]);
    expect(readFileSync(file, "utf8")).toBe("09:00:00 packed daffodil output\n");
  });

  it("follows only bound native children and preserves their first binding time", () => {
    const { env, paths } = fixture(), parent = "parent-session", child = "child-session";
    writeSession(paths, parent, [frame(bound(parent, 1, child)), bound(parent, 2, child), bound(parent, 3, "../../escape")]);
    writeSession(paths, child, [user(child, 1, "child question"), answer(child, 2, "child answer")]);
    writeSession(paths, "unrelated-session", [user("unrelated-session", 1, "private unrelated")]);
    const session = { agent: "muse" as const, cwd: env.home, sessionId: parent };
    expect(listNativeSubagents(session, paths)).toMatchObject([{ id: child, startedAt: 1_792_000_000_001 }]);
    expect(readTranscript(session, "0", child, paths)?.items.map(item => item.text)).toEqual(["child question", "child answer"]);
    expect(readTranscript(session, "0", "unrelated-session", paths)).toBeNull();
    expect(readTranscript(session, "0", "../../escape", paths)).toBeNull();
  });

  it("paginates retained records without losing partial writes or repeated record identities", () => {
    const { env, paths } = fixture(), id = "paged-session", first = user(id, 1, "first question");
    const file = writeSession(paths, id, [frame(first), { padding: "x".repeat(MAX_TRANSCRIPT_CHUNK_BYTES - 100) }, answer(id, 2, "second answer")]);
    appendFileSync(file, JSON.stringify(frame(first, user(id, 3, "third question"))));
    const session = { agent: "muse" as const, cwd: env.home, sessionId: id };
    const pages = [], ids = new Set<string>(); let from = "0";
    for (let n = 0; n < 6; n++) {
      const page = readTranscript(session, from, undefined, paths)!;
      pages.push(page); for (const item of page.items) ids.add(item.id!);
      if (page.next === from) break; from = page.next;
    }
    expect(pages[0]!.items.map(item => item.text)).toEqual(["first question"]);
    expect(ids).toEqual(new Set([`${id}-record-1`, `${id}-record-2`]));
    appendFileSync(file, "\n");
    const appended = readTranscript(session, from, undefined, paths)!;
    expect(appended.items.map(item => item.text)).toEqual(["first question", "third question"]);
    expect(appended.items[0]!.id).toBe(pages[0]!.items[0]!.id);
    expect(readTranscript(session, appended.next, undefined, paths)!.items).toEqual([]);
    expect(readTranscript(session, "tail", undefined, paths)!.items.map(item => item.text)).toContain("third question");
  });

  it("discovers real dated and flat logs once and refuses folders or escaping symlinks", () => {
    const { env, paths } = fixture();
    writeSession(paths, "dated-session", [user("dated-session", 1, "dated")]);
    writeSession(paths, "flat-session", [user("flat-session", 1, "flat")], true);
    writeSession(paths, "dated-session", [user("dated-session", 1, "duplicate path")], true);
    const bad = join(paths.muse!, "sessions", "2026", "10", "13", "directory-session", "session.jsonl");
    mkdirSync(bad, { recursive: true });
    const outside = join(env.home, "outside.jsonl"); writeFileSync(outside, JSON.stringify(user("escaped-session", 1, "outside")) + "\n");
    const linked = join(paths.muse!, "sessions", "2026", "10", "13", "escaped-session", "session.jsonl");
    mkdirSync(dirname(linked), { recursive: true }); symlinkSync(outside, linked);
    expect(museSessionIds(paths).sort()).toEqual(["dated-session", "flat-session"]);
    expect(readTranscript({ agent: "muse", cwd: env.home, sessionId: "directory-session" }, "0", undefined, paths)).toBeNull();
    expect(readTranscript({ agent: "muse", cwd: env.home, sessionId: "escaped-session" }, "0", undefined, paths)).toBeNull();
    expect(readTranscript({ agent: "muse", cwd: env.home, sessionId: "../../outside" }, "0", undefined, paths)).toBeNull();
  });

  it("ignores malformed transaction children and nonfinite timestamps", () => {
    expect(museItems({ retained_frame: "session_permission_transaction", children: [null, { record_json: "{" }, { record_json: 7 }, []] })).toEqual([]);
    expect(museItems({ ...user("finite-session", 1, "valid"), recorded_at: NaN })).toMatchObject([{ at: 0 }]);
  });

  it.each(CODING_AGENTS)("allows %s to delegate to every coding agent including Muse", caller => {
    expect(delegationTargets(caller)).toEqual(CODING_AGENTS);
  });
});
