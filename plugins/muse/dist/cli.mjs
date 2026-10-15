#!/usr/bin/env node
import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  openBrowser
} from "./chunks/chunk-LWVK3CB7.mjs";
import {
  formatDateTime,
  t
} from "./chunks/chunk-CE5EGKJK.mjs";
import {
  BridgeNode
} from "./chunks/chunk-Y7UQ56VK.mjs";
import {
  formatMessage,
  formatReplyRestrictions
} from "./chunks/chunk-OVC2JA2V.mjs";
import "./chunks/chunk-GHL2YWJD.mjs";
import {
  brokerFailureState,
  formatHealth
} from "./chunks/chunk-G5UG7VX7.mjs";
import {
  BridgeClient
} from "./chunks/chunk-5CUVWCAS.mjs";
import "./chunks/chunk-RQUYBZWF.mjs";
import "./chunks/chunk-3QYUMWCP.mjs";
import "./chunks/chunk-JTZGNEMM.mjs";
import "./chunks/chunk-ORHVXX2T.mjs";
import {
  loadOrCreateToken,
  resolveDbPath,
  resolveHome,
  resolvePipePath
} from "./chunks/chunk-AFDAMMNA.mjs";
import {
  DEFAULT_CONFIG,
  loadConfig
} from "./chunks/chunk-VB42W5UW.mjs";
import {
  CODING_AGENTS
} from "./chunks/chunk-IYJ5P7ML.mjs";
import "./chunks/chunk-2JW43AZX.mjs";
import "./chunks/chunk-RE3I7AXX.mjs";
import "./chunks/chunk-HYOPFLLN.mjs";
import {
  createLogger,
  nullLogger
} from "./chunks/chunk-IS3KHBHN.mjs";
import "./chunks/chunk-AR4BZM3F.mjs";
import {
  APP_VERSION,
  LOG_DIR_NAME,
  PROTOCOL_VERSION
} from "./chunks/chunk-HIVVJXLN.mjs";
import "./chunks/chunk-VNQ4UNAO.mjs";
import "./chunks/chunk-DEWCC5JJ.mjs";
import "./chunks/chunk-6RNADTH4.mjs";

// src/cli/main.ts
import { join } from "node:path";
var CLI_PEER_NAME = "cli";
var out = (s) => process.stdout.write(s + "\n");
function printResult(res) {
  for (const f of res.files) out(`  ${f}`);
  for (const f of res.skipped) out(t("cli.install.skipped", { path: f }));
}
async function main(argv) {
  const [command = "help", ...rest] = argv;
  const home = resolveHome();
  if (command === "job-state") return (await import("./chunks/job-close-MAQ4BOII.mjs")).runJobClose(command, rest, home, DEFAULT_CONFIG, nullLogger, out);
  const pipe = resolvePipePath(home);
  const log = createLogger({ home, component: "cli" });
  const makeNode = () => new BridgeNode({ pipePath: pipe, token: loadOrCreateToken(home), dbPath: resolveDbPath(home), agent: "other", name: CLI_PEER_NAME, cwd: process.cwd(), autoWake: false, log });
  switch (command) {
    case "antigravity-hook":
      return (await import("./chunks/antigravity-hook-G46XSY74.mjs")).runAntigravityHook(rest[0] ?? "PreInvocation");
    case "job-state":
    case "job-close":
    case "close-idle-jobs":
      return (await import("./chunks/job-close-MAQ4BOII.mjs")).runJobClose(command, rest, home, loadConfig(home, "other", log), log, out);
    case "repair-permissions":
      return (await import("./chunks/permission-repair-YRDC33J2.mjs")).runPermissionRepair(rest, home, log, out);
    case "doctor":
      return (await import("./chunks/doctor-QCUBKQBD.mjs")).runDoctor(rest, home, out);
    case "db":
      return (await import("./chunks/db-U6DZI2WE.mjs")).runDb(rest, home, out);
    case "storage":
      return (await import("./chunks/storage-XOKMDD65.mjs")).runStorage(rest, home, out);
    case "reindex":
      if (rest.length) {
        out("Usage: agent-bridge reindex");
        return 2;
      }
      return (await import("./chunks/reindex-MKV2NG7J.mjs")).runReindex(home, pipe, log, out);
    case "history-archive":
      if (rest.length > 1) {
        out("Usage: agent-bridge history-archive [absolute-archive-root]");
        return 2;
      }
      out(await (await import("./chunks/history-archive-WHBBJONN.mjs")).archiveHistory(home, rest[0]));
      return 0;
    case "slot":
      return (await import("./chunks/slot-WDFGELBX.mjs")).runSlot(rest, home, loadConfig(home, "other", log), out);
    case "connect":
    case "network":
    case "pair":
    case "link":
    case "unlink":
      return (await import("./chunks/cli-2YEZLXGS.mjs")).runNetworkCommand(command, rest, home, pipe, log, out);
    case "status": {
      let client;
      try {
        client = await BridgeClient.connect(pipe, log);
      } catch (err) {
        const code = err.code;
        if (code === "ENOENT" || code === "ECONNREFUSED") {
          out(t("cli.status.noBroker", { pipe }));
          return 0;
        }
        out(`Broker connection could not be confirmed (${code ?? err.message}); it may be busy or unavailable.`);
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
        const isOld = (v) => !v || v !== APP_VERSION;
        for (const p of peers) {
          out(t("cli.status.peer", { name: p.name, agent: p.agent, activity: p.activity ?? "unknown", version: p.version ?? "?", outdated: isOld(p.version) ? t("cli.status.outdatedMark") : "", since: formatDateTime(p.startedAt), cwd: p.cwd }));
        }
        const old = peers.filter((p) => isOld(p.version)).length;
        if (peers.length) out(old ? t("cli.status.outdated", { count: old, version: APP_VERSION }) : t("cli.status.upToDate", { version: APP_VERSION }));
      } catch (error) {
        out(`${brokerFailureState(error) === "slow" ? "Bridge responding slowly" : "Bridge status unavailable"}: ${error.message}`);
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
        out(t("cli.sent", { id: res.messages[0].id }));
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
      await new Promise((resolve) => process.once("SIGINT", resolve));
      await node.stop();
      return 0;
    }
    case "install":
    case "update":
    case "uninstall":
      return (await import("./chunks/installer-T3I6FV67.mjs")).runInstaller({ action: command, tools: (await import("./chunks/installer-T3I6FV67.mjs")).parseInstallerArgs(command, rest), yes: rest.includes("--yes") || rest.includes("-y"), out });
    case "ui": {
      const noOpen = rest.includes("--no-open");
      const mobileConfig = loadConfig(home, "other", log).mobile;
      let mobileUnavailable;
      if (mobileConfig) {
        if (rest.includes("--reset-key")) (await import("./chunks/dashboard-4BQN2ZFG.mjs")).dashboardKey(home, true);
        const existing = await (await import("./chunks/dashboard-4BQN2ZFG.mjs")).findRunningDashboard(home);
        if (existing) {
          const info2 = (await import("./chunks/dashboard-4BQN2ZFG.mjs")).withMobileUnavailable(existing, "invalid" in mobileConfig ? "config_invalid" : "source_unavailable");
          out(t("cli.ui.existing", { url: info2.url }));
          if (!noOpen) openBrowser(info2.url);
          return 0;
        }
        const portArg2 = rest.find((a) => a.startsWith("--port="))?.slice("--port=".length), cfg = loadConfig(home, "other", log);
        const node = makeNode();
        let activation;
        try {
          await node.start();
          activation = await (await import("./chunks/activation-I6REDAOC.mjs")).configuredMobileDashboard(node, mobileConfig, { home, pipe, port: portArg2 ? Number(portArg2) : cfg.dashboardPort, log });
          const info2 = await activation?.start();
          if (info2 && activation?.status() === "ready") {
            out(t("cli.ui.running", { url: info2.url }));
            if (!noOpen) openBrowser(info2.url);
            await new Promise((resolve) => process.once("SIGINT", resolve));
            return 0;
          }
          mobileUnavailable = activation?.status() ?? "source_unavailable";
        } catch {
          mobileUnavailable = "restart_required";
        } finally {
          await activation?.close().catch(() => {
          });
          await node.stop().catch(() => {
          });
        }
      }
      if (rest.includes("--reset-key")) (await import("./chunks/dashboard-4BQN2ZFG.mjs")).dashboardKey(home, true);
      const found = await (await import("./chunks/dashboard-4BQN2ZFG.mjs")).findRunningDashboard(home);
      const running = found && mobileUnavailable ? (await import("./chunks/dashboard-4BQN2ZFG.mjs")).withMobileUnavailable(found, mobileUnavailable) : found;
      if (running) {
        out(t("cli.ui.existing", { url: running.url }));
        if (!noOpen) openBrowser(running.url);
        return 0;
      }
      const portArg = rest.find((a) => a.startsWith("--port="))?.slice("--port=".length);
      const port = portArg ? Number(portArg) : loadConfig(home, "other", log).dashboardPort;
      const controller = new (await import("./chunks/dashboard-4BQN2ZFG.mjs")).DashboardController({ home, pipe, port, log, ...mobileUnavailable ? { mobileStatus: () => mobileUnavailable } : {} });
      const hosted = await controller.ensure();
      const info = mobileUnavailable ? (await import("./chunks/dashboard-4BQN2ZFG.mjs")).withMobileUnavailable(hosted, mobileUnavailable) : hosted;
      out(t("cli.ui.running", { url: info.url }));
      if (!noOpen) openBrowser(info.url);
      if (!controller.isHosting) return 0;
      await new Promise((resolve) => process.once("SIGINT", resolve));
      await controller.close();
      return 0;
    }
    case "watch": {
      const logPath = (await import("./chunks/watch-RTVN46DY.mjs")).findRunLog(home, rest[0]);
      if (!logPath) {
        out(t("cli.watch.none"));
        return 1;
      }
      out(t("cli.watch.following", { path: logPath }));
      await (await import("./chunks/watch-RTVN46DY.mjs")).watchRunLog(logPath, out);
      return 0;
    }
    case "rewake-hook":
      return (await import("./chunks/rewake-hook-KZPFN6TD.mjs")).runRewakeHook(rest.includes("--standby"));
    case "muse-hook":
      return (await import("./chunks/muse-hook-3ENYRMWZ.mjs")).runMuseHook(rest[0] ?? "");
    case "session-start-hook":
      return (await import("./chunks/session-start-hook-A46OBLY5.mjs")).runSessionStartHook(log);
    case "permission-hook":
      return (await import("./chunks/permission-hook-IXJPYLLG.mjs")).runPermissionHook(rest[0]);
    case "job-runner":
      return (await import("./chunks/job-runner-6NAOT4G5.mjs")).runJobRunner(rest[0]);
    case "reliability": {
      const picked = rest.filter((a) => CODING_AGENTS.includes(a));
      const only = rest.find((a) => a.startsWith("--only="))?.slice("--only=".length);
      const sections = (await import("./chunks/reliability-7U2TIETC.mjs")).RELIABILITY_SECTIONS.filter((s) => !only || s === only);
      const models = {};
      for (const arg of rest.filter((a) => a.startsWith("--model="))) {
        const [agent, ...model] = arg.slice("--model=".length).split(":");
        if (CODING_AGENTS.includes(agent) && model.length) models[agent] = model.join(":");
      }
      if (!sections.length) {
        out(t("cli.usage"));
        return 2;
      }
      return (await import("./chunks/reliability-7U2TIETC.mjs")).runReliability({ agents: picked.length ? picked : [...CODING_AGENTS], out, log, sections, models });
    }
    case "smoke": {
      const picked = rest.filter((a) => CODING_AGENTS.includes(a));
      return (await import("./chunks/smoke-QHOWYRYK.mjs")).runSmoke({ agents: picked.length ? picked : [...CODING_AGENTS], out, log });
    }
    case "install-opencode": {
      const source = (await import("./chunks/opencode-install-X5XLNKWX.mjs")).opencodeSourceDir();
      if (!source) {
        out(t("cli.opencode.noSource"));
        return 1;
      }
      const res = (await import("./chunks/opencode-install-X5XLNKWX.mjs")).installOpencode(source);
      out(t("cli.opencode.installed", { dir: res.configDir }));
      printResult(res);
      out(t("cli.opencode.restart"));
      return 0;
    }
    case "uninstall-opencode": {
      const res = (await import("./chunks/opencode-install-X5XLNKWX.mjs")).uninstallOpencode();
      out(res.files.length ? t("cli.opencode.removed", { dir: res.configDir }) : t("cli.opencode.nothing", { dir: res.configDir }));
      printResult(res);
      return 0;
    }
    case "cleanup":
      return (await import("./chunks/cleanup-M724CSMJ.mjs")).runCleanup(rest, { home, cwd: process.cwd(), log, out });
    case "paths":
      out(t("cli.paths", { home, logs: join(home, LOG_DIR_NAME), db: resolveDbPath(home), pipe }));
      return 0;
    case "help":
    case "--help":
    case "-h":
      out(t("cli.usage"));
      out("Network: connect [--yes] [--non-interactive --create | --address <host:port> --code <code>] | network | pair | link <host:port> <code> | unlink <instance-id>");
      out("Storage: doctor --migration-plan [--json], or doctor [--json] [--backup | --fix | --archive | --restore <backup>] [--yes]");
      out('Database viewer: db tables | db query "<sql>" [--db history] | db export --decompressed <table> <file.sqlite>');
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
    process.stderr.write(t("cli.error", { detail: String(err?.message ?? err) }) + "\n");
    process.exit(1);
  }
);
