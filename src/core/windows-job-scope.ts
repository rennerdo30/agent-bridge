import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Logger } from "./logger.js";

export interface ProcessCleanup {
  stopped: number[];
  remaining: number[];
}

export interface WindowsJobScope {
  guardian: ChildProcess;
  cleanup(): Promise<ProcessCleanup>;
  /** Release Node's handles; the guardian still owns the job until this runner exits. */
  detach(): void;
}

// The guardian starts BEFORE assigning the dedicated runner, so it is outside this private job.
// Assignment happens before delegates start. Future children inherit membership, including
// detached tools and orphans; no ancestry scan or executable-name matching is involved.
// The job handle is unnamed and non-inheritable. Never use this for a shared MCP server/broker.
/** Native binding block shared by the guardian and its focused tests. */
export const WINDOWS_JOB_NATIVE = String.raw`
# Emit the native ABI directly: no C# compiler process on the setup path.
# [AppDomain]::DefineDynamicAssembly exists only on .NET Framework, i.e. Windows PowerShell 5.1;
# that is why startWindowsJobScope pins the binary to System32 powershell.exe (not pwsh).
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
  (New-Object Reflection.AssemblyName('BridgeJobScopeNative')), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('Native')
$type = $module.DefineType('BridgeJobScopeNative', [Reflection.TypeAttributes]'Public, Sealed, Abstract')
function Define-Native([string]$name, [Type]$returns, [Type[]]$parameters) {
  # PSReflect pattern: DefinePInvokeMethod writes the ImplMap first, and a later DllImport
  # attribute cannot change it, so SetLastError would be lost. DefineMethod + PinvokeImpl
  # leaves the ImplMap to the DllImport attribute, which carries SetLastError and CharSet.
  $method = $type.DefineMethod($name, [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', $returns, $parameters)
  $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  $dllImport = [Runtime.InteropServices.DllImportAttribute]
  $attribute = New-Object Reflection.Emit.CustomAttributeBuilder(
    $dllImport.GetConstructor([Type[]]@([string])),
    [object[]]@('kernel32.dll'),
    [Reflection.FieldInfo[]]@($dllImport.GetField('SetLastError'), $dllImport.GetField('CharSet'), $dllImport.GetField('EntryPoint')),
    [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode, $name))
  $method.SetCustomAttribute($attribute)
}
Define-Native 'CreateJobObject' ([IntPtr]) ([Type[]]@([IntPtr], [string]))
Define-Native 'SetInformationJobObject' ([bool]) ([Type[]]@([IntPtr], [int], [IntPtr], [uint32]))
Define-Native 'QueryInformationJobObject' ([bool]) ([Type[]]@([IntPtr], [int], [IntPtr], [uint32], [IntPtr]))
Define-Native 'AssignProcessToJobObject' ([bool]) ([Type[]]@([IntPtr], [IntPtr]))
Define-Native 'IsProcessInJob' ([bool]) ([Type[]]@([IntPtr], [IntPtr], [bool].MakeByRefType()))
Define-Native 'OpenProcess' ([IntPtr]) ([Type[]]@([uint32], [bool], [int]))
Define-Native 'TerminateProcess' ([bool]) ([Type[]]@([IntPtr], [uint32]))
Define-Native 'WaitForSingleObject' ([uint32]) ([Type[]]@([IntPtr], [uint32]))
Define-Native 'CloseHandle' ([bool]) ([Type[]]@([IntPtr]))
$null = $type.CreateType()
function Check([bool]$ok) {
  if (!$ok) { throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error())) }
}
function Set-Limits([IntPtr]$job, [int]$flags) {
  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION: zero all fields except LimitFlags.
  # BasicLimitInformation.LimitFlags is at byte 16 on both Windows ABIs.
  $size = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }
  $data = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $size), 0, $data, $size)
    [Runtime.InteropServices.Marshal]::WriteInt32($data, 16, $flags)
    Check ([BridgeJobScopeNative]::SetInformationJobObject($job, 9, $data, $size))
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($data) }
}
function Members([IntPtr]$job, [int]$runner, [int]$initialSize = 4096) {
  for ($size = $initialSize; $size -le 8388608; $size *= 2) {
    $data = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    try {
      if (![BridgeJobScopeNative]::QueryInformationJobObject($job, 3, $data, $size, [IntPtr]::Zero)) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -eq 234) { continue }
        throw (New-Object ComponentModel.Win32Exception($errorCode))
      }
      $count = [Runtime.InteropServices.Marshal]::ReadInt32($data, 4)
      if ($count -gt ($size - 8) / [IntPtr]::Size -or [Runtime.InteropServices.Marshal]::ReadInt32($data, 0) -gt $count) { continue }
      for ($n = 0; $n -lt $count; $n++) {
        $id = [Runtime.InteropServices.Marshal]::ReadIntPtr($data, 8 + $n * [IntPtr]::Size).ToInt32()
        if ($id -ne $runner) { $id }
      }
      return
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($data) }
  }
  throw 'Job membership list exceeded its bound'
}
`;

const GUARD = WINDOWS_JOB_NATIVE + String.raw`
function Cleanup([IntPtr]$job, [int]$runner) {
  $stopped = New-Object 'Collections.Generic.HashSet[int]'
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $remaining = @(Members $job $runner)
    if ($remaining.Length -eq 0) { break }
    foreach ($id in $remaining) {
      # Hold the process handle through membership validation and termination.
      # An unrelated process that reused the PID cannot pass IsProcessInJob.
      $process = [BridgeJobScopeNative]::OpenProcess(0x00101001, $false, $id)
      if ($process -eq [IntPtr]::Zero) { continue }
      try {
        $member = $false
        if ([BridgeJobScopeNative]::IsProcessInJob($process, $job, [ref]$member) -and $member -and
            [BridgeJobScopeNative]::TerminateProcess($process, 1)) { $null = $stopped.Add($id) }
      } finally { $null = [BridgeJobScopeNative]::CloseHandle($process) }
    }
    [Threading.Thread]::Sleep(10)
  } while ([DateTime]::UtcNow -lt $deadline)
  $remaining = @(Members $job $runner)
  [Console]::WriteLine('{"type":"cleaned","stopped":[' + ($stopped -join ',') + '],"remaining":[' + ($remaining -join ',') + ']}')
  [Console]::Out.Flush()
}
$job = [BridgeJobScopeNative]::CreateJobObject([IntPtr]::Zero, $null)
Check ($job -ne [IntPtr]::Zero)
$owner = [IntPtr]::Zero
try {
  # Provisional assignment cannot kill the runner if Node times out.
  Set-Limits $job 0
  $owner = [BridgeJobScopeNative]::OpenProcess(0x00101101, $false, $runner)
  Check ($owner -ne [IntPtr]::Zero)
  Check ([BridgeJobScopeNative]::AssignProcessToJobObject($job, $owner))
  [Console]::WriteLine('{"type":"ready"}'); [Console]::Out.Flush()
  if ([Console]::ReadLine() -ne 'retain') { return }
  # KILL_ON_JOB_CLOSE only after Node accepts ownership. No breakaway flag.
  Set-Limits $job 0x2000
  [Console]::WriteLine('{"type":"retained"}'); [Console]::Out.Flush()
  while ($null -ne ($command = [Console]::ReadLine())) {
    if ($command -eq 'cleanup') { Cleanup $job $runner }
  }
  $null = [BridgeJobScopeNative]::WaitForSingleObject($owner, [uint32]::MaxValue)
} finally {
  if ($owner -ne [IntPtr]::Zero) { $null = [BridgeJobScopeNative]::CloseHandle($owner) }
  $null = [BridgeJobScopeNative]::CloseHandle($job)
}
`;

/** Only the current dedicated runner (or a fresh test-owned fixture) may be assigned. */
export function startWindowsJobScope(log: Logger, runnerPid = process.pid): Promise<WindowsJobScope> {
  if (process.platform !== "win32") return Promise.reject(new Error("Windows job scopes require Windows"));
  if (!Number.isSafeInteger(runnerPid) || runnerPid <= 0) return Promise.reject(new Error("Invalid runner PID for a Windows job scope: " + runnerPid));
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $runner=" + runnerPid + ";\n" + GUARD;
  // Windows PowerShell 5.1 (.NET Framework) is required by DefineDynamicAssembly in the guardian.
  const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const guardian = spawn(bin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let stderr = "", buffer = "", ready = false, failed = false, retaining = false;
    let pending: { resolve: (result: ProcessCleanup) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null = null;
    const fail = (err: Error) => {
      clearTimeout(startup);
      if (!ready && !failed) { failed = true; reject(err); }
      if (pending) { clearTimeout(pending.timer); pending.reject(err); pending = null; }
    };
    const startup = setTimeout(() => { fail(new Error("Windows job ownership setup timed out")); if (!retaining) guardian.kill(); else { guardian.stdin!.end(); (guardian.stdout as any)?.unref?.(); (guardian.stderr as any)?.unref?.(); guardian.unref(); } }, 8_000);
    guardian.on("error", fail);
    guardian.on("exit", (code) => fail(new Error("Windows job guardian exited (" + code + "): " + stderr.slice(-2000))));
    guardian.stdin!.on("error", fail);
    guardian.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    guardian.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type === "ready" && !ready && !failed && !retaining) {
          retaining = true; guardian.stdin!.write("retain\n");
        } else if (message.type === "retained" && !ready && !failed) {
          ready = true; clearTimeout(startup);
          log.info("job process ownership established", { runnerPid, guardianPid: guardian.pid, method: "private Windows job object" });
          resolve({
            guardian,
            cleanup: () => new Promise((yes, no) => {
              if (pending) return no(new Error("Job cleanup already in progress"));
              if (guardian.exitCode !== null || guardian.signalCode !== null) return no(new Error("Windows job guardian is gone"));
              pending = { resolve: yes, reject: no, timer: setTimeout(() => { if (pending) { pending.reject(new Error("Windows job cleanup timed out")); pending = null; } }, 10_000) };
              guardian.stdin!.write("cleanup\n");
            }),
            detach: () => {
              guardian.stdin!.end();
              guardian.stdout!.destroy(); guardian.stderr!.destroy();
              guardian.unref();
            },
          });
        } else if (message.type === "cleaned" && pending) {
          clearTimeout(pending.timer);
          const result: ProcessCleanup = { stopped: message.stopped, remaining: message.remaining };
          log.info("job background process cleanup", { ...result });
          pending.resolve(result); pending = null;
        }
      }
    });
  });
}

export function processCleanupReport(result: ProcessCleanup): string {
  const ids = (pids: number[]) => pids.length ? " (PIDs " + pids.join(", ") + ")" : "";
  return "Background process cleanup: stopped " + result.stopped.length + " surviving job-owned processes" + ids(result.stopped) + "; " + result.remaining.length + " still running" + ids(result.remaining) + ".";
}

/** Bounded setup failures degrade startup rather than failing a delegated task. */
export async function establishWindowsJobScope(log: Logger, start: () => Promise<WindowsJobScope> = () => startWindowsJobScope(log)): Promise<WindowsJobScope | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return await start(); }
    catch (err) { log.warn("Windows job ownership setup failed", { attempt, attempts: 2, error: (err as Error).message }); }
  }
  log.warn("job running in degraded process ownership mode", { cleanup: "private Windows job object unavailable; delegate process cleanup remains active" });
  return null;
}
