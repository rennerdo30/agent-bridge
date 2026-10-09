import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryIndex } from "../src/core/history.js";
import { ConversationIngestor } from "../src/core/conversations.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { conversationProject, projectDatabasePath, syncProjectMirror } from "../src/core/project-store.js";
import { indexedJobProjectionCurrent, markJobProjection, storeJobRecords } from "../src/core/job-archive-index.js";
import { readRunnerState, writeRunnerState } from "../src/mcp/job-host.js";
import { fileSignature } from "../src/core/file-cache.js";
import { statSync } from "node:fs";
import { makeEnv, type TestEnv } from "./helpers.js";

// AB-147: idle background work skips unchanged inputs by cheap signatures and backs off while nothing changes.
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

const line = (session: string, text: string) => JSON.stringify({ type: "user", sessionId: session, cwd: env.home, message: { role: "user", content: text } }) + "\n";

it("checks unchanged transcripts by size, backs off rescans while idle and wakes on a change", () => {
  const store = new MessageStore(env.db, nullLogger);
  const db = new DatabaseSync(env.db);
  const claude = join(env.home, "claude"), projects = join(claude, "projects", "fixture");
  mkdirSync(projects, { recursive: true });
  for (let i = 0; i < 100; i++) writeFileSync(join(projects, `session-${i}.jsonl`), line(`session-${i}`, `retained transcript ${i}`));
  const empty = join(env.home, "empty-native");
  const index = new HistoryIndex(db, env.home, { claude, codex: empty, opencode: empty });
  let now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const drain = () => {
    let ticks = 0;
    for (; ticks < 500; ticks++) {
      const result = index.tick(true);
      if (!result.work && !result.discovering) return ticks;
    }
    throw new Error("Idle sweep did not converge");
  };
  const files = () => Number(db.prepare("SELECT count(*) n FROM history_files").get()!.n);
  try {
    drain();
    expect(files()).toBe(100);
    expect(index.search({ query: "retained transcript 42" }).hits.length).toBeGreaterThan(0);
    // A fallback sweep over 100 unchanged transcripts takes a few batches, not one batch per two files.
    now += 30_001;
    expect(drain()).toBeLessThanOrEqual(8);
    // Nothing changed since that rescan: the next one waits twice as long.
    now += 30_001; drain();
    writeFileSync(join(projects, "session-new.jsonl"), line("session-new", "late_unwatched_transcript"));
    now += 30_001; drain();
    expect(files()).toBe(100);
    now += 30_001; drain();
    expect(files()).toBe(101);
    expect(index.search({ query: "late_unwatched_transcript" }).hits).toHaveLength(1);
    // A watcher-reported change restores the normal cadence for appends.
    for (let i = 0; i < 4; i++) { now += 60_001; drain(); }
    appendFileSync(join(projects, "session-7.jsonl"), line("session-7", "watched_append_after_wake"));
    index.wake();
    now += 30_001; drain();
    expect(index.search({ query: "watched_append_after_wake" }).hits).toHaveLength(1);
  } finally { index.close(); db.close(); store.close(); }
});

it("ingests retained job snapshots several per batch and rereads the job stores only after they change", () => {
  const store = new MessageStore(env.db, nullLogger);
  const db = new DatabaseSync(env.db);
  const empty = join(env.home, "empty-native");
  const ingest = new ConversationIngestor(db, env.home, { claude: empty, codex: empty, opencode: empty });
  const jobs = (status: string) => Array.from({ length: 40 }, (_, i) => ({ id: `id${i}`, name: `codex-job-${i}`, agent: "codex", status, startedAt: i, workdir: env.home, prompt: `retained job ${i}` }));
  const snapshots = () => Number(db.prepare("SELECT count(*) n FROM history_cursors WHERE source LIKE 'durable-job:%'").get()!.n);
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: jobs("done") }));
    for (let i = 0; i < 4; i++) ingest.tick();
    expect(snapshots()).toBe(40); // was one job per tick
    // Unchanged stores: the 30-second pass does not requeue anything.
    now += 30_001; ingest.tick();
    expect(snapshots()).toBe(40);
    // A changed registry is read again and its new versions are retained alongside the old ones.
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: jobs("failed") }));
    now += 30_001; for (let i = 0; i < 4; i++) ingest.tick();
    expect(snapshots()).toBe(80);
  } finally { ingest.close(); db.close(); store.close(); }
});

it("leaves an idle project mirror closed until its project gets a newer record", () => {
  const store = new MessageStore(env.db, nullLogger), db = store.history.database;
  const project = conversationProject(env.home), mirror = projectDatabasePath(project, env.home);
  const signature = () => [mirror, `${mirror}-wal`].map((p) => { try { return fileSignature(statSync(p)); } catch { return "missing"; } }).join("|");
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    db.prepare("INSERT INTO conversations(id,agent,session,project) VALUES('fixture','codex','fake',?)").run(project);
    db.prepare("INSERT INTO conversation_records VALUES(1,'fixture',0,0,'fixture',1,?,'first',NULL)").run(Buffer.from("first"));
    expect(syncProjectMirror(db, project, env.home)).toBe(1);
    expect(syncProjectMirror(db, project, env.home)).toBe(0); // full cycle, nothing new: the mirror goes idle
    const idle = signature();
    for (let i = 0; i < 5; i++) expect(syncProjectMirror(db, project, env.home)).toBe(0);
    expect(signature()).toBe(idle);
    // A record of another project does not wake it; one of this project is copied at once.
    db.prepare("INSERT INTO conversations(id,agent,session,project) VALUES('other','codex','other','elsewhere')").run();
    db.prepare("INSERT INTO conversation_records VALUES(2,'other',0,0,'other',2,?,'other',NULL)").run(Buffer.from("other"));
    expect(syncProjectMirror(db, project, env.home)).toBe(0);
    expect(signature()).toBe(idle);
    db.prepare("INSERT INTO conversation_records VALUES(3,'fixture',0,1,'fixture',3,?,'second',NULL)").run(Buffer.from("second"));
    expect(syncProjectMirror(db, project, env.home)).toBe(1);
    const read = new DatabaseSync(mirror, { readOnly: true });
    try { expect(read.prepare("SELECT count(*) n FROM conversation_records").get()!.n).toBe(2); } finally { read.close(); }
    // The periodic full cycle (late project associations) still runs after the recycle interval.
    expect(syncProjectMirror(db, project, env.home)).toBe(0);
    const settled = signature();
    now += 5 * 60_000 + 1;
    syncProjectMirror(db, project, env.home);
    expect(signature()).not.toBe(settled);
  } finally { store.close(); }
});

it("answers the job projection check from memory only while the stores are unchanged", () => {
  const path = join(env.home, "jobs.json");
  const job = { id: "one", name: "codex-job-one", owner: "owner", status: "done", startedAt: 1 };
  writeFileSync(path, JSON.stringify({ version: 4, jobs: [job] }));
  storeJobRecords(path, [job]);
  expect(indexedJobProjectionCurrent(path)).toBe(false);
  markJobProjection(path, [job]);
  expect(indexedJobProjectionCurrent(path)).toBe(true);
  expect(indexedJobProjectionCurrent(path)).toBe(true);
  writeFileSync(path, JSON.stringify({ version: 4, jobs: [{ ...job, status: "failed" }] }));
  expect(indexedJobProjectionCurrent(path)).toBe(false);
});

it("rereads runner state only after the runner rewrites it, and hands out copies", () => {
  writeRunnerState(env.home, "abc", { pid: 1, status: "running", updatedAt: 1 } as never);
  const first = readRunnerState(env.home, "abc")!;
  expect(first.updatedAt).toBe(1);
  (first as { status: string }).status = "mutated";
  expect(readRunnerState(env.home, "abc")!.status).toBe("running");
  writeRunnerState(env.home, "abc", { pid: 1, status: "done", updatedAt: 2 } as never);
  expect(readRunnerState(env.home, "abc")).toMatchObject({ status: "done", updatedAt: 2 });
  expect(readRunnerState(env.home, "missing")).toBeNull();
});
