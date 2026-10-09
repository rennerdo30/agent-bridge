import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { guardRunnerErrors, guardServerErrors } from "../src/mcp/job-runner-errors.js";

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

it("attempts fallback stderr only once when a delayed pipe error escapes after reporting finishes", async () => {
  const events = new EventEmitter();
  const error = vi.fn(() => { throw new Error("logger unavailable"); });
  let delayed!: () => void;
  const pipeFailure = new Promise<void>(resolve => { delayed = resolve; });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementationOnce(() => {
    setImmediate(() => {
      events.emit("uncaughtException", Object.assign(new Error("broken stderr pipe"), { code: "EPIPE" }), "uncaughtException");
      delayed();
    });
    return true;
  }).mockImplementation(() => true);
  const release = guardRunnerErrors({ error }, events as unknown as Pick<NodeJS.Process, "on" | "off">);
  try {
    events.emit("unhandledRejection", new Error("escaped broker failure"));
    await pipeFailure;
    expect(stderr).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledTimes(2);
    events.emit("uncaughtException", new Error("later independent callback"), "uncaughtException");
    expect(error).toHaveBeenCalledTimes(3);
    expect(stderr).toHaveBeenCalledOnce();
  } finally { release(); stderr.mockRestore(); }
});

it("handles delayed normal-logger pipe failures locally and preserves other stderr listeners", async () => {
  const events = new EventEmitter();
  const existing = vi.fn();
  const stderr = Object.assign(new EventEmitter(), { write: vi.fn((_text: string) => {
    setImmediate(() => stderr.emit("error", Object.assign(new Error("broken logger pipe"), { code: "EPIPE" })));
    return true;
  }) });
  stderr.on("error", existing);
  const error = vi.fn(() => { stderr.write("normal logger write\n"); });
  const release = guardRunnerErrors({ error }, events as unknown as Pick<NodeJS.Process, "on" | "off">,
    stderr as unknown as Pick<NodeJS.WriteStream, "on" | "off" | "write">);
  try {
    expect(stderr.listenerCount("error")).toBe(2);
    events.emit("uncaughtException", new Error("first independent callback"), "uncaughtException");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(error).toHaveBeenCalledOnce();
    expect(stderr.write).toHaveBeenCalledOnce();
    expect(existing).toHaveBeenCalledOnce();
    events.emit("unhandledRejection", new Error("later independent callback"));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(error).toHaveBeenCalledTimes(2);
    expect(stderr.write).toHaveBeenCalledTimes(2);
    expect(existing).toHaveBeenCalledTimes(2);
  } finally { release(); }
  expect(stderr.listeners("error")).toEqual([existing]);
  expect(events.listenerCount("uncaughtException")).toBe(0);
  expect(events.listenerCount("unhandledRejection")).toBe(0);
});

it.each(["reject", "throw"])("keeps a real dedicated Node process usable after an escaped %s", async failure => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!; mkdirSync(root, { recursive: true });
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

it("guards the MCP server against a stray rejection with its own message (AB-246)", () => {
  const events = new EventEmitter(), error = vi.fn();
  const release = guardServerErrors({ error }, events as unknown as Pick<NodeJS.Process, "on" | "off">);
  expect(() => events.emit("unhandledRejection", new Error("No job master is currently connected."))).not.toThrow();
  expect(error).toHaveBeenCalledWith("unexpected background failure; MCP server kept running", expect.objectContaining({ event: "unhandledRejection" }));
  release();
  expect(events.listenerCount("unhandledRejection")).toBe(0);
});
