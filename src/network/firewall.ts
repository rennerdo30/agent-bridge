import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { DISCOVERY_PORT, MAX_PORT } from "./constants.js";

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10_000;
const ELEVATION_TIMEOUT_MS = 120_000;
export interface FirewallPlan { platform: string; commands: string[]; explanation: string }
export interface FirewallStatus { state: "allowed" | "unknown"; detail: string }
export type CommandRunner = (file: string, args: string[]) => Promise<string>;
export const runCommand: CommandRunner = async (file, args) => (await exec(file, args, { windowsHide: true, timeout: COMMAND_TIMEOUT_MS })).stdout;

/** Plans are data: no command runs until a separate, explicitly confirmed action. */
export function planFirewall(platform: string, port: number, discovery: boolean): FirewallPlan {
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) throw new Error("expected a TCP port between 1 and 65535");
  const ports = [{ protocol: "TCP", port }, ...(discovery ? [{ protocol: "UDP", port: DISCOVERY_PORT }] : [])];
  if (platform === "win32") return {
    platform,
    commands: ports.map((p) => `netsh advfirewall firewall add rule name="agent-bridge ${p.protocol} ${p.port}" dir=in action=allow protocol=${p.protocol} localport=${p.port} profile=private remoteip=LocalSubnet`),
    explanation: "Allow inbound traffic from the local subnet on Private networks only. Administrator permission is required; Windows will show a UAC prompt. Public networks remain blocked.",
  };
  if (platform === "darwin") return {
    platform, commands: [`sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "${process.execPath}"`, `sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "${process.execPath}"`],
    explanation: `Allow the Node executable in System Settings > Network > Firewall > Options. macOS uses application rules, not port rules. If another firewall is installed, allow TCP ${port}${discovery ? ` and UDP ${DISCOVERY_PORT}` : ""} on the LAN. Review and run these commands yourself.`,
  };
  return { platform, commands: ports.map((p) => `sudo ufw allow from 192.168.1.0/24 to any port ${p.port} proto ${p.protocol.toLowerCase()}`), explanation: "Check your distribution's firewall (ufw, firewalld or nftables). Replace the example 192.168.1.0/24 with your trusted LAN subnet before running these commands. No rules are changed automatically." };
}

export async function detectFirewall(plan: FirewallPlan, run: CommandRunner = runCommand): Promise<FirewallStatus> {
  try {
    if (plan.platform === "win32") {
      // Read the effective policy. Conservatively recognize only the exact rules the wizard installs.
      const names = plan.commands.map((c) => /name="([^"]+)"/.exec(c)![1]!);
      const script = `$names = @(${names.map((n) => `'${n}'`).join(",")}); $found = @(Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction Stop | Where-Object { $_.DisplayName -in $names -and $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Profile -eq 'Private' } | ForEach-Object { $rule = $_; $port = $rule | Get-NetFirewallPortFilter; $address = $rule | Get-NetFirewallAddressFilter; [pscustomobject]@{ name=$rule.DisplayName; port=[string]$port.LocalPort; protocol=[string]$port.Protocol; remote=[string]$address.RemoteAddress } }); ConvertTo-Json -InputObject $found -Compress`;
      const found = JSON.parse(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])) as { name: string; port: string; protocol: string; remote: string }[];
      if (names.every((name) => found.some((r) => r.name === name && r.remote === "LocalSubnet" && name === `agent-bridge ${r.protocol === "6" ? "TCP" : r.protocol === "17" ? "UDP" : r.protocol} ${r.port}`))) return { state: "allowed", detail: "Matching inbound Private/LocalSubnet rules found. Group policy, block rules and third-party firewalls can still prevent access." };
    } else if (plan.platform === "darwin") {
      const state = await run("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"]);
      return { state: "unknown", detail: `macOS application firewall: ${state.trim()}. Check Node in Firewall Options; port access cannot be established by a local check.` };
    }
  } catch { /* An unavailable or restricted firewall API is not proof of allowed ports. */ }
  return { state: "unknown", detail: "No matching allow rules could be confirmed. Check the host firewall and trusted LAN profile." };
}

const runElevated: CommandRunner = async (file, args) => (await exec(file, args, { windowsHide: true, timeout: ELEVATION_TIMEOUT_MS })).stdout;

/** Caller must have received a distinct explicit confirmation, never inferred from --yes. */
export async function applyWindowsFirewall(plan: FirewallPlan, confirmed: boolean, run: CommandRunner = runElevated): Promise<void> {
  if (!confirmed || plan.platform !== "win32") throw new Error("explicit Windows firewall confirmation required");
  const script = plan.commands.map((command) => `& ${command}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`).join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encoded}'; if ($p.ExitCode -ne 0) { throw 'Firewall setup failed or was cancelled' }`]);
}

export async function copyPairingCode(code: string, platform = process.platform): Promise<boolean> {
  const commands = platform === "win32" ? [["clip.exe"]] : platform === "darwin" ? [["pbcopy"]] : [["xclip", "-selection", "clipboard"]];
  for (const [file, ...args] of commands) {
    const copied = await new Promise<boolean>((resolve) => {
      const child = spawn(file!, args, { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => { child.kill(); resolve(false); }, COMMAND_TIMEOUT_MS);
      child.on("error", () => { clearTimeout(timer); resolve(false); });
      child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
      child.stdin.on("error", () => {});
      child.stdin.end(code);
    });
    if (copied) return true;
  }
  return false;
}
