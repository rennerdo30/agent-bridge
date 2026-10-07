import { join } from "node:path";
import { directory, fileStat, MAX_NATIVE_SUBAGENTS, MAX_TEXT_CHARS, MAX_TITLE_CHARS, object, preview, readJsonl, safeFile, scanJsonl, time, TRANSCRIPT_ID, type JsonObject, type NativeSubagent, type TranscriptItem, type TranscriptPage, type TranscriptPaths, type TranscriptSession } from "./common.js";

export function antigravitySessionFile(session: TranscriptSession, paths: TranscriptPaths): string | null {
  return paths.antigravity && session.sessionId && TRANSCRIPT_ID.test(session.sessionId) ? safeFile(paths.antigravity, join(paths.antigravity, "brain", session.sessionId, ".system_generated", "logs", "transcript.jsonl")) : null;
}

export function antigravityItems(row: JsonObject): TranscriptItem[] {
  const at = time(row.created_at), items: TranscriptItem[] = [];
  const id = Number.isSafeInteger(row.step_index) ? String(row.step_index) : undefined;
  // Native logs record completed tool output as GENERIC/MODEL, including denied calls.
  const toolResult = row.type === "GENERIC" && typeof row.content === "string" && /^Created At: [^\n]*\nCompleted At: /.test(row.content);
  if (toolResult) items.push({ kind: "tool", at, tool: "result", summary: preview(row.content), id });
  else if (typeof row.content === "string" && row.content && (["USER_INPUT", "PLANNER_RESPONSE", "AGENT_RESPONSE"].includes(row.type) || (row.type === "GENERIC" && row.source === "MODEL"))) items.push({ kind: row.type === "USER_INPUT" ? "user" : "assistant", at, text: preview(row.content, MAX_TEXT_CHARS), id });
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

export function listAntigravitySubagents(session: TranscriptSession, paths: TranscriptPaths): NativeSubagent[] {
  const file = antigravitySessionFile(session, paths);
  if (!file) return [];
  const children = new Map<string, NativeSubagent>();
  for (const { value } of scanJsonl(file)) for (const item of antigravityItems(value)) {
    const child = item.subagent;
    if (!child || children.size >= MAX_NATIVE_SUBAGENTS) continue;
    const nested = antigravitySessionFile({ ...session, sessionId: child.id }, paths), stat = nested ? fileStat(nested) : null;
    children.set(child.id, { id: child.id, title: child.title, status: "unknown", startedAt: item.at, updatedAt: stat?.mtimeMs ?? item.at });
  }
  return [...children.values()];
}

export function readAntigravityChat(session: TranscriptSession, paths: TranscriptPaths, from = "0", child?: string): TranscriptPage | null {
  if (child && (!TRANSCRIPT_ID.test(child) || !listAntigravitySubagents(session, paths).some((entry) => entry.id === child))) return null;
  const file = antigravitySessionFile(child ? { ...session, sessionId: child } : session, paths);
  if (!file) return null;
  const page = readJsonl(file, from);
  return { items: page.entries.flatMap(({ value }) => antigravityItems(value)), next: page.next };
}

export function antigravitySessionIds(paths: TranscriptPaths): string[] {
  return paths.antigravity ? directory(join(paths.antigravity, "brain")).filter((id) => TRANSCRIPT_ID.test(id)) : [];
}
