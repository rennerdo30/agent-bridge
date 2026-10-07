import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_TEXT_CHARS, MAX_TOOL_PREVIEW_CHARS, MAX_TRANSCRIPT_CHUNK_BYTES, readJsonl, safeFile } from "../src/core/transcripts/common.js";
import { claudeItems, listClaudeSubagents, readClaudeChat } from "../src/core/transcripts/claude.js";
import { codexItems, listCodexSubagents, readCodexChat } from "../src/core/transcripts/codex.js";
import { listOpencodeSubagents, opencodeItems, readOpencodeChat } from "../src/core/transcripts/opencode.js";
import { transcriptPaths, validTranscriptCursor } from "../src/core/transcripts/index.js";
import { CLAUDE_SESSION, CODEX_CHILD, CODEX_SESSION, FIXTURES, installTranscriptFixtures } from "./transcript-fixtures.js";

let home: string, fixture: ReturnType<typeof installTranscriptFixtures>;
const claude = { agent: "claude" as const, cwd: "/project/example", sessionId: CLAUDE_SESSION };
const codex = { agent: "codex" as const, cwd: "/project/example", sessionId: CODEX_SESSION };
const opencode = { agent: "opencode" as const, cwd: "/project/example", sessionId: "ses_child" };
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-transcripts-")); fixture = installTranscriptFixtures(home); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("bounded JSONL reading", () => {
  it("waits for a partial final UTF-8 line, then reads it exactly once", () => {
    const file = join(home, "partial.jsonl"), first = '{"text":"猫"}\n', second = '{"text":"犬"}';
    writeFileSync(file, first + second);
    const page = readJsonl(file);
    expect(page.entries.map((r) => r.value.text)).toEqual(["猫"]);
    expect(page.next).toBe(`j:${Buffer.byteLength(first)}:0`);
    expect(readJsonl(file, page.next).next).toBe(page.next);
    appendFileSync(file, "\n");
    const next = readJsonl(file, page.next);
    expect(next.entries.map((r) => r.value.text)).toEqual(["犬"]);
    expect(readJsonl(file, next.next).entries).toEqual([]);
  });
  it("advances across oversized lines without interpreting their suffix", () => {
    const file = join(home, "large.jsonl");
    writeFileSync(file, JSON.stringify({ output: "x".repeat(MAX_TRANSCRIPT_CHUNK_BYTES * 2) }) + '\n{"type":"visible"}\n');
    let next = "0";
    const values: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const page = readJsonl(file, next);
      expect(Number(page.next.split(":")[1]) - (next === "0" ? 0 : Number(next.split(":")[1]))).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHUNK_BYTES);
      values.push(...page.entries.map((r) => r.value.type).filter(Boolean));
      next = page.next;
    }
    expect(values).toEqual(["visible"]);
  });
  it("skips malformed JSON and a cursor inside a line, and resets after truncation", () => {
    const file = join(home, "unknown.jsonl");
    writeFileSync(file, 'not json\nnull\n{"type":"known"}\n');
    expect(readJsonl(file, "2").entries.at(-1)?.value.type).toBe("known");
    const page = readJsonl(file);
    writeFileSync(file, '{"type":"new"}\n');
    expect(readJsonl(file, page.next).entries[0]?.value.type).toBe("new");
  });
  it("keeps storage overrides and rejects unsafe cursor numbers and symlink escapes", () => {
    expect(transcriptPaths({ CLAUDE_CONFIG_DIR: join(home, "c"), CODEX_HOME: join(home, "x"), XDG_DATA_HOME: join(home, "data") }, home)).toEqual({ claude: join(home, "c"), codex: join(home, "x"), opencode: join(home, "data", "opencode"), antigravity: join(home, ".gemini", "antigravity-cli") });
    expect(transcriptPaths({}, home).opencode).toBe(join(home, ".local", "share", "opencode"));
    for (const cursor of ["-1", "NaN", "1e6", "j:9007199254740992:0", "o:2:../secret"]) expect(validTranscriptCursor(cursor)).toBe(false);
    for (const cursor of ["0", "123", "j:12:1", "o:1791277200000:prt_1"]) expect(validTranscriptCursor(cursor)).toBe(true);
    const root = join(home, "root"), outside = join(home, "outside");
    mkdirSync(root); mkdirSync(outside); writeFileSync(join(outside, "secret"), "hidden");
    symlinkSync(outside, join(root, "link"), "junction");
    expect(safeFile(root, join(root, "link", "secret"))).toBeNull();
  });
});

describe("Claude transcripts", () => {
  it("reads normal chat and tools from a real-format fixture without changing the file", () => {
    const before = readFileSync(fixture.claude);
    const page = readClaudeChat(claude, fixture.paths)!;
    expect(page.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(page.items[0]).toMatchObject({ at: 1791277200000, text: "Inspect the module." });
    expect(readClaudeChat(claude, fixture.paths, page.next)?.items).toEqual([]);
    expect(readFileSync(fixture.claude)).toEqual(before);
  });
  it("lists nested native children and reads only the selected child's turns", () => {
    const list = listClaudeSubagents(claude, fixture.paths);
    expect(list).toMatchObject([{ id: "agent_example", title: "Review the module.", status: "done" }]);
    expect(readClaudeChat(claude, fixture.paths, "0", "agent_example")?.items.map((i) => i.text)).toEqual(["Review the module.", "Review complete."]);
    expect(readClaudeChat(claude, fixture.paths, "0", "foreign_child")).toBeNull();
    expect(readClaudeChat(claude, fixture.paths, "0", "../secret")).toBeNull();
  });
  it("separates legacy inline sidechains from the parent's own chat", () => {
    rmSync(join(dirname(fixture.claude), CLAUDE_SESSION), { recursive: true });
    appendFileSync(fixture.claude, readFileSync(join(FIXTURES, "claude-subagent.jsonl")));
    expect(readClaudeChat(claude, fixture.paths)?.items).toHaveLength(4);
    expect(listClaudeSubagents(claude, fixture.paths)[0]?.id).toBe("agent_example");
    expect(readClaudeChat(claude, fixture.paths, "0", "agent_example")?.items).toHaveLength(2);
  });
  it("preserves older inline children alongside newer nested child files", () => {
    appendFileSync(fixture.claude, readFileSync(join(FIXTURES, "claude-subagent.jsonl"), "utf8").replaceAll('"agent_example"', '"legacy_child"'));
    expect(listClaudeSubagents(claude, fixture.paths).map((s) => s.id)).toEqual(["agent_example", "legacy_child"]);
    expect(readClaudeChat(claude, fixture.paths, "0", "legacy_child")?.items).toHaveLength(2);
  });
  it("handles unknown records and nested values and caps tool previews", () => {
    for (const row of [{ type: "assistant", message: null }, { type: "new-format", message: {} }, { type: "user", message: { content: [null, 7] } }]) expect(claudeItems(row)).toEqual([]);
    const result = claudeItems({ type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(5000) }] }, toolUseResult: { agentId: "agent_example", description: "Review" } });
    expect(result[0]?.summary?.length).toBe(MAX_TOOL_PREVIEW_CHARS + 1);
    expect(result[1]?.subagent).toEqual({ id: "agent_example", title: "Review", agent: "claude" });
  });
});

describe("Codex transcripts", () => {
  it("uses a read-only thread index but validates its paths and native relationships", () => {
    const file = join(fixture.paths.codex, "state_5.sqlite"), db = new DatabaseSync(file);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, source TEXT)");
    const child = join(dirname(fixture.codex), `rollout-2026-10-06T09-00-00-${CODEX_CHILD}.jsonl`);
    const source = JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: CODEX_SESSION } } });
    db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(CODEX_SESSION, fixture.codex, '"vscode"');
    db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(CODEX_CHILD, child, source);
    db.close();
    const before = readFileSync(file);
    expect(readCodexChat(codex, fixture.paths)?.items).toHaveLength(4);
    expect(listCodexSubagents(codex, fixture.paths)[0]?.id).toBe(CODEX_CHILD);
    expect(readFileSync(file)).toEqual(before);
    const update = new DatabaseSync(file);
    update.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(fixture.claude, CODEX_SESSION);
    update.close();
    // An index path outside the Codex session store is ignored; the valid rollout is found on disk.
    expect(readCodexChat(codex, fixture.paths)?.items).toHaveLength(4);
  });
  it("reads response items once and ignores internal event/reasoning copies", () => {
    appendFileSync(fixture.codex, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "duplicate" } }) + "\n" + JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "hidden" }] } }) + "\n");
    const page = readCodexChat(codex, fixture.paths)!;
    expect(page.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(readCodexChat(codex, fixture.paths, page.next)?.items).toEqual([]);
  });
  it("uses thread id and explicit parent links, then reads the child's own history", () => {
    const file = join(dirname(fixture.codex), `rollout-2026-10-06T09-00-00-${CODEX_CHILD}.jsonl`);
    appendFileSync(file, JSON.stringify({ timestamp: "2026-10-06T09:00:00.000Z", ordinal: 3, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Inherited parent turn" }] } }) + "\n");
    expect(listCodexSubagents(codex, fixture.paths)).toMatchObject([{ id: CODEX_CHILD, title: "Reviewer", status: "done" }]);
    expect(readCodexChat(codex, fixture.paths, "0", CODEX_CHILD)?.items[0]?.text).toBe("Review complete.");
    expect(readCodexChat(codex, fixture.paths, "0", CODEX_CHILD)?.items).toHaveLength(1);
    expect(readCodexChat({ ...codex, sessionId: "other-session" }, fixture.paths, "0", CODEX_CHILD)).toBeNull();
  });
  it("does not mistake ordinary forks for native subagents or guess unknown types", () => {
    const file = join(dirname(fixture.codex), `rollout-2026-10-06T09-00-00-${CODEX_CHILD}.jsonl`);
    const rows = readFileSync(file, "utf8").trim().split("\n").map((s) => JSON.parse(s));
    rows[0].payload.source = "cli";
    delete rows[0].payload.thread_source;
    rows[0].payload.forked_from_id = CODEX_SESSION;
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    expect(listCodexSubagents(codex, fixture.paths)).toEqual([]);
    expect(codexItems({ type: "response_item", payload: { type: "reasoning", summary: "hidden" } })).toEqual([]);
    expect(codexItems({ type: "response_item", payload: null })).toEqual([]);
    expect(codexItems({ type: "response_item", payload: { type: "function_call_output", output: JSON.stringify({ agent_id: CODEX_CHILD, nickname: "Reviewer" }) } })[1]?.subagent).toEqual({ id: CODEX_CHILD, title: "Reviewer", agent: "codex" });
    expect(codexItems({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(5000) } })[0]?.summary?.length).toBe(MAX_TOOL_PREVIEW_CHARS + 1);
    expect(codexItems({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(MAX_TEXT_CHARS + 1) }] } })[0]?.text?.length).toBe(MAX_TEXT_CHARS + 1);
  });
});

describe("OpenCode SQLite transcripts", () => {
  it("reads real message/part shapes, skips unknown parts and opens the database read-only", () => {
    const before = readFileSync(fixture.sqlite), page = readOpencodeChat(opencode, fixture.paths)!;
    expect(page.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "tool", "tool", "subagent"]);
    expect(page.items.at(-1)?.subagent).toMatchObject({ id: "ses_grandchild", agent: "opencode" });
    expect(readOpencodeChat(opencode, fixture.paths, page.next)?.items).toEqual([]);
    expect(readFileSync(fixture.sqlite)).toEqual(before);
  });
  it("discovers children by parent_id and refuses foreign child sessions", () => {
    const parent = { ...opencode, sessionId: "ses_parent" };
    expect(listOpencodeSubagents(parent, fixture.paths)).toMatchObject([{ id: "ses_child", title: "Module review (@general subagent)", status: "unknown" }]);
    expect(readOpencodeChat(parent, fixture.paths, "0", "ses_child")?.items.length).toBeGreaterThan(0);
    expect(readOpencodeChat(parent, fixture.paths, "0", "ses_grandchild")).toBeNull();
  });
  it("returns updated streaming parts with the same item id", () => {
    const first = readOpencodeChat(opencode, fixture.paths)!;
    const db = new DatabaseSync(fixture.sqlite);
    db.prepare("UPDATE part SET time_updated = ?, data = ? WHERE id = ?").run(1791277201000, JSON.stringify({ type: "text", text: "Updated answer." }), "prt_3");
    db.close();
    expect(readOpencodeChat(opencode, fixture.paths, first.next)?.items).toEqual([{ kind: "assistant", at: 1791277200003, text: "Updated answer.", id: "prt_3" }]);
  });
  it("bounds large SQLite pages, skips oversized parts and continues to later records", () => {
    const db = new DatabaseSync(fixture.sqlite);
    db.exec("BEGIN");
    db.exec("DELETE FROM part");
    const insert = db.prepare("INSERT INTO part VALUES (?, 'msg_1', 'ses_child', ?, ?, ?)");
    insert.run("prt_huge", 1791277200000, 1791277200000, JSON.stringify({ type: "text", text: "x".repeat(MAX_TRANSCRIPT_CHUNK_BYTES + 1) }));
    for (let i = 1; i <= 220; i++) insert.run(`prt_${String(i).padStart(3, "0")}`, 1791277200000 + i, 1791277200000 + i, JSON.stringify({ type: "text", text: `Answer ${i}` }));
    db.exec("COMMIT");
    db.close();
    const first = readOpencodeChat(opencode, fixture.paths)!;
    expect(first.items).toEqual([]);
    const second = readOpencodeChat(opencode, fixture.paths, first.next)!;
    expect(second.items).toHaveLength(200);
    const third = readOpencodeChat(opencode, fixture.paths, second.next)!;
    expect(third.items).toHaveLength(20);
    expect(third.items.at(-1)?.text).toBe("Answer 220");
  });
  it("does not throw on malformed JSON, missing storage or unknown schema", () => {
    for (const part of [null, { type: "new" }, { type: "tool", state: null }, { type: "text", text: 12 }]) expect(opencodeItems(part, "assistant", 0, "id")).toEqual([]);
    expect(readOpencodeChat(opencode, { ...fixture.paths, opencode: join(home, "missing") })).toBeNull();
    const db = new DatabaseSync(fixture.sqlite);
    db.exec("DROP TABLE part"); db.close();
    expect(readOpencodeChat(opencode, fixture.paths)?.items).toEqual([]);
  });
});
