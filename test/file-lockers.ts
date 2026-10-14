import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Windows Restart Manager names the processes that hold a file open; it needs no elevation or extra tools.
const SCRIPT = String.raw`
param([string]$Path)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FileLockers {
  [StructLayout(LayoutKind.Sequential)] struct UniqueProcess { public int Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Start; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string App;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string Service;
    public int Type; public int Status; public int Session; [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint files, string[] names, uint apps, IntPtr unique, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] ProcessInfo[] info, ref uint reasons);
  public static int[] Find(string path) {
    uint handle; if (RmStartSession(out handle, 0, Guid.NewGuid().ToString()) != 0) return new int[0];
    try {
      if (RmRegisterResources(handle, 1, new[] { path }, 0, IntPtr.Zero, 0, null) != 0) return new int[0];
      uint needed = 0, count = 0, reasons = 0;
      int result = RmGetList(handle, out needed, ref count, null, ref reasons);
      if (result != 234 || needed == 0) return new int[0];
      var info = new ProcessInfo[needed]; count = needed;
      if (RmGetList(handle, out needed, ref count, info, ref reasons) != 0) return new int[0];
      var pids = new List<int>(); for (int i = 0; i < count; i++) pids.Add(info[i].Process.Pid); return pids.ToArray();
    } finally { RmEndSession(handle); }
  }
}
'@
foreach ($id in [FileLockers]::Find($Path)) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
  "$id ppid=$($p.ParentProcessId) $($p.Name) $("$($p.CommandLine)".Substring(0, [Math]::Min(240, "$($p.CommandLine)".Length)))"
}
`;

/** Diagnostics only: which processes (this test process included) still hold `path` open on Windows. */
export async function describeFileLockers(path: string): Promise<string> {
  if (process.platform !== "win32") return "";
  try {
    const command = `& { ${SCRIPT} } -Path '${path.replace(/'/g, "''")}'`;
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 60_000 });
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
      .map(line => line.startsWith(`${process.pid} `) ? `${line} [this test process]` : line);
    return lines.length ? lines.join("\n") : "no process reported";
  } catch (error) { return `locker lookup failed: ${String(error)}`; }
}
