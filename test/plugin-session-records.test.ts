import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { liveRuntimeSessions, recordRuntimeSession } from "../src/core/plugin-runtime.js";

// AB-248: plugin-sessions records with reused PIDs must not look live, and records are retired (archived), not kept forever.
let home: string, child: ChildProcess;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ab-plugin-sessions-"));
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  await new Promise((r) => child.once("spawn", r));
});
afterEach(() => { child.kill(); rmSync(home, { recursive: true, force: true }); });

const record = (pid: number, startedAt: string) => JSON.stringify({ schemaVersion: 1, pid, client: "codex", version: "0.1.0", worker: "w.mjs", startedAt }) + "\n";

it("does not report a record whose PID now belongs to a process started after the launch", () => {
  const dir = join(home, "plugin-sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${child.pid}.json`), record(child.pid!, new Date(Date.now() - 3_600_000).toISOString()));
  expect(liveRuntimeSessions(home, "codex")).toEqual([]);
});

it("archives records of exited launches and of an earlier launch with the same PID, without backup copies", () => {
  const dir = join(home, "plugin-sessions");
  mkdirSync(dir, { recursive: true });
  const dead = 2_147_000_000, old = record(dead, new Date(0).toISOString());
  writeFileSync(join(dir, `${dead}.json`), old);
  const now = new Date().toISOString();
  recordRuntimeSession(home, { pid: process.pid, client: "codex", version: "0.1.0", worker: "a.mjs", startedAt: now });
  recordRuntimeSession(home, { pid: process.pid, client: "codex", version: "0.1.1", worker: "b.mjs", startedAt: now });
  expect(readdirSync(dir).filter((f) => f !== "archive").sort()).toEqual([`${process.pid}.json`]);
  const archived = readdirSync(join(dir, "archive")).map((f) => readFileSync(join(dir, "archive", f), "utf8"));
  expect(archived).toContain(old);
  expect(archived.some((text) => text.includes('"version":"0.1.0"') && text.includes(`"pid":${process.pid}`))).toBe(true);
  expect(existsSync(join(dir, `${dead}.json`))).toBe(false);
  expect(liveRuntimeSessions(home, "codex").map((s) => s.version)).toEqual(["0.1.1"]);
});
