import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TranscriptPaths } from "../src/core/transcripts/common.js";

/** Only called with a fresh synthetic home. ~96 MiB input, bounded 256 KiB seed buffers. */
export function seedLargeHistoryBackfill(home: string): { paths: TranscriptPaths; bytes: number; files: { path: string; agent: string; session: string }[] } {
  const paths = { codex: join(home, "codex-fixture"), claude: join(home, "claude-fixture"), opencode: join(home, "xdg-fixture", "opencode"), antigravity: join(home, "antigravity-fixture") };
  const codex = join(paths.codex, "sessions", "2026", "10", "08", "rollout-2026-10-08T00-00-00-00000000-0000-4000-8000-000000000167.jsonl");
  const claude = join(paths.claude, "projects", "backfill", "backfill-session.jsonl");
  for (const file of [codex, claude]) mkdirSync(dirname(file), { recursive: true });
  writeFileSync(codex, JSON.stringify({ type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000167", cwd: home } }) + "\n");
  writeFileSync(claude, JSON.stringify({ type: "user", sessionId: "backfill-session", cwd: home, message: { content: "backfill witness" } }) + "\n");
  const text = "backfill_index_needle ".repeat(700);
  const codexLine = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }) + "\n";
  const claudeLine = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
  for (let i = 0; i < 200; i++) { appendFileSync(codex, codexLine.repeat(16)); appendFileSync(claude, claudeLine.repeat(16)); }
  mkdirSync(paths.opencode, { recursive: true });
  const sqlite = join(paths.opencode, "opencode.db"), db = new DatabaseSync(sqlite);
  try {
    db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER);
      CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);`);
    db.prepare("INSERT INTO session VALUES('ses_backfill',NULL,'Backfill',?,1,1)").run(home);
    db.exec("BEGIN");
    for (let i = 0; i < 800; i++) db.prepare("INSERT INTO part VALUES(?,'msg_backfill','ses_backfill',1,1,?)").run(`prt_${String(i).padStart(5, "0")}`, JSON.stringify({ type: "text", text }));
    db.exec("COMMIT");
  } finally { db.close(); }
  return { paths, bytes: statSync(codex).size + statSync(claude).size + statSync(sqlite).size,
    files: [{ path: codex, agent: "codex", session: "00000000-0000-4000-8000-000000000167" }, { path: claude, agent: "claude", session: "backfill-session" }, { path: "opencode:ses_backfill", agent: "opencode", session: "ses_backfill" }] };
}

/** Register known inputs so backfill runs throughout the measurement window. */
export function primeLargeHistoryBackfill(db: DatabaseSync, home: string, fixture: ReturnType<typeof seedLargeHistoryBackfill>): void {
  for (const file of fixture.files) db.prepare("INSERT OR IGNORE INTO history_files(path,kind,agent,session,cwd,child,checked) VALUES(?,'transcript',?,?,?,NULL,-100000)").run(file.path,file.agent,file.session,home);
}
export function backfillBytes(db: DatabaseSync, fixture: ReturnType<typeof seedLargeHistoryBackfill>): number {
  return Number(db.prepare("SELECT coalesce(sum(length(raw)),0) n FROM conversation_records WHERE source IN (?,?,?) OR source LIKE ?")
    .get(fixture.files[0]!.path,fixture.files[1]!.path,fixture.files[2]!.path,`${fixture.files[2]!.path}:%`)!.n);
}
