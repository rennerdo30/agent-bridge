import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  installOpencode,
  opencodeSourceDir,
  pluginSourceDir,
  uninstallOpencode
} from "./chunk-V4BYQSLK.mjs";
import {
  claudeMarketplace,
  syncMarketplace
} from "./chunk-3UEO4724.mjs";
import {
  t
} from "./chunk-BG6KJS4H.mjs";
import {
  BridgeClient
} from "./chunk-TEWRMKDT.mjs";
import {
  antigravityHookCommand,
  antigravityPluginDir,
  antigravityRuntimeHome,
  resolveBinary,
  unwrapNpmShim
} from "./chunk-7Y7S3XVI.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-CKNSPGQW.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveHome,
  resolvePipePath
} from "./chunk-BVYKWEQF.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-M26SH6VN.mjs";
import {
  loadOrCreateToken
} from "./chunk-V4WDBMEN.mjs";
import "./chunk-AGEMLUYH.mjs";
import "./chunk-KLFFS5AY.mjs";
import "./chunk-2GQW7PXU.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-ZNBE7QJQ.mjs";
import "./chunk-EUVUYVJQ.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-3HR6VMN7.mjs";
import "./chunk-I6MYXRDE.mjs";
import "./chunk-WM3QOXKL.mjs";
import {
  archiveFile,
  nullLogger
} from "./chunk-UNRS7LDN.mjs";
import {
  assertUnlinked,
  atomicPluginWrite,
  liveRuntimeSessions,
  pluginFiles,
  publishPlugin,
  releaseVersion,
  selectRuntime,
  validatePluginPublication
} from "./chunk-VBHAVRFY.mjs";
import {
  APP_VERSION,
  PROTOCOL_VERSION
} from "./chunk-DLCSA3SJ.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/cli/installer.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

// src/cli/codex-users.ts
import { execFile } from "node:child_process";
var LOOKUP_TIMEOUT_MS = 1e4;
function classifyCodexProcesses(procs) {
  const byPid = new Map(procs.map((p) => [p.ProcessId, p]));
  const codex = procs.filter((p) => /^codex(\.exe)?$/i.test(p.Name) && !/exec-server|code-mode-host/i.test(p.CommandLine ?? ""));
  const codexPids = new Set(codex.map((p) => p.ProcessId));
  return codex.filter((p) => !codexPids.has(p.ParentProcessId)).map((p) => {
    const parent = byPid.get(p.ParentProcessId);
    const started = p.CreationDate ? new Date(p.CreationDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?";
    const bridge = /agent-bridge[\\/].*server\.mjs\s+--agent=(\w+)/i.exec(parent?.CommandLine ?? "");
    if (bridge) return { pid: p.ProcessId, kind: "subagent", startedBy: bridge[1], started };
    if (/agent-bridge[\\/].*cli\.mjs"?\s+job-runner\b/i.test(parent?.CommandLine ?? "")) return { pid: p.ProcessId, kind: "subagent", startedBy: "agent-bridge", started };
    if (/^(ChatGPT|Codex)(\.exe)?$/i.test(parent?.Name ?? "")) return { pid: p.ProcessId, kind: "app", started };
    return { pid: p.ProcessId, kind: "session", started };
  });
}
function listCodexUsers() {
  if (process.platform !== "win32") return Promise.resolve([]);
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='CreationDate';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress";
  return new Promise((resolve2) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve2([]);
      try {
        const data = JSON.parse(stdout);
        resolve2(classifyCodexProcesses(Array.isArray(data) ? data : [data]));
      } catch {
        resolve2([]);
      }
    });
  });
}
function describeCodexUser(u) {
  if (u.kind === "app") return `the Codex app (pid ${u.pid}, since ${u.started}): update once it is idle`;
  if (u.kind === "subagent") return `a Codex subagent of ${u.startedBy === "agent-bridge" ? "an agent-bridge" : `a ${u.startedBy}`} session (pid ${u.pid}, since ${u.started}): wait until it finishes, or cancel it with cancel_subagent`;
  return `a Codex session (pid ${u.pid}, since ${u.started}): update once it is idle`;
}

// src/cli/antigravity-install.ts
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, parse, sep } from "node:path";
import { homedir } from "node:os";
var MARKER = ".agent-bridge-owned";
function unlinked(path) {
  let current = resolve(path);
  for (; ; ) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Plugin links are not supported: ${current}`);
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
}
var antigravitySourceDir = (from) => pluginSourceDir("antigravity", "plugin.json", from);
function metadata(path) {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid native metadata; preserved unchanged: ${path}`);
  return value;
}
var record = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
function grantAntigravityBridgeMcp(settings = join(homedir(), ".gemini", "antigravity-cli", "settings.json")) {
  unlinked(settings);
  unlinked(join(dirname(settings), "archive"));
  const config = existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid native Antigravity settings; preserved unchanged");
  const permissions = config.permissions ?? {};
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions) || permissions.allow !== void 0 && !Array.isArray(permissions.allow)) throw new Error("Invalid native Antigravity permissions; preserved unchanged");
  const rule = "mcp(agent-bridge_agent-bridge/*)";
  if (permissions.allow?.includes(rule)) return;
  config.permissions = { ...permissions, allow: [...permissions.allow ?? [], rule] };
  atomicPluginWrite(settings, JSON.stringify(config, null, 2) + "\n");
}
function installAntigravity(source, target = antigravityPluginDir()) {
  source = resolve(source);
  target = resolve(target);
  unlinked(source);
  unlinked(target);
  const contains = (parent, child) => {
    const path = relative(parent, child);
    return !path || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  if (contains(source, target) || contains(target, source)) throw new Error("Plugin source and installation must be separate directories");
  const runtimeHome = antigravityRuntimeHome(target);
  if (contains(source, runtimeHome) || contains(runtimeHome, source)) throw new Error("Plugin source and runtime must be separate directories");
  unlinked(runtimeHome);
  unlinked(join(target, MARKER));
  if (existsSync(target) && (!existsSync(join(target, MARKER)) || readFileSync(join(target, MARKER), "utf8").trim() !== "agent-bridge")) throw new Error(`Refusing to replace an unowned Antigravity plugin: ${target}`);
  if (JSON.parse(readFileSync(join(source, "plugin.json"), "utf8")).name !== "agent-bridge") throw new Error("Invalid Antigravity plugin source");
  const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
  releaseVersion(version);
  for (const file of ["server.mjs", "worker.mjs", "cli.mjs", "history-worker.mjs"]) {
    if (!existsSync(join(source, "dist", file))) throw new Error(`Missing Antigravity runtime: ${file}`);
  }
  const result = { configDir: target, files: [], skipped: [] };
  const files = pluginFiles(source).filter((file) => !file.replaceAll("\\", "/").startsWith("dist/") && !["hooks.json", "mcp_config.json"].includes(file));
  for (const file of files) unlinked(join(target, file));
  for (const name of ["mcp_config.json", "hooks.json", "archive"]) unlinked(join(target, name));
  const previousConfig = metadata(join(target, "mcp_config.json")), previousHooks = metadata(join(target, "hooks.json"));
  if (previousConfig.mcpServers !== void 0 && !record(previousConfig.mcpServers) || previousHooks["agent-bridge"] !== void 0 && !record(previousHooks["agent-bridge"])) throw new Error("Invalid native plugin settings; preserved unchanged");
  const previousServer = previousConfig.mcpServers?.["agent-bridge"] ?? {};
  if (!record(previousServer) || previousServer.env !== void 0 && !record(previousServer.env)) throw new Error("Invalid native MCP settings; preserved unchanged");
  const runtime = selectRuntime(runtimeHome, "antigravity", source, version);
  result.files.push(runtime);
  const write = (file, text) => {
    const path = join(target, file);
    atomicPluginWrite(path, text);
    result.files.push(path);
  };
  for (const file of files) write(file, readFileSync(join(source, file)));
  write(MARKER, "agent-bridge\n");
  const config = { ...previousConfig, mcpServers: { ...previousConfig.mcpServers, "agent-bridge": { ...previousServer, command: process.execPath, args: [join(runtime, "dist", "server.mjs"), "--agent=antigravity"], env: { ...previousServer.env, AGENT_BRIDGE_PLUGIN_RUNTIME_HOME: runtimeHome } } } };
  const command = (event) => antigravityHookCommand(join(runtime, "dist", "cli.mjs"), event);
  write("hooks.json", JSON.stringify({ ...previousHooks, "agent-bridge": {
    ...previousHooks["agent-bridge"],
    PreInvocation: [{ type: "command", command: command("PreInvocation"), timeout: 30 }],
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: command("PreToolUse"), timeout: 600 }] }],
    Stop: [{ type: "command", command: command("Stop"), timeout: 30 }]
  } }, null, 2) + "\n");
  write("mcp_config.json", JSON.stringify(config, null, 2) + "\n");
  if (target === antigravityPluginDir()) grantAntigravityBridgeMcp();
  return result;
}
function uninstallAntigravity(target = antigravityPluginDir()) {
  unlinked(target);
  unlinked(join(target, MARKER));
  unlinked(join(dirname(target), "archive"));
  const result = { configDir: target, files: [], skipped: [] };
  if (!existsSync(target)) return result;
  if (lstatSync(target).isSymbolicLink() || !existsSync(join(target, MARKER)) || readFileSync(join(target, MARKER), "utf8").trim() !== "agent-bridge") result.skipped.push(target);
  else {
    archiveFile(target);
    result.files.push(target);
  }
  return result;
}

// src/cli/live-update.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
function compareReleases(a, b) {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = left[i] - right[i];
    if (difference) return difference;
  }
  return 0;
}
function updateCodex(source, home = process.env.CODEX_HOME || join2(homedir2(), ".codex"), version = APP_VERSION) {
  const base = join2(home, "plugins", "cache", "agent-bridge", "agent-bridge");
  assertUnlinked(base);
  for (const entry of existsSync2(base) ? readdirSync(base, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "local" || !/^\d+\.\d+\.\d+$/.test(entry.name)) throw new Error(`Codex cache uses an unsupported version selector (${entry.name}); preserved unchanged.`);
    if (compareReleases(entry.name, version) > 0) throw new Error(`Codex already has a newer version (${entry.name}); preserved unchanged.`);
  }
  const configPath = join2(home, "config.toml");
  assertUnlinked(configPath);
  const config = existsSync2(configPath) ? readFileSync2(configPath, "utf8") : "";
  const marketplace = join2(home, "agent-bridge-marketplace");
  const nextConfig = codexLiveConfig(config, marketplace);
  validatePluginPublication(source, base, version);
  validatePluginPublication(source, join2(marketplace, "plugins"), version);
  for (const clone of [join2(home, "plugins", "marketplaces", "agent-bridge"), join2(home, "marketplaces", "agent-bridge")]) {
    if (existsSync2(clone)) syncMarketplace(clone, "codex", version);
  }
  const root = publishPlugin(source, base, version);
  publishPlugin(source, join2(marketplace, "plugins"), version);
  atomicPluginWrite(join2(marketplace, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "agent-bridge",
    plugins: [{
      name: "agent-bridge",
      source: { source: "local", path: `./plugins/${version}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools"
    }]
  }, null, 2) + "\n");
  atomicPluginWrite(configPath, nextConfig);
  return root;
}
function tomlTableEnd(text) {
  let depth = 0, multi = null, offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    if (!multi && depth === 0 && /^\s*\[/.test(line)) return offset;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (multi) {
        if (c === "\\" && multi === '"""') {
          i++;
          continue;
        }
        if (line.startsWith(multi, i)) {
          multi = null;
          i += 2;
        }
        continue;
      }
      if (c === "#") break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        multi = line.slice(i, i + 3);
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        for (i++; i < line.length && line[i] !== c; i++) if (c === '"' && line[i] === "\\") i++;
        continue;
      }
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
    }
    offset += line.length;
  }
  if (depth || multi) throw new Error("The agent-bridge marketplace table has an unterminated array or string; preserved unchanged");
  return text.length;
}
function codexLiveConfig(config, marketplace) {
  const header = /^\s*\[marketplaces\.(?:agent-bridge|"agent-bridge"|'agent-bridge')\]\s*(?:#.*)?$/gm;
  const matches = [...config.matchAll(header)];
  if (matches.length > 1) throw new Error("Duplicate agent-bridge marketplace tables; preserved unchanged");
  const fields = `source_type = "local"
source = ${JSON.stringify(marketplace.replaceAll("\\", "/"))}
`;
  if (matches.length) {
    const match = matches[0], start = match.index + match[0].length;
    const tail = config.slice(start), end = tomlTableEnd(tail);
    const body = tail.slice(0, end).replace(/^\s*(?:source_type|source)\s*=.*(?:\r?\n|$)/gm, "");
    config = config.slice(0, start) + "\n" + fields + body + tail.slice(end);
  } else config += `
[marketplaces.agent-bridge]
${fields}`;
  if (!/^\s*\[plugins\.(?:"agent-bridge@agent-bridge"|'agent-bridge@agent-bridge')\]/m.test(config)) config += '\n[plugins."agent-bridge@agent-bridge"]\nenabled = true\n';
  return config;
}
function updateClaude(source, home = process.env.CLAUDE_CONFIG_DIR || join2(homedir2(), ".claude"), version = APP_VERSION) {
  const metadata2 = join2(home, "plugins", "installed_plugins.json");
  assertUnlinked(metadata2);
  const installed = JSON.parse(readFileSync2(metadata2, "utf8"));
  const entries = installed?.plugins?.["agent-bridge@agent-bridge"];
  if (installed.version !== 2 || !Array.isArray(entries) || entries.length === 0 || entries.some((e) => !e || typeof e.installPath !== "string" || typeof e.scope !== "string")) throw new Error("Unsupported or missing installed plugin metadata; preserved unchanged. Install the plugin first.");
  if (entries.some((entry) => typeof entry.version === "string" && /^\d+\.\d+\.\d+$/.test(entry.version) && compareReleases(entry.version, version) > 0)) throw new Error("Claude already has a newer version; preserved unchanged");
  validatePluginPublication(source, join2(home, "plugins", "cache", "agent-bridge", "agent-bridge"), version);
  syncMarketplace(claudeMarketplace(home), "claude", version);
  const root = publishPlugin(source, join2(home, "plugins", "cache", "agent-bridge", "agent-bridge"), version);
  installed.plugins["agent-bridge@agent-bridge"] = entries.map((entry) => {
    const next = { ...entry, installPath: root, version, lastUpdated: (/* @__PURE__ */ new Date()).toISOString() };
    delete next.gitCommitSha;
    return next;
  });
  atomicPluginWrite(metadata2, JSON.stringify(installed, null, 2) + "\n");
  return root;
}
function activatePluginRuntime(source, client, bridgeHome, version = APP_VERSION) {
  return selectRuntime(bridgeHome, client, source, version);
}
function reportPluginSessions(home, client, version, out) {
  const sessions = liveRuntimeSessions(home, client);
  out(`  New MCP server starts select v${version}; existing sessions keep working. No sessions were stopped or switched mid-session.`);
  for (const s of sessions) out(`    pid ${s.pid}: v${s.version}${s.version === version ? " (current)" : " (retained old code)"}, started ${s.startedAt}`);
  out(`  ${sessions.filter((s) => s.version === version).length} recorded live launch(es) on the selected version; ${sessions.filter((s) => s.version !== version).length} on retained versions. Legacy launches are not recorded.`);
}
async function reportConnectedVersions(home, clients, version, out) {
  let client = null;
  try {
    client = await BridgeClient.connect(resolvePipePath(home, process.env), nullLogger);
    await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
    const peers = (await client.request("peers", {})).filter((peer) => clients.includes(peer.agent));
    for (const peer of peers) out(`  ${peer.name}: v${peer.version ?? "unknown"}${peer.version === version ? " (current)" : " (retained old code)"}`);
    out(`  Connected sessions: ${peers.filter((peer) => peer.version === version).length} current, ${peers.filter((peer) => peer.version !== version).length} older or unknown. Switched mid-session: 0.`);
  } catch {
    out("  Connected-session version report unavailable; no sessions were restarted. Use agent-bridge status later.");
  } finally {
    client?.close();
  }
}

// src/cli/installer.ts
var MARKETPLACE_REPO = "rennerdo30/agent-bridge";
var MARKETPLACE_NAME = "agent-bridge";
var PLUGIN_ID = `agent-bridge@${MARKETPLACE_NAME}`;
var TOOLS = ["claude", "codex", "opencode", "antigravity"];
function planFor(tool, action) {
  if (tool === "antigravity") return [{ kind: "antigravity", action }];
  if (tool === "claude") {
    switch (action) {
      case "install":
        return [
          // Adding an existing marketplace fails harmlessly; the update afterwards refreshes it.
          { kind: "command", bin: "claude", args: ["plugin", "marketplace", "add", MARKETPLACE_REPO], allowFailure: true },
          { kind: "command", bin: "claude", args: ["plugin", "marketplace", "update", MARKETPLACE_NAME] },
          { kind: "command", bin: "claude", args: ["plugin", "install", PLUGIN_ID] },
          { kind: "live-update", tool }
        ];
      case "update":
        return [{ kind: "live-update", tool }];
      case "uninstall":
        return [{ kind: "command", bin: "claude", args: ["plugin", "uninstall", PLUGIN_ID] }];
    }
  }
  if (tool === "codex") {
    switch (action) {
      case "install":
        return [
          { kind: "command", bin: "codex", args: ["plugin", "marketplace", "add", MARKETPLACE_REPO], allowFailure: true },
          { kind: "command", bin: "codex", args: ["plugin", "marketplace", "upgrade", MARKETPLACE_NAME] },
          { kind: "command", bin: "codex", args: ["plugin", "add", PLUGIN_ID] },
          { kind: "live-update", tool }
        ];
      case "update":
        return [{ kind: "live-update", tool }];
      case "uninstall":
        return [{ kind: "command", bin: "codex", args: ["plugin", "remove", PLUGIN_ID] }];
    }
  }
  return [{ kind: "opencode", action }];
}
function describeStep(step) {
  if (step.kind === "command") return `${step.bin} ${step.args.join(" ")}`;
  if (step.kind === "antigravity") return `${step.action} immutable Antigravity plugin (keep all old versions)`;
  if (step.kind === "live-update") return `publish immutable ${step.tool} plugin version (keep all old versions)`;
  return step.action === "uninstall" ? t("installer.opencodeRemove") : t("installer.opencodeCopy");
}
function runInherited(bin, args) {
  const resolved = resolveBinary(bin);
  if (!resolved) return Promise.resolve(127);
  const shim = /\.(cmd|bat)$/i.test(resolved) ? unwrapNpmShim(resolved) : null;
  const command = shim?.command ?? resolved;
  const fullArgs = [...shim?.prefix ?? [], ...args];
  return new Promise((resolve2) => {
    const child = spawn(command, fullArgs, { stdio: "inherit", shell: false });
    child.on("error", () => resolve2(1));
    child.on("close", (code) => resolve2(code ?? 1));
  });
}
function ask(rl, question) {
  return new Promise((resolve2) => {
    const onClose = () => resolve2("");
    rl.once("close", onClose);
    rl.question(question).then(
      (a) => {
        rl.off("close", onClose);
        resolve2(a);
      },
      () => resolve2("")
    );
  });
}
async function runInstaller(opts) {
  const rl = opts.yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  let failures = 0;
  try {
    for (const tool of opts.tools) {
      const bin = tool === "antigravity" ? "agy" : tool;
      if (!resolveBinary(bin)) {
        opts.out(t("installer.notFound", { tool }));
        continue;
      }
      const steps = planFor(tool, opts.action);
      opts.out(t("installer.plan", { tool }));
      for (const s of steps) opts.out(`  ${describeStep(s)}`);
      if (tool === "codex" && opts.action !== "update") {
        opts.out(t("installer.codexNote"));
        const users = await listCodexUsers();
        if (users.length) {
          opts.out(t("installer.codexInUse"));
          for (const u of users) opts.out(`    - ${describeCodexUser(u)}`);
          if (process.platform === "win32") {
            opts.out(t("installer.codexSkippedInUse"));
            continue;
          }
        }
      }
      if (rl) {
        const answer = (await ask(rl, t("installer.confirm", { tool }))).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          opts.out(t("installer.skipped", { tool }));
          continue;
        }
      }
      for (const step of steps) {
        if (step.kind === "antigravity") {
          try {
            const source = antigravitySourceDir();
            if (step.action !== "uninstall" && !source) throw new Error("Missing Antigravity plugin build");
            const res = step.action === "uninstall" ? uninstallAntigravity() : installAntigravity(source);
            for (const file of res.files) opts.out(`  ${file}`);
            if (step.action !== "uninstall") reportPluginSessions(resolveHome(), "antigravity", APP_VERSION, opts.out);
          } catch (error) {
            opts.out(`  Native plugin change failed: ${String(error)}`);
            failures++;
          }
          continue;
        }
        if (step.kind === "live-update") {
          try {
            const source = pluginSourceDir(step.tool, `${step.tool === "codex" ? ".codex-plugin" : ".claude-plugin"}/plugin.json`);
            if (!source) throw new Error("Missing packaged plugin source");
            const root = step.tool === "codex" ? updateCodex(source) : updateClaude(source);
            activatePluginRuntime(source, step.tool, resolveHome());
            opts.out(`  + ${root}`);
            reportPluginSessions(resolveHome(), step.tool, APP_VERSION, opts.out);
          } catch (error) {
            opts.out(`  Update failed: ${String(error)}`);
            failures++;
          }
          continue;
        }
        if (step.kind === "opencode") {
          const source = opencodeSourceDir();
          if (step.action === "uninstall") {
            const res = uninstallOpencode();
            for (const f of res.files) opts.out(`  - ${f}`);
          } else if (!source) {
            opts.out(t("cli.opencode.noSource"));
            failures++;
          } else {
            const res = installOpencode(source);
            for (const f of res.files) opts.out(`  + ${f}`);
            for (const f of res.skipped) opts.out(t("cli.install.skipped", { path: f }));
            reportPluginSessions(resolveHome(), tool, APP_VERSION, opts.out);
          }
          continue;
        }
        opts.out(`> ${describeStep(step)}`);
        const code = await runInherited(step.bin, step.args);
        if (code !== 0 && !step.allowFailure) {
          opts.out(t("installer.stepFailed", { code }));
          if (tool === "codex") {
            const users = await listCodexUsers();
            if (users.length) {
              opts.out(t("installer.codexBlocked"));
              for (const u of users) opts.out(`    - ${describeCodexUser(u)}`);
            }
          }
          failures++;
          break;
        }
      }
    }
  } finally {
    rl?.close();
  }
  if (opts.action === "update") await reportConnectedVersions(resolveHome(), opts.tools, APP_VERSION, opts.out);
  opts.out(failures ? t("installer.doneWithErrors", { count: failures }) : t("installer.done"));
  return failures ? 1 : 0;
}
function parseInstallerArgs(action, rest) {
  const picked = rest.filter((a) => TOOLS.includes(a));
  return picked.length ? picked : [...TOOLS];
}
export {
  MARKETPLACE_NAME,
  MARKETPLACE_REPO,
  PLUGIN_ID,
  TOOLS,
  describeStep,
  parseInstallerArgs,
  planFor,
  runInstaller
};
