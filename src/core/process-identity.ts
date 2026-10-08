import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
let parentIdentity: Promise<string | null> | undefined;

/** A PID alone can be reused. Bind reload recovery to the CLI process's creation time. */
export function parentProcessIdentity(): Promise<string | null> {
  return parentIdentity ??= readProcessIdentity(process.ppid);
}

export async function readProcessIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return start ? `${boot.trim()}:${start}` : null;
    }
    const { stdout } = process.platform === "win32"
      ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: 5_000 })
      : await exec("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5_000, env: { ...process.env, LC_ALL: "C" } });
    return stdout.trim() || null;
  } catch { return null; }
}

/** One Windows process query rather than one PowerShell process per retained reader. */
export async function readProcessIdentities(pids: number[]): Promise<Map<number, string>> {
  const valid = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  const result = new Map<number, string>();
  if (!valid.length) return result;
  if (process.platform === "win32") {
    try {
      const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id @(${valid.join(",")}) -ErrorAction SilentlyContinue | ForEach-Object { try { [string]$_.Id + '|' + [string]$_.StartTime.ToUniversalTime().Ticks } catch {} }`], { windowsHide: true, timeout: 5_000 });
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^(\d+)\|(\d+)$/.exec(line.trim());
        if (match && valid.includes(Number(match[1]))) result.set(Number(match[1]), match[2]!);
      }
    } catch { /* Unknown readers continue to block upgrades. */ }
  } else {
    await Promise.all(valid.map(async pid => { const identity = await readProcessIdentity(pid); if (identity) result.set(pid, identity); }));
  }
  return result;
}

let ownIdentity: string | undefined;

/** Creation identity for lock acquisition/recovery, never for polling hot paths. */
export function processIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid && ownIdentity) return ownIdentity;
  try {
    let identity: string | undefined;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (start) identity = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
    } else {
      identity = (process.platform === "win32"
        ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: 5_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        : execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } })).trim() || undefined;
    }
    if (pid === process.pid) ownIdentity = identity;
    return identity;
  } catch { return undefined; }
}

/** Unknown access/probe failures never authorize recovery of another owner's data. */
export function isProcessIdentityAlive(pid: number, identity: string): boolean | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !identity) return undefined;
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
  const current = processIdentity(pid);
  return current === undefined ? undefined : current === identity;
}
