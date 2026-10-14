import { join } from "node:path";
import { directory, fileStat, MAX_NATIVE_SUBAGENTS, MAX_TEXT_CHARS, MAX_TITLE_CHARS, object, parse, preview, readJsonl, safeFile, scanJsonl, TRANSCRIPT_ID, type JsonObject, type NativeSubagent, type TranscriptItem, type TranscriptPage, type TranscriptPaths, type TranscriptSession } from "./common.js";

/** Muse timestamps are microseconds since the epoch; bridge items use milliseconds. */
function museTime(row: JsonObject): number {
  const at = typeof row.recorded_at === "number" ? row.recorded_at : 0;
  return Number.isFinite(at) ? at > 1e13 ? Math.floor(at / 1000) : at : 0;
}

function sessionFileAt(root: string, dir: string): string | null {
  const file = safeFile(root, join(dir, "session.jsonl"));
  return file && fileStat(file)?.isFile() ? file : null;
}

export function museSessionFile(session: TranscriptSession, paths: TranscriptPaths): string | null {
  if (!paths.muse || !session.sessionId || !TRANSCRIPT_ID.test(session.sessionId)) return null;
  const root = join(paths.muse, "sessions");
  for (const year of directory(root)) for (const month of directory(join(root, year))) for (const day of directory(join(root, year, month))) {
    const file = sessionFileAt(paths.muse, join(root, year, month, day, session.sessionId));
    if (file) return file;
  }
  return sessionFileAt(paths.muse, join(root, session.sessionId));
}

function recordItems(ev: JsonObject): TranscriptItem[] {
  const at = museTime(ev);
  const payload = object(ev.payload);
  const id = typeof ev.id === "string" ? ev.id : typeof ev.sequence === "number" ? String(ev.sequence) : undefined;
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

/** One stored line: either a bare session record or a retained frame wrapping records as JSON strings. */
export function museItems(row: JsonObject): TranscriptItem[] {
  if (typeof row.retained_frame === "string" && Array.isArray(row.children)) {
    return row.children.map(object).flatMap((child) => typeof child.record_json === "string" ? recordItems(parse(child.record_json)) : []);
  }
  return recordItems(row);
}

export function listMuseSubagents(session: TranscriptSession, paths: TranscriptPaths): NativeSubagent[] {
  const file = museSessionFile(session, paths);
  if (!file) return [];
  const children = new Map<string, NativeSubagent>();
  for (const { value } of scanJsonl(file)) for (const item of museItems(value)) {
    const child = item.subagent;
    if (!child || children.has(child.id) || children.size >= MAX_NATIVE_SUBAGENTS) continue;
    const nested = museSessionFile({ ...session, sessionId: child.id }, paths), stat = nested ? fileStat(nested) : null;
    children.set(child.id, { id: child.id, title: child.title, status: "unknown", startedAt: item.at, updatedAt: stat?.mtimeMs ?? item.at });
  }
  return [...children.values()];
}

export function readMuseChat(session: TranscriptSession, paths: TranscriptPaths, from = "0", child?: string): TranscriptPage | null {
  if (child && (!TRANSCRIPT_ID.test(child) || !listMuseSubagents(session, paths).some((entry) => entry.id === child))) return null;
  const file = museSessionFile(child ? { ...session, sessionId: child } : session, paths);
  if (!file) return null;
  const page = readJsonl(file, from);
  return { items: page.entries.flatMap(({ value }) => museItems(value)), next: page.next };
}

export function museSessionIds(paths: TranscriptPaths): string[] {
  if (!paths.muse) return [];
  const root = join(paths.muse, "sessions"), ids = new Set<string>();
  for (const id of directory(root)) if (TRANSCRIPT_ID.test(id) && sessionFileAt(paths.muse, join(root, id))) ids.add(id);
  for (const year of directory(root)) for (const month of directory(join(root, year))) for (const day of directory(join(root, year, month))) {
    for (const id of directory(join(root, year, month, day))) if (TRANSCRIPT_ID.test(id) && sessionFileAt(paths.muse, join(root, year, month, day, id))) ids.add(id);
  }
  return [...ids];
}
