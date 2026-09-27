/**
 * Turn the JSON event streams of headless agent runs into short status lines ("running: npm test"),
 * so a delegating agent (and its user) can see what a subagent is doing.
 */
import type { CodingAgent } from "./protocol.js";

const MAX_STATUS_CHARS = 140;

function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_STATUS_CHARS ? `${one.slice(0, MAX_STATUS_CHARS - 1)}…` : one;
}

function firstString(o: any, keys: string[]): string | null {
  for (const k of keys) if (typeof o?.[k] === "string" && o[k]) return o[k];
  return null;
}

const INPUT_KEYS = ["command", "file_path", "filePath", "path", "pattern", "query", "url", "description"];

/** `codex exec --json` events. */
export function describeCodexEvent(ev: any): string | null {
  const item = ev?.item;
  if (ev?.type === "item.started" && item) {
    switch (item.type) {
      case "command_execution":
        return clip(`running: ${item.command ?? ""}`);
      case "file_change": {
        const paths = (item.changes ?? []).map((c: any) => c?.path).filter(Boolean);
        return clip(`editing ${paths.join(", ") || "files"}`);
      }
      case "mcp_tool_call":
        return clip(`tool ${item.server ?? ""}.${item.tool ?? ""}`);
      case "web_search":
        return clip(`searching the web${item.query ? `: ${item.query}` : ""}`);
    }
  }
  if (ev?.type === "item.completed" && item?.type === "reasoning") return "thinking";
  if (ev?.type === "item.completed" && item?.type === "agent_message") return "writing the answer";
  return null;
}

/** `claude -p --output-format stream-json --verbose` events. */
export function describeClaudeEvent(ev: any): string | null {
  if (ev?.type !== "assistant") return null;
  const blocks: any[] = ev.message?.content ?? [];
  const tool = blocks.find((b) => b?.type === "tool_use");
  if (tool) {
    const detail = firstString(tool.input, INPUT_KEYS);
    return clip(`${tool.name}${detail ? `: ${detail}` : ""}`);
  }
  if (blocks.some((b) => b?.type === "text")) return "writing the answer";
  if (blocks.some((b) => b?.type === "thinking")) return "thinking";
  return null;
}

/** `opencode run --format json` events. */
export function describeOpencodeEvent(ev: any): string | null {
  if (ev?.type === "tool_use") {
    const part = ev.part ?? {};
    const detail = firstString(part.state?.input, INPUT_KEYS);
    return clip(`${part.tool ?? "tool"}${detail ? `: ${detail}` : ""}`);
  }
  if (ev?.type === "text") return "writing the answer";
  if (ev?.type === "reasoning") return "thinking";
  return null;
}

const DESCRIBERS: Record<CodingAgent, (ev: any) => string | null> = {
  codex: describeCodexEvent,
  claude: describeClaudeEvent,
  opencode: describeOpencodeEvent,
};

/** A stdout line handler that reports each new status (consecutive duplicates are dropped). */
export function progressLineHandler(agent: CodingAgent, onProgress: ((m: string) => void) | undefined): ((line: string) => void) | undefined {
  if (!onProgress) return undefined;
  let last = "";
  return (line) => {
    if (!line.startsWith("{")) return;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const msg = DESCRIBERS[agent](ev);
    if (msg && msg !== last) {
      last = msg;
      onProgress(msg);
    }
  };
}
