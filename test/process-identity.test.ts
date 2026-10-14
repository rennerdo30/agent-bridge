import { execFileSync, spawn } from "node:child_process";
import { expect, it } from "vitest";
import { processIdentity, readProcessIdentities, readProcessIdentity } from "../src/core/process-identity.js";

it.skipIf(process.platform !== "win32")("preserves the exact persisted Get-Process UTC tick identity", async () => {
  const old = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
  { encoding: "utf8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  expect(old).toMatch(/^\d+$/);
  const sync = processIdentity(process.pid), async = await readProcessIdentity(process.pid);
  expect(sync).toBe(old);
  expect(async).toBe(old);
  expect(Buffer.from(sync!, "utf8")).toEqual(Buffer.from(old, "utf8"));
  expect(Buffer.from(async!, "utf8")).toEqual(Buffer.from(old, "utf8"));
});

it("retains a requested live identity when another requested process has exited", async () => {
  const child = spawn(process.execPath, ["-e", "process.send('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  try {
    await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); });
    const deadPid = child.pid!;
    await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); });
    const identities = await readProcessIdentities([process.pid, deadPid, 2147483647]);
    expect(identities.get(process.pid)).toBe(processIdentity(process.pid));
    expect(identities.get(process.pid)).toBeTruthy();
    expect(identities.has(2147483647)).toBe(false);
    // A newly reused PID may legitimately appear; it must never discard the live result.
    try { process.kill(deadPid, 0); } catch { expect(identities.has(deadPid)).toBe(false); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); });
  }
});
