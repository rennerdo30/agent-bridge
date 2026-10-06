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
const GUARD = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
public static class BridgeJobScope {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint rights, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime, jobTime; public uint flags; public UIntPtr minWorkingSet, maxWorkingSet;
    public uint activeProcessLimit; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong read, write, other, readBytes, writeBytes, otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits basic; public IoCounters io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static int[] Members(IntPtr job, int runner) {
    for (int size=4096; size<=8388608; size*=2) {
      IntPtr data=Marshal.AllocHGlobal(size);
      try {
        if (!QueryInformationJobObject(job, 3, data, (uint)size, IntPtr.Zero)) {
          if (Marshal.GetLastWin32Error()==234) continue;
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        int count=Marshal.ReadInt32(data, 4);
        if (count> (size-8)/IntPtr.Size || Marshal.ReadInt32(data, 0)>count) continue;
        var ids=new List<int>();
        for (int n=0; n<count; n++) {
          int pid=(int)Marshal.ReadIntPtr(data, 8+n*IntPtr.Size).ToInt64();
          if (pid!=runner) ids.Add(pid);
        }
        return ids.ToArray();
      } finally { Marshal.FreeHGlobal(data); }
    }
    throw new Exception("Job membership list exceeded its bound");
  }
  static void Cleanup(IntPtr job, int runner) {
    var stopped=new HashSet<int>();
    DateTime deadline=DateTime.UtcNow.AddSeconds(5);
    int[] remaining;
    do {
      remaining=Members(job, runner);
      if (remaining.Length==0) break;
      foreach (int pid in remaining) {
        // Keep the handle through the membership check and termination. A reused PID outside
        // this job can never pass IsProcessInJob, even if it appeared in the prior snapshot.
        IntPtr process=OpenProcess(0x00101001, false, pid);
        if (process==IntPtr.Zero) continue;
        try {
          bool member;
          if (IsProcessInJob(process, job, out member) && member && TerminateProcess(process, 1)) stopped.Add(pid);
        } finally { CloseHandle(process); }
      }
      Thread.Sleep(10);
    } while (DateTime.UtcNow<deadline);
    remaining=Members(job, runner);
    Console.WriteLine("{\"type\":\"cleaned\",\"stopped\":["+String.Join(",",stopped)+"],\"remaining\":["+String.Join(",",remaining)+"]}");
    Console.Out.Flush();
  }
  public static void Run(int runner) {
    IntPtr job=CreateJobObject(IntPtr.Zero, null);
    Check(job!=IntPtr.Zero);
    IntPtr owner=IntPtr.Zero;
    try {
      var limits=new Limits(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway permission.
      int size=Marshal.SizeOf(limits); IntPtr data=Marshal.AllocHGlobal(size);
      try { Marshal.StructureToPtr(limits, data, false); Check(SetInformationJobObject(job, 9, data, (uint)size)); }
      finally { Marshal.FreeHGlobal(data); }
      owner=OpenProcess(0x00101101, false, runner); Check(owner!=IntPtr.Zero);
      Check(AssignProcessToJobObject(job, owner));
      Console.WriteLine("{\"type\":\"ready\"}"); Console.Out.Flush();
      string command;
      while ((command=Console.ReadLine())!=null) {
        if (command=="cleanup") Cleanup(job, runner);
      }
      // EOF releases the runner's pipes, not the containment. Closing this last job handle
      // after owner exit also catches tools started while the final report was being delivered.
      WaitForSingleObject(owner, 0xffffffff);
    } finally {
      if (owner!=IntPtr.Zero) CloseHandle(owner);
      CloseHandle(job);
    }
  }
}
`;

/** Only the current dedicated runner (or a fresh test-owned fixture) may be assigned. */
export function startWindowsJobScope(log: Logger, runnerPid = process.pid): Promise<WindowsJobScope> {
  if (process.platform !== "win32") return Promise.reject(new Error("Windows job scopes require Windows"));
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); Add-Type -TypeDefinition @'\n" + GUARD + "\n'@; [BridgeJobScope]::Run(" + runnerPid + ")";
  const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const guardian = spawn(bin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let stderr = "", buffer = "", ready = false;
    let pending: { resolve: (result: ProcessCleanup) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null = null;
    const fail = (err: Error) => {
      clearTimeout(startup);
      if (!ready) reject(err);
      if (pending) { clearTimeout(pending.timer); pending.reject(err); pending = null; }
    };
    const startup = setTimeout(() => { fail(new Error("Windows job ownership setup timed out")); guardian.kill(); }, 25_000);
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
        if (message.type === "ready" && !ready) {
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
