import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDashboard } from "../src/core/dashboard-read.js";
import { nullLogger } from "../src/core/logger.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { claudeSessionFile, claudeSubagentScanCounters, listClaudeSubagents } from "../src/core/transcripts/claude.js";
import { contentText, fileStat, MAX_NATIVE_SUBAGENTS, MAX_TITLE_CHARS, MAX_TRANSCRIPT_CHUNK_BYTES, object, preview, readHead, readTail, safeFile, scanJsonl, time, TRANSCRIPT_ID, directory, type NativeSubagent, type TranscriptPaths, type TranscriptSession } from "../src/core/transcripts/common.js";

// Count every transcript file the subagent scan opens.
const opened: string[] = [];
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => { opened.push(String(args[0])); return fs.openSync(...args); } };
});

/** The pre-AB-382 listing, kept verbatim as the reference result. */
function uncachedList(session: TranscriptSession, paths: TranscriptPaths): NativeSubagent[] {
  const main = claudeSessionFile(session, paths);
  if (!main) return [];
  const out = new Map<string, NativeSubagent>();
  const dir = join(main.replace(/\.jsonl$/, ""), "subagents");
  for (const name of directory(dir).slice(0, MAX_NATIVE_SUBAGENTS)) {
    const id = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(name)?.[1];
    if (!id || !TRANSCRIPT_ID.test(id)) continue;
    const file = safeFile(paths.claude, join(dir, name));
    if (!file) continue;
    const st = fileStat(file), head = readHead(file), tail = readTail(file);
    const last = [...tail].reverse().find((r) => r.type === "assistant");
    out.set(id, { id, title: preview(contentText(object(head.message).content) || `Subagent ${id}`, MAX_TITLE_CHARS), status: object(last?.message).stop_reason === "end_turn" ? "done" : "unknown", startedAt: time(head.timestamp) || st?.birthtimeMs || 0, updatedAt: st?.mtimeMs || 0 });
  }
  const nestedIds = new Set(out.keys());
  for (const { value: r } of scanJsonl(main)) {
    if (r.isSidechain !== true || typeof r.agentId !== "string" || !TRANSCRIPT_ID.test(r.agentId)) continue;
    if (nestedIds.has(r.agentId)) continue;
    const existing = out.get(r.agentId), at = time(r.timestamp);
    if (!existing && out.size >= MAX_NATIVE_SUBAGENTS) continue;
    out.set(r.agentId, { id: r.agentId, title: existing?.title ?? preview(contentText(object(r.message).content) || `Subagent ${r.agentId}`, MAX_TITLE_CHARS), status: object(r.message).stop_reason === "end_turn" ? "done" : existing?.status ?? "unknown", startedAt: existing?.startedAt ?? at, updatedAt: at });
  }
  return [...out.values()];
}

const N = 40;
const SESSION = "session-scan";
const line = (row: unknown) => `${JSON.stringify(row)}\n`;
const user = (text: string, at = 1_791_277_200_000) => line({ type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: text } });
const assistant = (text: string, stop: string | null, at = 1_791_277_260_000) => line({ type: "assistant", timestamp: new Date(at).toISOString(), message: { role: "assistant", content: [{ type: "text", text }], stop_reason: stop } });
const sidechain = (agentId: string, text: string, stop: string | null, at: number) => line({ type: stop ? "assistant" : "user", isSidechain: true, agentId, timestamp: new Date(at).toISOString(), message: { content: text, stop_reason: stop } });
const padding = (bytes: number) => { let out = ""; while (out.length < bytes) out += user("x".repeat(4_000)); return out; };

let root: string, paths: TranscriptPaths, session: TranscriptSession, main: string, children: string;
const child = (i: number) => join(children, `agent-child_${i}.jsonl`);
const scanReads = () => opened.filter((file) => file.startsWith(realpathSync.native(root)) && file.endsWith(".jsonl")).map((file) => file.slice(realpathSync.native(root).length));
const rel = (file: string) => realpathSync.native(file).slice(realpathSync.native(root).length);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ab-subagent-scan-"));
  paths = { claude: join(root, "claude"), codex: join(root, "codex"), opencode: join(root, "opencode") };
  session = { agent: "claude", cwd: "/project/example", sessionId: SESSION };
  main = join(paths.claude, "projects", "-project-example", `${SESSION}.jsonl`);
  children = join(paths.claude, "projects", "-project-example", SESSION, "subagents");
  mkdirSync(children, { recursive: true });
  // The parent holds old inline sidechains beyond two whole chunks, so the legacy scan resumes mid-file.
  writeFileSync(main, user("Main task") + sidechain("legacy_one", "Legacy one", null, 1) + padding(MAX_TRANSCRIPT_CHUNK_BYTES * 2) +
    sidechain("legacy_one", "done", "end_turn", 2) + sidechain("child_0", "shadowed by a nested file", null, 3) + sidechain("legacy_two", "Legacy two", null, 4));
  for (let i = 0; i < N; i++) writeFileSync(child(i), user(`Task ${i}`, 1_791_277_200_000 + i) + assistant("working", null) + (i % 2 ? assistant("finished", "end_turn") : ""));
  // One child is larger than the tail window.
  writeFileSync(child(N), user("Large task") + assistant("finished early", "end_turn") + padding(MAX_TRANSCRIPT_CHUNK_BYTES - 120_000));
  opened.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("dashboard native-subagent scan (AB-382)", () => {
  it("returns the uncached result, and an unchanged second read opens no transcript", () => {
    const expected = uncachedList(session, paths);
    expect(expected).toHaveLength(N + 3);
    opened.length = 0;
    const before = { ...claudeSubagentScanCounters };
    expect(listClaudeSubagents(session, paths)).toEqual(expected);
    expect(claudeSubagentScanCounters.childParses - before.childParses).toBe(N + 1);
    opened.length = 0;
    const second = { ...claudeSubagentScanCounters };
    expect(listClaudeSubagents(session, paths)).toEqual(expected);
    expect(scanReads()).toEqual([]);
    expect(claudeSubagentScanCounters).toEqual(second);
  });

  it("rereads only a changed file and keeps results identical to the uncached scan", () => {
    listClaudeSubagents(session, paths);
    opened.length = 0;
    const check = () => { const cached = listClaudeSubagents(session, paths); const reads = scanReads(); opened.length = 0; expect(cached).toEqual(uncachedList(session, paths)); opened.length = 0; return reads; };

    appendFileSync(child(4), assistant("now done", "end_turn"));
    expect(check()).toEqual([rel(child(4))]);
    appendFileSync(child(5), assistant("resumed", null));
    expect(check()).toEqual([rel(child(5))]);
    // Appends push the old last assistant record out of the tail window.
    appendFileSync(child(N), padding(200_000));
    expect(new Set(check())).toEqual(new Set([rel(child(N))]));
    expect(listClaudeSubagents(session, paths).find((s) => s.id === `child_${N}`)?.status).toBe("unknown");
    opened.length = 0;
    // An in-place rewrite (even one that grows the file) reparses only that file; a removed file drops out.
    writeFileSync(child(6), user("Rewritten") + assistant("short", "end_turn"));
    rmSync(child(7));
    expect(new Set(check())).toEqual(new Set([rel(child(6))]));
    // The parent's legacy scan resumes after its last whole chunk instead of rereading from byte 0.
    const chunks = claudeSubagentScanCounters.legacyChunks;
    appendFileSync(main, sidechain("legacy_three", "Legacy three", "end_turn", 5) + sidechain("legacy_two", "done", "end_turn", 6));
    expect(new Set(check())).toEqual(new Set([rel(main)]));
    expect(claudeSubagentScanCounters.legacyChunks - chunks).toBe(2);
    expect(listClaudeSubagents(session, paths).slice(-3).map((s) => [s.id, s.status])).toEqual([["legacy_one", "done"], ["legacy_two", "done"], ["legacy_three", "done"]]);
    // Rewriting the parent in place restarts its legacy scan from byte 0.
    writeFileSync(main, padding(MAX_TRANSCRIPT_CHUNK_BYTES * 3) + sidechain("legacy_four", "Legacy four", null, 7));
    opened.length = 0;
    check();
    expect(listClaudeSubagents(session, paths).slice(-1).map((s) => s.id)).toEqual(["legacy_four"]);
  });

  it("serves dashboard subagent reads through the history reader with the same cache", async () => {
    const peer = { id: "p1", name: "claude-scan", agent: "claude", cwd: session.cwd, sessionId: SESSION } as PeerInfo;
    const ctx = { home: root, log: nullLogger, transcripts: paths, peers: () => [peer] };
    const read = async () => {
      const r = await readDashboard(ctx, { path: `/api/sessions/${peer.name}/subagents` });
      expect(r.status).toBe(200);
      return (r.body as { subagents: NativeSubagent[] }).subagents;
    };
    const before = claudeSubagentScanCounters.childParses;
    expect(await read()).toEqual(uncachedList(session, paths));
    expect(claudeSubagentScanCounters.childParses - before).toBe(N + 1);
    // An unchanged refresh only lists and stats; a changed child is the only file read again.
    opened.length = 0;
    expect(await read()).toEqual(uncachedList(session, paths));
    opened.length = 0;
    await read();
    expect(scanReads()).toEqual([]);
    appendFileSync(child(9), assistant("late", "end_turn"));
    opened.length = 0;
    const fresh = await read();
    expect(scanReads()).toEqual([rel(child(9))]);
    expect(fresh).toEqual(uncachedList(session, paths));
  });
});
