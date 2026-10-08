import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { guardRunnerErrors } from "../src/mcp/job-runner-errors.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it("logs both escaped callback failures without recursion and removes only its own listeners", () => {
  const events = new EventEmitter();
  const existing = vi.fn(); events.on("unhandledRejection", existing);
  const error = vi.fn().mockImplementationOnce(() => {
    events.emit("uncaughtException", new Error("nested logger failure"), "uncaughtException");
    throw new Error("logger unavailable");
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => { throw new Error("stderr unavailable"); });
  try {
    const release = guardRunnerErrors({ error }, events as unknown as Pick<NodeJS.Process, "on" | "off">);
    expect(() => events.emit("unhandledRejection", new Error("escaped broker timeout"))).not.toThrow();
    expect(() => events.emit("uncaughtException", new Error("escaped timer callback"), "uncaughtException")).not.toThrow();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls.map(call => call[1].event)).toEqual(["unhandledRejection", "uncaughtException"]);
    release(); release();
    expect(events.listeners("unhandledRejection")).toEqual([existing]);
    expect(events.listenerCount("uncaughtException")).toBe(0);
  } finally { stderr.mockRestore(); }
});

it.each(["reject", "throw"])("keeps a real dedicated Node process usable after an escaped %s", async failure => {
  const root = join(process.cwd(), ".agent-bridge-test"); mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, "runner-errors-")); homes.push(home);
  const entry = join(home, "fixture.ts"), outfile = join(home, "fixture.mjs");
  const helper = resolve("src/mcp/job-runner-errors.ts").replaceAll("\\", "/");
  writeFileSync(entry, `import { guardRunnerErrors } from ${JSON.stringify(helper)};
    const release = guardRunnerErrors({error: (_message, data) => console.log(data.event)});
    setTimeout(() => { ${failure === "throw" ? 'throw new Error("callback failed");' : 'void Promise.reject(new Error("request timed out"));'} }, 0);
    setTimeout(() => {
      console.log("later control and active turn finished");
      release();
      console.log("guards:" + process.listenerCount("unhandledRejection") + ":" + process.listenerCount("uncaughtException"));
    }, 50);
  `);
  await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const result = await promisify(execFile)(process.execPath, ["--unhandled-rejections=strict", outfile], { timeout: 5_000 });
  expect(result.stdout).toContain(failure === "throw" ? "uncaughtException" : "unhandledRejection");
  expect(result.stdout).toContain("later control and active turn finished");
  expect(result.stdout).toContain("guards:0:0");
});
