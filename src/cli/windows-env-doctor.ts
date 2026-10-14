import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DoctorFinding } from "../core/doctor.js";

type ProbeOptions = { timeout: number; maxBuffer: number; windowsHide: boolean; encoding: "utf8" };
type MetricsProbe = (command: string, args: string[], options: ProbeOptions) => Promise<{ stdout: string }>;
const exec = promisify(execFile);
const defaultProbe: MetricsProbe = (command, args, options) => exec(command, args, options);

/** Read only the persistent user scope; the child returns counts, never PATH contents. */
export async function windowsUserPathFindings(platform: NodeJS.Platform = process.platform, probe: MetricsProbe = defaultProbe): Promise<DoctorFinding[]> {
  if (platform !== "win32") return [];
  const script = "$pathValue = [Environment]::GetEnvironmentVariable('Path', 'User'); " +
    "$toolCount = @($pathValue -split ';' | Where-Object { $_.Trim().TrimEnd('\\','/').Replace('\\','/') -match '(?i)(^|/)\\.dotnet/tools$' }).Count; " +
    "@{length = ([string]$pathValue).Length; dotnetToolsEntries = $toolCount} | ConvertTo-Json -Compress";
  try {
    const { stdout } = await probe("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 2_000, maxBuffer: 4_096, windowsHide: true, encoding: "utf8" });
    const metrics: unknown = JSON.parse(stdout);
    if (!metrics || typeof metrics !== "object") return [];
    const { length, dotnetToolsEntries } = metrics as Record<string, unknown>;
    if (!Number.isSafeInteger(length) || !Number.isSafeInteger(dotnetToolsEntries) || (length as number) < 0 || (dotnetToolsEntries as number) < 0) return [];
    const findings: DoctorFinding[] = [];
    if ((length as number) > 2_000) findings.push({ severity: "warning", code: "windows-user-path-long", path: "Windows user environment",
      detail: `Persistent user PATH has ${length} characters (over 2000); review it manually for redundant entries.`, fixable: false });
    if ((dotnetToolsEntries as number) >= 3) findings.push({ severity: "warning", code: "windows-user-path-dotnet-tools", path: "Windows user environment",
      detail: `Persistent user PATH contains ${dotnetToolsEntries} .dotnet/tools entries; review repeated entries manually.`, fixable: false });
    return findings;
  } catch { return []; } // Optional diagnostics must not expose command output or errors containing PATH.
}
