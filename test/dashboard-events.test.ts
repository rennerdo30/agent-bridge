import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rawSourceReads } from "../src/core/byte-source.js";
import { readDashboard } from "../src/core/dashboard-read.js";
import { HistoryBackground } from "../src/core/history-background.js";
import { HistoryChangeFeed, historyChangeOf, streamHistoryChanges, type HistoryChange } from "../src/core/history-feed.js";
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

    const worker = new HistoryBackground(env.db, nullLogger);
    cleanup.push(() => worker.close());
    const peer = { id: "p1", name: "claude-x", agent: "claude", cwd, pid: 1, agentPid: null, sessionId: SESSION, startedAt: 0, autoWake: false } as unknown as PeerInfo;
    const ctx = { home: env.home, log: nullLogger, peers: () => [peer], transcripts: paths };
    const page = async (from: string) => (await readDashboard(ctx, { path: "/api/sessions/claude-x/chat", query: { from } } as never)).body as Record<string, any>;
    const deadline = Date.now() + 60_000;
    while ((await page("tail")).importing !== undefined) {
      if (Date.now() > deadline) throw new Error("initial import did not finish");
      await new Promise(r => setTimeout(r, 20));
    }

    // The dashboard's event stream, served exactly as startUi serves GET /api/events.
    const feed = new HistoryChangeFeed(env.home);
    cleanup.push(() => feed.close());
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
    const samples: number[] = [];
    for (let n = 0; n < 5; n++) {
      await new Promise(r => setTimeout(r, 300));
      const started = performance.now();
      appendFileSync(main, say(`live ${n}`));
      let changes: HistoryChange[];
      do changes = await nextEvent();
      while (!changes.some(c => c.kind === "chat" && c.session === SESSION));
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
    console.info(`AB-383 line on disk -> pushed event -> indexed read: ${samples.map(ms => ms.toFixed(0)).join(", ")} ms`);
    expect(Math.max(...samples)).toBeLessThan(PUSH_BUDGET_MS);
  });
});
