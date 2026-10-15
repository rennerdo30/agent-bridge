import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENV, LATE_RELAUNCH_BACKOFF_MAX_MS, LATE_RELAUNCH_BACKOFF_MIN_MS } from "./constants.js";
import type { BridgeConfig } from "./config.js";

export type DaemonLaunch = { kind: "created" } | { kind: "unavailable"; reason: "windows_wmi_unavailable" | "windows_wmi_create_rejected" } | { kind: "unknown"; stage?: "read" | "startup" | "create"; errorCode?: number };
export interface DaemonOptions { cli: string; home: string; pipe: string; cwd: string; dashboard?: boolean; config?: Pick<BridgeConfig, "network" | "mobile" | "dashboardPort"> }
const CREATE_TIMEOUT_MS = 5_000;
/** Hard bound for the creation helper process after the decision budget has passed. */
const HELPER_LIMIT_MS = 30_000;
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

/** The Windows creation helper as seen by its supervisor (a ChildProcess; a test double in unit tests). */
export interface CreateHelper {
  stdin: NodeJS.WritableStream & { on(event: "error", listener: (error: Error) => void): unknown };
  stdout: NodeJS.ReadableStream & { setEncoding(encoding: "utf8"): NodeJS.ReadableStream };
  once(event: "close", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(): unknown;
}
/**
 * Spacing of new creation attempts after late definite failures, per node: 5 s, doubling to 5 min. Only an
 * authenticated registration resets it, so a creation path that keeps failing late cannot relaunch in a loop.
 */
export class RelaunchBackoff {
  private delay = LATE_RELAUNCH_BACKOFF_MIN_MS;
  private notBefore = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}
  /** Record a late definite failure; returns the delay before the next attempt may start. */
  failed(): number {
    const delay = this.delay;
    this.notBefore = this.now() + delay;
    this.delay = Math.min(delay * 2, LATE_RELAUNCH_BACKOFF_MAX_MS);
    return delay;
  }
  get ready(): boolean { return this.now() >= this.notBefore; }
  reset(): void { this.delay = LATE_RELAUNCH_BACKOFF_MIN_MS; this.notBefore = 0; }
}

/** A classification the helper produced after the decision budget had already settled the launch. */
export type LateDaemonLaunch = (late: DaemonLaunch) => void;

/**
 * Decide within the 5 s budget, then keep observing. The decision budget stays 5 s: a later receipt is
 * "unknown" and never permits fallback. The helper itself is not killed then. On a loaded PC PowerShell
 * startup alone can exceed the budget, and killing it turned a slow but successful creation into a guaranteed
 * outage. Discovery finds the daemon if Create is applied. The helper's own close after the decision is
 * reported to `late`, so a definite late failure need not stay latched as "unknown" for the session's life.
 */
export function superviseCreateHelper(child: CreateHelper, input: string, late?: LateDaemonLaunch): Promise<DaemonLaunch> {
  return new Promise(resolve => {
    let output = "", settled = false, closed = false;
    const finish = (result: DaemonLaunch) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => finish({ kind: "unknown" }), CREATE_TIMEOUT_MS);
    const limit = setTimeout(() => child.kill(), HELPER_LIMIT_MS);
    child.once("error", () => finish({ kind: "unknown" }));
    child.stdin.on("error", () => finish({ kind: "unknown" }));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1024) { finish({ kind: "unknown" }); child.kill(); }
    });
    child.once("close", code => {
      clearTimeout(limit);
      if (closed) return;
      closed = true;
      const result = classifyWindowsCreate(code, output);
      if (settled) late?.(result); else finish(result);
    });
    child.stdin.end(input);
  });
}

/** A creation receipt is not readiness. Existing authenticated IPC is the readiness check. */
export async function launchDaemon(options: DaemonOptions, late?: LateDaemonLaunch): Promise<DaemonLaunch> {
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
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_CREATE, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  return superviseCreateHelper(child as unknown as CreateHelper, JSON.stringify({ command: [process.execPath, options.cli, "broker-daemon"].map(windowsArgument).join(" "), cwd: options.cwd,
    environment: Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => `${key}=${value}`) }), late);
}
