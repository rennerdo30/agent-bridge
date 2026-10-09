import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  claudeMarketplace
} from "./chunk-GCMAOG4B.mjs";
import {
  archiveHome,
  doctor,
  fixDoctor
} from "./chunk-WPH6BLEG.mjs";
import "./chunk-IOTDGB5L.mjs";
import {
  brokerFailureState,
  formatHealth,
  probeBrokerHealth
} from "./chunk-FHJRNC7V.mjs";
import "./chunk-VMLMAYUW.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-Z4B57VCI.mjs";
import "./chunk-BUGIU4VT.mjs";
import "./chunk-GXD6MOY6.mjs";
import "./chunk-F7FSK2FI.mjs";
import {
  createBackup,
  readBackup,
  restoreBackup
} from "./chunk-4GJUIXBN.mjs";
import "./chunk-6RGRWK7M.mjs";
import "./chunk-4RDTZ3IQ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolvePipePath
} from "./chunk-L4M5HEV4.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-7OVAI3PR.mjs";
import "./chunk-PCXGTT2Z.mjs";
import "./chunk-2KLFTBBJ.mjs";
import "./chunk-ETHEYCLK.mjs";
import "./chunk-CUZHUOFY.mjs";
import "./chunk-QI6BOSWF.mjs";
import "./chunk-L3WJOWYS.mjs";
import "./chunk-NSTCMPSE.mjs";
import "./chunk-JNVJDIQM.mjs";
import "./chunk-FDMEMG4Z.mjs";
import {
  nullLogger
} from "./chunk-EVPBD2NK.mjs";
import {
  assertUnlinked,
  liveRuntimeSessions
} from "./chunk-SFW3GO73.mjs";
import {
  APP_VERSION,
  PROTOCOL_VERSION
} from "./chunk-7EOIPV3B.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/cli/doctor.ts
import { createInterface } from "node:readline/promises";

// src/cli/plugin-doctor.ts
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
function pluginDoctorPaths(bridge, userHome = homedir(), env = process.env) {
  return {
    bridge,
    claude: env.CLAUDE_CONFIG_DIR || join(userHome, ".claude"),
    codex: env.CODEX_HOME || join(userHome, ".codex"),
    opencode: join(env.XDG_CONFIG_HOME || join(userHome, ".config"), "opencode"),
    antigravity: join(userHome, ".gemini", "config", "plugins", "agent-bridge")
  };
}
function inspectPluginVersions(paths, processes = [], expected = APP_VERSION) {
  const findings = [];
  const add = (client, path, label, actual, target = expected) => {
    if (actual !== target) findings.push({
      severity: "warning",
      code: "plugin-version-mismatch",
      path,
      detail: `${client} ${label}: ${String(actual ?? "missing")}; expected ${target}. Fix: agent-bridge update ${client} --yes`,
      fixable: false
    });
  };
  const read = (path) => {
    assertUnlinked(path);
    return readFileSync(path, "utf8");
  };
  const json = (path) => JSON.parse(read(path));
  const descriptor = (client) => client === "claude" ? ".claude-plugin/plugin.json" : client === "codex" ? ".codex-plugin/plugin.json" : "package.json";
  const cache = (client, root, target = expected) => {
    const directory = root.split(/[\\/]/).at(-1);
    if (directory && /^\d+\.\d+\.\d+$/.test(directory)) add(client, root, "cache directory", directory, target);
    const path = join(root, descriptor(client));
    add(client, path, "cache manifest", existsSync(path) ? json(path).version : null, target);
    for (const file of ["server.mjs", "worker.mjs"]) if (!existsSync(join(root, "dist", file))) add(client, join(root, "dist", file), "cache executable", null, target);
  };
  const runtime = (client, home) => {
    const path = join(home, "plugin-versions", client, "active.json");
    if (!existsSync(path)) return;
    const active = json(path);
    add(client, path, "runtime selector", active.version);
    if (active.schemaVersion !== 1 || active.protocol !== PROTOCOL_VERSION) add(client, path, "runtime compatibility", "unsupported");
    if (typeof active.version === "string" && /^\d+\.\d+\.\d+$/.test(active.version)) cache(client, join(dirname(path), active.version), active.version);
  };
  const marketplace = (client, root) => {
    const path = join(root, client === "claude" ? ".claude-plugin/marketplace.json" : ".agents/plugins/marketplace.json");
    const entry = json(path).plugins?.find((p) => p.name === "agent-bridge");
    const source = client === "claude" ? entry?.source : entry?.source?.path;
    if (client === "claude") add(client, path, "marketplace record", entry?.version);
    if (typeof source !== "string" || !source.startsWith("./") || source.split(/[\\/]/).includes("..")) throw new Error(`Unsupported marketplace source: ${path}`);
    const manifest = join(root, source, descriptor(client));
    add(client, manifest, "marketplace source", json(manifest).version);
  };
  for (const client of ["claude", "codex", "opencode", "antigravity"]) {
    try {
      const home = paths[client];
      assertUnlinked(home);
      if (client === "claude") {
        const record = join(home, "plugins", "installed_plugins.json"), market = claudeMarketplace(home);
        if (existsSync(record) || existsSync(market)) {
          marketplace(client, market);
          const entries = existsSync(record) ? json(record).plugins?.["agent-bridge@agent-bridge"] : null;
          if (!Array.isArray(entries) || !entries.length) add(client, record, "installed record", null);
          else for (const entry of entries) {
            add(client, record, `installed record (${entry.scope})`, entry.version);
            if (typeof entry.installPath === "string") cache(client, entry.installPath, entry.version);
            else add(client, record, "installed path", null);
          }
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
          const names = readdirSync(base).filter((n) => /^\d+\.\d+\.\d+$/.test(n)).sort((a, b) => {
            const x = a.split(".").map(Number), y = b.split(".").map(Number);
            return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
          });
          const selected = names.at(-1);
          add(client, base, "native cache selector", selected);
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
    } catch (error) {
      findings.push({ severity: "warning", code: "plugin-version-unreadable", path: paths[client], detail: `${client}: ${String(error)}. Fix: agent-bridge update ${client} --yes`, fixable: false });
    }
  }
  const recorded = /* @__PURE__ */ new Map();
  for (const home of [paths.bridge, join(paths.opencode, "agent-bridge"), join(dirname(paths.antigravity), ".agent-bridge-runtime")]) {
    for (const client of ["claude", "codex", "opencode", "antigravity"]) {
      try {
        for (const session of liveRuntimeSessions(home, client)) recorded.set(session.pid, session);
      } catch {
      }
    }
  }
  const reportProcess = (pid, client, actual, path) => {
    if (actual !== expected) findings.push({
      severity: "warning",
      code: "plugin-running-version",
      path,
      detail: `${client} running pid ${pid}: ${actual ?? "unknown"}; selected release ${expected}. Existing sessions retain their code. Fix: agent-bridge update ${client} --yes; after active work finishes, ${client === "claude" ? "run /reload-plugins in Claude Code" : `restart ${client === "antigravity" ? "agy" : client}`}.`,
      fixable: false
    });
  };
  for (const proc of processes) {
    const normalized = proc.command.replaceAll("\\", "/");
    const client = /--agent=(claude|codex|opencode|antigravity)\b/.exec(normalized)?.[1];
    if (!client || !/\/(?:server|worker)\.mjs(?:"|\s|$)/.test(normalized) || !normalized.includes("agent-bridge")) continue;
    const session = recorded.get(proc.pid);
    const version = session?.version ?? /(?:cache\/agent-bridge\/agent-bridge|plugin-versions\/(?:claude|codex|opencode|antigravity))\/(\d+\.\d+\.\d+)\//.exec(normalized)?.[1];
    reportProcess(proc.pid, client, version, session?.worker ?? proc.command);
    recorded.delete(proc.pid);
  }
  for (const [pid, session] of recorded) reportProcess(pid, session.client, session.version, session.worker);
  return findings;
}
async function listServerProcesses() {
  const win = process.platform === "win32";
  return new Promise((resolveResult) => execFile(win ? "powershell.exe" : "ps", win ? ["-NoProfile", "-NonInteractive", "-Command", `@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Select-Object @{n='pid';e={$_.ProcessId}},@{n='command';e={$_.CommandLine}}) | ConvertTo-Json -Compress`] : ["-ax", "-o", "pid=,args="], { windowsHide: true, timeout: 1e4, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    if (error) return resolveResult(null);
    try {
      resolveResult(win ? JSON.parse(stdout || "[]").filter((p) => typeof p.command === "string") : stdout.split("\n").flatMap((line) => {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        return m ? [{ pid: Number(m[1]), command: m[2] }] : [];
      }));
    } catch {
      resolveResult(null);
    }
  }));
}

// src/cli/windows-env-doctor.ts
import { execFile as execFile2 } from "node:child_process";
import { promisify } from "node:util";
var exec = promisify(execFile2);
var defaultProbe = (command, args, options) => exec(command, args, options);
async function windowsUserPathFindings(platform = process.platform, probe = defaultProbe) {
  if (platform !== "win32") return [];
  const script = "$pathValue = [Environment]::GetEnvironmentVariable('Path', 'User'); $toolCount = @($pathValue -split ';' | Where-Object { $_.Trim().TrimEnd('\\','/').Replace('\\','/') -match '(?i)(^|/)\\.dotnet/tools$' }).Count; @{length = ([string]$pathValue).Length; dotnetToolsEntries = $toolCount} | ConvertTo-Json -Compress";
  try {
    const { stdout } = await probe(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 2e3, maxBuffer: 4096, windowsHide: true, encoding: "utf8" }
    );
    const metrics = JSON.parse(stdout);
    if (!metrics || typeof metrics !== "object") return [];
    const { length, dotnetToolsEntries } = metrics;
    if (!Number.isSafeInteger(length) || !Number.isSafeInteger(dotnetToolsEntries) || length < 0 || dotnetToolsEntries < 0) return [];
    const findings = [];
    if (length > 2e3) findings.push({
      severity: "warning",
      code: "windows-user-path-long",
      path: "Windows user environment",
      detail: `Persistent user PATH has ${length} characters (over 2000); review it manually for redundant entries.`,
      fixable: false
    });
    if (dotnetToolsEntries >= 3) findings.push({
      severity: "warning",
      code: "windows-user-path-dotnet-tools",
      path: "Windows user environment",
      detail: `Persistent user PATH contains ${dotnetToolsEntries} .dotnet/tools entries; review repeated entries manually.`,
      fixable: false
    });
    return findings;
  } catch {
    return [];
  }
}

// src/cli/doctor.ts
async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(yes|y)$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}
async function runDoctor(args, home, out, ask = confirm) {
  if (args.includes("--migration-plan")) {
    if (args.some((arg) => arg !== "--migration-plan" && arg !== "--json")) {
      out("Usage: agent-bridge doctor --migration-plan [--json]");
      return 2;
    }
    const { migrationPlan } = await import("./migration-plan-32JGLZUJ.mjs");
    const plan = migrationPlan(home);
    out(JSON.stringify(plan, null, args.includes("--json") ? void 0 : 2));
    return 0;
  }
  const restoreAt = args.indexOf("--restore");
  const restore = restoreAt >= 0 ? args[restoreAt + 1] : void 0;
  const actions = Number(restoreAt >= 0) + Number(args.includes("--fix")) + Number(args.includes("--archive")) + Number(args.includes("--backup"));
  const allowed = /* @__PURE__ */ new Set(["--restore", "--fix", "--archive", "--backup", "--yes", "-y", "--json"]);
  if (actions > 1 || restoreAt >= 0 && (!restore || restore.startsWith("-")) || args.some((a, i) => !allowed.has(a) && (restoreAt < 0 || i !== restoreAt + 1))) {
    out("Usage: agent-bridge doctor [--json] [--backup | --fix | --archive | --restore <backup>] [--yes]");
    return 2;
  }
  const yes = args.includes("--yes") || args.includes("-y");
  if (restore) {
    readBackup(restore);
    const backupReport = doctor(restore);
    if (backupReport.findings.some((f) => f.severity === "error")) throw new Error("backup contains unsupported or damaged data; restore refused");
    if (!(yes || await ask(`Restore ${restore}? Current data will be preserved in a recovery backup.`))) {
      out("Restore cancelled; data unchanged.");
      return 1;
    }
    out(`Restored backup. Previous data preserved at ${restoreBackup(home, restore, true)}`);
  } else if (args.includes("--backup")) out(`Backup created: ${createBackup(home)}`);
  else if (args.includes("--fix") || args.includes("--archive")) {
    const archive = args.includes("--archive");
    if (!(yes || await ask(archive ? "Archive old data? Every record remains readable." : "Quarantine orphan temporary files? All data will be preserved."))) {
      out("Maintenance cancelled; data unchanged.");
      return 1;
    }
    out(archive ? `Archived: ${JSON.stringify(archiveHome(home, true))}` : `Preserved files: ${JSON.stringify(fixDoctor(home, true))}`);
  }
  const report = doctor(home);
  report.brokerHealth = await probeBrokerHealth(resolvePipePath(home), nullLogger).catch((error) => {
    if (brokerFailureState(error) !== "offline") report.findings.push({
      severity: "warning",
      code: "broker-health-unconfirmed",
      path: home,
      detail: brokerFailureState(error) === "slow" ? "Bridge responding slowly; history-import progress could not be refreshed." : "Bridge health unavailable; broker absence is not confirmed.",
      fixable: false
    });
    return null;
  });
  const processes = await listServerProcesses();
  report.findings.push(...await windowsUserPathFindings());
  report.findings.push(...inspectPluginVersions(pluginDoctorPaths(home), processes ?? []));
  if (processes === null) report.findings.push({ severity: "warning", code: "plugin-process-unavailable", path: home, detail: "Running server process lookup unavailable; rerun agent-bridge doctor from the host account.", fixable: false });
  if (args.includes("--json")) out(JSON.stringify(report));
  else {
    if (report.brokerHealth) out(formatHealth(report.brokerHealth));
    for (const item of report.schema) out(`${item.path}: schema ${item.actual ?? "absent"}, code ${item.expected}`);
    for (const item of report.findings) out(`${item.severity.toUpperCase()} ${item.code}: ${item.path}: ${item.detail}${item.fixable ? " (--fix)" : ""}`);
    out(`Size: ${report.totalBytes} bytes across ${report.sizes.length} files. Recent backups: ${report.backups.length}.`);
    for (const item of report.sizes) out(`  ${item.bytes} bytes  ${item.path}`);
  }
  return report.ok ? 0 : 1;
}
export {
  runDoctor
};
