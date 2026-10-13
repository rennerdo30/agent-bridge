import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as transcripts from "../src/core/transcripts/common.js";
import { CodexLineageLookup, codexCallIdentity } from "../src/mcp/codex-lineage.js";
import { makeEnv, type TestEnv } from "./helpers.js";
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await env.cleanup(); });
function header(id: string, rows: unknown[], complete = true) {
  const dir = join(env.home, "sessions", "2026", "10", "11"); mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-fixture-${id}.jsonl`);
  writeFileSync(file, rows.map(payload => JSON.stringify({ type: "session_meta", payload })).join("\n") + (complete ? "\n" : ""));
  return file;
}
it.each(["cli", "vscode", "exec", "mcp"])("only interactive main source %s can succeed a broker", source => {
  header("launch", [{ id: "launch", source }]);
  const lookup = new CodexLineageLookup(join(env.home, "sessions"));
  expect(lookup.classify("launch")).toBe("main");
  expect(lookup.isInteractive("launch")).toBe(["cli", "vscode"].includes(source));
  header("child", [{ id: "child", source: { subagent: { thread_spawn: { parent_thread_id: "launch" } } } }]);
  expect(lookup.isInteractive("child")).toBe(false);
});
it.each([
  { thread_source: "subagent", parent_thread_id: "root" },
  { source: { subagent: { thread_spawn: { parent_thread_id: "root" } } } },
])("matches native lineage against the child id even with inherited root metadata: %j", lineage => {
  header("child", [{ id: "root", source: "cli" }, { id: "child", session_id: "root", ...lineage }]);
  const lookup = new CodexLineageLookup(join(env.home, "sessions"));
  expect(lookup.classify("child")).toBe("child");
  expect(lookup.classify("root")).toBe("unknown");
});
it("allows main forks/resumes without inferring children from changed ids", () => {
  header("resume", [{ id: "root", source: "cli" }, { id: "resume", session_id: "root", forked_from_id: "root", source: "cli" }]);
  expect(new CodexLineageLookup(join(env.home, "sessions")).classify("resume")).toBe("main");
  expect(codexCallIdentity({ threadId: "resume", sessionId: "root" }).threadId).toBe("resume");
  expect(codexCallIdentity({ sessionId: "root" }).threadId).toBeUndefined();
});
it("retries incomplete/missing lineage and refuses a supplied outside file", () => {
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  const lookup = new CodexLineageLookup(join(env.home, "sessions"));
  expect(lookup.classify("later")).toBe("unknown");
  const file = header("later", [{ id: "later", source: "cli" }], false);
  now += 10_000;
  expect(lookup.classify("later", file)).toBe("unknown");
  writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: "later", source: "cli" } }) + "\n");
  expect(lookup.classify("later", file)).toBe("unknown");
  now += 10_000;
  expect(lookup.classify("later", file)).toBe("main");
  const outside = join(env.home, "outside.jsonl"); writeFileSync(outside, JSON.stringify({ type: "session_meta", payload: { id: "outside", source: "cli" } }) + "\n");
  expect(lookup.classify("outside", outside)).toBe("unknown");
  expect(lookup.classify("../later", file)).toBe("unknown");
});

const desktopId = "019baa5a-3c18-7000-8000-000000000001";
function desktopFixture(day: string, child = false) {
  const id = child ? "019baa5a-3c18-7000-8000-000000000002" : desktopId;
  const dir = join(env.home, "sessions", ...day.split("-")); mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-fixture-${id}.jsonl`);
  copyFileSync(join(import.meta.dirname, "fixtures", "transcripts", `codex-desktop-${child ? "child" : "main"}.jsonl`), file);
  return id;
}

it.each(["2026-01-10", "2026-01-09", "2026-01-11"])("finds a months-old desktop thread resumed today in creation day %s without a transcript hint", day => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-11T12:00:00Z"));
  const root = join(env.home, "sessions"), latest = join(root, "2026", "10", "11");
  desktopFixture(day);
  mkdirSync(latest, { recursive: true });
  const actualDirectory = transcripts.directory;
  const listing = vi.spyOn(transcripts, "directory").mockImplementation(dir => dir === latest ? Array.from({ length: 20_001 }, (_, i) => `rollout-newer-${i}.jsonl`) : actualDirectory(dir));
  expect(new CodexLineageLookup(root).classify(desktopId)).toBe("main");
  // Newer history would exhaust fallback; direct lookup never even lists its root.
  expect(listing.mock.calls.map(([dir]) => dir)).not.toContain(root);
  expect(listing.mock.calls.map(([dir]) => dir)).not.toContain(latest);
  expect(listing.mock.calls.length).toBeLessThanOrEqual(3);
});

it("rejects native thread_spawn with only a nested parent id", () => {
  const id = desktopFixture("2026-01-10", true);
  const { payload } = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "transcripts", "codex-desktop-child.jsonl"), "utf8"));
  expect(payload.parent_thread_id).toBeUndefined();
  expect(payload.source.subagent.thread_spawn).toMatchObject({ parent_thread_id: desktopId, depth: 1, agent_path: "/root/x", agent_nickname: "fixture-child" });
  expect(new CodexLineageLookup(join(env.home, "sessions")).classify(id)).toBe("child");
});

it.each([
  ["bridge-main", "main"], ["sidepanel-main", "main"], ["tui-main", "main"], ["guardian-child", "child"],
])("classifies the real %s header as %s without a transcript hint", (fixture, expected) => {
  const file = join(import.meta.dirname, "fixtures", "transcripts", `codex-${fixture}.jsonl`);
  const { payload } = JSON.parse(readFileSync(file, "utf8"));
  const dir = join(env.home, "sessions", "2026", "01", "10"); mkdirSync(dir, { recursive: true });
  copyFileSync(file, join(dir, `rollout-fixture-${payload.id}.jsonl`));
  if (fixture === "bridge-main") expect(payload.thread_source).toBeUndefined();
  if (fixture === "guardian-child") expect(payload.source).toEqual({ subagent: { other: "guardian" } });
  expect(new CodexLineageLookup(join(env.home, "sessions")).classify(payload.id)).toBe(expected);
});

it("does not rescan a missing id on every call and discovers its header after ten seconds", () => {
  let now = Date.parse("2026-10-11T12:00:00Z"); vi.spyOn(Date, "now").mockImplementation(() => now);
  const listing = vi.spyOn(transcripts, "directory"), read = vi.spyOn(transcripts, "readJsonl");
  const lookup = new CodexLineageLookup(join(env.home, "sessions"));
  expect(lookup.classify(desktopId)).toBe("unknown");
  const fileId = desktopFixture("2026-01-10");
  const file = join(env.home, "sessions", "2026", "01", "10", `rollout-fixture-${fileId}.jsonl`);
  const scans = listing.mock.calls.length, reads = read.mock.calls.length;
  now += 9_999;
  for (let i = 0; i < 100; i++) expect(lookup.classify(desktopId, file)).toBe("unknown");
  expect(listing).toHaveBeenCalledTimes(scans); expect(read).toHaveBeenCalledTimes(reads);
  // A different id is independent; unknown is temporary, never a permanent decision.
  const child = desktopFixture("2026-01-10", true);
  expect(lookup.classify(child)).toBe("child");
  now++;
  expect(lookup.classify(desktopId)).toBe("main");
  const after = listing.mock.calls.length;
  expect(lookup.classify(desktopId)).toBe("main"); expect(listing).toHaveBeenCalledTimes(after);
});

it("uses bounded fallback when a UUIDv7 rollout is stored outside its derived day", () => {
  desktopFixture("2026-10-11");
  expect(new CodexLineageLookup(join(env.home, "sessions")).classify(desktopId)).toBe("main");
});

it("honors CODEX_HOME for the default lookup root", () => {
  vi.stubEnv("CODEX_HOME", ` ${env.home} `);
  desktopFixture("2026-01-10");
  expect(transcripts.transcriptPaths().codex).toBe(env.home);
  expect(new CodexLineageLookup().classify(desktopId)).toBe("main");
});
