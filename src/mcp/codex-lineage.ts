import { join } from "node:path";
import { directory, object, readJsonl, safeFile, transcriptPaths, TRANSCRIPT_ID } from "../core/transcripts/common.js";

export type CodexLineage = "main" | "child" | "unknown";
/** Filesystem-only admission. No CLI database is opened; missing headers are retried after a short cooldown. */
export class CodexLineageLookup {
  private readonly known = new Map<string, CodexLineage>();
  private readonly interactive = new Map<string, boolean>();
  private readonly retryAfter = new Map<string, number>();
  constructor(private readonly root = join(transcriptPaths().codex, "sessions")) {}

  classify(id: string, transcript?: string | null): CodexLineage {
    if (!TRANSCRIPT_ID.test(id)) return "unknown";
    const cached = this.known.get(id);
    if (cached) return cached;
    if (Date.now() < (this.retryAfter.get(id) ?? 0)) return "unknown";
    const inspect = (path: string): CodexLineage => {
      const file = safeFile(this.root, path);
      if (!file) return "unknown";
      // Forks can contain ancestor session_meta records; only this thread's record counts.
      const row = readJsonl(file, "0", 512 * 1024).entries.find(({ value }) => value.type === "session_meta" && object(value.payload).id === id);
      if (!row) return "unknown";
      const meta = object(row.value.payload), source = object(meta.source);
      if (meta.thread_source === "subagent" || source.subagent !== undefined || typeof meta.parent_thread_id === "string" && meta.parent_thread_id.length > 0) return "child";
      const main = ["cli", "vscode", "exec", "mcp"].includes(meta.source) || ["cli", "vscode", "exec", "mcp"].includes(meta.thread_source);
      if (main) this.interactive.set(id, ["cli", "vscode"].includes(meta.source) || ["cli", "vscode"].includes(meta.thread_source));
      return main ? "main" : "unknown";
    };
    let result: CodexLineage = transcript ? inspect(transcript) : "unknown";
    let directories = 0, entries = 0;
    const visited = new Set<string>();
    const scan = (path: string): CodexLineage => {
      if (visited.has(path) || directories >= 2_000 || entries >= 20_000) return "unknown";
      visited.add(path);
      const dir = safeFile(this.root, path);
      if (!dir) return "unknown";
      directories++;
      for (const name of directory(dir)) {
        if (++entries > 20_000) break;
        if (!name.startsWith("rollout-") || !name.endsWith(`-${id}.jsonl`)) continue;
        const found = inspect(join(dir, name));
        if (found !== "unknown") return found;
      }
      return "unknown";
    };
    // UUIDv7 embeds creation time, not resume time. Check its day before newer history
    // can exhaust discovery, including adjacent days for local timezone/midnight storage.
    if (result === "unknown" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      const created = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
      for (const offset of [0, -1, 1]) {
        const day = new Date(created + offset * 86_400_000).toISOString();
        if (!/^\d{4}-/.test(day)) continue;
        result = scan(join(this.root, ...day.slice(0, 10).split("-")));
        if (result !== "unknown") break;
      }
    }
    if (result === "unknown") outer: for (const year of directory(this.root).filter(s => /^\d{4}$/.test(s)).sort().reverse()) {
      const yearDir = safeFile(this.root, join(this.root, year));
      if (!yearDir) continue;
      for (const month of directory(yearDir).filter(s => /^\d{2}$/.test(s)).sort().reverse()) {
        const monthDir = safeFile(this.root, join(yearDir, month));
        if (!monthDir) continue;
        for (const day of directory(monthDir).filter(s => /^\d{2}$/.test(s)).sort().reverse()) {
          if (directories >= 2_000 || entries >= 20_000) break outer;
          result = scan(join(monthDir, day));
          if (result !== "unknown") break outer;
        }
      }
    }
    if (result !== "unknown") {
      this.retryAfter.delete(id);
      this.known.set(id, result);
      if (this.known.size > 512) { const oldest = this.known.keys().next().value!; this.known.delete(oldest); this.interactive.delete(oldest); }
    } else {
      this.retryAfter.delete(id);
      this.retryAfter.set(id, Date.now() + 10_000);
      if (this.retryAfter.size > 2_048) this.retryAfter.delete(this.retryAfter.keys().next().value!);
    }
    return result;
  }

  /** Exec/MCP sources can use tools as mains, but are headless and never upgrade successors. */
  isInteractive(id: string, transcript?: string | null): boolean {
    return this.classify(id, transcript) === "main" && this.interactive.get(id) === true;
  }
}

export interface CodexCallIdentity { threadId?: string | null; agentId?: string | null; transcript?: string | null }
/** MCP sessionId can be inherited by children. Only a caller threadId or hook ThreadId identifies the caller. */
export function codexCallIdentity(meta?: Record<string, unknown>, hook?: CodexCallIdentity): CodexCallIdentity {
  const given = (value: unknown) => typeof value === "string" && value && !value.startsWith("${") ? value : null;
  return { threadId: given(meta?.threadId) ?? hook?.threadId, agentId: hook?.agentId ?? given(meta?.agent_id), transcript: hook?.transcript ?? given(meta?.transcript_path) };
}
