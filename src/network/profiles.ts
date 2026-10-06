import { runCommand, type CommandRunner } from "./firewall.js";

export interface NetworkProfile { interfaceAlias: string; interfaceIndex: number; category: string }
export interface NetworkProfileStatus { networkProfiles: NetworkProfile[]; networkProfileHint: string | null }
const PROFILE_CACHE_MS = 30_000;
const PROFILE_SCRIPT = "ConvertTo-Json -InputObject @(Get-NetConnectionProfile -ErrorAction Stop | Select-Object @{n='interfaceAlias';e={$_.InterfaceAlias}},@{n='interfaceIndex';e={$_.InterfaceIndex}},@{n='category';e={[string]$_.NetworkCategory}}) -Compress";
let cached: { expiresAt: number; status: Promise<NetworkProfileStatus> } | null = null;

/** Read-only, bounded profile query. Never changes profiles or firewall policy. */
export async function readNetworkProfiles(platform: string, run: CommandRunner = runCommand): Promise<NetworkProfileStatus> {
  if (platform !== "win32") return { networkProfiles: [], networkProfileHint: null };
  try {
    const parsed: unknown = JSON.parse(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROFILE_SCRIPT]));
    if (!Array.isArray(parsed)) throw new Error("unexpected network profile response");
    const networkProfiles = parsed.filter((entry): entry is NetworkProfile => entry && typeof entry.interfaceAlias === "string" && Number.isInteger(entry.interfaceIndex) && typeof entry.category === "string");
    const publicProfiles = networkProfiles.filter((entry) => entry.category === "Public");
    return {
      networkProfiles,
      networkProfileHint: publicProfiles.length
        ? `Windows Public network profile on ${publicProfiles.map((entry) => entry.interfaceAlias).join(", ")}. The agent-bridge Private firewall rules do not apply there; inbound TCP and UDP discovery may be blocked. On a trusted LAN, review Get-NetConnectionProfile and change only that adapter to Private, or ask your administrator for appropriate rules.`
        : null,
    };
  } catch {
    return { networkProfiles: [], networkProfileHint: "Windows network profiles could not be checked. Review Get-NetConnectionProfile; Private firewall rules do not apply to Public networks." };
  }
}

export function networkProfileStatus(platform = process.platform): Promise<NetworkProfileStatus> {
  if (!cached || cached.expiresAt <= Date.now()) cached = { expiresAt: Date.now() + PROFILE_CACHE_MS, status: readNetworkProfiles(platform) };
  return cached.status;
}
