import { join } from "node:path";
import { directory, object, readJsonl, safeFile, transcriptPaths, TRANSCRIPT_ID } from "../core/transcripts/common.js";

export type CodexLineage = "main" | "child" | "unknown";
/** Filesystem-only admission. No CLI database is opened and negative results are not cached. */
export class CodexLineageLookup {
  private readonly known = new Map<string, CodexLineage>();
  constructor(private readonly root = join(transcriptPaths().codex, "sessions")) {}

  classify(id: string, transcript?: string | null): CodexLineage {
    if (!TRANSCRIPT_ID.test(id)) return "unknown";
    const cached = this.known.get(id);
    if (cached) return cached;
    const inspect = (path: string): CodexLineage => {
      const file = safeFile(this.root, path);
      if (!file) return "unknown";
      // Forks can contain ancestor session_meta records; only this thread's record counts.
      const row = readJsonl(file, "0", 512 * 1024).entries.find(({ value }) => value.type === "session_meta" && object(value.payload).id === id);
      if (!row) return "unknown";
      const meta = object(row.value.payload), source = object(meta.source);
      if (meta.thread_source === "subagent" || source.subagent !== undefined || typeof meta.parent_thread_id === "string" && meta.parent_thread_id.length > 0) return "child";
      return ["cli", "vscode", "exec", "mcp"].includes(meta.source) || ["cli", "vscode", "exec", "mcp"].includes(meta.thread_source) ? "main" : "unknown";
    };
    let result: CodexLineage = transcript ? inspect(transcript) : "unknown";
    let examined = 0;
    if (result === "unknown") outer: for (const year of directory(this.root).filter(s => /^\d{4}$/.test(s)).sort().reverse()) {
      const yearDir = safeFile(this.root, join(this.root, year));
      if (!yearDir) continue;
      for (const month of directory(yearDir).filter(s => /^\d{2}$/.test(s)).sort().reverse()) {
        const monthDir = safeFile(this.root, join(yearDir, month));
        if (!monthDir) continue;
        for (const day of directory(monthDir).filter(s => /^\d{2}$/.test(s)).sort().reverse()) {
          const dir = safeFile(this.root, join(monthDir, day));
          if (!dir) continue;
          // Bound discovery, including directories, without following arbitrary folder trees.
          if (++examined > 2_000) break outer;
          for (const name of directory(dir)) {
            if (++examined > 20_000) break outer;
            if (!name.startsWith("rollout-") || !name.endsWith(`-${id}.jsonl`)) continue;
            result = inspect(join(dir, name));
            if (result !== "unknown") break outer;
          }
        }
      }
    }
    if (result !== "unknown") {
      this.known.set(id, result);
      if (this.known.size > 512) this.known.delete(this.known.keys().next().value!);
    }
    return result;
  }
}

export interface CodexCallIdentity { threadId?: string | null; agentId?: string | null; transcript?: string | null }
/** MCP sessionId can be inherited by children. Only a caller threadId or hook ThreadId identifies the caller. */
export function codexCallIdentity(meta?: Record<string, unknown>, hook?: CodexCallIdentity): CodexCallIdentity {
  const given = (value: unknown) => typeof value === "string" && value && !value.startsWith("${") ? value : null;
  return { threadId: given(meta?.threadId) ?? hook?.threadId, agentId: hook?.agentId ?? given(meta?.agent_id), transcript: hook?.transcript ?? given(meta?.transcript_path) };
}
