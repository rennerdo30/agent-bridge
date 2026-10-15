import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeByteSources, rawSourceReads } from "../src/core/byte-source.js";
import { historyReader } from "../src/core/dashboard-history.js";
import { readDashboard } from "../src/core/dashboard-read.js";
import { HistoryBackground } from "../src/core/history-background.js";
import { HISTORY_FEED_SCAN_ROWS, HISTORY_FEED_SCAN_SQL, HistoryChangeFeed, historyChangeOf, streamHistoryChanges, type HistoryChange } from "../src/core/history-feed.js";
import { ConversationIngestor } from "../src/core/conversations.js";
import { HistoryIndex } from "../src/core/history.js";
import { HistorySourceResolver } from "../src/core/history-sources.js";
import { migrateHistoryStore, openHistoryStore } from "../src/core/history-store.js";
import { nullLogger } from "../src/core/logger.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { MessageStore } from "../src/core/store.js";
import type { TranscriptPaths } from "../src/core/transcripts/index.js";
import { makeEnv } from "./helpers.js";

/** AB-383: a line written to a transcript reaches an open dashboard as a pushed event plus an indexed read. */
const SESSION = "11111111-2222-3333-4444-555555555555";
/** Owner target: under 500 ms from the line on disk to the line readable by the dashboard (aim ~200 ms). */
const PUSH_BUDGET_MS = 500;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

const say = (text: string) => JSON.stringify({ type: "assistant", sessionId: SESSION, timestamp: new Date().toISOString(), message: { content: [{ type: "text", text }] } }) + "\n";

describe("history change feed (AB-383)", () => {
  it("maps retained conversations to dashboard targets", () => {
    expect(historyChangeOf(`claude:${SESSION}`)).toEqual({ kind: "chat", agent: "claude", session: SESSION, child: null });
    expect(historyChangeOf(`claude:${SESSION}:native:agent_1`)).toEqual({ kind: "chat", agent: "claude", session: SESSION, child: "agent_1" });
    expect(historyChangeOf("bridge:run:2026-10-15-01-00-00-codex-job-abcd1234")).toEqual({ kind: "run", run: "2026-10-15-01-00-00-codex-job-abcd1234" });
    expect(historyChangeOf("bridge:job:x")).toBeNull();
    expect(historyChangeOf("other:abc")).toBeNull();
  });

  it("pushes an appended line to an open event stream and serves it from history.db within the budget", async () => {
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
    writeFileSync(main, Array.from({ length: 20 }, (_, n) => say(`before ${n}`)).join(""));

    const timings: Record<string, unknown>[] = [];
    const worker = new HistoryBackground(env.db, { ...nullLogger, debug: (_message, data) => { if (data) timings.push(data); } });
    cleanup.push(() => worker.close());
    const peer = { id: "p1", name: "claude-x", agent: "claude", cwd, pid: 1, agentPid: null, sessionId: SESSION, startedAt: 0, autoWake: false } as unknown as PeerInfo;
    // The dashboard's event feed; as in startUi, dashboard reads borrow its held history.db connection (AB-397).
    const feed = new HistoryChangeFeed(env.home);
    cleanup.push(() => feed.close());
    const ctx = { home: env.home, log: nullLogger, peers: () => [peer], transcripts: paths, history: () => feed.connection };
    const page = async (from: string) => (await readDashboard(ctx, { path: "/api/sessions/claude-x/chat", query: { from } } as never)).body as Record<string, any>;
    const deadline = Date.now() + 60_000;
    while ((await page("tail")).importing !== undefined) {
      if (Date.now() > deadline) throw new Error("initial import did not finish");
      await new Promise(r => setTimeout(r, 20));
    }

    // The dashboard's event stream, served exactly as startUi serves GET /api/events.
    const server = createServer((req, res) => streamHistoryChanges(feed, req, res));
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
    const abort = new AbortController();
    cleanup.push(() => abort.abort());
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`, { signal: abort.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let buffered = "";
    const nextEvent = async (): Promise<HistoryChange[]> => {
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2);
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6)) as HistoryChange[];
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("event stream ended");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    };

    let cursor = (await page("tail")).next as string;
    const samples: number[] = [], pushed: number[] = [];
    for (let n = 0; n < 5; n++) {
      await new Promise(r => setTimeout(r, 300));
      const started = performance.now();
      appendFileSync(main, say(`live ${n}`));
      let changes: HistoryChange[];
      do changes = await nextEvent();
      while (!changes.some(c => c.kind === "chat" && c.session === SESSION));
      pushed.push(performance.now() - started);
      const before = rawSourceReads();
      const fresh = await page(cursor);
      const elapsed = performance.now() - started;
      // Served from history.db: no file read, and the pushed line is there.
      expect(rawSourceReads() - before).toBe(0);
      expect(fresh.importing).toBeUndefined();
      expect(fresh.items.map((item: { text?: string }) => item.text)).toEqual([`live ${n}`]);
      cursor = fresh.next;
      samples.push(elapsed);
    }
    console.info(`AB-383 line on disk -> pushed event -> indexed read: ${samples.map(ms => ms.toFixed(0)).join(", ")} ms (event at ${pushed.map(ms => ms.toFixed(0)).join(", ")} ms)`);
    console.info("AB-383 worker phases (ms):", JSON.stringify(timings.slice(-12)));
    expect(Math.max(...samples)).toBeLessThan(PUSH_BUDGET_MS);
  });

  it("lets dashboard reads borrow the feed's held history.db connection without closing it (AB-397)", async () => {
    vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
    const env = makeEnv(); cleanup.push(() => env.cleanup());
    const store = new MessageStore(env.db, nullLogger); cleanup.push(() => store.close());
    const db = openHistoryStore(join(env.home, "history.db")); cleanup.push(() => db.close());
    await migrateHistoryStore(env.db, db);
    const feed = new HistoryChangeFeed(env.home); cleanup.push(() => feed.close());
    expect(feed.connection).toBeNull();
    const unsubscribe = feed.subscribe(() => {});
    const held = feed.connection!;
    expect(held).not.toBeNull();
    const prepare = vi.spyOn(held, "prepare");
    const reader = historyReader(env.home, () => feed.connection);
    expect(reader.read(() => activeByteSources()).value).toBeInstanceOf(HistorySourceResolver);
    expect(prepare).toHaveBeenCalled();
    reader.close();
    prepare.mockRestore();
    // Still the feed's: open, polled, and released only with the last stream.
    expect(held.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
    expect(feed.active).toEqual({ polling: true, connected: true });
    unsubscribe();
    expect(feed.active).toEqual({ polling: false, connected: false });
    // Without a held connection (or with a closed one) a read opens and closes its own, as before.
    const fallback = historyReader(env.home, () => held);
    expect(fallback.read(() => activeByteSources()).value).toBeInstanceOf(HistorySourceResolver);
    fallback.close();
  });

  it("reads new records by rowid range, never by scanning the whole table", () => {
    const env = makeEnv(); cleanup.push(() => env.cleanup());
    const db = openHistoryStore(join(env.home, "history.db")); cleanup.push(() => db.close());
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${HISTORY_FEED_SCAN_SQL}`).all(0, HISTORY_FEED_SCAN_ROWS).map(row => String(row.detail)).join("\n");
    expect(plan).toMatch(/SEARCH conversation_records USING INTEGER PRIMARY KEY \(rowid>\?\)/);
    expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
  });

  it("releases its timer and history.db connection when the last stream closes", async () => {
    vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
    const env = makeEnv(); cleanup.push(() => env.cleanup());
    const store = new MessageStore(env.db, nullLogger); cleanup.push(() => store.close());
    const db = openHistoryStore(join(env.home, "history.db")); cleanup.push(() => db.close());
    await migrateHistoryStore(env.db, db);
    const feed = new HistoryChangeFeed(env.home); cleanup.push(() => feed.close());
    const first = feed.subscribe(() => {}), second = feed.subscribe(() => {});
    expect(feed.active).toEqual({ polling: true, connected: true });
    first();
    expect(feed.active).toEqual({ polling: true, connected: true });
    second();
    expect(feed.active).toEqual({ polling: false, connected: false });
  });

  it("serves /api/events only behind dashboard authentication and ends open streams on close", async () => {
    const env = makeEnv(); cleanup.push(() => env.cleanup());
    const { startUi } = await import("../src/cli/ui.js");
    const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    let closed = false;
    cleanup.push(async () => { if (!closed) await ui.close(); });
    const base = ui.url.replace(/\/\?t=.*$/, "");
    expect((await fetch(`${base}/api/events`)).status).toBe(403);
    const cookie = String((await fetch(ui.url, { redirect: "manual" })).headers.get("set-cookie")).split(";")[0]!;
    // A foreign Host (DNS rebinding) is refused even with the cookie.
    const foreign = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: ui.port, path: "/api/events", headers: { host: "evil.example", cookie } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject); req.end();
    });
    expect(foreign).toBe(403);
    const response = await fetch(`${base}/api/events`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("retry: 1000");
    const ended = (async () => { for (;;) if ((await reader.read()).done) return true; })();
    closed = true;
    await ui.close();
    await expect(ended).resolves.toBe(true);
  });

  it("commits a retained chunk and its source offset together: a failed write leaves neither", async () => {
    vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
    const env = makeEnv(); cleanup.push(() => env.cleanup());
    const store = new MessageStore(env.db, nullLogger); cleanup.push(() => store.close());
    const source = new DatabaseSync(env.db); cleanup.push(() => source.close());
    const db = openHistoryStore(join(env.home, "history.db")); cleanup.push(() => db.close());
    await migrateHistoryStore(env.db, db);
    const paths: TranscriptPaths = { claude: join(env.home, "claude"), codex: join(env.home, "empty-codex"), opencode: join(env.home, "empty-opencode") };
    const cwd = join(env.home, "project"); mkdirSync(cwd);
    const main = join(paths.claude, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${SESSION}.jsonl`);
    mkdirSync(dirname(main), { recursive: true });
    writeFileSync(main, say("first") + say("second"));
    const index = new HistoryIndex(db, env.home, paths, source); cleanup.push(() => index.close());
    const ingest = new ConversationIngestor(db, env.home, paths, source); cleanup.push(() => ingest.close());
    for (let n = 0; n < 50 && !db.prepare("SELECT 1 FROM history_files WHERE path=?").get(main); n++) index.tick(true);
    const retained = () => ({
      records: Number(db.prepare("SELECT count(*) n FROM conversation_records WHERE source=?").get(main)!.n),
      offset: Number(db.prepare("SELECT offset FROM conversation_sources WHERE id=?").get(main)?.offset ?? 0),
    });
    // Fail after the chunk record is inserted, inside the same write.
    const failing = vi.spyOn(ingest as unknown as { indexRecord(): void }, "indexRecord").mockImplementation(() => { throw new Error("injected index failure"); });
    expect(() => { for (let n = 0; n < 20; n++) ingest.tick(); }).toThrow("injected index failure");
    expect(retained()).toEqual({ records: 0, offset: 0 });
    failing.mockRestore();
    for (let n = 0; n < 20 && retained().offset === 0; n++) ingest.tick();
    expect(retained()).toEqual({ records: 1, offset: Buffer.byteLength(say("first") + say("second")) });
  });
});
