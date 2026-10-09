import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  applyWindowsFirewall,
  copyPairingCode,
  detectFirewall,
  networkProfileStatus,
  parseNetworkAddress,
  planFirewall
} from "./chunk-2PRMJRMM.mjs";
import {
  BridgeClient
} from "./chunk-QFQU7TGT.mjs";
import "./chunk-GVOVE4SF.mjs";
import {
  loadOrCreateToken
} from "./chunk-V4WDBMEN.mjs";
import {
  PAIRING_TTL_MS,
  loadConfig,
  networkConfigSchema
} from "./chunk-QIKHA2R5.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-NZ5LZOZH.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-NWPQJULH.mjs";
import "./chunk-4EDVJNL7.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-7EOIPV3B.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/network/cli.ts
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Writable } from "node:stream";

// src/network/wizard.ts
var WAIT_POLL_MS = 1e3;
var SECONDS_PER_MINUTE = 60;
function parseConnectOptions(args) {
  const options = { yes: false, nonInteractive: false, create: false, firewall: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--yes") options.yes = true;
    else if (flag === "--non-interactive") options.nonInteractive = true;
    else if (flag === "--create") options.create = true;
    else if (flag === "--firewall") options.firewall = true;
    else if (flag === "--no-discovery") options.discovery = false;
    else if (["--address", "--code", "--name", "--bind", "--port"].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--port") options.port = Number(value);
      else if (flag === "--address") options.address = value;
      else if (flag === "--code") options.code = value;
      else if (flag === "--name") options.name = value;
      else options.bind = value;
    } else throw new Error(`unknown connect option: ${flag}`);
  }
  if (options.create && (options.address || options.code)) throw new Error("choose either --create or --address with --code");
  if (options.nonInteractive && !options.create && !(options.address && options.code)) throw new Error("--non-interactive requires --create or --address and --code");
  if (options.nonInteractive && options.firewall) throw new Error("firewall setup requires an interactive explicit confirmation");
  return options;
}
async function runConnectWizard(options, deps) {
  const { out, request } = deps;
  const step = (value) => {
    deps.signal?.throwIfAborted();
    deps.step?.(value);
    out(`
${value === "done" ? "Connected" : value[0].toUpperCase() + value.slice(1)}:`);
  };
  const ask = (label, fallback, secret = false) => options.nonInteractive ? Promise.resolve(fallback) : deps.prompt(label, fallback, secret);
  const accept = (label) => options.yes || !options.nonInteractive && deps.confirm(label);
  step("enable");
  let status = await request("networkStatus", {});
  const base = status.config ?? deps.config;
  const needsSetup = !status.enabled || options.name !== void 0 || options.bind !== void 0 || options.port !== void 0 || options.discovery !== void 0;
  let config = base;
  if (needsSetup) {
    config = networkConfigSchema.parse({
      ...base,
      enabled: true,
      name: options.name ?? await ask("Instance name", base.name),
      bind: options.bind ?? await ask("LAN bind address (0.0.0.0 exposes trusted LAN interfaces)", base.bind === "127.0.0.1" ? "0.0.0.0" : base.bind),
      port: options.port ?? Number(await ask("TCP port", String(base.port))),
      discovery: options.discovery ?? true
    });
    planFirewall(deps.platform, config.port, config.discovery);
    out(`Save network settings in config.json: ${config.name}, ${config.bind}:${config.port}, discovery ${config.discovery ? "on" : "off"}. Other settings are preserved. This exposes the listener to the selected interfaces; use a trusted LAN only.`);
    if (!await accept("Save and enable networking?")) {
      out("Setup cancelled; configuration unchanged.");
      return 1;
    }
  } else out(`Networking already enabled for ${status.identity?.name ?? base.name}.`);
  step("firewall");
  const plan = planFirewall(deps.platform, needsSetup ? config.port : status.port || config.port, config.discovery);
  const firewall = await deps.firewallStatus(plan);
  out(firewall.detail);
  out(plan.explanation);
  for (const command of plan.commands) out(command);
  if (deps.platform === "win32" && (firewall.state !== "allowed" || options.firewall) && !options.nonInteractive && await deps.confirm("Add these exact firewall rules now? Requires administrator permission (UAC).")) {
    await deps.applyFirewall(plan);
    out((await deps.firewallStatus(plan)).detail);
  } else out("Firewall unchanged. You can review and run the commands yourself.");
  step("reload");
  if (needsSetup) status = await request("networkConfigure", config);
  if (!status.enabled) throw new Error("Networking unavailable. Restart all local agent-bridge hosting sessions, then run connect again.");
  out("Broker network configuration is active. No session restart is required now. Keep network settings consistent in per-agent config and environment overrides before future broker elections.");
  step("choose");
  status = await request("networkStatus", {});
  for (const [i, instance] of status.discovered.entries()) out(`${i + 1}. ${instance.name} \u2014 ${instance.host}:${instance.port} (untrusted discovery hint)`);
  if (!status.discovered.length) out("No PCs discovered yet. Use a manual host:port, or create a code on this PC. Multicast may take a few seconds.");
  const mode = options.create ? "create" : options.address ? "connect" : (await ask("Create a code on this PC, or connect to another PC? (create/connect)", "create")).toLowerCase();
  if (mode !== "create" && mode !== "connect") throw new Error("choose create or connect");
  step("pair");
  let id;
  if (mode === "create") {
    const previous = new Set(status.paired.map((p) => p.id));
    out("Creating a one-use invitation in the protected network key store. It expires after ten minutes.");
    const invitation = await request("networkPair", {});
    const expiresAt = invitation.expiresAt ?? deps.now() + PAIRING_TTL_MS;
    out(await deps.clipboard(invitation.code) ? "Pairing code copied to clipboard." : "Clipboard unavailable; copy the code below securely.");
    out("Secret pairing code (share only with the other PC; keep out of logs and shell history):");
    out(invitation.code);
    out(`On the other PC run agent-bridge connect and choose connect. Use this PC's LAN address with TCP port ${status.port}.`);
    let remote2;
    while (deps.now() < expiresAt) {
      deps.signal?.throwIfAborted();
      const seconds = Math.max(0, Math.ceil((expiresAt - deps.now()) / 1e3));
      out(`Waiting for the other PC: ${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, "0")} remaining (Ctrl+C cancels).`);
      status = await request("networkStatus", {});
      remote2 = status.paired.find((p) => p.connected && !previous.has(p.id));
      if (remote2) break;
      await deps.sleep(WAIT_POLL_MS);
    }
    if (!remote2) {
      out("Pairing code expired. Run connect again to create a fresh code.");
      return 1;
    }
    id = remote2.id;
  } else {
    const choice = options.address ?? await ask("Discovered PC number or manual host:port", "");
    const index = /^\d+$/.test(choice) ? Number(choice) - 1 : -1;
    const discovered = status.discovered[index];
    const address = discovered ? `${discovered.host}:${discovered.port}` : choice;
    const endpoint = parseNetworkAddress(address);
    const code = options.code ?? await ask("Secret code from the other PC", "", true);
    if (!code) throw new Error("pairing code is required");
    out(`Pairing with ${address} will save its identity and secret in the protected network key store and reconnect this endpoint in future.`);
    id = (await request("networkLink", { ...endpoint, code })).id;
  }
  step("verify");
  const result = await request("networkVerify", { id });
  for (const peer of result.peers) out(`Remote peer: ${peer.name} (${peer.agent})`);
  if (!result.peers.length) out("No remote agent sessions currently advertised; start one on the other PC to exchange agent messages.");
  out(`Test message echo round trip acknowledged in ${result.roundTripMs} ms.`);
  step("done");
  status = await request("networkStatus", {});
  const remote = status.paired.find((p) => p.id === id);
  out(`Paired with ${remote?.name ?? id}. Encrypted link verified. Use the instance/peer name with send. Unlink on both PCs to revoke pairing; the clipboard may still contain the code.`);
  return 0;
}

// src/network/cli.ts
var NETWORK_USAGE = "agent-bridge network | pair | pair <code> <host:port> | link <host:port> <code> | unlink <instance-id>";
async function runNetworkCommand(command, args, home, pipe, log, out) {
  const client = await BridgeClient.connect(pipe, log).catch((error) => {
    if (command === "connect") throw new Error("No local broker is available. Start an agent-bridge hosting session, then run connect again. If its broker predates the wizard, restart all local hosting sessions after updating.");
    throw error;
  });
  try {
    await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
    if (command === "connect") {
      const options = parseConnectOptions(args);
      if (!process.stdin.isTTY && !options.nonInteractive) throw new Error("Use --non-interactive --yes with --create or --address and --code when stdin is not a terminal.");
      const cancellation = new AbortController();
      const cancel = () => {
        cancellation.abort();
        client.close();
      };
      process.on("SIGINT", cancel);
      let muted = false;
      const output = new Writable({ write(chunk, _encoding, done) {
        if (!muted) process.stdout.write(chunk);
        done();
      } });
      const prompts = options.nonInteractive ? null : createInterface({ input: process.stdin, output, terminal: true });
      prompts?.on("SIGINT", cancel);
      const prompt = async (label, fallback = "", secret = false) => {
        if (!prompts) throw new Error("interactive prompt unavailable");
        if (secret) {
          process.stdout.write(`${label}: `);
          muted = true;
        }
        try {
          return (await prompts.question(secret ? "" : `${label}${fallback ? ` [${fallback}]` : ""}: `, { signal: cancellation.signal })).trim() || fallback;
        } finally {
          if (secret) {
            muted = false;
            process.stdout.write("\n");
          }
        }
      };
      try {
        return await runConnectWizard(options, {
          request: client.request.bind(client),
          config: loadConfig(home, "other", log).network,
          platform: process.platform,
          prompt,
          confirm: async (label) => /^(y|yes)$/i.test(await prompt(`${label} [y/N]`)),
          out,
          firewallStatus: detectFirewall,
          applyFirewall: (plan) => applyWindowsFirewall(plan, true),
          clipboard: copyPairingCode,
          now: Date.now,
          signal: cancellation.signal,
          sleep: (ms) => delay(ms, void 0, { signal: cancellation.signal })
        });
      } catch (error) {
        if (!cancellation.signal.aborted) throw error;
        out("Setup cancelled. Already saved settings/pairings remain; an unused code expires after ten minutes.");
        return 1;
      } finally {
        process.off("SIGINT", cancel);
        prompts?.close();
      }
    } else if (command === "network") {
      out(JSON.stringify({ ...await client.request("networkStatus", {}), ...await networkProfileStatus() }, null, 2));
    } else if (command === "pair" && args.length === 0) {
      out((await client.request("networkPair", {})).code);
    } else if ((command === "link" || command === "pair") && args.length === 2) {
      const [address, code] = command === "pair" ? [args[1], args[0]] : [args[0], args[1]];
      const remote = await client.request("networkLink", { code, ...parseNetworkAddress(address) });
      out(`Paired with ${remote.name} (${remote.fingerprint}).`);
    } else if (command === "unlink" && args.length === 1) {
      const result = await client.request("networkUnlink", { id: args[0] });
      out(result.removed ? "Instance unlinked." : "Instance was not paired.");
    } else {
      out(NETWORK_USAGE);
      return 2;
    }
    return 0;
  } finally {
    client.close();
  }
}
export {
  parseNetworkAddress,
  runNetworkCommand
};
