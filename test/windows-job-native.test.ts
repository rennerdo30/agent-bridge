import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { startWindowsJobScope, WINDOWS_JOB_NATIVE } from "../src/core/windows-job-scope.js";

// Runs the guardian's real binding block in the same pinned Windows PowerShell 5.1.
function runNative(probe: string): string[] {
  const script = "$ErrorActionPreference='Stop'\n" + WINDOWS_JOB_NATIVE + "\n" + probe;
  const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(bin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

it.skipIf(process.platform !== "win32")("native bindings preserve the failing call's last error", () => {
  // Seed a different last error first so a stale value cannot pass.
  const lines = runNative(String.raw`
$null = [BridgeJobScopeNative]::CloseHandle([IntPtr]::Zero)
$seed = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
$handle = [BridgeJobScopeNative]::OpenProcess(0x1000, $false, 0)
$code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
[Console]::WriteLine("seed=$seed")
[Console]::WriteLine("open=$($handle -eq [IntPtr]::Zero) code=$code")
`);
  expect(lines).toEqual(["seed=6", "open=True code=87"]);
}, 20_000);

it.skipIf(process.platform !== "win32")("Members grows an undersized buffer after ERROR_MORE_DATA", () => {
  // Two members (this shell and one idle child it owns) against a buffer sized for one entry.
  const lines = runNative(String.raw`
$job = [BridgeJobScopeNative]::CreateJobObject([IntPtr]::Zero, $null)
Check ($job -ne [IntPtr]::Zero)
$child = $null
try {
  $self = [BridgeJobScopeNative]::OpenProcess(0x00101101, $false, $PID)
  Check ($self -ne [IntPtr]::Zero)
  try { Check ([BridgeJobScopeNative]::AssignProcessToJobObject($job, $self)) }
  finally { $null = [BridgeJobScopeNative]::CloseHandle($self) }
  $child = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/d /c ping -n 30 127.0.0.1 >nul' -WindowStyle Hidden -PassThru
  $one = 8 + [IntPtr]::Size
  $data = [Runtime.InteropServices.Marshal]::AllocHGlobal($one)
  try {
    $ok = [BridgeJobScopeNative]::QueryInformationJobObject($job, 3, $data, $one, [IntPtr]::Zero)
    [Console]::WriteLine("direct=$ok code=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())")
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($data) }
  $members = @(Members $job 0 $one)
  [Console]::WriteLine("self=$($members -contains $PID) child=$($members -contains $child.Id)")
} finally {
  if ($child) { $child.Kill(); $null = $child.WaitForExit(5000) }
  $null = [BridgeJobScopeNative]::CloseHandle($job)
}
`);
  expect(lines).toEqual(["direct=False code=234", "self=True child=True"]);
}, 20_000);

it.skipIf(process.platform !== "win32")("rejects a runner PID that is not a positive safe integer before spawning", async () => {
  for (const pid of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
    await expect(startWindowsJobScope(nullLogger, pid)).rejects.toThrow("Invalid runner PID");
  }
});
