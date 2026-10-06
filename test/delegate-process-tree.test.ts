import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { killTree, pidAlive } from "../src/core/delegate.js";

it("terminates a real owned tree while an independently supervised tool survives", async () => {
  const children: ChildProcess[] = [];
  const start = (source: string) => {
    const child = spawn(process.execPath, ["-e", source], {
      detached: process.platform !== "win32", windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(child);
    return child;
  };
  try {
    // The independent tool belongs to this test's supervisor, not to the delegate.
    const independent = start(`process.send("ready"); process.on("message", () => process.send("alive")); setInterval(() => {}, 1000);`);
    await once(independent, "message");
    const root = start(`
      const child = require("node:child_process").spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000)"], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      child.once("message", () => process.send(child.pid));
      // Reap the child before exiting on POSIX, including in containers whose PID 1
      // does not reap orphans. Windows taskkill /F bypasses these handlers.
      process.on("SIGTERM", () => {});
      child.once("exit", () => process.exit(0));
      setInterval(() => {}, 1000);
    `);
    const [descendantPid] = await once(root, "message");
    expect(pidAlive(descendantPid)).toBe(true);
    await killTree(root, "process isolation regression");
    // OS bookkeeping can lag process closure; bound the poll well below the CI timeout.
    for (let n = 0; n < 40 && pidAlive(descendantPid); n++) await delay(50);
    expect(pidAlive(descendantPid)).toBe(false);
    const alive = once(independent, "message");
    independent.send("ping");
    expect((await alive)[0]).toBe("alive");
  } finally {
    await Promise.all(children.map((child) => killTree(child, "test-owned cleanup")));
  }
});
