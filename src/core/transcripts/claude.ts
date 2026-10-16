import { realpathSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { activeByteSources } from "../byte-source.js";
import { drainScan } from "../responsive-scan.js";
import { contentText, directory, fileStat, MAX_DISCOVERY_BYTES, MAX_NATIVE_SUBAGENTS, MAX_TEXT_CHARS, MAX_TITLE_CHARS, MAX_TRANSCRIPT_CHUNK_BYTES, object, preview, readHead, readJsonl, readJsonlChunk, safeFile, time, TRANSCRIPT_ID, type JsonObject, type NativeSubagent, type TranscriptItem, type TranscriptPage, type TranscriptPaths, type TranscriptSession } from "./common.js";

export function claudeSessionFile(session: TranscriptSession, paths: TranscriptPaths): string | null {
  if (!session.sessionId || !TRANSCRIPT_ID.test(session.sessionId)) return null;
  const projects = join(paths.claude, "projects");
  // Windows encoding replaces the drive colon and each separator with a dash.
  const encoded = session.cwd.replace(/[^A-Za-z0-9]/g, "-");
  const direct = safeFile(projects, join(projects, encoded, `${session.sessionId}.jsonl`));
  if (direct) return direct;
  // Realpaths, long project names and CLI slug changes need a session-id lookup.
  for (const dir of directory(projects)) {
    const file = safeFile(projects, join(projects, dir, `${session.sessionId}.jsonl`));
    if (file) return file;
  }
  return null;
}

export function claudeItems(row: JsonObject): TranscriptItem[] {
  if (!["user", "assistant"].includes(row.type)) return [];
  const message = object(row.message), at = time(row.timestamp);
  const content = message.content;
  if (typeof content === "string") return row.isMeta ? [] : [{ kind: row.type, at, text: preview(content, MAX_TEXT_CHARS) }];
  if (!Array.isArray(content)) return [];
  const items: TranscriptItem[] = [];
  for (const block of content.map(object)) {
    if (block.type === "text" && typeof block.text === "string") items.push({ kind: row.type, at, text: preview(block.text, MAX_TEXT_CHARS) });
    if (block.type === "tool_use" && typeof block.name === "string") items.push({ kind: "tool", at, tool: block.name, summary: preview(block.input) });
    if (block.type === "tool_result") {
      items.push({ kind: "tool", at, tool: typeof block.tool_use_id === "string" ? block.tool_use_id : "result", summary: preview(contentText(block.content)) });
      const result = object(row.toolUseResult);
      if (typeof result.agentId === "string" && TRANSCRIPT_ID.test(result.agentId)) items.push({ kind: "subagent", at, subagent: { id: result.agentId, title: preview(result.description || "Native subagent", MAX_TITLE_CHARS), agent: "claude" } });
    }
  }
  return items;
}

export function readClaudeChat(session: TranscriptSession, paths: TranscriptPaths, from = "0", child?: string): TranscriptPage | null {
  const main = claudeSessionFile(session, paths);
  if (!main || (child !== undefined && !TRANSCRIPT_ID.test(child))) return null;
  const nested = child ? safeFile(paths.claude, join(dirname(main), session.sessionId!, "subagents", `agent-${child}.jsonl`)) : null;
  const legacy = child && !nested ? listClaudeSubagents(session, paths).some((s) => s.id === child) : false;
  if (child && !nested && !legacy) return null;
  const page = readJsonl(nested ?? main, from);
  return { items: page.entries.filter(({ value: r }) => child ? nested || (r.isSidechain === true && r.agentId === child) : r.isSidechain !== true).flatMap(({ value }) => claudeItems(value)), next: page.next };
}

/** Parsed native-child summary of one transcript file, valid while its stat identity is unchanged (AB-382). */
interface ChildSummary {
  /** The contained realpath this summary was parsed from. */
  file?: string;
  signature: string; size: number; ino: number;
  title: string; startedAt: number; headFound: boolean;
  /** End of the last complete line read, or -1 when appends cannot resume (oversized tail line). */
  scannedTo: number;
  /** The bytes just before `scannedTo`: a resume first checks them, so an in-place rewrite is reparsed. */
  mark?: Buffer;
  /** Offset and stop state of the last assistant record before `scannedTo`, or -1. */
  lastAssistant: number; done: boolean;
}
/** Legacy inline sidechains folded per child, in first-appearance order. */
interface LegacyChild { title: string; startedAt: number; updatedAt: number; done: boolean }
interface LegacyFold { from: string; iteration: number; children: Map<string, LegacyChild>; mark?: Buffer }
interface LegacyScan {
  signature: string; size: number; ino: number;
  /** Fold state after the last chunk that filled a whole read: those bytes never change in an append-only file. */
  committed: LegacyFold;
  children: Map<string, LegacyChild>;
}
const MAX_CACHED_SESSIONS = 64;
/** Per subagents directory: the summaries of the files listed last time, keyed by listed path. */
const childCache = new Map<string, Map<string, ChildSummary>>();
const legacyCache = new Map<string, LegacyScan>();
/** Test probe: child transcripts parsed and parent JSONL chunks read for subagent lists. */
export const claudeSubagentScanCounters = { childParses: 0, legacyChunks: 0 };

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key); cache.set(key, value);
  while (cache.size > MAX_CACHED_SESSIONS) cache.delete(cache.keys().next().value!);
}
const statSignature = (st: Stats) => `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}:${st.dev}`;
const cloneChildren = (children: Map<string, LegacyChild>) => new Map([...children].map(([id, child]) => [id, { ...child }]));

function lastAssistantIn(entries: readonly { value: JsonObject; offset: number }[]): { offset: number; done: boolean } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const { value, offset } = entries[i]!;
    if (value.type === "assistant") return { offset, done: object(value.message).stop_reason === "end_turn" };
  }
  return null;
}
const endOf = (next: string) => { const m = /^j:(\d+):([01])$/.exec(next); return m?.[2] === "0" ? Number(m[1]) : -1; };

/** Same result as the head record plus the last assistant record in the final MAX_TRANSCRIPT_CHUNK_BYTES,
 * but an unchanged file is not read and appended bytes are parsed on their own when they fit that window. */
function childSummary(id: string, file: string, st: Stats, saved: ChildSummary | undefined): ChildSummary {
  const signature = statSignature(st);
  if (saved?.signature === signature) return saved;
  claudeSubagentScanCounters.childParses++;
  const window = Math.max(0, st.size - MAX_TRANSCRIPT_CHUNK_BYTES);
  if (saved?.mark && saved.scannedTo >= 0 && saved.ino === st.ino && st.size >= saved.size && window <= saved.scannedTo) {
    const page = readJsonlChunk(file, `j:${saved.scannedTo}:0`, MAX_TRANSCRIPT_CHUNK_BYTES, { expect: saved.mark, mark: true }), scannedTo = endOf(page.next);
    // Changed bytes before the old end, or a record not starting there, mean a rewrite, not an append: reparse.
    if (!page.rewritten && scannedTo >= 0 && (page.entries.length === 0 || page.entries[0]!.offset === saved.scannedTo)) {
      const last = lastAssistantIn(page.entries) ?? (saved.lastAssistant >= window ? { offset: saved.lastAssistant, done: saved.done } : null);
      const head = saved.headFound ? undefined : headSummary(id, file, st);
      return { ...(head ?? { title: saved.title, startedAt: saved.startedAt, headFound: true }), signature, size: st.size, ino: st.ino, scannedTo, mark: page.mark, lastAssistant: last?.offset ?? -1, done: last?.done ?? false };
    }
  }
  const tail = readJsonlChunk(file, String(window), MAX_TRANSCRIPT_CHUNK_BYTES, { mark: true }), last = lastAssistantIn(tail.entries);
  return { ...headSummary(id, file, st), signature, size: st.size, ino: st.ino, scannedTo: endOf(tail.next), mark: tail.mark, lastAssistant: last?.offset ?? -1, done: last?.done ?? false };
}
function headSummary(id: string, file: string, st: Stats): Pick<ChildSummary, "title" | "startedAt" | "headFound"> {
  const head = readHead(file);
  return { title: preview(contentText(object(head.message).content) || `Subagent ${id}`, MAX_TITLE_CHARS), startedAt: time(head.timestamp) || st.birthtimeMs || 0, headFound: Object.keys(head).length > 0 };
}

/** The bounded scanJsonl metadata pass over the parent JSONL for legacy inline sidechains, resumed after the last whole chunk. */
function* legacyChildren(main: string, st: Stats | null): Generator<void, Map<string, LegacyChild>> {
  if (!st) return new Map();
  const signature = statSignature(st), saved = legacyCache.get(main);
  if (saved?.signature === signature) { remember(legacyCache, main, saved); return saved.children; }
  const empty = (): LegacyFold => ({ from: "0", iteration: 0, children: new Map() });
  let resume = saved && saved.ino === st.ino && st.size >= saved.size ? saved.committed : empty();
  // Resume only when the bytes before the committed offset are unchanged; otherwise rescan from byte 0.
  if (resume.mark && readJsonlChunk(main, resume.from, 0, { expect: resume.mark }).rewritten) resume = empty();
  let committed: LegacyFold = { ...resume, children: cloneChildren(resume.children) }, children = committed.children, tentative = false, from = committed.from;
  for (let iteration = committed.iteration; iteration * MAX_TRANSCRIPT_CHUNK_BYTES < MAX_DISCOVERY_BYTES; iteration++) {
    yield;
    claudeSubagentScanCounters.legacyChunks++;
    const page = readJsonlChunk(main, from, MAX_TRANSCRIPT_CHUNK_BYTES, { mark: true });
    if (page.next === from) break;
    // A short read reached the current end of file; its chunk boundary moves as the file grows.
    if (!tentative && page.length < page.maxBytes) { tentative = true; children = cloneChildren(children); }
    for (const { value: r } of page.entries) {
      if (r.isSidechain !== true || typeof r.agentId !== "string" || !TRANSCRIPT_ID.test(r.agentId)) continue;
      const existing = children.get(r.agentId), at = time(r.timestamp), done = object(r.message).stop_reason === "end_turn";
      if (existing) { existing.updatedAt = at; existing.done ||= done; continue; }
      // At most MAX_NATIVE_SUBAGENTS ids are shadowed by nested files, so later new ids can never be listed.
      if (children.size >= 2 * MAX_NATIVE_SUBAGENTS) continue;
      children.set(r.agentId, { title: preview(contentText(object(r.message).content) || `Subagent ${r.agentId}`, MAX_TITLE_CHARS), startedAt: at, updatedAt: at, done });
    }
    from = page.next;
    // A failed read has no mark; the fold then stays tentative so the next change rescans this chunk.
    if (!tentative && !page.mark) { tentative = true; children = cloneChildren(children); }
    if (!tentative) committed = { from, iteration: iteration + 1, children, mark: page.mark };
  }
  // Cached maps are never mutated afterwards: a later resume clones its committed fold first.
  remember(legacyCache, main, { signature, size: st.size, ino: st.ino, committed, children });
  return children;
}

/** A child file is parsed again only when its stat identity changes; an unchanged refresh only lists and stats. */
function* claudeSubagentSteps(session: TranscriptSession, paths: TranscriptPaths): Generator<void, NativeSubagent[]> {
  const main = claudeSessionFile(session, paths);
  if (!main) return [];
  const out = new Map<string, NativeSubagent>();
  const dir = join(dirname(main), session.sessionId!, "subagents");
  let root: string | null = null;
  try { root = realpathSync.native(paths.claude); } catch { /* safeFile refuses every child then. */ }
  const previous = childCache.get(dir), current = new Map<string, ChildSummary>();
  for (const name of directory(dir).slice(0, MAX_NATIVE_SUBAGENTS)) {
    const id = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(name)?.[1];
    if (!id || !TRANSCRIPT_ID.test(id)) continue;
    const listed = join(dir, name), saved = previous?.get(listed);
    yield;
    // The same device, inode, size and times as the contained realpath checked before: the same file, unchanged.
    const seen = saved ? fileStat(listed) : null;
    if (saved && seen && statSignature(seen) === saved.signature) {
      current.set(listed, saved);
      out.set(id, { id, title: saved.title, status: saved.done ? "done" : "unknown", startedAt: saved.startedAt, updatedAt: seen.mtimeMs || 0 });
      continue;
    }
    const file = root ? safeFile(paths.claude, listed, root) : null;
    if (!file) continue;
    const st = fileStat(file);
    // A fully ingested file's head and tail facts come from the history store (AB-383).
    const known = activeByteSources()?.claudeChild?.(file, MAX_TRANSCRIPT_CHUNK_BYTES);
    if (known) {
      out.set(id, { id, title: known.title ?? preview(`Subagent ${id}`, MAX_TITLE_CHARS), status: known.status, startedAt: known.startedAt || st?.birthtimeMs || 0, updatedAt: st?.mtimeMs || 0 });
      continue;
    }
    if (!st) { out.set(id, { id, title: preview(`Subagent ${id}`, MAX_TITLE_CHARS), status: "unknown", startedAt: 0, updatedAt: 0 }); continue; }
    const summary = { ...childSummary(id, file, st, saved?.file === file ? saved : undefined), file };
    current.set(listed, summary);
    out.set(id, { id, title: summary.title, status: summary.done ? "done" : "unknown", startedAt: summary.startedAt, updatedAt: st.mtimeMs || 0 });
  }
  // Files no longer listed leave the cache with the previous generation.
  remember(childCache, dir, current);
  // Old versions wrote sidechain records into the parent's JSONL. The store can prove there are none.
  // Stat before the store looks: a cached fold is then never labelled newer than the bytes it read.
  const mainStat = fileStat(main);
  if (activeByteSources()?.noInlineSidechains?.(main)) return [...out.values()];
  const nestedIds = new Set(out.keys());
  for (const [id, child] of yield* legacyChildren(main, mainStat)) {
    if (nestedIds.has(id) || out.size >= MAX_NATIVE_SUBAGENTS) continue;
    out.set(id, { id, title: child.title, status: child.done ? "done" : "unknown", startedAt: child.startedAt, updatedAt: child.updatedAt });
  }
  return [...out.values()];
}

/** Synchronous: the dashboard runs it inside readWithHistory, whose byte sources never span an await (AB-383). */
export function listClaudeSubagents(session: TranscriptSession, paths: TranscriptPaths): NativeSubagent[] {
  return drainScan(claudeSubagentSteps(session, paths));
}
