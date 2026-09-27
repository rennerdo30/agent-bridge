import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Logger } from "./logger.js";

const LOOKUP_TIMEOUT_MS = 5_000;
/** How many ancestors to inspect; MCP servers may be spawned through a shim (cmd.exe, npx, node). */
const MAX_ANCESTORS = 4;

interface ProcInfo {
  pid: number;
  ppid: number;
  cmdline: string;
}

function exec(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

async function lookup(pid: number): Promise<ProcInfo | null> {
  try {
    if (process.platform === "linux") {
      const [cmd, stat] = await Promise.all([readFile(`/proc/${pid}/cmdline`, "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      return { pid, ppid, cmdline: cmd.split("\0").join(" ") };
    }
    if (process.platform === "win32") {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.ParentProcessId)"; $p.CommandLine }`;
      const out = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      const [ppidLine, ...rest] = out.split(/\r?\n/);
      if (!ppidLine?.trim()) return null;
      return { pid, ppid: Number(ppidLine.trim()), cmdline: rest.join(" ").trim() };
    }
    const out = await exec("ps", ["-o", "ppid=,args=", "-p", String(pid)]);
    const m = /^\s*(\d+)\s+(.*)$/s.exec(out.trim());
    return m ? { pid, ppid: Number(m[1]), cmdline: m[2]!.trim() } : null;
  } catch {
    return null;
  }
}

const CHANNEL_FLAGS = ["--channels", "--dangerously-load-development-channels"];

/** True if the command line enables a channel that names agent-bridge. */
export function cmdlineEnablesChannel(cmdline: string, pluginName: string): boolean {
  const tokens = cmdline.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
  const values: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const eq = CHANNEL_FLAGS.find((f) => tok.startsWith(`${f}=`));
    if (eq) {
      values.push(tok.slice(eq.length + 1));
    } else if (CHANNEL_FLAGS.includes(tok)) {
      // Variadic flag: collect values until the next option.
      for (let j = i + 1; j < tokens.length && !tokens[j]!.startsWith("-"); j++) values.push(tokens[j]!);
    }
  }
  return values.some((v) => v.split(",").some((entry) => entry.includes(pluginName)));
}

/**
 * Walk up from our parent looking for a Claude Code process whose command line enables our channel.
 * Best effort: any failure means "not detected" and delivery falls back to hooks.
 */
export async function detectClaudeChannel(pluginName: string, log: Logger): Promise<boolean> {
  let pid = process.ppid;
  for (let i = 0; i < MAX_ANCESTORS && pid > 1; i++) {
    const info = await lookup(pid);
    if (!info) break;
    log.debug("inspected ancestor process", { pid, cmdline: info.cmdline.slice(0, 300) });
    if (cmdlineEnablesChannel(info.cmdline, pluginName)) return true;
    if (/\bclaude(\.exe)?\b/i.test(info.cmdline) && !/node_modules|agent-bridge/i.test(info.cmdline)) break;
    pid = info.ppid;
  }
  return false;
}
