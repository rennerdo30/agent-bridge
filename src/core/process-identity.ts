import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
let parentIdentity: Promise<string | null> | undefined;

/** A PID alone can be reused. Bind reload recovery to the CLI process's creation time. */
export function parentProcessIdentity(): Promise<string | null> {
  return parentIdentity ??= processIdentity(process.ppid);
}

async function processIdentity(pid: number): Promise<string | null> {
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
