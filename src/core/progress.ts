/**
 * Turn the JSON event streams of headless agent runs into short status lines, so a delegating agent
 * (and its user) can follow what a subagent is doing:
 *
 *   "12m · step 58 (20 cmds, 17 edits) · bash: grep -rn Layout …"
 *   "14m · step 61 (20 cmds, 18 edits) · says: Rooms per building type are in, now the furniture kit …"
 */
import type { CodingAgent } from "./protocol.js";

const MAX_STATUS_CHARS = 140;
const MAX_SAY_CHARS = 160;

export type StepKind = "cmd" | "edit" | "read" | "tool" | "say" | "think";
export interface Step {
  kind: StepKind;
  text: string;
  /** Stable id of the underlying event part, used to report each part once. */
  id?: string;
  /** Unshortened text (full message or command) for the run log and dashboard. */
  full?: string;
}

/** Short status text plus the unshortened original. */
function txt(s: string, max = MAX_STATUS_CHARS): { text: string; full: string } {
  return { text: clip(s, max), full: s.trim() };
}

function clip(s: string, max = MAX_STATUS_CHARS): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function firstString(o: any, keys: string[]): string | null {
  for (const k of keys) if (typeof o?.[k] === "string" && o[k]) return o[k];
  return null;
}

const INPUT_KEYS = ["command", "file_path", "filePath", "path", "pattern", "query", "url", "description"];
const EDIT_TOOLS = /^(edit|write|multiedit|patch|apply_patch|notebookedit)$/i;
const CMD_TOOLS = /^(bash|shell|powershell)$/i;
const READ_TOOLS = /^(read|grep|glob|list|ls|find)$/i;

function kindOfTool(name: string): StepKind {
  if (EDIT_TOOLS.test(name)) return "edit";
  if (CMD_TOOLS.test(name)) return "cmd";
  if (READ_TOOLS.test(name)) return "read";
  return "tool";
}

function say(text: string): Step | null {
  return text.trim() ? { kind: "say", text: `says: ${clip(text, MAX_SAY_CHARS)}`, full: `says: ${text.trim()}` } : null;
}

/** `codex exec --json` events. */
export function describeCodexEvent(ev: any): Step | null {
  const item = ev?.item;
  if (ev?.type === "item.started" && item) {
    switch (item.type) {
      case "command_execution":
        return { kind: "cmd", ...txt(`running: ${item.command ?? ""}`), id: item.id };
      case "file_change": {
        const paths = (item.changes ?? []).map((c: any) => c?.path).filter(Boolean);
        return { kind: "edit", ...txt(`editing ${paths.join(", ") || "files"}`), id: item.id };
      }
      case "mcp_tool_call":
        return { kind: "tool", ...txt(`tool ${item.server ?? ""}.${item.tool ?? ""}`), id: item.id };
      case "web_search":
        return { kind: "tool", ...txt(`searching the web${item.query ? `: ${item.query}` : ""}`), id: item.id };
    }
  }
  if (ev?.type === "item.completed" && item?.type === "reasoning") return { kind: "think", text: "thinking" };
  if (ev?.type === "item.completed" && item?.type === "agent_message") return say(String(item.text ?? ""));
  return null;
}

/** `claude -p --output-format stream-json --verbose` events. */
export function describeClaudeEvent(ev: any): Step | null {
  if (ev?.type !== "assistant") return null;
  const blocks: any[] = ev.message?.content ?? [];
  const tool = blocks.find((b) => b?.type === "tool_use");
  if (tool) {
    const detail = firstString(tool.input, INPUT_KEYS);
    return { kind: kindOfTool(String(tool.name)), ...txt(`${tool.name}${detail ? `: ${detail}` : ""}`), id: tool.id };
  }
  const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
  if (text) return say(text);
  if (blocks.some((b) => b?.type === "thinking")) return { kind: "think", text: "thinking" };
  return null;
}

/** `opencode run --format json` events, and message parts from `opencode serve` (same part shape). */
export function describeOpencodeEvent(ev: any): Step | null {
  const part = ev?.part ?? {};
  if (ev?.type === "tool_use" || part.type === "tool") {
    const tool = String(part.tool ?? "tool");
    const detail = firstString(part.state?.input, INPUT_KEYS);
    return { kind: kindOfTool(tool), ...txt(`${tool}${detail ? `: ${detail}` : ""}`), id: part.id };
  }
  if (ev?.type === "text" || part.type === "text") return say(String(part.text ?? ""));
  if (ev?.type === "reasoning" || part.type === "reasoning") return { kind: "think", text: "thinking" };
  return null;
}

const DESCRIBERS: Record<CodingAgent, (ev: any) => Step | null> = {
  codex: describeCodexEvent,
  claude: describeClaudeEvent,
  opencode: describeOpencodeEvent,
};

function formatElapsed(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? `${Math.round(ms / 1000)}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Event handler that counts steps and reports each new one with elapsed time and totals.
 * Consecutive duplicates and repeated updates of the same part are dropped.
 */
export function progressEventHandler(
  agent: CodingAgent,
  onProgress: ((m: string, full?: string) => void) | undefined,
  now: () => number = Date.now,
): ((ev: unknown) => void) | undefined {
  if (!onProgress) return undefined;
  const started = now();
  const seen = new Set<string>();
  const counts: Record<StepKind, number> = { cmd: 0, edit: 0, read: 0, tool: 0, say: 0, think: 0 };
  let steps = 0;
  let last = "";
  return (ev) => {
    const step = DESCRIBERS[agent](ev);
    if (!step) return;
    if (step.id) {
      const key = `${step.kind}:${step.id}`;
      if (seen.has(key)) return;
      seen.add(key);
    }
    if (step.text === last) return;
    last = step.text;
    if (step.kind !== "think" && step.kind !== "say") steps++;
    counts[step.kind]++;
    const totals = [counts.cmd && `${counts.cmd} cmds`, counts.edit && `${counts.edit} edits`].filter(Boolean).join(", ");
    const where = steps ? ` · step ${steps}${totals ? ` (${totals})` : ""}` : "";
    const head = `${formatElapsed(now() - started)}${where} · `;
    onProgress(head + step.text, step.full ? head + step.full : undefined);
  };
}

/** Same, for newline-delimited JSON on stdout. */
export function progressLineHandler(agent: CodingAgent, onProgress: ((m: string, full?: string) => void) | undefined): ((line: string) => void) | undefined {
  const handle = progressEventHandler(agent, onProgress);
  if (!handle) return undefined;
  return (line) => {
    if (!line.startsWith("{")) return;
    try {
      handle(JSON.parse(line));
    } catch {
      // not JSON
    }
  };
}
