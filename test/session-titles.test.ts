import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { claudeChatTitle } from "../src/core/session-titles.js";

// AB-474: plain Claude sessions show the AI title Claude Code writes into its transcript.
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const CWD = "E:/Development/game";
function transcript(lines: object[]) {
  const home = mkdtempSync(join(tmpdir(), "ab-titles-")); homes.push(home);
  const id = "0f9d5c0e-1111-4222-8333-" + String(homes.length).padStart(12, "0");
  const dir = join(home, "projects", CWD.replace(/[^A-Za-z0-9]/g, "-")); mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const paths = { claude: home, codex: join(home, "codex"), opencode: join(home, "opencode") };
  return { file, paths, session: { agent: "claude" as const, cwd: CWD, sessionId: id } };
}
const user = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

it("returns the newest AI title of a Claude session, and nothing for other agents or untitled sessions", () => {
  const t = transcript([{ type: "ai-title", aiTitle: "First guess", sessionId: "x" }, user("hello"), { type: "ai-title", aiTitle: "T3 integration status", sessionId: "x" }]);
  expect(claudeChatTitle(t.session, t.paths, 1_000)).toBe("T3 integration status");
  expect(claudeChatTitle({ ...t.session, agent: "codex" }, t.paths, 1_000)).toBeNull();
  const untitled = transcript([user("no title yet")]);
  expect(claudeChatTitle(untitled.session, untitled.paths, 1_000)).toBeNull();
});

it("re-reads a changed transcript only after the refresh interval", () => {
  const t = transcript([{ type: "ai-title", aiTitle: "Old title", sessionId: "x" }]);
  expect(claudeChatTitle(t.session, t.paths, 10_000)).toBe("Old title");
  appendFileSync(t.file, JSON.stringify({ type: "ai-title", aiTitle: "New title", sessionId: "x" }) + "\n");
  expect(claudeChatTitle(t.session, t.paths, 11_000)).toBe("Old title"); // within 30 s: cached
  expect(claudeChatTitle(t.session, t.paths, 41_000)).toBe("New title");
});
