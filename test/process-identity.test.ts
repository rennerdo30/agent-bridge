import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { processIdentity, readProcessIdentities } from "../src/core/process-identity.js";

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
