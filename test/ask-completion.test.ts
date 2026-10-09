import { readJobVersions } from "../src/core/job-archive-index.js";
import { readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recordAskCompletion, reconcileAskCompletions, observeAskToolRecord } from "../src/core/ask-completion.js";
import { DatabaseSync } from "node:sqlite";
import { makeEnv, type TestEnv } from "./helpers.js";
import { readArchivedJobs } from "../src/core/job-archive.js";
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });
/** The reconcile backup's bytes, in the home or where the archive migration retired it. */
function retainedBackup(): string | undefined {
  for (const dir of [env.home, join(env.home, "cold-storage", "jobs-v1", "root-originals")]) {
    try {
      const name = readdirSync(dir).find(entry => entry.startsWith("jobs.json.backup-"));
      if (name) return readFileSync(join(dir, name), "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return undefined;
}
const job = { id: "askfixture", name: "codex-ask-askfixture", owner: "owner", startedAt: 10, status: "running", prompt: "retained context" };
it("recovers a legacy ask from paired completed native tool records and refuses unpaired results", () => {
  const path = join(env.home, "jobs.json"), db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE history_cursors(source TEXT PRIMARY KEY,cursor TEXT)");
  writeFileSync(path, JSON.stringify({ version: 4, jobs: [job] }));
  const observe = (content: unknown[], at: number) => observeAskToolRecord(db, env.home, "fixture-native-log", 0, Buffer.from(JSON.stringify({ message: { content } })), at);
  try {
    const result = { type: "tool_result", tool_use_id: "call-1", content: `Job: ${job.name}\ncodex session_id: fixture\n\ncomplete answer` };
    observe([result], 20); expect(reconcileAskCompletions(path)).toBe(0);
    observe([{ type: "tool_use", id: "call-1", name: "mcp__agent_bridge__ask_codex", input: { prompt: "task" } }], 9);
    observe([result], 20); expect(reconcileAskCompletions(path)).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8")).jobs[0]).toMatchObject({ status: "done", finishedAt: 20 });
  } finally { db.close(); }
});
it("reconciles a stale active ask from its matching completion receipt without losing the original", async () => {
  const path = join(env.home, "jobs.json"), raw = JSON.stringify({ version: 4, privateField: "retained", jobs: [job] });
  writeFileSync(path, raw);
  recordAskCompletion(env.home, { ...job, finishedAt: 20, status: "done" });
  const owner = env.node("owner"); await owner.start();
  expect((await owner.projectJobs()).find(j => j.name === job.name)).toMatchObject({ status: "done", finishedAt: 20, prompt: job.prompt });
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ privateField: "retained" });
  // The broker's job-archive migration may run after the reconcile and retire the backup,
  // byte-verified, into cold storage. The original must be retained in one of the two places.
  await vi.waitFor(() => expect(retainedBackup()).toBe(raw));
  expect(readJobVersions(path, job.id)).toHaveLength(2);
  expect(reconcileAskCompletions(path)).toBe(0);
});
it("never treats an older completion as proof for a new continuation", () => {
  const path = join(env.home, "jobs.json"), raw = JSON.stringify({ version: 4, jobs: [{ ...job, startedAt: 30 }] });
  writeFileSync(path, raw);
  recordAskCompletion(env.home, { ...job, finishedAt: 20, status: "done" });
  expect(reconcileAskCompletions(path)).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(raw);
});
it("keeps terminal receipt authority in archives while retaining every stale original byte", () => {
  const path = join(env.home, "jobs.json");
  writeFileSync(path, JSON.stringify({ version: 4, jobs: [job] }));
  recordAskCompletion(env.home, { ...job, finishedAt: 20, status: "done" });
  expect(reconcileAskCompletions(path)).toBe(1);
  const originals = readJobVersions(path, job.id);
  const stale = originals.find(record => record.status === "running")!;
  const bytes = JSON.stringify(stale);
  expect(readArchivedJobs(path).find(record => record.id === job.id)).toMatchObject({ status: "done", finishedAt: 20, prompt: job.prompt });
  expect(JSON.stringify(readJobVersions(path, job.id).find(record => record.status === "running"))).toBe(bytes);
  expect(originals).toHaveLength(2);
});
it("retains native JSONL pairing across bounded import chunks and restart", () => {
  const path = join(env.home, "jobs.json"), file = join(env.home, "fixture-history.db");
  let db = new DatabaseSync(file);
  db.exec("CREATE TABLE history_cursors(source TEXT PRIMARY KEY,cursor TEXT)");
  writeFileSync(path, JSON.stringify({ version: 4, jobs: [job] }));
  const call = JSON.stringify({ timestamp: 9, message: { content: [{ type: "tool_use", id: "split-call", name: "mcp__agent_bridge__ask_codex" }] } });
  const result = JSON.stringify({ timestamp: 20, message: { content: [{ type: "tool_result", tool_use_id: "split-call", content: `Job: ${job.name}\ncodex session_id: fixture\ncompleted` }] } });
  const bytes = Buffer.from(call + "\n" + result + "\n"), split = call.length + 80;
  observeAskToolRecord(db, env.home, "native-jsonl", 0, bytes.subarray(0, split), 100, 0);
  db.close(); db = new DatabaseSync(file);
  try {
    observeAskToolRecord(db, env.home, "native-jsonl", 0, bytes.subarray(split), 100, split);
    expect(reconcileAskCompletions(path)).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8")).jobs[0]).toMatchObject({ status: "done", finishedAt: 20 });
  } finally { db.close(); }
});
