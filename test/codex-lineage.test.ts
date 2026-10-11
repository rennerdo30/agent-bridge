import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CodexLineageLookup, codexCallIdentity } from "../src/mcp/codex-lineage.js";
import { makeEnv, type TestEnv } from "./helpers.js";
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });
function header(id: string, rows: unknown[], complete = true) {
  const dir = join(env.home, "sessions", "2026", "10", "11"); mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-fixture-${id}.jsonl`);
  writeFileSync(file, rows.map(payload => JSON.stringify({ type: "session_meta", payload })).join("\n") + (complete ? "\n" : ""));
  return file;
}
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
  const lookup = new CodexLineageLookup(join(env.home, "sessions"));
  expect(lookup.classify("later")).toBe("unknown");
  const file = header("later", [{ id: "later", source: "cli" }], false);
  expect(lookup.classify("later", file)).toBe("unknown");
  writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: "later", source: "cli" } }) + "\n");
  expect(lookup.classify("later", file)).toBe("main");
  const outside = join(env.home, "outside.jsonl"); writeFileSync(outside, JSON.stringify({ type: "session_meta", payload: { id: "outside", source: "cli" } }) + "\n");
  expect(lookup.classify("outside", outside)).toBe("unknown");
  expect(lookup.classify("../later", file)).toBe("unknown");
});
