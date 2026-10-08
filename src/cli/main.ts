import { join } from "node:path";
import { BridgeClient } from "../core/client.js";
import { LOG_DIR_NAME } from "../core/constants.js";
import { formatDateTime, t } from "../core/i18n.js";
import { createLogger, nullLogger } from "../core/logger.js";
import { BridgeNode } from "../core/node.js";
import { resolveDbPath, resolveHome, resolvePipePath } from "../core/paths.js";
import { APP_VERSION, PROTOCOL_VERSION } from "../core/constants.js";
import { loadOrCreateToken } from "../core/token.js";
import { formatMessage, formatReplyRestrictions } from "../mcp/format.js";
import { CODING_AGENTS, type CodingAgent } from "../core/protocol.js";
import { parseInstallerArgs, runInstaller } from "./installer.js";
import { runPermissionHook } from "./permission-hook.js";
import { runAntigravityHook } from "./antigravity-hook.js";
import { runRewakeHook } from "./rewake-hook.js";
import { runSessionStartHook } from "./session-start-hook.js";
import { findRunLog, watchRunLog } from "./watch.js";
import { dashboardKey, findRunningDashboard, DashboardController } from "./dashboard.js";
import { DEFAULT_CONFIG, loadConfig } from "../core/config.js";
import { openBrowser } from "./open.js";
import { RELIABILITY_SECTIONS, runReliability } from "./reliability.js";
import { runSmoke } from "./smoke.js";
import { runCleanup } from "./cleanup.js";
import { runPermissionRepair } from "./permission-repair.js";
import { runJobClose } from "./job-close.js";
import { installOpencode, opencodeSourceDir, uninstallOpencode, type InstallResult } from "./opencode-install.js";
import { runJobRunner } from "../mcp/job-runner.js";
import { runReindex } from "./reindex.js";
import { archiveHistory } from "./history-archive.js";
import { runSlot } from "./slot.js";
import { runNetworkCommand } from "../network/cli.js";
import { runDoctor } from "./doctor.js";
import { brokerFailureState, formatHealth } from "../core/health.js";

const CLI_PEER_NAME = "cli";
const out = (s: string) => process.stdout.write(s + "\n");

function printResult(res: InstallResult): void {
  for (const f of res.files) out(`  ${f}`);
  for (const f of res.skipped) out(t("cli.install.skipped", { path: f }));
}

async function main(argv: string[]): Promise<number> {
  const [command = "help", ...rest] = argv;
  const home = resolveHome();
  // State inspection must not create logs or repair malformed configuration/stores.
  if (command === "job-state") return runJobClose(command, rest, home, DEFAULT_CONFIG, nullLogger, out);
  const pipe = resolvePipePath(home);
  const log = createLogger({ home, component: "cli" });
  const makeNode = () =>
    new BridgeNode({ pipePath: pipe, token: loadOrCreateToken(home), dbPath: resolveDbPath(home), agent: "other", name: CLI_PEER_NAME, cwd: process.cwd(), autoWake: false, log });

  switch (command) {
    case "antigravity-hook": return runAntigravityHook(rest[0] ?? "PreInvocation");
    case "job-state":
    case "job-close":
    case "close-idle-jobs":
      return runJobClose(command, rest, home, loadConfig(home, "other", log), log, out);
    case "repair-permissions":
      return runPermissionRepair(rest, home, log, out);
    case "doctor":
      return runDoctor(rest, home, out);
    case "reindex":
      if (rest.length) { out("Usage: agent-bridge reindex"); return 2; }
      return runReindex(home, pipe, log, out);
    case "history-archive":
      if (rest.length > 1) { out("Usage: agent-bridge history-archive [absolute-archive-root]"); return 2; }
      out(await archiveHistory(home, rest[0]));
      return 0;
    case "slot":
      return runSlot(rest, home, loadConfig(home, "other", log), out);
    case "connect":
    case "network":
    case "pair":
    case "link":
    case "unlink":
      return runNetworkCommand(command, rest, home, pipe, log, out);
    case "status": {
      let client: BridgeClient;
      try {
        client = await BridgeClient.connect(pipe, log);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ECONNREFUSED") { out(t("cli.status.noBroker", { pipe })); return 0; }
        out(`Broker connection could not be confirmed (${code ?? (err as Error).message}); it may be busy or unavailable.`);
        return 1;
      }
      try {
        const started = performance.now();
        const ping = await client.request("ping", {});
        if (ping.health) out(formatHealth({ ...ping.health, roundTripMs: performance.now() - started }));
        await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
        const peers = await client.request("peers", {});
        out(t("cli.status.broker", { pid: String(ping.brokerPid), protocol: String(ping.protocol), pipe }));
        out(t("cli.status.peers", { count: peers.length }));
        const isOld = (v: string | undefined) => !v || v !== APP_VERSION;
        for (const p of peers) {
          out(t("cli.status.peer", { name: p.name, agent: p.agent, activity: p.activity ?? "unknown", version: p.version ?? "?", outdated: isOld(p.version) ? t("cli.status.outdatedMark") : "", since: formatDateTime(p.startedAt), cwd: p.cwd }));
        }
        const old = peers.filter((p) => isOld(p.version)).length;
        if (peers.length) out(old ? t("cli.status.outdated", { count: old, version: APP_VERSION }) : t("cli.status.upToDate", { version: APP_VERSION }));
      } catch (error) {
        out(`${brokerFailureState(error) === "slow" ? "Bridge responding slowly" : "Bridge status unavailable"}: ${(error as Error).message}`);
        return 1;
      } finally {
        client.close();
      }
      return 0;
    }
    case "send": {
      const [to, ...words] = rest;
      if (!to || words.length === 0) {
        out(t("cli.usage"));
        return 2;
      }
      const node = makeNode();
      try {
        await node.start();
        const res = await node.send({ to, body: words.join(" ") });
        out(t("cli.sent", { id: res.messages[0]!.id }));
        for (const hint of formatReplyRestrictions(res)) out(hint);
      } finally {
        await node.stop();
      }
      return 0;
    }
    case "tail": {
      const node = makeNode();
      node.on("message", (m) => {
        out(formatMessage(m));
        node.markRead([m.id]);
      });
      await node.start();
      out(t("cli.tail.listening", { name: node.name }));
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
      await node.stop();
      return 0;
    }
    case "install":
    case "update":
    case "uninstall":
      return runInstaller({ action: command, tools: parseInstallerArgs(command, rest), yes: rest.includes("--yes") || rest.includes("-y"), out });
    case "ui": {
      const noOpen = rest.includes("--no-open");
      if (rest.includes("--reset-key")) dashboardKey(home, true);
      // Usually an agent session already hosts it: just open that one.
      const running = await findRunningDashboard(home);
      if (running) {
        out(t("cli.ui.existing", { url: running.url }));
        if (!noOpen) openBrowser(running.url);
        return 0;
      }
      const portArg = rest.find((a) => a.startsWith("--port="))?.slice("--port=".length);
      const port = portArg ? Number(portArg) : loadConfig(home, "other", log).dashboardPort;
      const controller = new DashboardController({ home, pipe, port, log });
      const info = await controller.ensure();
      out(t("cli.ui.running", { url: info.url }));
      if (!noOpen) openBrowser(info.url);
      if (!controller.isHosting) return 0;
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
      await controller.close();
      return 0;
    }
    case "watch": {
      const logPath = findRunLog(home, rest[0]);
      if (!logPath) {
        out(t("cli.watch.none"));
        return 1;
      }
      out(t("cli.watch.following", { path: logPath }));
      await watchRunLog(logPath, out);
      return 0;
    }
    case "rewake-hook":
      return runRewakeHook(rest.includes("--standby"));
    case "session-start-hook":
      return runSessionStartHook(log);
    case "permission-hook":
      return runPermissionHook(rest[0]);
    case "job-runner":
      // Internal: started by a session's MCP server for one background subagent (see mcp/job-host.ts).
      return runJobRunner(rest[0]);
    case "reliability": {
      // reliability [agents...] [--only=core|live] [--model=<agent>:<model> ...]
      const picked = rest.filter((a) => (CODING_AGENTS as readonly string[]).includes(a)) as CodingAgent[];
      const only = rest.find((a) => a.startsWith("--only="))?.slice("--only=".length);
      const sections = RELIABILITY_SECTIONS.filter((s) => !only || s === only);
      const models: Partial<Record<CodingAgent, string>> = {};
      for (const arg of rest.filter((a) => a.startsWith("--model="))) {
        const [agent, ...model] = arg.slice("--model=".length).split(":");
        if ((CODING_AGENTS as readonly string[]).includes(agent!) && model.length) models[agent as CodingAgent] = model.join(":");
      }
      if (!sections.length) {
        out(t("cli.usage"));
        return 2;
      }
      return runReliability({ agents: picked.length ? picked : [...CODING_AGENTS], out, log, sections, models });
    }
    case "smoke": {
      const picked = rest.filter((a) => (CODING_AGENTS as readonly string[]).includes(a)) as CodingAgent[];
      return runSmoke({ agents: picked.length ? picked : [...CODING_AGENTS], out, log });
    }
    case "install-opencode": {
      const source = opencodeSourceDir();
      if (!source) {
        out(t("cli.opencode.noSource"));
        return 1;
      }
      const res = installOpencode(source);
      out(t("cli.opencode.installed", { dir: res.configDir }));
      printResult(res);
      out(t("cli.opencode.restart"));
      return 0;
    }
    case "uninstall-opencode": {
      const res = uninstallOpencode();
      out(res.files.length ? t("cli.opencode.removed", { dir: res.configDir }) : t("cli.opencode.nothing", { dir: res.configDir }));
      printResult(res);
      return 0;
    }
    case "cleanup":
      return runCleanup(rest, { home, cwd: process.cwd(), log, out });
    case "paths":
      out(t("cli.paths", { home, logs: join(home, LOG_DIR_NAME), db: resolveDbPath(home), pipe }));
      return 0;
    case "help":
    case "--help":
    case "-h":
      out(t("cli.usage"));
      out("Network: connect [--yes] [--non-interactive --create | --address <host:port> --code <code>] | network | pair | link <host:port> <code> | unlink <instance-id>");
      out("Storage: doctor [--json] [--backup | --fix | --archive | --restore <backup>] [--yes]");
      return 0;
    default:
      out(t("cli.unknownCommand", { command }));
      out(t("cli.usage"));
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(t("cli.error", { detail: String((err as Error)?.message ?? err) }) + "\n");
    process.exit(1);
  },
);
