import { execFile } from "node:child_process";

/**
 * On Windows, `codex plugin add` cannot replace the plugin while any Codex process has agent-bridge loaded
 * ("Access is denied"): Codex starts plugin servers with the plugin folder as their working directory. That
 * includes Codex subagents started by agent-bridge sessions, not only open Codex windows. List what is running
 * so the updater can say what to close or wait for.
 */
const LOOKUP_TIMEOUT_MS = 10_000;

export interface CodexUser {
  pid: number;
  kind: "app" | "subagent" | "session";
  /** For subagents: the agent kind of the session that started it. */
  startedBy?: string;
  started: string;
}

interface Proc {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  CommandLine: string | null;
  CreationDate: string | null;
}

/** Classify running codex.exe processes; pure so it can be tested. */
export function classifyCodexProcesses(procs: Proc[]): CodexUser[] {
  const byPid = new Map(procs.map((p) => [p.ProcessId, p]));
  const codex = procs.filter((p) => /^codex(\.exe)?$/i.test(p.Name) && !/exec-server|code-mode-host/i.test(p.CommandLine ?? ""));
  const codexPids = new Set(codex.map((p) => p.ProcessId));
  return codex
    .filter((p) => !codexPids.has(p.ParentProcessId)) // helpers of another codex process
    .map((p) => {
      const parent = byPid.get(p.ParentProcessId);
      const started = p.CreationDate ? new Date(p.CreationDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?";
      const bridge = /agent-bridge[\\/].*server\.mjs\s+--agent=(\w+)/i.exec(parent?.CommandLine ?? "");
      if (bridge) return { pid: p.ProcessId, kind: "subagent", startedBy: bridge[1], started };
      // A background subagent in its job runner (agent-bridge 0.24+): node ... cli.mjs job-runner <spec>.
      if (/agent-bridge[\\/].*cli\.mjs"?\s+job-runner\b/i.test(parent?.CommandLine ?? "")) return { pid: p.ProcessId, kind: "subagent", startedBy: "agent-bridge", started };
      if (/^(ChatGPT|Codex)(\.exe)?$/i.test(parent?.Name ?? "")) return { pid: p.ProcessId, kind: "app", started };
      return { pid: p.ProcessId, kind: "session", started };
    });
}

export function listCodexUsers(): Promise<CodexUser[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine," +
    "@{n='CreationDate';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const data = JSON.parse(stdout) as Proc | Proc[];
        resolve(classifyCodexProcesses(Array.isArray(data) ? data : [data]));
      } catch {
        resolve([]);
      }
    });
  });
}

export function describeCodexUser(u: CodexUser): string {
  if (u.kind === "app") return `the Codex app (pid ${u.pid}, since ${u.started}): update once it is idle`;
  if (u.kind === "subagent") return `a Codex subagent of ${u.startedBy === "agent-bridge" ? "an agent-bridge" : `a ${u.startedBy}`} session (pid ${u.pid}, since ${u.started}): wait until it finishes, or cancel it with cancel_subagent`;
  return `a Codex session (pid ${u.pid}, since ${u.started}): update once it is idle`;
}
