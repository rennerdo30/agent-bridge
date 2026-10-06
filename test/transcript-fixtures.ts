import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TranscriptPaths } from "../src/core/transcripts/index.js";

export const CLAUDE_SESSION = "session-example";
export const CODEX_SESSION = "00000000-0000-4000-8000-000000000000";
export const CODEX_CHILD = "11111111-1111-4111-8111-111111111111";
export const FIXTURES = join(import.meta.dirname, "fixtures", "transcripts");

export function installTranscriptFixtures(home: string): { paths: TranscriptPaths; claude: string; codex: string; sqlite: string } {
  const paths = { claude: join(home, "claude"), codex: join(home, "codex"), opencode: join(home, "opencode") };
  const claude = join(paths.claude, "projects", "project-example", `${CLAUDE_SESSION}.jsonl`);
  const codex = join(paths.codex, "sessions", "2026", "10", "06", `rollout-2026-10-06T09-00-00-${CODEX_SESSION}.jsonl`);
  const child = join(dirname(claude), CLAUDE_SESSION, "subagents", "agent-agent_example.jsonl");
  const codexChild = join(dirname(codex), `rollout-2026-10-06T09-00-00-${CODEX_CHILD}.jsonl`);
  for (const [source, target] of [["claude.jsonl", claude], ["claude-subagent.jsonl", child], ["codex.jsonl", codex], ["codex-subagent.jsonl", codexChild]]) {
    mkdirSync(dirname(target!), { recursive: true });
    copyFileSync(join(FIXTURES, source!), target!);
  }
  mkdirSync(paths.opencode, { recursive: true });
  const sqlite = join(paths.opencode, "opencode.db"), db = new DatabaseSync(sqlite);
  try {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
    const fixture = JSON.parse(readFileSync(join(FIXTURES, "opencode.json"), "utf8"));
    for (const table of ["session", "message", "part"]) for (const row of fixture[`${table}s`]) {
      const keys = Object.keys(row), values = Object.values(row).map((v) => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
      db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...values as (string | number | null)[]);
    }
  } finally { db.close(); }
  return { paths, claude, codex, sqlite };
}
