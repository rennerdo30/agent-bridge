import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  listAntigravitySubagents,
  listMuseSubagents,
  readAntigravityChat,
  readMuseChat
} from "./chunk-IKMJMH2G.mjs";
import {
  MAX_CURSOR_CHARS,
  MAX_DISCOVERY_BYTES,
  MAX_DISCOVERY_FILES,
  MAX_NATIVE_SUBAGENTS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_TRANSCRIPT_CHUNK_BYTES,
  SQLITE_READ_TIMEOUT_MS,
  TRANSCRIPT_ID,
  activeByteSources,
  contentText,
  directory,
  fileStat,
  object,
  parse,
  preview,
  readHead,
  readJsonl,
  readJsonlChunk,
  readTail,
  safeFile,
  time,
  transcriptPaths
} from "./chunk-I32N5HZ3.mjs";
import {
  drainScan
} from "./chunk-J4YP2FBF.mjs";

// src/core/transcripts/claude.ts
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
function claudeSessionFile(session, paths) {
  if (!session.sessionId || !TRANSCRIPT_ID.test(session.sessionId)) return null;
  const projects = join(paths.claude, "projects");
  const encoded = session.cwd.replace(/[^A-Za-z0-9]/g, "-");
  const direct = safeFile(projects, join(projects, encoded, `${session.sessionId}.jsonl`));
  if (direct) return direct;
  for (const dir of directory(projects)) {
    const file = safeFile(projects, join(projects, dir, `${session.sessionId}.jsonl`));
    if (file) return file;
  }
  return null;
}
function claudeItems(row) {
  if (!["user", "assistant"].includes(row.type)) return [];
  const message = object(row.message), at = time(row.timestamp);
  const content = message.content;
  if (typeof content === "string") return row.isMeta ? [] : [{ kind: row.type, at, text: preview(content, MAX_TEXT_CHARS) }];
  if (!Array.isArray(content)) return [];
  const items = [];
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
function readClaudeChat(session, paths, from = "0", child) {
  const main = claudeSessionFile(session, paths);
  if (!main || child !== void 0 && !TRANSCRIPT_ID.test(child)) return null;
  const nested = child ? safeFile(paths.claude, join(dirname(main), session.sessionId, "subagents", `agent-${child}.jsonl`)) : null;
  const legacy = child && !nested ? listClaudeSubagents(session, paths).some((s) => s.id === child) : false;
  if (child && !nested && !legacy) return null;
  const page = readJsonl(nested ?? main, from);
  return { items: page.entries.filter(({ value: r }) => child ? nested || r.isSidechain === true && r.agentId === child : r.isSidechain !== true).flatMap(({ value }) => claudeItems(value)), next: page.next };
}
var MAX_CACHED_SESSIONS = 64;
var childCache = /* @__PURE__ */ new Map();
var legacyCache = /* @__PURE__ */ new Map();
var claudeSubagentScanCounters = { childParses: 0, legacyChunks: 0 };
function remember(cache2, key, value) {
  cache2.delete(key);
  cache2.set(key, value);
  while (cache2.size > MAX_CACHED_SESSIONS) cache2.delete(cache2.keys().next().value);
}
var statSignature = (st) => `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}:${st.dev}`;
var cloneChildren = (children) => new Map([...children].map(([id, child]) => [id, { ...child }]));
function lastAssistantIn(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const { value, offset } = entries[i];
    if (value.type === "assistant") return { offset, done: object(value.message).stop_reason === "end_turn" };
  }
  return null;
}
var endOf = (next) => {
  const m = /^j:(\d+):([01])$/.exec(next);
  return m?.[2] === "0" ? Number(m[1]) : -1;
};
function childSummary(id, file, st, saved) {
  const signature = statSignature(st);
  if (saved?.signature === signature) return saved;
  claudeSubagentScanCounters.childParses++;
  const window = Math.max(0, st.size - MAX_TRANSCRIPT_CHUNK_BYTES);
  if (saved?.mark && saved.scannedTo >= 0 && saved.ino === st.ino && st.size >= saved.size && window <= saved.scannedTo) {
    const page = readJsonlChunk(file, `j:${saved.scannedTo}:0`, MAX_TRANSCRIPT_CHUNK_BYTES, { expect: saved.mark, mark: true }), scannedTo = endOf(page.next);
    if (!page.rewritten && scannedTo >= 0 && (page.entries.length === 0 || page.entries[0].offset === saved.scannedTo)) {
      const last2 = lastAssistantIn(page.entries) ?? (saved.lastAssistant >= window ? { offset: saved.lastAssistant, done: saved.done } : null);
      const head2 = saved.headFound ? void 0 : headSummary(id, file, st);
      const summary = head2 ?? { title: saved.title, startedAt: saved.startedAt, headFound: true };
      return { ...summary, signature, size: st.size, ino: st.ino, scannedTo, mark: page.mark, lastAssistant: last2?.offset ?? -1, done: last2?.done ?? false, cacheable: summary.headFound };
    }
  }
  const tail = readJsonlChunk(file, String(window), MAX_TRANSCRIPT_CHUNK_BYTES, { mark: true }), last = lastAssistantIn(tail.entries), head = headSummary(id, file, st);
  return {
    ...head,
    signature,
    size: st.size,
    ino: st.ino,
    scannedTo: endOf(tail.next),
    mark: tail.mark,
    lastAssistant: last?.offset ?? -1,
    done: last?.done ?? false,
    cacheable: head.headFound && tail.mark !== void 0
  };
}
function headSummary(id, file, st) {
  const head = readHead(file);
  return { title: preview(contentText(object(head.message).content) || `Subagent ${id}`, MAX_TITLE_CHARS), startedAt: time(head.timestamp) || st.birthtimeMs || 0, headFound: Object.keys(head).length > 0 };
}
function* legacyChildren(main, st) {
  if (!st) return /* @__PURE__ */ new Map();
  const signature = statSignature(st), saved = legacyCache.get(main);
  if (saved?.signature === signature) {
    remember(legacyCache, main, saved);
    return saved.children;
  }
  const empty = () => ({ from: "0", iteration: 0, children: /* @__PURE__ */ new Map() });
  let resume = saved && saved.ino === st.ino && st.size >= saved.size ? saved.committed : empty();
  if (resume.mark && readJsonlChunk(main, resume.from, 0, { expect: resume.mark }).rewritten) resume = empty();
  let committed = { ...resume, children: cloneChildren(resume.children) }, children = committed.children, tentative = false, from = committed.from, failed = false;
  for (let iteration = committed.iteration; iteration * MAX_TRANSCRIPT_CHUNK_BYTES < MAX_DISCOVERY_BYTES; iteration++) {
    yield;
    claudeSubagentScanCounters.legacyChunks++;
    const page = readJsonlChunk(main, from, MAX_TRANSCRIPT_CHUNK_BYTES, { mark: true });
    if (!page.mark) {
      failed = true;
      break;
    }
    if (page.next === from) break;
    if (!tentative && page.length < page.maxBytes) {
      tentative = true;
      children = cloneChildren(children);
    }
    for (const { value: r } of page.entries) {
      if (r.isSidechain !== true || typeof r.agentId !== "string" || !TRANSCRIPT_ID.test(r.agentId)) continue;
      const existing = children.get(r.agentId), at = time(r.timestamp), done = object(r.message).stop_reason === "end_turn";
      if (existing) {
        existing.updatedAt = at;
        existing.done ||= done;
        continue;
      }
      if (children.size >= 2 * MAX_NATIVE_SUBAGENTS) continue;
      children.set(r.agentId, { title: preview(contentText(object(r.message).content) || `Subagent ${r.agentId}`, MAX_TITLE_CHARS), startedAt: at, updatedAt: at, done });
    }
    from = page.next;
    if (!tentative) committed = { from, iteration: iteration + 1, children, mark: page.mark };
  }
  if (!failed) remember(legacyCache, main, { signature, size: st.size, ino: st.ino, committed, children });
  return children;
}
function* claudeSubagentSteps(session, paths) {
  const main = claudeSessionFile(session, paths);
  if (!main) return [];
  const out = /* @__PURE__ */ new Map();
  const dir = join(dirname(main), session.sessionId, "subagents");
  let root = null;
  try {
    root = realpathSync.native(paths.claude);
  } catch {
  }
  const previous = childCache.get(dir), current = /* @__PURE__ */ new Map();
  for (const name of directory(dir).slice(0, MAX_NATIVE_SUBAGENTS)) {
    const id = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(name)?.[1];
    if (!id || !TRANSCRIPT_ID.test(id)) continue;
    const listed = join(dir, name), saved = previous?.get(listed);
    yield;
    const seen = saved ? fileStat(listed) : null;
    if (saved && seen && statSignature(seen) === saved.signature) {
      current.set(listed, saved);
      out.set(id, { id, title: saved.title, status: saved.done ? "done" : "unknown", startedAt: saved.startedAt, updatedAt: seen.mtimeMs || 0 });
      continue;
    }
    const file = root ? safeFile(paths.claude, listed, root) : null;
    if (!file) continue;
    const st = fileStat(file);
    const known = activeByteSources()?.claudeChild?.(file, MAX_TRANSCRIPT_CHUNK_BYTES);
    if (known) {
      out.set(id, { id, title: known.title ?? preview(`Subagent ${id}`, MAX_TITLE_CHARS), status: known.status, startedAt: known.startedAt || st?.birthtimeMs || 0, updatedAt: st?.mtimeMs || 0 });
      continue;
    }
    if (!st) {
      out.set(id, { id, title: preview(`Subagent ${id}`, MAX_TITLE_CHARS), status: "unknown", startedAt: 0, updatedAt: 0 });
      continue;
    }
    const summary = { ...childSummary(id, file, st, saved?.file === file ? saved : void 0), file };
    if (summary.cacheable) current.set(listed, summary);
    out.set(id, { id, title: summary.title, status: summary.done ? "done" : "unknown", startedAt: summary.startedAt, updatedAt: st.mtimeMs || 0 });
  }
  remember(childCache, dir, current);
  const mainStat = fileStat(main);
  if (activeByteSources()?.noInlineSidechains?.(main)) return [...out.values()];
  const nestedIds = new Set(out.keys());
  for (const [id, child] of yield* legacyChildren(main, mainStat)) {
    if (nestedIds.has(id) || out.size >= MAX_NATIVE_SUBAGENTS) continue;
    out.set(id, { id, title: child.title, status: child.done ? "done" : "unknown", startedAt: child.startedAt, updatedAt: child.updatedAt });
  }
  return [...out.values()];
}
function listClaudeSubagents(session, paths) {
  return drainScan(claudeSubagentSteps(session, paths));
}

// src/core/transcripts/codex.ts
import { join as join2 } from "node:path";
import { DatabaseSync } from "node:sqlite";
var ROLLOUT_NAME = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
var DISCOVERY_CACHE_MS = 1e4;
var MAX_INDEX_PATH_CHARS = 4096;
var cache = /* @__PURE__ */ new Map();
function rollout(file, id, known) {
  const head = known && Object.keys(known).length ? known : object(readHead(file).payload);
  const data = head.id === id ? head : object(readJsonl(file).entries.find(({ value: r }) => r.type === "session_meta" && object(r.payload).id === id)?.value.payload);
  return { file, id, meta: Object.fromEntries(["id", "source", "thread_source", "parent_thread_id", "timestamp", "agent_nickname", "agent_path", "subagent_history_start_ordinal"].filter((key) => data[key] !== void 0).map((key) => [key, data[key]])) };
}
function indexedRollouts(paths, id, parentId) {
  const name = directory(paths.codex).filter((s) => /^state_\d+\.sqlite$/.test(s)).sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0];
  if (!name) return null;
  const file = safeFile(paths.codex, join2(paths.codex, name));
  if (!file) return null;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: SQLITE_READ_TIMEOUT_MS });
    const rows = id ? db.prepare("SELECT id, substr(rollout_path, 1, ?) AS path FROM threads WHERE id = ? LIMIT 1").all(MAX_INDEX_PATH_CHARS, id) : db.prepare(`SELECT id, substr(rollout_path, 1, ?) AS path FROM threads
          WHERE CASE WHEN json_valid(source) THEN json_extract(source, '$.subagent.thread_spawn.parent_thread_id') END = ? LIMIT ?`).all(MAX_INDEX_PATH_CHARS, parentId, MAX_NATIVE_SUBAGENTS);
    const out = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || !TRANSCRIPT_ID.test(row.id) || typeof row.path !== "string") continue;
      const target = safeFile(join2(paths.codex, "sessions"), row.path);
      if (!target) continue;
      const entry = rollout(target, row.id);
      if (entry.meta.id === row.id && (!parentId || parent(entry.meta) === parentId)) out.push(entry);
    }
    return out.length ? out : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
function rollouts(paths) {
  const root = join2(paths.codex, "sessions"), existing = cache.get(root);
  if (existing && Date.now() - existing.at < DISCOVERY_CACHE_MS) return existing.files;
  const files = [];
  const knownFiles = new Map(existing?.files.map((r) => [r.file, r]));
  for (const year of directory(root).filter((s) => /^\d{4}$/.test(s)).sort().reverse()) {
    for (const month of directory(join2(root, year)).filter((s) => /^\d{2}$/.test(s)).sort().reverse()) {
      for (const day of directory(join2(root, year, month)).filter((s) => /^\d{2}$/.test(s)).sort().reverse()) {
        for (const name of directory(join2(root, year, month, day)).sort().reverse()) {
          const id = ROLLOUT_NAME.exec(name)?.[1];
          if (!id) continue;
          const file = safeFile(root, join2(root, year, month, day, name));
          if (!file) continue;
          const known = knownFiles.get(file);
          files.push(rollout(file, id, known?.meta));
          if (files.length >= MAX_DISCOVERY_FILES) {
            cache.set(root, { at: Date.now(), files });
            return files;
          }
        }
      }
    }
  }
  cache.set(root, { at: Date.now(), files });
  return files;
}
function parent(meta) {
  const spawn = object(object(object(meta.source).subagent).thread_spawn);
  if (!Object.keys(spawn).length && meta.thread_source !== "subagent") return void 0;
  return typeof meta.parent_thread_id === "string" ? meta.parent_thread_id : typeof spawn.parent_thread_id === "string" ? spawn.parent_thread_id : void 0;
}
function codexItems(row) {
  if (row.type !== "response_item") return [];
  const p = object(row.payload), at = time(row.timestamp);
  if (p.type === "message" && ["user", "assistant"].includes(p.role) && p.channel !== "analysis") {
    const text = contentText(p.content);
    return text ? [{ kind: p.role, at, text: preview(text, MAX_TEXT_CHARS) }] : [];
  }
  if (["function_call", "custom_tool_call"].includes(p.type) && typeof p.name === "string") return [{ kind: "tool", at, tool: p.name, summary: preview(p.arguments ?? p.input) }];
  if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
    const items = [{ kind: "tool", at, tool: typeof p.call_id === "string" ? p.call_id : "result", summary: preview(p.output) }];
    const result = typeof p.output === "string" ? parse(p.output) : object(p.output);
    if (typeof result.agent_id === "string" && TRANSCRIPT_ID.test(result.agent_id)) items.push({ kind: "subagent", at, subagent: { id: result.agent_id, title: preview(result.nickname || "Native subagent", MAX_TITLE_CHARS), agent: "codex" } });
    return items;
  }
  return [];
}
function readCodexChat(session, paths, from = "0", child) {
  if (!session.sessionId || !TRANSCRIPT_ID.test(session.sessionId) || child !== void 0 && !TRANSCRIPT_ID.test(child)) return null;
  const id = child ?? session.sessionId;
  const entry = (indexedRollouts(paths, id) ?? rollouts(paths)).find((r) => r.id === id);
  if (!entry || child && parent(entry.meta) !== session.sessionId) return null;
  const page = readJsonl(entry.file, from);
  const start = entry.meta.subagent_history_start_ordinal;
  return { items: page.entries.filter(({ value: r }) => typeof start !== "number" || typeof r.ordinal !== "number" || r.ordinal >= start).flatMap(({ value }) => codexItems(value)), next: page.next };
}
function listCodexSubagents(session, paths) {
  if (!session.sessionId || !TRANSCRIPT_ID.test(session.sessionId)) return [];
  return (indexedRollouts(paths, void 0, session.sessionId) ?? rollouts(paths)).filter((r) => parent(r.meta) === session.sessionId).slice(0, MAX_NATIVE_SUBAGENTS).map(({ file, id, meta }) => {
    const st = fileStat(file);
    const last = [...readTail(file)].reverse().find((r) => r.type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(object(r.payload).type));
    const state = object(last?.payload).type;
    const spawn = object(object(object(meta.source).subagent).thread_spawn);
    return { id, title: preview(meta.agent_nickname || spawn.agent_nickname || meta.agent_path || spawn.agent_path || `Subagent ${id}`, MAX_TITLE_CHARS), status: state === "task_complete" ? "done" : state === "turn_aborted" ? "interrupted" : "unknown", startedAt: time(meta.timestamp) || st?.birthtimeMs || 0, updatedAt: st?.mtimeMs || 0 };
  });
}

// src/core/transcripts/opencode.ts
import { join as join3 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var MAX_SQLITE_PARTS = 200;
var SQLITE_CURSOR = /^o:(\d+):([A-Za-z0-9_-]*)$/;
function openDatabase(paths) {
  const file = safeFile(paths.opencode, join3(paths.opencode, "opencode.db"));
  if (!file) return null;
  try {
    return new DatabaseSync2(file, { readOnly: true, timeout: SQLITE_READ_TIMEOUT_MS });
  } catch {
    return null;
  }
}
function opencodeItems(data, role, at, id) {
  const part = object(data), state = object(part.state);
  if (part.type === "text" && typeof part.text === "string" && ["user", "assistant"].includes(String(role))) return [{ kind: role, at, text: preview(part.text, MAX_TEXT_CHARS), id }];
  if (part.type !== "tool" || typeof part.tool !== "string") return [];
  const items = [{ kind: "tool", at, tool: part.tool, summary: preview(state.output ?? state.error ?? state.input), id }];
  const child = object(state.metadata).sessionId;
  if (part.tool === "task" && typeof child === "string" && TRANSCRIPT_ID.test(child)) items.push({ kind: "subagent", at, id: `${id}-child`, subagent: { id: child, title: preview(state.title || "Native subagent", MAX_TITLE_CHARS), agent: "opencode" } });
  return items;
}
function readOpencodeChat(session, paths, from = "0", child) {
  if (!session.sessionId || !TRANSCRIPT_ID.test(session.sessionId) || child !== void 0 && !TRANSCRIPT_ID.test(child)) return null;
  const db = openDatabase(paths);
  if (!db) return null;
  const match = SQLITE_CURSOR.exec(from), after = Number(match?.[1] ?? 0), afterId = match?.[2] ?? "";
  let next = `o:${Number.isSafeInteger(after) ? after : 0}:${afterId}`;
  try {
    const id = child ?? session.sessionId;
    const exists = child ? db.prepare("SELECT id FROM session WHERE id = ? AND parent_id = ?").get(id, session.sessionId) : db.prepare("SELECT id FROM session WHERE id = ?").get(id);
    if (!exists) return null;
    const stmt = db.prepare(`SELECT p.id, p.time_created, p.time_updated, length(CAST(p.data AS BLOB)) AS bytes,
      substr(p.data, 1, ?) AS data, CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END AS role
      FROM part p JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
      WHERE p.session_id = ? AND (p.time_updated > ? OR (p.time_updated = ? AND p.id > ?))
      ORDER BY p.time_updated, p.id LIMIT ?`);
    const items = [];
    let bytes = 0;
    for (const row of stmt.iterate(MAX_TRANSCRIPT_CHUNK_BYTES, id, after, after, afterId, MAX_SQLITE_PARTS)) {
      const length = Number(row.bytes);
      if (bytes + Math.min(length, MAX_TRANSCRIPT_CHUNK_BYTES) > MAX_TRANSCRIPT_CHUNK_BYTES) break;
      next = `o:${Number(row.time_updated)}:${String(row.id)}`;
      bytes += Math.min(length, MAX_TRANSCRIPT_CHUNK_BYTES);
      if (length <= MAX_TRANSCRIPT_CHUNK_BYTES && typeof row.data === "string") items.push(...opencodeItems(parse(row.data), row.role, time(row.time_created), String(row.id)));
    }
    return { items, next };
  } catch {
    return { items: [], next };
  } finally {
    db.close();
  }
}
function listOpencodeSubagents(session, paths) {
  if (!session.sessionId || !TRANSCRIPT_ID.test(session.sessionId)) return [];
  const db = openDatabase(paths);
  if (!db) return [];
  try {
    return db.prepare(`SELECT id, substr(title, 1, ?) AS title, time_created, time_updated FROM session
      WHERE parent_id = ? ORDER BY time_created LIMIT ?`).all(MAX_TITLE_CHARS, session.sessionId, MAX_NATIVE_SUBAGENTS).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      status: "unknown",
      startedAt: time(row.time_created),
      updatedAt: time(row.time_updated)
    })).filter((s) => TRANSCRIPT_ID.test(s.id));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

// src/core/transcripts/index.ts
function validTranscriptCursor(from) {
  const match = /^(?:(?:j:)?(\d+)(?::[01])?|o:(\d+):[A-Za-z0-9_-]*)$/.exec(from);
  if (from === "tail") return true;
  return from.length <= MAX_CURSOR_CHARS && !!match && Number.isSafeInteger(Number(match[1] ?? match[2]));
}
function readTranscript(session, from = "0", child, paths = transcriptPaths()) {
  switch (session.agent) {
    case "claude":
      return readClaudeChat(session, paths, from, child);
    case "codex":
      return readCodexChat(session, paths, from, child);
    case "opencode":
      return readOpencodeChat(session, paths, from, child);
    case "antigravity":
      return readAntigravityChat(session, paths, from, child);
    case "muse":
      return readMuseChat(session, paths, from, child);
    default:
      return null;
  }
}
function listNativeSubagents(session, paths = transcriptPaths()) {
  switch (session.agent) {
    case "claude":
      return listClaudeSubagents(session, paths);
    case "codex":
      return listCodexSubagents(session, paths);
    case "opencode":
      return listOpencodeSubagents(session, paths);
    case "antigravity":
      return listAntigravitySubagents(session, paths);
    case "muse":
      return listMuseSubagents(session, paths);
    default:
      return [];
  }
}

export {
  claudeItems,
  codexItems,
  validTranscriptCursor,
  readTranscript,
  listNativeSubagents
};
