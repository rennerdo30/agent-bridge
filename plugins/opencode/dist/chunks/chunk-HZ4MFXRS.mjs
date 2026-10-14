import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MAX_NATIVE_SUBAGENTS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  TRANSCRIPT_ID,
  directory,
  fileStat,
  object,
  parse,
  preview,
  readJsonl,
  safeFile,
  scanJsonl,
  time
} from "./chunk-NVDPULGI.mjs";

// src/core/transcripts/antigravity.ts
import { join } from "node:path";
function antigravitySessionFile(session, paths) {
  return paths.antigravity && session.sessionId && TRANSCRIPT_ID.test(session.sessionId) ? safeFile(paths.antigravity, join(paths.antigravity, "brain", session.sessionId, ".system_generated", "logs", "transcript.jsonl")) : null;
}
function antigravityItems(row) {
  const at = time(row.created_at), items = [];
  const id = Number.isSafeInteger(row.step_index) ? String(row.step_index) : void 0;
  const toolResult = row.type === "GENERIC" && typeof row.content === "string" && /^Created At: [^\n]*\nCompleted At: /.test(row.content);
  if (toolResult) items.push({ kind: "tool", at, tool: "result", summary: preview(row.content), id });
  else if (typeof row.content === "string" && row.content && (["USER_INPUT", "PLANNER_RESPONSE", "AGENT_RESPONSE"].includes(row.type) || row.type === "GENERIC" && row.source === "MODEL")) items.push({ kind: row.type === "USER_INPUT" ? "user" : "assistant", at, text: preview(row.content, MAX_TEXT_CHARS), id });
  for (const call of (Array.isArray(row.tool_calls) ? row.tool_calls : []).map(object)) {
    items.push({ kind: "tool", at, tool: String(call.name ?? call.tool_name ?? "tool"), summary: preview(call.arguments ?? call.args ?? call.parameters), id: `${id ?? ""}:${items.length}` });
  }
  const subagents = object(row.subagent_info).subagents ?? row.subagents;
  for (const child of (Array.isArray(subagents) ? subagents : []).map(object)) {
    if (typeof child.conversation_id !== "string" || !TRANSCRIPT_ID.test(child.conversation_id)) continue;
    items.push({ kind: "subagent", at, subagent: { id: child.conversation_id, title: preview(child.role ?? child.type_name ?? "Native subagent", MAX_TITLE_CHARS), agent: "antigravity" } });
  }
  return items;
}
function listAntigravitySubagents(session, paths) {
  const file = antigravitySessionFile(session, paths);
  if (!file) return [];
  const children = /* @__PURE__ */ new Map();
  for (const { value } of scanJsonl(file)) for (const item of antigravityItems(value)) {
    const child = item.subagent;
    if (!child || children.size >= MAX_NATIVE_SUBAGENTS) continue;
    const nested = antigravitySessionFile({ ...session, sessionId: child.id }, paths), stat = nested ? fileStat(nested) : null;
    children.set(child.id, { id: child.id, title: child.title, status: "unknown", startedAt: item.at, updatedAt: stat?.mtimeMs ?? item.at });
  }
  return [...children.values()];
}
function readAntigravityChat(session, paths, from = "0", child) {
  if (child && (!TRANSCRIPT_ID.test(child) || !listAntigravitySubagents(session, paths).some((entry) => entry.id === child))) return null;
  const file = antigravitySessionFile(child ? { ...session, sessionId: child } : session, paths);
  if (!file) return null;
  const page = readJsonl(file, from);
  return { items: page.entries.flatMap(({ value }) => antigravityItems(value)), next: page.next };
}

// src/core/transcripts/muse.ts
import { join as join2 } from "node:path";
function museTime(row) {
  const at = typeof row.recorded_at === "number" ? row.recorded_at : 0;
  return Number.isFinite(at) ? at > 1e13 ? Math.floor(at / 1e3) : at : 0;
}
function sessionFileAt(root, dir) {
  const file = safeFile(root, join2(dir, "session.jsonl"));
  return file && fileStat(file)?.isFile() ? file : null;
}
function museSessionFile(session, paths) {
  if (!paths.muse || !session.sessionId || !TRANSCRIPT_ID.test(session.sessionId)) return null;
  const root = join2(paths.muse, "sessions");
  for (const year of directory(root)) for (const month of directory(join2(root, year))) for (const day of directory(join2(root, year, month))) {
    const file = sessionFileAt(paths.muse, join2(root, year, month, day, session.sessionId));
    if (file) return file;
  }
  return sessionFileAt(paths.muse, join2(root, session.sessionId));
}
function recordItems(ev) {
  const at = museTime(ev);
  const payload = object(ev.payload);
  const id = typeof ev.id === "string" ? ev.id : typeof ev.sequence === "number" ? String(ev.sequence) : void 0;
  if (ev.payload_type === "turn.input.user" && typeof payload.prompt === "string" && payload.prompt) {
    return [{ kind: "user", at, text: preview(payload.prompt, MAX_TEXT_CHARS), id }];
  }
  if (payload.kind === "run_terminal" && typeof payload.text === "string" && payload.text) {
    return [{ kind: "assistant", at, text: preview(payload.text, MAX_TEXT_CHARS), id }];
  }
  if (ev.payload_type === "tool_batch.effect.started") {
    const rec = object(payload.record);
    if (typeof rec.tool_name === "string" && rec.tool_name) {
      return [{ kind: "tool", at, tool: rec.tool_name, summary: preview(rec.call_id ?? ""), id: typeof rec.effect_id === "string" ? rec.effect_id : id }];
    }
  }
  if (ev.payload_type === "subagent.control.child_session_bound") {
    const rec = object(payload.record);
    if (typeof rec.child_session_id === "string" && TRANSCRIPT_ID.test(rec.child_session_id)) {
      return [{ kind: "subagent", at, subagent: { id: rec.child_session_id, title: preview("Muse subagent", MAX_TITLE_CHARS), agent: "muse" }, id }];
    }
  }
  return [];
}
function museItems(row) {
  if (typeof row.retained_frame === "string" && Array.isArray(row.children)) {
    return row.children.map(object).flatMap((child) => typeof child.record_json === "string" ? recordItems(parse(child.record_json)) : []);
  }
  return recordItems(row);
}
function listMuseSubagents(session, paths) {
  const file = museSessionFile(session, paths);
  if (!file) return [];
  const children = /* @__PURE__ */ new Map();
  for (const { value } of scanJsonl(file)) for (const item of museItems(value)) {
    const child = item.subagent;
    if (!child || children.has(child.id) || children.size >= MAX_NATIVE_SUBAGENTS) continue;
    const nested = museSessionFile({ ...session, sessionId: child.id }, paths), stat = nested ? fileStat(nested) : null;
    children.set(child.id, { id: child.id, title: child.title, status: "unknown", startedAt: item.at, updatedAt: stat?.mtimeMs ?? item.at });
  }
  return [...children.values()];
}
function readMuseChat(session, paths, from = "0", child) {
  if (child && (!TRANSCRIPT_ID.test(child) || !listMuseSubagents(session, paths).some((entry) => entry.id === child))) return null;
  const file = museSessionFile(child ? { ...session, sessionId: child } : session, paths);
  if (!file) return null;
  const page = readJsonl(file, from);
  return { items: page.entries.flatMap(({ value }) => museItems(value)), next: page.next };
}

export {
  antigravityItems,
  listAntigravitySubagents,
  readAntigravityChat,
  museItems,
  listMuseSubagents,
  readMuseChat
};
