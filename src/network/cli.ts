import { BridgeClient } from "../core/client.js";
import { PROTOCOL_VERSION } from "../core/constants.js";
import type { Logger } from "../core/logger.js";
import { loadOrCreateToken } from "../core/token.js";
import { MAX_PORT } from "./constants.js";

const NETWORK_USAGE = "agent-bridge network | pair | pair <code> <host:port> | link <host:port> <code> | unlink <instance-id>";

export function parseNetworkAddress(address: string): { host: string; port: number } {
  const url = new URL(`tls://${address}`);
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > MAX_PORT || url.username || url.password || url.pathname || url.search || url.hash) throw new Error("expected host:port");
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

/** Uses the already running broker; a short-lived CLI never owns the network listener. */
export async function runNetworkCommand(command: string, args: string[], home: string, pipe: string, log: Logger, out: (value: string) => void): Promise<number> {
  const client = await BridgeClient.connect(pipe, log);
  try {
    await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
    if (command === "network") {
      out(JSON.stringify(await client.request("networkStatus", {}), null, 2));
    } else if (command === "pair" && args.length === 0) {
      out((await client.request("networkPair", {})).code);
    } else if ((command === "link" || command === "pair") && args.length === 2) {
      const [address, code] = command === "pair" ? [args[1]!, args[0]!] : [args[0]!, args[1]!];
      const remote = await client.request("networkLink", { code, ...parseNetworkAddress(address) });
      out(`Paired with ${remote.name} (${remote.fingerprint}).`);
    } else if (command === "unlink" && args.length === 1) {
      const result = await client.request("networkUnlink", { id: args[0]! });
      out(result.removed ? "Instance unlinked." : "Instance was not paired.");
    } else {
      out(NETWORK_USAGE);
      return 2;
    }
    return 0;
  } finally { client.close(); }
}
