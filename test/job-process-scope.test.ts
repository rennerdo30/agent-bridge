import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { killTree, pidAlive } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import { processCleanupReport, startWindowsJobScope, type WindowsJobScope } from "../src/core/windows-job-scope.js";

it("reports cleanup counts and exact remaining ownership identities", () => {
  expect(processCleanupReport({ stopped: [123, 456], remaining: [] })).toBe("Background process cleanup: stopped 2 surviving job-owned processes (PIDs 123, 456); 0 still running.");
  expect(processCleanupReport({ stopped: [], remaining: [789] })).toContain("1 still running (PIDs 789)");
});

it.skipIf(process.platform !== "win32")("contains orphaned detached tools while its owner and a sibling stay alive", async () => {
  const children: ChildProcess[] = [];
  const start = (source: string) => {
    const child = spawn(process.execPath, ["-e", source], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.push(child);
    return child;
  };
  let scope: WindowsJobScope | undefined;
  let orphan: number | undefined;
  const sibling = start(`process.send('ready'); process.on('message', () => process.send('alive')); setInterval(() => {},1000);`);
  const runner = start(`
    process.send('ready'); setInterval(() => {},1000);
    process.on('message', () => {
      const code = "const c=require('node:child_process').spawn(process.execPath,['-e',\\\"process.send('ready');setInterval(()=>{},1000);\\\"],{detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>{process.send(c.pid);c.disconnect();process.exit(0);});";
      const intermediate=require('node:child_process').spawn(process.execPath,['-e',code],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
      let pid; intermediate.once('message', n=>pid=n);
      intermediate.once('exit',()=>process.send(pid));
    });
  `);
  try {
    await Promise.all([once(sibling, "message"), once(runner, "message")]);
    scope = await startWindowsJobScope(nullLogger, runner.pid!);
    const launch = async () => {
      const message = once(runner, "message"); runner.send("start");
      const [pid] = await message; orphan = pid;
      expect(pidAlive(pid)).toBe(true);
      return pid as number;
    };
    const pid = await launch();
    const cleanup = await scope.cleanup();
    expect(cleanup.remaining).toEqual([]);
    expect(cleanup.stopped).toContain(pid);
    expect(cleanup.stopped).not.toContain(runner.pid);
    expect(pidAlive(pid)).toBe(false);
    expect(pidAlive(runner.pid!)).toBe(true);
    const alive = once(sibling, "message"); sibling.send("ping");
    expect((await alive)[0]).toBe("alive");
    // Membership also protects the short window between cleanup and runner exit/report delivery.
    const late = await launch();
    const closed = once(scope.guardian, "close");
    scope.detach();
    await killTree(runner, "test-owned runner exit");
    await closed;
    for (let n = 0; n < 40 && pidAlive(late); n++) await delay(50);
    expect(pidAlive(late)).toBe(false);
    expect(pidAlive(sibling.pid!)).toBe(true);
  } finally {
    scope?.detach();
    await Promise.all(children.map(child => killTree(child, "test-owned cleanup")));
    // Only this fixture can have created this PID. The guardian owns its immutable job membership.
    if (orphan && pidAlive(orphan)) throw new Error("Test-owned orphan did not stop");
  }
});
