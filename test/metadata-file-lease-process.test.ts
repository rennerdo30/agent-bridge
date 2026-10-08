import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { metadataFileLease } from "../src/core/metadata-file-lease.js";

let home: string;
let child: ChildProcess | undefined;

beforeEach(async () => {
  const root = join(process.cwd(), ".agent-bridge-test");
  mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "lease-process-"));
  const bundle = await build({ entryPoints: ["src/core/metadata-file-lease.ts"], bundle: true, platform: "node", format: "esm", packages: "external", write: false });
  writeFileSync(join(home, "lease-helper.mjs"), bundle.outputFiles[0]!.contents);
  writeFileSync(join(home, "runner.mjs"), 'import { metadataFileLease } from "./lease-helper.mjs"; metadataFileLease(process.argv[2]); process.send({ ready: true }); setInterval(() => {}, 1000);\n');
  writeFileSync(join(home, "owner-data.txt"), "unique owner bytes");
});

afterEach(async () => {
  // Only the child created by this fixture is stopped; foreign processes are never selected.
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, "exit");
    child.kill("SIGKILL");
    await stopped;
  }
  child = undefined;
  expect(readFileSync(join(home, "owner-data.txt"), "utf8")).toBe("unique owner bytes");
  rmSync(home, { recursive: true, force: true });
});

describe("real metadata lease process death", () => {
  it("protects a live child, then recovers its established lease after killing that exact child", async () => {
    const path = join(home, "jobs.json.lock");
    child = spawn(process.execPath, [join(home, "runner.mjs"), path], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const proc = child;
    let stderr = "";
    proc.stderr?.on("data", chunk => { stderr += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      proc.once("message", message => { if (message && typeof message === "object" && "ready" in message) resolve(); else reject(new Error("unexpected child lease response")); });
      proc.once("error", reject);
      proc.once("exit", code => reject(new Error(`lease child exited ${code}: ${stderr}`)));
    });
    const original = readFileSync(path, "utf8");
    expect(JSON.parse(original)).toMatchObject({ version: 2, pid: proc.pid, identity: expect.any(String) });
    expect(() => metadataFileLease(path)).toThrow("live or unknown owner");
    const stopped = once(proc, "exit");
    proc.kill("SIGKILL");
    await stopped;
    const release = metadataFileLease(path);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
    const archive = join(home, ".metadata-leases", createHash("sha256").update("jobs.json.lock").digest("hex"), "archive");
    const archived = readdirSync(archive);
    expect(archived).toHaveLength(1);
    const saved = join(archive, archived[0]!);
    const record = readdirSync(saved).find(name => name.startsWith("released-v2."))!;
    expect(readFileSync(join(saved, record), "utf8")).toBe(original);
    release();
    expect(existsSync(path)).toBe(false);
  });
});
