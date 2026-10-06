import type { BridgeClient } from "../core/client.js";
import type { NetworkConfig } from "./config.js";
import { networkConfigSchema } from "./config.js";
import { PAIRING_TTL_MS } from "./constants.js";
import type { NetworkStatus } from "./link.js";
import { parseNetworkAddress } from "./address.js";
import { planFirewall, type FirewallPlan, type FirewallStatus } from "./firewall.js";

const WAIT_POLL_MS = 1_000;
const SECONDS_PER_MINUTE = 60;
export type WizardStep = "enable" | "firewall" | "reload" | "choose" | "pair" | "verify" | "done";
export interface ConnectOptions {
  yes: boolean;
  nonInteractive: boolean;
  create: boolean;
  address?: string;
  code?: string;
  name?: string;
  bind?: string;
  port?: number;
  discovery?: boolean;
  firewall: boolean;
}
export interface WizardDependencies {
  request: BridgeClient["request"];
  config: NetworkConfig;
  platform: string;
  prompt: (label: string, fallback?: string, secret?: boolean) => Promise<string>;
  confirm: (label: string) => Promise<boolean>;
  out: (text: string) => void;
  step?: (step: WizardStep) => void;
  signal?: AbortSignal;
  firewallStatus: (plan: FirewallPlan) => Promise<FirewallStatus>;
  applyFirewall: (plan: FirewallPlan) => Promise<void>;
  clipboard: (code: string) => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export function parseConnectOptions(args: string[]): ConnectOptions {
  const options: ConnectOptions = { yes: false, nonInteractive: false, create: false, firewall: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
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

/** All effects and prompts are injected so tests never touch a real home, firewall or remote PC. */
export async function runConnectWizard(options: ConnectOptions, deps: WizardDependencies): Promise<number> {
  const { out, request } = deps;
  const step = (value: WizardStep) => { deps.signal?.throwIfAborted(); deps.step?.(value); out(`\n${value === "done" ? "Connected" : value[0]!.toUpperCase() + value.slice(1)}:`); };
  const ask = (label: string, fallback: string, secret = false) => options.nonInteractive ? Promise.resolve(fallback) : deps.prompt(label, fallback, secret);
  const accept = (label: string) => options.yes || !options.nonInteractive && deps.confirm(label);
  step("enable");
  let status: NetworkStatus = await request("networkStatus", {});
  const base = status.config ?? deps.config;
  const needsSetup = !status.enabled || options.name !== undefined || options.bind !== undefined || options.port !== undefined || options.discovery !== undefined;
  let config = base;
  if (needsSetup) {
    config = networkConfigSchema.parse({
      ...base, enabled: true,
      name: options.name ?? await ask("Instance name", base.name),
      bind: options.bind ?? await ask("LAN bind address (0.0.0.0 exposes trusted LAN interfaces)", base.bind === "127.0.0.1" ? "0.0.0.0" : base.bind),
      port: options.port ?? Number(await ask("TCP port", String(base.port))),
      discovery: options.discovery ?? true,
    });
    planFirewall(deps.platform, config.port, config.discovery);
    out(`Save network settings in config.json: ${config.name}, ${config.bind}:${config.port}, discovery ${config.discovery ? "on" : "off"}. Other settings are preserved. This exposes the listener to the selected interfaces; use a trusted LAN only.`);
    if (!await accept("Save and enable networking?")) { out("Setup cancelled; configuration unchanged."); return 1; }
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
  for (const [i, instance] of status.discovered.entries()) out(`${i + 1}. ${instance.name} — ${instance.host}:${instance.port} (untrusted discovery hint)`);
  if (!status.discovered.length) out("No PCs discovered yet. Use a manual host:port, or create a code on this PC. Multicast may take a few seconds.");
  const mode = options.create ? "create" : options.address ? "connect" : (await ask("Create a code on this PC, or connect to another PC? (create/connect)", "create")).toLowerCase();
  if (mode !== "create" && mode !== "connect") throw new Error("choose create or connect");
  step("pair");
  let id: string;
  if (mode === "create") {
    const previous = new Set(status.paired.map((p) => p.id));
    out("Creating a one-use invitation in the protected network key store. It expires after ten minutes.");
    const invitation = await request("networkPair", {});
    const expiresAt = invitation.expiresAt ?? deps.now() + PAIRING_TTL_MS;
    out(await deps.clipboard(invitation.code) ? "Pairing code copied to clipboard." : "Clipboard unavailable; copy the code below securely.");
    out("Secret pairing code (share only with the other PC; keep out of logs and shell history):");
    out(invitation.code);
    out(`On the other PC run agent-bridge connect and choose connect. Use this PC's LAN address with TCP port ${status.port}.`);
    let remote: NetworkStatus["paired"][number] | undefined;
    while (deps.now() < expiresAt) {
      deps.signal?.throwIfAborted();
      const seconds = Math.max(0, Math.ceil((expiresAt - deps.now()) / 1000));
      out(`Waiting for the other PC: ${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, "0")} remaining (Ctrl+C cancels).`);
      status = await request("networkStatus", {});
      remote = status.paired.find((p) => p.connected && !previous.has(p.id));
      if (remote) break;
      await deps.sleep(WAIT_POLL_MS);
    }
    if (!remote) { out("Pairing code expired. Run connect again to create a fresh code."); return 1; }
    id = remote.id;
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
