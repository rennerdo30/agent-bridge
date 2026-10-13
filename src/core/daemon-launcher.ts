import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENV } from "./constants.js";
import type { BridgeConfig } from "./config.js";

export type DaemonLaunch = { kind: "created" } | { kind: "unavailable"; reason: "windows_wmi_unavailable" | "windows_wmi_create_rejected" } | { kind: "unknown"; stage?: "read" | "startup" | "create"; errorCode?: number };
export interface DaemonOptions { cli: string; home: string; pipe: string; cwd: string; dashboard?: boolean; config?: Pick<BridgeConfig, "network" | "mobile" | "dashboardPort"> }
const CREATE_TIMEOUT_MS = 5_000;
const CREATE_FAILURES = new Set([2, 3, 8, 9, 21, 22, 0xffffffff]);
export function classifyWindowsCreate(exitCode: number | null, output: string): DaemonLaunch {
  try {
    const result = JSON.parse(output);
    if (result && ["read", "startup", "create"].includes(result.stage) && Number.isSafeInteger(result.hresult)) return { kind: "unknown", stage: result.stage, errorCode: result.hresult };
    if (exitCode !== 0 || !result || Object.keys(result).sort().join(",") !== "code,pid" || !Number.isSafeInteger(result.code) || !Number.isSafeInteger(result.pid)) return { kind: "unknown" };
    if (result.code === 0 && result.pid > 0) return { kind: "created" };
    if (CREATE_FAILURES.has(result.code) && result.pid === 0) return { kind: "unavailable", reason: "windows_wmi_create_rejected" };
  } catch { /* A provider exception is not proof that Create was never applied. */ }
  return { kind: "unknown" };
}

/** Windows CommandLineToArgvW/CRT quoting, never shell quoting. */
export function windowsArgument(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("invalid daemon argument");
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

// No supplied value is interpolated into PowerShell source or its command line.
// WMI creates outside the caller's Job Object; breakaway excludes the provider's job too.
const WINDOWS_CREATE = String.raw`
$ErrorActionPreference='Stop'
$phase='read'
try {
  $reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))
  try { $inputData = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  $phase='startup'
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
    ShowWindow=[uint16]0; CreateFlags=[uint32]0x09000400; EnvironmentVariables=[string[]]$inputData.environment
  }
  $phase='create'
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine=[string]$inputData.command; CurrentDirectory=[string]$inputData.cwd; ProcessStartupInformation=$startup
  }
  [Console]::Out.WriteLine((@{code=[uint32]$result.ReturnValue; pid=[uint32]$result.ProcessId} | ConvertTo-Json -Compress))
} catch { [Console]::Out.WriteLine((@{stage=$phase; hresult=[int]$_.Exception.HResult} | ConvertTo-Json -Compress)); exit 1 }
`;

/** Keep configuration/native transcript discovery, without inheriting session control credentials. */
export function daemonEnvironment(options: DaemonOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [ENV.home]: options.home, [ENV.pipe]: options.pipe };
  for (const key of Object.keys(env)) {
    if (/^AGENT_BRIDGE_(?:PARENT_|ROOT_|JOB_|DELEGATE_|INTERNAL$)/.test(key)) delete env[key];
  }
  delete env.NODE_OPTIONS;
  env.AGENT_BRIDGE_DAEMON_DASHBOARD = options.dashboard ? "1" : "0";
  if (options.config) env.AGENT_BRIDGE_DAEMON_CONFIG = JSON.stringify(options.config);
  else delete env.AGENT_BRIDGE_DAEMON_CONFIG;
  return env;
}

/** A creation receipt is not readiness. Existing authenticated IPC is the readiness check. */
export async function launchDaemon(options: DaemonOptions): Promise<DaemonLaunch> {
  if (!existsSync(options.cli)) throw new Error("broker daemon runtime is unavailable");
  const env = daemonEnvironment(options);
  if (process.platform !== "win32") {
    return new Promise(resolve => {
      const child = spawn(process.execPath, [options.cli, "broker-daemon"], { cwd: options.cwd, env, detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => resolve({ kind: "unknown" }));
      child.once("spawn", () => { child.unref(); resolve({ kind: "created" }); });
    });
  }
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(powershell)) return { kind: "unavailable", reason: "windows_wmi_unavailable" };
  return new Promise(resolve => {
    let output = "", settled = false;
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_CREATE, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const finish = (result: DaemonLaunch) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { finish({ kind: "unknown" }); child.kill(); }, CREATE_TIMEOUT_MS);
    child.once("error", () => finish({ kind: "unknown" }));
    child.stdin!.on("error", () => finish({ kind: "unknown" }));
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1024) { finish({ kind: "unknown" }); child.kill(); }
    });
    child.once("close", code => {
      finish(classifyWindowsCreate(code, output));
    });
    child.stdin!.end(JSON.stringify({ command: [process.execPath, options.cli, "broker-daemon"].map(windowsArgument).join(" "), cwd: options.cwd,
      environment: Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => `${key}=${value}`) }));
  });
}
