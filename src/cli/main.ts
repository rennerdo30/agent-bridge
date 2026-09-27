import { join } from "node:path";
import { BridgeClient } from "../core/client.js";
import { LOG_DIR_NAME } from "../core/constants.js";
import { formatDateTime, t } from "../core/i18n.js";
import { createLogger } from "../core/logger.js";
import { BridgeNode } from "../core/node.js";
import { resolveDbPath, resolveHome, resolvePipePath } from "../core/paths.js";
import { formatMessage } from "../mcp/format.js";

const CLI_PEER_NAME = "cli";
const out = (s: string) => process.stdout.write(s + "\n");

async function main(argv: string[]): Promise<number> {
  const [command = "help", ...rest] = argv;
  const home = resolveHome();
  const pipe = resolvePipePath(home);
  const log = createLogger({ home, component: "cli" });
  const makeNode = () =>
    new BridgeNode({ pipePath: pipe, dbPath: resolveDbPath(home), agent: "other", name: CLI_PEER_NAME, cwd: process.cwd(), autoWake: false, log });

  switch (command) {
    case "status": {
      let client: BridgeClient;
      try {
        client = await BridgeClient.connect(pipe, log);
      } catch {
        out(t("cli.status.noBroker", { pipe }));
        return 0;
      }
      try {
        const ping = await client.request("ping", {});
        const peers = await client.request("peers", {});
        out(t("cli.status.broker", { pid: String(ping.brokerPid), protocol: String(ping.protocol), pipe }));
        out(t("cli.status.peers", { count: peers.length }));
        for (const p of peers) out(t("cli.status.peer", { name: p.name, agent: p.agent, since: formatDateTime(p.startedAt), cwd: p.cwd }));
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
    case "paths":
      out(t("cli.paths", { home, logs: join(home, LOG_DIR_NAME), db: resolveDbPath(home), pipe }));
      return 0;
    case "help":
    case "--help":
    case "-h":
      out(t("cli.usage"));
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
