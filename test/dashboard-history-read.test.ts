import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rawSourceReads } from "../src/core/byte-source.js";
import { ConversationIngestor } from "../src/core/conversations.js";
import { readDashboard } from "../src/core/dashboard-read.js";
import { HistoryIndex } from "../src/core/history.js";
import { HistoryBackground } from "../src/core/history-background.js";
import { migrateHistoryStore, openHistoryReader, openHistoryStore } from "../src/core/history-store.js";
import { nullLogger } from "../src/core/logger.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { MessageStore } from "../src/core/store.js";
import { listNativeSubagents, readTranscript, type TranscriptPaths } from "../src/core/transcripts/index.js";
import { makeEnv } from "./helpers.js";

/** AB-383: dashboard sessions, subagents, chat pages and run logs come from history.db, equal to the file reads. */
const SESSION = "11111111-2222-3333-4444-555555555555";
const LINES = 10_000;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

function line(n: number, session = SESSION): string {
  const at = new Date(Date.UTC(2026, 9, 15, 0, 0, 0) + n * 1000).toISOString();
  if (n % 7 === 3) return JSON.stringify({ type: "assistant", sessionId: session, timestamp: at, message: { role: "assistant", stop_reason: "tool_use",
    content: [{ type: "text", text: `step ${n}` }, { type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `echo ${n}` } }] } });
  if (n % 7 === 4) return JSON.stringify({ type: "user", sessionId: session, timestamp: at, message: { role: "user",
    content: [{ type: "tool_result", tool_use_id: `t${n - 1}`, content: `out ${n} ${"x".repeat(n % 300)}` }] } });
  // A few records are longer than one retained 64 KiB chunk.
  const text = n % 2500 === 1234 ? `long ${n} ${"y".repeat(150_000)}` : `message ${n} ${"z".repeat(n % 500)}`;
  return JSON.stringify({ type: n % 2 ? "assistant" : "user", sessionId: session, timestamp: at,
    message: { role: n % 2 ? "assistant" : "user", content: n % 2 ? [{ type: "text", text }] : text, ...(n % 2 ? { stop_reason: "end_turn" } : {}) } });
}

async function fixture() {
  vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
  const env = makeEnv(); cleanup.push(() => env.cleanup());
  const store = new MessageStore(env.db, nullLogger); cleanup.push(() => store.close());
  const source = new DatabaseSync(env.db); cleanup.push(() => source.close());
  const db = openHistoryStore(join(env.home, "history.db")); cleanup.push(() => db.close());
  await migrateHistoryStore(env.db, db);
  const cwd = join(env.home, "project"); mkdirSync(cwd);
  const paths: TranscriptPaths = { claude: join(env.home, "claude"), codex: join(env.home, "empty-codex"), opencode: join(env.home, "empty-opencode") };
  const main = join(paths.claude, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${SESSION}.jsonl`);
  mkdirSync(dirname(main), { recursive: true });
  writeFileSync(main, Array.from({ length: LINES }, (_, n) => line(n)).join("\n") + "\n");
  const kids = join(dirname(main), SESSION, "subagents");
  mkdirSync(kids, { recursive: true });
  const at = "2026-10-15T01:00:00.000Z";
  const children: Record<string, string[]> = {
    done: [JSON.stringify({ type: "user", isSidechain: true, timestamp: at, message: { content: "Review the parser" } }),
      JSON.stringify({ type: "assistant", isSidechain: true, timestamp: at, message: { stop_reason: "end_turn", content: [{ type: "text", text: "Reviewed." }] } })],
    working: [JSON.stringify({ type: "user", isSidechain: true, timestamp: at, message: { content: "Write tests" } }),
      JSON.stringify({ type: "assistant", isSidechain: true, timestamp: at, message: { stop_reason: "tool_use", content: [{ type: "text", text: "Working" }] } })],
    // A first record longer than one retained chunk: its facts are computed from the retained bytes.
    huge: [JSON.stringify({ type: "user", isSidechain: true, timestamp: at, message: { content: `Huge ${"h".repeat(90_000)}` } }),
      JSON.stringify({ type: "assistant", isSidechain: true, timestamp: at, message: { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } })],
  };
  for (const [id, rows] of Object.entries(children)) writeFileSync(join(kids, `agent-${id}.jsonl`), rows.join("\n") + "\n");
  const runs = join(env.home, "runs"); mkdirSync(runs, { recursive: true });
  const runLog = join(runs, "2026-10-15-01-00-00-codex-job-abcd1234.log");
  writeFileSync(runLog, "01:00:00 codex-job-abcd1234 by claude-x in /tmp, access write\nDo the task\n---\n01:00:01 working\n");
  const index = new HistoryIndex(db, env.home, paths, source); cleanup.push(() => index.close());
  const ingest = new ConversationIngestor(db, env.home, paths, source); cleanup.push(() => ingest.close());
  ingest.onUnknownPaths = (changed) => { index.registerChanged(changed); };
  // Register the five files, then let the ingester retain them; search indexing is not under test.
  const drain = () => {
    for (let n = 0; n < 50 && Number(db.prepare("SELECT count(*) n FROM history_files WHERE kind IN ('transcript','run')").get()!.n) < 5; n++) index.tick(true);
    let idle = 0;
    for (let n = 0; n < 2_000 && idle < 3; n++) idle = ingest.tick() ? 0 : idle + 1;
  };
  const peer = { id: "p1", name: "claude-x", agent: "claude", cwd, pid: 1, agentPid: null, sessionId: SESSION, startedAt: 0, autoWake: false } as unknown as PeerInfo;
  const ctx = { home: env.home, log: nullLogger, peers: () => [peer], transcripts: paths };
  const api = async (path: string, query: Record<string, string> = {}) => {
    const result = await readDashboard(ctx, { path, query } as never);
    expect(result.status).toBe(200);
    return result.body as Record<string, any>;
  };
  return { env, db, paths, main, kids, runLog, peer, index, ingest, drain, api };
}

const chat = `/api/sessions/claude-x/chat`;

describe("dashboard reads from the history store (AB-383)", () => {
  it("serves the newest chat page, forward pages and subagents equal to the file reads, with zero raw reads", async () => {
    const f = await fixture();
    f.drain();
    const session = { agent: "claude" as const, cwd: f.peer.cwd, sessionId: SESSION };

    const before = rawSourceReads();
    const started = performance.now();
    const tail = await f.api(chat, { from: "tail" });
    const tailMs = performance.now() - started;
    const kids = await f.api(`/api/sessions/claude-x/subagents`);
    const childPage = await f.api(`/api/sessions/claude-x/subagents/done`, { from: "0" });
    const run = await f.api(`/api/runs/2026-10-15-01-00-00-codex-job-abcd1234`, { from: "0" });
    expect(rawSourceReads() - before).toBe(0);
    for (const body of [tail, kids, childPage, run]) expect(body.importing).toBeUndefined();
    console.info(`AB-383 newest chat page of a ${LINES}-line session from history.db: ${tailMs.toFixed(1)} ms`);
    expect(tailMs).toBeLessThan(1_000);

    // Equivalence: the same messages, order and cursors as the file reads.
    expect(tail).toEqual(readTranscript(session, "tail", undefined, f.paths));
    expect(kids.subagents).toEqual(listNativeSubagents(session, f.paths));
    expect(kids.subagents.map((k: { id: string; status: string }) => [k.id, k.status]).sort()).toEqual([["done", "done"], ["huge", "done"], ["working", "unknown"]]);
    expect(childPage).toEqual(readTranscript(session, "0", "done", f.paths));
    expect(run.text).toContain("01:00:01 working");
  });

  it("pages forward from the start through every record with the file reader's cursors", async () => {
    const f = await fixture();
    f.drain();
    const session = { agent: "claude" as const, cwd: f.peer.cwd, sessionId: SESSION };
    const before = rawSourceReads();
    const viaStore: unknown[] = [], cursors: string[] = [];
    for (let from = "0", n = 0; n < 200; n++) {
      const page = await f.api(chat, { from });
      viaStore.push(...page.items); cursors.push(page.next);
      if (page.next === from) break;
      from = page.next;
    }
    expect(rawSourceReads() - before).toBe(0);
    const viaFile: unknown[] = [], fileCursors: string[] = [];
    for (let from = "0", n = 0; n < 200; n++) {
      const page = readTranscript(session, from, undefined, f.paths)!;
      viaFile.push(...page.items); fileCursors.push(page.next);
      if (page.next === from) break;
      from = page.next;
    }
    expect(cursors).toEqual(fileCursors);
    expect(viaStore).toEqual(viaFile);
    expect(viaStore.length).toBeGreaterThan(LINES);
  });

  it("flags sources that are not ingested yet and answers from the file", async () => {
    const f = await fixture();
    const session = { agent: "claude" as const, cwd: f.peer.cwd, sessionId: SESSION };
    const tail = await f.api(chat, { from: "tail" });
    expect(tail.importing).toBe(true);
    const { importing: _flag, ...page } = tail;
    expect(page).toEqual(readTranscript(session, "tail", undefined, f.paths));
    const kids = await f.api(`/api/sessions/claude-x/subagents`);
    expect(kids.importing).toBe(true);
    expect(kids.subagents).toEqual(listNativeSubagents(session, f.paths));
  });

  it("serves lines appended after ingestion: a watched change is retained in the next batch", async () => {
    const f = await fixture();
    f.drain();
    const first = await f.api(chat, { from: "tail" });
    appendFileSync(f.main, line(LINES + 1) + "\n");
    // Not retained yet: the live tail past the ingested offset is read from the file, so nothing is lost or late.
    const live = await f.api(chat, { from: first.next });
    expect(live.items.map((i: { text?: string }) => i.text)).toEqual([expect.stringContaining(`message ${LINES + 1}`)]);
    // One ingest batch retains it (the watcher marks the file changed; a bounded poll is the safety net).
    const started = performance.now();
    for (let n = 0; n < 20; n++) { f.ingest.tick(); const row = f.db.prepare("SELECT offset FROM conversation_sources WHERE id=?").get(f.main); if (Number(row?.offset) > Number(/j:(\d+)/.exec(first.next)![1])) break; }
    const ingestMs = performance.now() - started;
    const before = rawSourceReads();
    const retained = await f.api(chat, { from: first.next });
    expect(rawSourceReads() - before).toBe(0);
    expect(retained).toEqual(live);
    console.info(`AB-383 appended line retained by the ingester in ${ingestMs.toFixed(1)} ms of batch work`);
  });

  it("the history worker retains a watched append within the latency budget", async () => {
    vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
    const env = makeEnv(); cleanup.push(() => env.cleanup());
    const store = new MessageStore(env.db, nullLogger); cleanup.push(() => store.close());
    // Never the real CLI homes: every transcript root points into this test's home.
    const paths: TranscriptPaths = { claude: join(env.home, "claude"), codex: join(env.home, "codex"), opencode: join(env.home, "xdg", "opencode"), antigravity: join(env.home, "antigravity"), muse: join(env.home, "xdg", "muse") };
    vi.stubEnv("CLAUDE_CONFIG_DIR", paths.claude);
    vi.stubEnv("CODEX_HOME", paths.codex);
    vi.stubEnv("XDG_DATA_HOME", join(env.home, "xdg"));
    vi.stubEnv("ANTIGRAVITY_CLI_HOME", paths.antigravity!);
    const cwd = join(env.home, "project"); mkdirSync(cwd);
    const main = join(paths.claude, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${SESSION}.jsonl`);
    mkdirSync(dirname(main), { recursive: true });
    writeFileSync(main, Array.from({ length: 20 }, (_, n) => line(n)).join("\n") + "\n");
    const worker = new HistoryBackground(env.db, nullLogger);
    cleanup.push(() => worker.close());
    const peer = { id: "p1", name: "claude-x", agent: "claude", cwd, pid: 1, agentPid: null, sessionId: SESSION, startedAt: 0, autoWake: false } as unknown as PeerInfo;
    const ctx = { home: env.home, log: nullLogger, peers: () => [peer], transcripts: paths };
    const tail = async () => (await readDashboard(ctx, { path: chat, query: { from: "tail" } } as never)).body as Record<string, any>;
    const wait = async (done: () => Promise<boolean> | boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!(await done())) { if (Date.now() > end) throw new Error("condition not met in time"); await new Promise(r => setTimeout(r, 5)); }
    };
    await wait(async () => (await tail()).importing === undefined, 60_000);
    const retained = () => {
      const db = openHistoryReader(join(env.home, "history.db"));
      try { return Number(db.prepare("SELECT offset FROM conversation_sources WHERE id=?").get(main)?.offset ?? 0); } finally { db.close(); }
    };
    const samples: number[] = [];
    for (let n = 0; n < 5; n++) {
      const size = retained();
      const started = performance.now();
      appendFileSync(main, JSON.stringify({ type: "assistant", sessionId: SESSION, timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: `live ${n}` }] } }) + "\n");
      await wait(() => retained() > size, 5_000);
      samples.push(performance.now() - started);
      const page = await tail();
      expect(page.importing).toBeUndefined();
      expect(page.items.at(-1).text).toBe(`live ${n}`);
      await new Promise(r => setTimeout(r, 150));
    }
    console.info(`AB-383 append -> retained in history.db by the worker: ${samples.map(ms => ms.toFixed(0)).join(", ")} ms`);
    expect(Math.max(...samples)).toBeLessThan(5_000);
  });
});
