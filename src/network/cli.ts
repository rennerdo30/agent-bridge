import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Writable } from "node:stream";
import { BridgeClient } from "../core/client.js";
import { PROTOCOL_VERSION } from "../core/constants.js";
import type { Logger } from "../core/logger.js";
import { loadOrCreateToken } from "../core/token.js";
import { loadConfig } from "../core/config.js";
import { applyWindowsFirewall, copyPairingCode, detectFirewall } from "./firewall.js";
import { parseConnectOptions, runConnectWizard } from "./wizard.js";
import { parseNetworkAddress } from "./address.js";
export { parseNetworkAddress } from "./address.js";

const NETWORK_USAGE = "agent-bridge network | pair | pair <code> <host:port> | link <host:port> <code> | unlink <instance-id>";

/** Uses the already running broker; a short-lived CLI never owns the network listener. */
export async function runNetworkCommand(command: string, args: string[], home: string, pipe: string, log: Logger, out: (value: string) => void): Promise<number> {
  const client = await BridgeClient.connect(pipe, log).catch((error: unknown) => {
    if (command === "connect") throw new Error("No local broker is available. Start an agent-bridge hosting session, then run connect again. If its broker predates the wizard, restart all local hosting sessions after updating.");
    throw error;
  });
  try {
    await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
    if (command === "connect") {
      const options = parseConnectOptions(args);
      if (!process.stdin.isTTY && !options.nonInteractive) throw new Error("Use --non-interactive --yes with --create or --address and --code when stdin is not a terminal.");
      const cancellation = new AbortController();
      const cancel = () => { cancellation.abort(); client.close(); };
      process.on("SIGINT", cancel);
      let muted = false;
      const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); } });
      const prompts = options.nonInteractive ? null : createInterface({ input: process.stdin, output, terminal: true });
      prompts?.on("SIGINT", cancel);
      const prompt = async (label: string, fallback = "", secret = false) => {
        if (!prompts) throw new Error("interactive prompt unavailable");
        if (secret) { process.stdout.write(`${label}: `); muted = true; }
        try { return (await prompts.question(secret ? "" : `${label}${fallback ? ` [${fallback}]` : ""}: `, { signal: cancellation.signal })).trim() || fallback; }
        finally { if (secret) { muted = false; process.stdout.write("\n"); } }
      };
      try {
        return await runConnectWizard(options, {
          request: client.request.bind(client), config: loadConfig(home, "other", log).network,
          platform: process.platform, prompt,
          confirm: async (label) => /^(y|yes)$/i.test(await prompt(`${label} [y/N]`)), out,
          firewallStatus: detectFirewall, applyFirewall: (plan) => applyWindowsFirewall(plan, true),
          clipboard: copyPairingCode, now: Date.now, signal: cancellation.signal, sleep: (ms) => delay(ms, undefined, { signal: cancellation.signal }),
        });
      } catch (error) {
        if (!cancellation.signal.aborted) throw error;
        out("Setup cancelled. Already saved settings/pairings remain; an unused code expires after ten minutes.");
        return 1;
      } finally { process.off("SIGINT", cancel); prompts?.close(); }
    } else if (command === "network") {
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
