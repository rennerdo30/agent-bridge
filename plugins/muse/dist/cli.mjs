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
} from "./chunks/chunk-I3KYQMXK.mjs";
import {
  formatMessage,
  formatReplyRestrictions
} from "./chunks/chunk-OVC2JA2V.mjs";
import "./chunks/chunk-6GB5V3SB.mjs";
import {
  brokerFailureState,
  formatHealth
} from "./chunks/chunk-OTY7MWGM.mjs";
import {
  BridgeClient
} from "./chunks/chunk-7JCJMPVW.mjs";
import "./chunks/chunk-RQUYBZWF.mjs";
import "./chunks/chunk-26TSVBIO.mjs";
import "./chunks/chunk-JTZGNEMM.mjs";
import "./chunks/chunk-ORHVXX2T.mjs";
import {
  loadOrCreateToken,
  tokenPath
} from "./chunks/chunk-DNAUDSOJ.mjs";
import {
  bundleDirectory
} from "./chunks/chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath,
  resolveHome,
  resolvePipePath
} from "./chunks/chunk-ZT3W4XMU.mjs";
import {
  DEFAULT_CONFIG,
  loadConfig
} from "./chunks/chunk-GUU5SJ6T.mjs";
import "./chunks/chunk-BOKHWZQ3.mjs";
import "./chunks/chunk-RE3I7AXX.mjs";
import {
  CODING_AGENTS
} from "./chunks/chunk-IYJ5P7ML.mjs";
import "./chunks/chunk-HYOPFLLN.mjs";
import {
  createLogger,
  nullLogger
} from "./chunks/chunk-JJ6UMMYX.mjs";
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
import { readFileSync } from "node:fs";
var CLI_PEER_NAME = "cli";
var out = (s) => process.stdout.write(s + "\n");
function printResult(res) {
  for (const f of res.files) out(`  ${f}`);
  for (const f of res.skipped) out(t("cli.install.skipped", { path: f }));
}
async function main(argv) {
  const [command = "help", ...rest] = argv;
  const home = resolveHome();
  if (command === "job-state") return (await import("./chunks/job-close-JPLV4TMC.mjs")).runJobClose(command, rest, home, DEFAULT_CONFIG, nullLogger, out);
  const pipe = resolvePipePath(home);
  const log = command === "core" ? nullLogger : createLogger({ home, component: "cli" });
  const brokerDaemon = () => loadConfig(home, "other", log).daemon.enabled ? {
    cli: join(bundleDirectory(import.meta.url), "cli.mjs"),
    dashboard: () => loadConfig(home, "other", log).dashboard,
    config: () => {
      const cfg = loadConfig(home, "other", log);
      const port = rest.find((arg) => arg.startsWith("--port="))?.slice(7);
      return { network: cfg.network, mobile: cfg.mobile, dashboardPort: port ? Number(port) : cfg.dashboardPort };
    }
  } : void 0;
  const makeNode = () => new BridgeNode({ pipePath: pipe, token: loadOrCreateToken(home), dbPath: resolveDbPath(home), daemon: brokerDaemon(), agent: "other", name: CLI_PEER_NAME, cwd: process.cwd(), autoWake: false, log });
  switch (command) {
    case "core": {
      if (rest.length !== 1 || rest[0] !== "status") throw new Error("Usage: agent-bridge core status. Safe restart/stop awaits the lifecycle prerequisite review.");
      let client;
      try {
        client = await BridgeClient.connect(pipe, log, void 0, { readOnlyDirectory: true });
      } catch (error) {
        if (["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")) {
          out(JSON.stringify({ available: false }));
          return 0;
        }
        throw error;
      }
      try {
        let token;
        try {
          token = readFileSync(tokenPath(home), "utf8").trim();
          if (!token) throw new Error();
        } catch {
          throw new Error("Core status authentication material is unavailable; no material was created.");
        }
        await client.request("auth", { protocol: PROTOCOL_VERSION, token });
        out(JSON.stringify(await client.request("coreStatus", {})));
      } finally {
        client.close();
      }
      return 0;
    }
    case "broker-daemon":
      if (rest.length) throw new Error("broker-daemon accepts no arguments");
      return (await import("./chunks/broker-daemon-4RWNEOMC.mjs")).runBrokerDaemon(home, pipe, log);
    case "antigravity-hook":
      return (await import("./chunks/antigravity-hook-77IDLLB3.mjs")).runAntigravityHook(rest[0] ?? "PreInvocation");
    case "job-state":
    case "job-close":
    case "close-idle-jobs":
      return (await import("./chunks/job-close-JPLV4TMC.mjs")).runJobClose(command, rest, home, loadConfig(home, "other", log), log, out);
    case "repair-permissions":
      return (await import("./chunks/permission-repair-5O4ZXFPG.mjs")).runPermissionRepair(rest, home, log, out);
    case "doctor":
      return (await import("./chunks/doctor-C5YUDMO2.mjs")).runDoctor(rest, home, out);
    case "db":
      return (await import("./chunks/db-V4CJBWRB.mjs")).runDb(rest, home, out);
    case "storage":
      return (await import("./chunks/storage-X5F6XW7X.mjs")).runStorage(rest, home, out);
    case "reindex":
      if (rest.length) {
        out("Usage: agent-bridge reindex");
        return 2;
      }
      return (await import("./chunks/reindex-SCIDKRE7.mjs")).runReindex(home, pipe, log, out);
    case "history-archive":
      if (rest.length > 1) {
        out("Usage: agent-bridge history-archive [absolute-archive-root]");
        return 2;
      }
      out(await (await import("./chunks/history-archive-WHBBJONN.mjs")).archiveHistory(home, rest[0]));
      return 0;
    case "slot":
      return (await import("./chunks/slot-5TMERXK7.mjs")).runSlot(rest, home, loadConfig(home, "other", log), out);
    case "connect":
    case "network":
    case "pair":
    case "link":
    case "unlink":
      return (await import("./chunks/cli-PTM6DW4C.mjs")).runNetworkCommand(command, rest, home, pipe, log, out);
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
      return (await import("./chunks/installer-D7IMPLYF.mjs")).runInstaller({ action: command, tools: (await import("./chunks/installer-D7IMPLYF.mjs")).parseInstallerArgs(command, rest), yes: rest.includes("--yes") || rest.includes("-y"), out });
    case "ui": {
      const noOpen = rest.includes("--no-open");
      const mobileConfig = loadConfig(home, "other", log).mobile;
      let mobileUnavailable;
      if (mobileConfig) {
        if (rest.includes("--reset-key")) (await import("./chunks/dashboard-7OT6CMJI.mjs")).dashboardKey(home, true);
        const existing = await (await import("./chunks/dashboard-7OT6CMJI.mjs")).findRunningDashboard(home);
        if (existing) {
          const info2 = (await import("./chunks/dashboard-7OT6CMJI.mjs")).withMobileUnavailable(existing, "invalid" in mobileConfig ? "config_invalid" : "source_unavailable");
          out(t("cli.ui.existing", { url: info2.url }));
          if (!noOpen) openBrowser(info2.url);
          return 0;
        }
        const portArg2 = rest.find((a) => a.startsWith("--port="))?.slice("--port=".length), cfg = loadConfig(home, "other", log);
        const node = makeNode();
        let activation;
        try {
          await node.start();
          if (node.usesDaemon && !node.isBroker) {
            const info2 = await node.ensureDashboard(true, portArg2 ? Number(portArg2) : cfg.dashboardPort);
            if (info2) {
              out(t("cli.ui.existing", { url: info2.url }));
              if (!noOpen) openBrowser(info2.url);
              return 0;
            }
            mobileUnavailable = "source_unavailable";
          } else {
            activation = await (await import("./chunks/activation-LTJTPBDR.mjs")).configuredMobileDashboard(node, mobileConfig, { home, pipe, port: portArg2 ? Number(portArg2) : cfg.dashboardPort, log });
            const info2 = await activation?.start();
            if (info2 && activation?.status() === "ready") {
              out(t("cli.ui.running", { url: info2.url }));
              if (!noOpen) openBrowser(info2.url);
              await new Promise((resolve) => process.once("SIGINT", resolve));
              return 0;
            }
            mobileUnavailable = activation?.status() ?? "source_unavailable";
          }
        } catch (error) {
          if (!node.isConnected) throw error;
          mobileUnavailable = "restart_required";
        } finally {
          await activation?.close().catch(() => {
          });
          await node.stop().catch(() => {
          });
        }
      }
      if (rest.includes("--reset-key")) (await import("./chunks/dashboard-7OT6CMJI.mjs")).dashboardKey(home, true);
      const found = await (await import("./chunks/dashboard-7OT6CMJI.mjs")).findRunningDashboard(home);
      const running = found && mobileUnavailable ? (await import("./chunks/dashboard-7OT6CMJI.mjs")).withMobileUnavailable(found, mobileUnavailable) : found;
      if (running) {
        out(t("cli.ui.existing", { url: running.url }));
        if (!noOpen) openBrowser(running.url);
        return 0;
      }
      const portArg = rest.find((a) => a.startsWith("--port="))?.slice("--port=".length);
      const port = portArg ? Number(portArg) : loadConfig(home, "other", log).dashboardPort;
      const controller = new (await import("./chunks/dashboard-7OT6CMJI.mjs")).DashboardController({ home, pipe, port, log, brokerDaemon: brokerDaemon(), ...mobileUnavailable ? { mobileStatus: () => mobileUnavailable } : {} });
      const hosted = await controller.ensure();
      const info = mobileUnavailable ? (await import("./chunks/dashboard-7OT6CMJI.mjs")).withMobileUnavailable(hosted, mobileUnavailable) : hosted;
      out(t("cli.ui.running", { url: info.url }));
      if (!noOpen) openBrowser(info.url);
      if (!controller.isHosting) return 0;
      await new Promise((resolve) => process.once("SIGINT", resolve));
      await controller.close();
      return 0;
    }
    case "watch": {
      const logPath = (await import("./chunks/watch-NSOMVMGA.mjs")).findRunLog(home, rest[0]);
      if (!logPath) {
        out(t("cli.watch.none"));
        return 1;
      }
      out(t("cli.watch.following", { path: logPath }));
      await (await import("./chunks/watch-NSOMVMGA.mjs")).watchRunLog(logPath, out);
      return 0;
    }
    case "rewake-hook":
      return (await import("./chunks/rewake-hook-JJW5WWO3.mjs")).runRewakeHook(rest.includes("--standby"));
    case "muse-hook":
      return (await import("./chunks/muse-hook-2I4HW634.mjs")).runMuseHook(rest[0] ?? "");
    case "session-start-hook":
      return (await import("./chunks/session-start-hook-TNN2CEIW.mjs")).runSessionStartHook(log);
    case "permission-hook":
      return (await import("./chunks/permission-hook-EWL5DED7.mjs")).runPermissionHook(rest[0]);
    case "job-runner":
      return (await import("./chunks/job-runner-KTJHQJ6G.mjs")).runJobRunner(rest[0]);
    case "reliability": {
      const picked = rest.filter((a) => CODING_AGENTS.includes(a));
      const only = rest.find((a) => a.startsWith("--only="))?.slice("--only=".length);
      const sections = (await import("./chunks/reliability-IVNGHN4F.mjs")).RELIABILITY_SECTIONS.filter((s) => !only || s === only);
      const models = {};
      for (const arg of rest.filter((a) => a.startsWith("--model="))) {
        const [agent, ...model] = arg.slice("--model=".length).split(":");
        if (CODING_AGENTS.includes(agent) && model.length) models[agent] = model.join(":");
      }
      if (!sections.length) {
        out(t("cli.usage"));
        return 2;
      }
      return (await import("./chunks/reliability-IVNGHN4F.mjs")).runReliability({ agents: picked.length ? picked : [...CODING_AGENTS], out, log, sections, models });
    }
    case "smoke": {
      const picked = rest.filter((a) => CODING_AGENTS.includes(a));
      return (await import("./chunks/smoke-ME2T47CO.mjs")).runSmoke({ agents: picked.length ? picked : [...CODING_AGENTS], out, log });
    }
    case "install-opencode": {
      const source = (await import("./chunks/opencode-install-HTAMNBNQ.mjs")).opencodeSourceDir();
      if (!source) {
        out(t("cli.opencode.noSource"));
        return 1;
      }
      const res = (await import("./chunks/opencode-install-HTAMNBNQ.mjs")).installOpencode(source);
      out(t("cli.opencode.installed", { dir: res.configDir }));
      printResult(res);
      out(t("cli.opencode.restart"));
      return 0;
    }
    case "uninstall-opencode": {
      const res = (await import("./chunks/opencode-install-HTAMNBNQ.mjs")).uninstallOpencode();
      out(res.files.length ? t("cli.opencode.removed", { dir: res.configDir }) : t("cli.opencode.nothing", { dir: res.configDir }));
      printResult(res);
      return 0;
    }
    case "cleanup":
      return (await import("./chunks/cleanup-Z333ZY3T.mjs")).runCleanup(rest, { home, cwd: process.cwd(), log, out });
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
