import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageStore } from "../src/core/store.js";
import {
  ConversationIngestor,
  readConversation,
  CONVERSATION_BYTES,
} from "../src/core/conversations.js";
import { HistoryIndex } from "../src/core/history.js";
import { MAX_TRANSCRIPT_CHUNK_BYTES } from "../src/core/transcripts/common.js";
import {
  conversationProject,
  ensureProjectFolder,
  projectDatabasePath,
} from "../src/core/project-store.js";
import { loadConfig } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import {
  installTranscriptFixtures,
  CLAUDE_SESSION,
} from "./transcript-fixtures.js";
import { makeEnv, type TestEnv } from "./helpers.js";

export let env: TestEnv;
export let close: (() => void)[] = [];
beforeEach(() => {
  env = makeEnv();
  vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
});
afterEach(async () => {
  for (const f of close.reverse()) f();
  close = [];
  await env.cleanup();
  vi.unstubAllEnvs();
});
export function fixture(claudeOnly = false) {
  const s = new MessageStore(env.db, nullLogger);
  close.push(() => s.close());
  const files = installTranscriptFixtures(env.home),
    db = new DatabaseSync(env.db);
  close.push(() => db.close());
  const project = join(env.home, "project");
  mkdirSync(project);
  execFileSync("git", ["init", project], {
    stdio: "ignore",
    windowsHide: true,
  });
  appendFileSync(
    files.claude,
    JSON.stringify({
      type: "user",
      cwd: project,
      message: { content: "durable_project_needle" },
    }) + "\n",
  );
  const cli = new DatabaseSync(files.sqlite);
  cli.exec("ALTER TABLE session ADD COLUMN directory TEXT");
  cli.prepare("UPDATE session SET directory=?").run(project);
  cli.close();
  // Byte retention and generation tests only exercise Claude. Keep unrelated
  // Codex/OpenCode fixtures outside discovery for those focused cases.
  const paths = claudeOnly ? {
    ...files.paths,
    codex: join(env.home, "empty-codex"),
    opencode: join(env.home, "empty-opencode"),
  } : files.paths;
  const index = new HistoryIndex(db, env.home, paths);
  close.push(() => index.close());
  const ingest = new ConversationIngestor(db, env.home, paths);
  close.push(() => ingest.close());
  const tick = (count = 80) => {
    let idleSweeps = 0;
    for (let i = 0; i < count; i++) {
      const indexed = index.tick();
      const ingested = ingest.tick();
      // Finish a complete idle source sweep instead of writing dozens of
      // redundant primary/mirror WAL batches after the fixture has converged.
      if (indexed.work || ingested) idleSweeps = 0;
      else if (!indexed.discovering && !ingest.discovering) idleSweeps++;
      if (idleSweeps >= 2)
        return;
    }
  };
  return { s, files, paths, db, project, index, ingest, tick };
}
