import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION, PROTOCOL_VERSION } from "../core/constants.js";
import type { DoctorFinding } from "../core/doctor.js";
import { assertUnlinked, liveRuntimeSessions, type PluginClient } from "../core/plugin-runtime.js";
import { claudeMarketplace } from "./marketplace-sync.js";

export interface PluginDoctorPaths { claude: string; codex: string; opencode: string; antigravity: string; bridge: string }
export interface ServerProcess { pid: number; command: string }
export function pluginDoctorPaths(bridge: string, userHome = homedir(), env = process.env): PluginDoctorPaths {
  return { bridge, claude: env.CLAUDE_CONFIG_DIR || join(userHome, ".claude"), codex: env.CODEX_HOME || join(userHome, ".codex"),
    opencode: join(env.XDG_CONFIG_HOME || join(userHome, ".config"), "opencode"), antigravity: join(userHome, ".gemini", "config", "plugins", "agent-bridge") };
}

/** No client, token, database or plugin manager is started by this check. All reads reject links. */
export function inspectPluginVersions(paths: PluginDoctorPaths, processes: ServerProcess[] = [], expected = APP_VERSION): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const add = (client: PluginClient, path: string, label: string, actual: unknown, target = expected) => {
    if (actual !== target) findings.push({ severity: "warning", code: "plugin-version-mismatch", path,
      detail: `${client} ${label}: ${String(actual ?? "missing")}; expected ${target}. Fix: agent-bridge update ${client} --yes`, fixable: false });
  };
  const read = (path: string) => { assertUnlinked(path); return readFileSync(path, "utf8"); };
  const json = (path: string) => JSON.parse(read(path));
  const descriptor = (client: PluginClient) => client === "claude" ? ".claude-plugin/plugin.json" : client === "codex" ? ".codex-plugin/plugin.json" : "package.json";
  const cache = (client: PluginClient, root: string, target = expected) => {
    const directory = root.split(/[\\/]/).at(-1);
    if (directory && /^\d+\.\d+\.\d+$/.test(directory)) add(client, root, "cache directory", directory, target);
    const path = join(root, descriptor(client));
    add(client, path, "cache manifest", existsSync(path) ? json(path).version : null, target);
    for (const file of ["server.mjs", "worker.mjs"]) if (!existsSync(join(root, "dist", file))) add(client, join(root, "dist", file), "cache executable", null, target);
  };
  const runtime = (client: PluginClient, home: string) => {
    const path = join(home, "plugin-versions", client, "active.json");
    if (!existsSync(path)) return;
    const active = json(path);
    add(client, path, "runtime selector", active.version);
    if (active.schemaVersion !== 1 || active.protocol !== PROTOCOL_VERSION) add(client, path, "runtime compatibility", "unsupported");
    if (typeof active.version === "string" && /^\d+\.\d+\.\d+$/.test(active.version)) cache(client, join(dirname(path), active.version), active.version);
  };
  const marketplace = (client: "claude" | "codex", root: string) => {
    const path = join(root, client === "claude" ? ".claude-plugin/marketplace.json" : ".agents/plugins/marketplace.json");
    const entry = json(path).plugins?.find((p: any) => p.name === "agent-bridge");
    const source = client === "claude" ? entry?.source : entry?.source?.path;
    if (client === "claude") add(client, path, "marketplace record", entry?.version);
    if (typeof source !== "string" || !source.startsWith("./") || source.split(/[\\/]/).includes("..")) throw new Error(`Unsupported marketplace source: ${path}`);
    const manifest = join(root, source, descriptor(client));
    add(client, manifest, "marketplace source", json(manifest).version);
  };
  for (const client of ["claude", "codex", "opencode", "antigravity"] as const) {
    try {
      const home = paths[client]; assertUnlinked(home);
      if (client === "claude") {
        const record = join(home, "plugins", "installed_plugins.json"), market = claudeMarketplace(home);
        if (existsSync(record) || existsSync(market)) {
          marketplace(client, market);
          const entries = existsSync(record) ? json(record).plugins?.["agent-bridge@agent-bridge"] : null;
          if (!Array.isArray(entries) || !entries.length) add(client, record, "installed record", null);
          else for (const entry of entries) { add(client, record, `installed record (${entry.scope})`, entry.version); if (typeof entry.installPath === "string") cache(client, entry.installPath, entry.version); else add(client, record, "installed path", null); }
        }
        runtime(client, paths.bridge);
      } else if (client === "codex") {
        const record = join(home, "config.toml"), base = join(home, "plugins", "cache", "agent-bridge", "agent-bridge");
        const config = existsSync(record) ? read(record) : "";
        const table = /^\s*\[marketplaces\.(?:agent-bridge|"agent-bridge"|'agent-bridge')\]\s*(?:#.*)?\r?\n([^]*?)(?=^\s*\[|$(?![^]))/m.exec(config)?.[1];
        if (table) {
          const type = /^\s*source_type\s*=\s*["']([^"']+)["']/m.exec(table)?.[1];
          const source = /^\s*source\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')/m.exec(table)?.[1];
          if (type === "local" && source) marketplace(client, source.startsWith('"') ? JSON.parse(source) : source.slice(1, -1));
          else add(client, record, "installed marketplace selector", type ?? "missing", "local");
        } else if (existsSync(base)) add(client, record, "installed marketplace selector", null, "local");
        if (existsSync(base)) {
          assertUnlinked(base);
          const names = readdirSync(base).filter((n) => /^\d+\.\d+\.\d+$/.test(n)).sort((a,b) => { const x=a.split('.').map(Number),y=b.split('.').map(Number); return x[0]!-y[0]! || x[1]!-y[1]! || x[2]!-y[2]!; });
          const selected = names.at(-1); add(client, base, "native cache selector", selected);
          if (selected) cache(client, join(base, selected), selected);
          if (readdirSync(base).includes("local")) add(client, base, "native cache selector", "local (takes precedence)");
        }
        for (const clone of [join(home, "plugins", "marketplaces", "agent-bridge"), join(home, "marketplaces", "agent-bridge")]) if (existsSync(clone)) marketplace(client, clone);
        runtime(client, paths.bridge);
      } else if (client === "opencode") {
        const loader = join(home, "plugins", "agent-bridge.js"), runtimeHome = join(home, "agent-bridge");
        runtime(client, runtimeHome);
        if (existsSync(loader)) {
          const url = /export \* from\s+("[^"\r\n]+")/.exec(read(loader))?.[1];
          const root = url ? dirname(dirname(fileURLToPath(JSON.parse(url)))) : null;
          add(client, loader, "installed loader", root ? root.split(/[\\/]/).at(-1) : "legacy");
          if (root) cache(client, root);
        }
      } else {
        runtime(client, join(dirname(home), ".agent-bridge-runtime"));
        const record = join(home, "mcp_config.json");
        if (existsSync(record)) {
          add(client, join(home, "package.json"), "installed record", json(join(home, "package.json")).version);
          const server = json(record).mcpServers?.["agent-bridge"]?.args?.[0];
          const root = typeof server === "string" ? dirname(dirname(server)) : null;
          add(client, record, "installed MCP loader", root?.split(/[\\/]/).at(-1));
          if (root) cache(client, root);
        }
      }
    } catch (error) { findings.push({ severity: "warning", code: "plugin-version-unreadable", path: paths[client], detail: `${client}: ${String(error)}. Fix: agent-bridge update ${client} --yes`, fixable: false }); }
  }
  const recorded = new Map<number, { client: PluginClient; version: string; worker: string }>();
  for (const home of [paths.bridge, join(paths.opencode, "agent-bridge"), join(dirname(paths.antigravity), ".agent-bridge-runtime")]) {
    for (const client of ["claude", "codex", "opencode", "antigravity"] as const) {
      try { for (const session of liveRuntimeSessions(home, client)) recorded.set(session.pid, session); } catch { /* separately inspected selectors report link errors */ }
    }
  }
  const reportProcess = (pid: number, client: PluginClient, actual: string | undefined, path: string) => {
    if (actual !== expected) findings.push({ severity: "warning", code: "plugin-running-version", path,
      detail: `${client} running pid ${pid}: ${actual ?? "unknown"}; selected release ${expected}. Existing sessions retain their code. Fix: agent-bridge update ${client} --yes; after active work finishes, ${client === "claude" ? "run /reload-plugins in Claude Code" : `restart ${client === "antigravity" ? "agy" : client}`}.`, fixable: false });
  };
  for (const proc of processes) {
    const normalized = proc.command.replaceAll("\\", "/");
    const client = /--agent=(claude|codex|opencode|antigravity)\b/.exec(normalized)?.[1] as PluginClient | undefined;
    if (!client || !/\/(?:server|worker)\.mjs(?:"|\s|$)/.test(normalized) || !normalized.includes("agent-bridge")) continue;
    const session = recorded.get(proc.pid);
    const version = session?.version ?? /(?:cache\/agent-bridge\/agent-bridge|plugin-versions\/(?:claude|codex|opencode|antigravity))\/(\d+\.\d+\.\d+)\//.exec(normalized)?.[1];
    reportProcess(proc.pid, client, version, session?.worker ?? proc.command); recorded.delete(proc.pid);
  }
  for (const [pid, session] of recorded) reportProcess(pid, session.client, session.version, session.worker);
  return findings;
}

export async function listServerProcesses(): Promise<ServerProcess[] | null> {
  const win = process.platform === "win32";
  return new Promise((resolveResult) => execFile(win ? "powershell.exe" : "ps", win ? ["-NoProfile", "-NonInteractive", "-Command", "@(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object @{n='pid';e={$_.ProcessId}},@{n='command';e={$_.CommandLine}}) | ConvertTo-Json -Compress"] : ["-ax", "-o", "pid=,args="], { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    if (error) return resolveResult(null);
    try { resolveResult(win ? JSON.parse(stdout || "[]").filter((p: ServerProcess) => typeof p.command === "string") : stdout.split("\n").flatMap(line => { const m=/^\s*(\d+)\s+(.*)$/.exec(line); return m ? [{pid:Number(m[1]),command:m[2]!}] : []; })); } catch { resolveResult(null); }
  }));
}
