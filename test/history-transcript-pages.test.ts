import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryIndex } from "../src/core/history.js";
import { historySchema } from "../src/core/history-schema.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv, db: DatabaseSync, index: HistoryIndex;
type File = { path: string; kind: string; agent: string; session: string; cwd: string; child: null };
let file: File;
beforeEach(() => {
  env = makeEnv(); db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE messages(id TEXT, body TEXT, from_agent TEXT, from_name TEXT, from_id TEXT, recipient TEXT, to_target TEXT, created_at INTEGER)");
  db.exec(historySchema(false));
  const root = join(env.home, "claude"); mkdirSync(root);
  file = { path: join(root, "session.jsonl"), kind: "transcript", agent: "claude", session: "session", cwd: env.home, child: null };
  writeFileSync(file.path, Array.from({ length: 20 }, (_, n) => JSON.stringify({ type: "assistant", uuid: `item-${n}`,
    message: { content: [{ type: "text", text: `line ${n}` }] } }) + "\n").join(""));
  index = new HistoryIndex(db, null, { claude: root, codex: root, opencode: root });
});
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); index?.close(); db.close(); await env.cleanup(); });
// Exercise the actual bounded page used by tick, with discovery already done.
const page = () => (index as unknown as { indexFile(file: File): number }).indexFile(file);

it.each([false, true])("attributes per-item sync stalls and keeps the page commit within 500 ms (batch=%s)", batch => {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  if (!batch) {
    // Reproduce the former page policy with the real document/tag writer and
    // source parser; only the outer page transaction is removed.
    vi.spyOn(index as unknown as { transcriptPage(file: File, next: string, write: () => void): void }, "transcriptPage")
      .mockImplementation((_file, next, write) => {
        write();
        db.prepare("INSERT INTO history_cursors VALUES (?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(file.path, next);
      });
  }
  const exec = db.exec.bind(db);
  let commits = 0;
  vi.spyOn(db, "exec").mockImplementation(sql => {
    exec(sql);
    // Simulate a slow disk sync, without generating load or sleeping. Nested
    // savepoint releases do not commit the outer transaction to disk.
    if (sql.startsWith("RELEASE ") && !db.isTransaction) { commits++; vi.advanceTimersByTime(120); }
  });
  const started = performance.now();
  expect(page()).toBe(20);
  if (batch) expect(performance.now() - started).toBeLessThan(500);
  else expect(performance.now() - started).toBeGreaterThan(500);
  expect(commits).toBe(batch ? 1 : 20);
  expect(db.prepare("SELECT count(*) n FROM history_documents").get()?.n).toBe(20);
  expect(db.prepare("SELECT cursor FROM history_cursors WHERE source=?").get(file.path)?.cursor).toMatch(/^j:/);
});

it("rolls back a failed page and its cursor together and replays every original item", () => {
  db.exec("CREATE TRIGGER refuse_item BEFORE INSERT ON history_documents WHEN new.body='line 5' BEGIN SELECT RAISE(ABORT, 'page refused'); END");
  expect(page).toThrow("page refused");
  expect(db.prepare("SELECT count(*) n FROM history_documents").get()?.n).toBe(0);
  expect(db.prepare("SELECT cursor FROM history_cursors WHERE source=?").get(file.path)).toBeUndefined();
  db.exec("DROP TRIGGER refuse_item");
  expect(page()).toBe(20);
  expect(db.prepare("SELECT count(*) n FROM history_documents").get()?.n).toBe(20);
});
