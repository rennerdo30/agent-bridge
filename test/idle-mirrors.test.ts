import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationIngestor } from "../src/core/conversations.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";
import * as mirrors from "../src/core/project-store.js";

let env: TestEnv, store: MessageStore, db: DatabaseSync, ingest: ConversationIngestor;
beforeEach(() => {
  env = makeEnv(); vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0"); store = new MessageStore(env.db, nullLogger); db = new DatabaseSync(env.db);
  const root = join(env.home, "empty-native"); mkdirSync(root); ingest = new ConversationIngestor(db, env.home, { claude: root, codex: root, opencode: root });
});
afterEach(async () => { ingest.close(); db.close(); store.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await env.cleanup(); });

it("finishes large sweeps without rediscovering pending projects on forced ticks", () => {
  const projects = Array.from({ length: 70 }, (_, i) => join(env.home, `project-${String(i).padStart(3, "0")}`));
  for (const project of projects) db.prepare("INSERT INTO conversation_projects(project) VALUES(?)").run(project);
  const seen = new Map<string, number>();
  const sync = vi.spyOn(mirrors, "syncProjectMirror").mockImplementation((_db, project, pending) => { const count=(seen.get(project) ?? 0)+1; seen.set(project,count); pending?.(count < 3); return 0; });
  // More than one discovery page and per-project batch; forced requests must not restart active sweeps.
  for (let i = 0; i < 220 && ingest.discovering; i++) ingest.tick(true);
  expect(ingest.discovering).toBe(false);
  expect(seen.size).toBe(70); expect([...seen.values()].every(count => count === 3)).toBe(true);
  const calls = sync.mock.calls.length;
  for (let i = 0; i < 10; i++) ingest.tick(false);
  expect(sync).toHaveBeenCalledTimes(calls);
  ingest.notifyJobs(); ingest.tick(false);
  expect(sync.mock.calls.length).toBeGreaterThan(calls);
});
