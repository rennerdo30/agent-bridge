import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  DISCOVERY_PORT,
  MAX_PORT
} from "./chunk-EVQHXDRX.mjs";

// src/network/firewall.ts
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
var exec = promisify(execFile);
var COMMAND_TIMEOUT_MS = 1e4;
var ELEVATION_TIMEOUT_MS = 12e4;
var runCommand = async (file, args) => (await exec(file, args, { windowsHide: true, timeout: COMMAND_TIMEOUT_MS })).stdout;
function planFirewall(platform, port, discovery) {
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) throw new Error("expected a TCP port between 1 and 65535");
  const ports = [{ protocol: "TCP", port }, ...discovery ? [{ protocol: "UDP", port: DISCOVERY_PORT }] : []];
  if (platform === "win32") return {
    platform,
    commands: ports.map((p) => `netsh advfirewall firewall add rule name="agent-bridge ${p.protocol} ${p.port}" dir=in action=allow protocol=${p.protocol} localport=${p.port} profile=private remoteip=LocalSubnet`),
    explanation: "Allow inbound traffic from the local subnet on Private networks only. Administrator permission is required; Windows will show a UAC prompt. Public networks remain blocked."
  };
  if (platform === "darwin") return {
    platform,
    commands: [`sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "${process.execPath}"`, `sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "${process.execPath}"`],
    explanation: `Allow the Node executable in System Settings > Network > Firewall > Options. macOS uses application rules, not port rules. If another firewall is installed, allow TCP ${port}${discovery ? ` and UDP ${DISCOVERY_PORT}` : ""} on the LAN. Review and run these commands yourself.`
  };
  return { platform, commands: ports.map((p) => `sudo ufw allow from 192.168.1.0/24 to any port ${p.port} proto ${p.protocol.toLowerCase()}`), explanation: "Check your distribution's firewall (ufw, firewalld or nftables). Replace the example 192.168.1.0/24 with your trusted LAN subnet before running these commands. No rules are changed automatically." };
}
async function detectFirewall(plan, run = runCommand) {
  try {
    if (plan.platform === "win32") {
      const names = plan.commands.map((c) => /name="([^"]+)"/.exec(c)[1]);
      const script = `$names = @(${names.map((n) => `'${n}'`).join(",")}); $found = @(Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction Stop | Where-Object { $_.DisplayName -in $names -and $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Profile -eq 'Private' } | ForEach-Object { $rule = $_; $port = $rule | Get-NetFirewallPortFilter; $address = $rule | Get-NetFirewallAddressFilter; [pscustomobject]@{ name=$rule.DisplayName; port=[string]$port.LocalPort; protocol=[string]$port.Protocol; remote=[string]$address.RemoteAddress } }); ConvertTo-Json -InputObject $found -Compress`;
      const found = JSON.parse(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]));
      if (names.every((name) => found.some((r) => r.name === name && r.remote === "LocalSubnet" && name === `agent-bridge ${r.protocol === "6" ? "TCP" : r.protocol === "17" ? "UDP" : r.protocol} ${r.port}`))) return { state: "allowed", detail: "Matching inbound Private/LocalSubnet rules found. Group policy, block rules and third-party firewalls can still prevent access." };
    } else if (plan.platform === "darwin") {
      const state = await run("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"]);
      return { state: "unknown", detail: `macOS application firewall: ${state.trim()}. Check Node in Firewall Options; port access cannot be established by a local check.` };
    }
  } catch {
  }
  return { state: "unknown", detail: "No matching allow rules could be confirmed. Check the host firewall and trusted LAN profile." };
}
var runElevated = async (file, args) => (await exec(file, args, { windowsHide: true, timeout: ELEVATION_TIMEOUT_MS })).stdout;
async function applyWindowsFirewall(plan, confirmed, run = runElevated) {
  if (!confirmed || plan.platform !== "win32") throw new Error("explicit Windows firewall confirmation required");
  const script = plan.commands.map((command) => `& ${command}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`).join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encoded}'; if ($p.ExitCode -ne 0) { throw 'Firewall setup failed or was cancelled' }`]);
}
async function copyPairingCode(code, platform = process.platform) {
  const commands = platform === "win32" ? [["clip.exe"]] : platform === "darwin" ? [["pbcopy"]] : [["xclip", "-selection", "clipboard"]];
  for (const [file, ...args] of commands) {
    const copied = await new Promise((resolve) => {
      const child = spawn(file, args, { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, COMMAND_TIMEOUT_MS);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on("close", (code2) => {
        clearTimeout(timer);
        resolve(code2 === 0);
      });
      child.stdin.on("error", () => {
      });
      child.stdin.end(code);
    });
    if (copied) return true;
  }
  return false;
}

// src/network/profiles.ts
var PROFILE_CACHE_MS = 3e4;
var PROFILE_SCRIPT = "ConvertTo-Json -InputObject @(Get-NetConnectionProfile -ErrorAction Stop | Select-Object @{n='interfaceAlias';e={$_.InterfaceAlias}},@{n='interfaceIndex';e={$_.InterfaceIndex}},@{n='category';e={[string]$_.NetworkCategory}}) -Compress";
var cached = null;
async function readNetworkProfiles(platform, run = runCommand) {
  if (platform !== "win32") return { networkProfiles: [], networkProfileHint: null };
  try {
    const parsed = JSON.parse(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROFILE_SCRIPT]));
    if (!Array.isArray(parsed)) throw new Error("unexpected network profile response");
    const networkProfiles = parsed.filter((entry) => entry && typeof entry.interfaceAlias === "string" && Number.isInteger(entry.interfaceIndex) && typeof entry.category === "string");
    const publicProfiles = networkProfiles.filter((entry) => entry.category === "Public");
    return {
      networkProfiles,
      networkProfileHint: publicProfiles.length ? `Windows Public network profile on ${publicProfiles.map((entry) => entry.interfaceAlias).join(", ")}. The agent-bridge Private firewall rules do not apply there; inbound TCP and UDP discovery may be blocked. On a trusted LAN, review Get-NetConnectionProfile and change only that adapter to Private, or ask your administrator for appropriate rules.` : null
    };
  } catch {
    return { networkProfiles: [], networkProfileHint: "Windows network profiles could not be checked. Review Get-NetConnectionProfile; Private firewall rules do not apply to Public networks." };
  }
}
function networkProfileStatus(platform = process.platform) {
  if (!cached || cached.expiresAt <= Date.now()) cached = { expiresAt: Date.now() + PROFILE_CACHE_MS, status: readNetworkProfiles(platform) };
  return cached.status;
}

// src/network/address.ts
function parseNetworkAddress(address) {
  const url = new URL(`tls://${address}`);
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > MAX_PORT || url.username || url.password || url.pathname || url.search || url.hash) throw new Error("expected host:port");
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

export {
  planFirewall,
  detectFirewall,
  applyWindowsFirewall,
  copyPairingCode,
  networkProfileStatus,
  parseNetworkAddress
};
