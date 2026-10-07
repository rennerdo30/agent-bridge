import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, it } from "vitest";
import { migrationLock } from "../src/core/migration-lock.js";

let home: string;
const children: ChildProcess[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-migrate-parallel-")); });
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); })));
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

it("migrates 6→7 once across six simultaneous processes with one protected snapshot", async () => {
  const path = join(home, "bridge.db"), db = new DatabaseSync(path);
  db.exec("CREATE TABLE owner_data(body); INSERT INTO owner_data VALUES('keep'); PRAGMA user_version=6;"); db.close();
  const bundle = join(home, "migrations.mjs");
  await build({ entryPoints: [join(import.meta.dirname, "../src/core/sqlite-migrations.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const script = `import { DatabaseSync } from 'node:sqlite'; import { migrateSqlite } from ${JSON.stringify(pathToFileURL(bundle).href)};
    const db = new DatabaseSync(${JSON.stringify(path)}); console.log('ready');
    process.stdin.once('data', () => { try { migrateSqlite(db, ${JSON.stringify(path)}, true, 7, [{version:7,sql:'CREATE TABLE job_delivery_routes(id TEXT PRIMARY KEY, recipient TEXT, consumed_at INTEGER); PRAGMA user_version=7;'}], {info(){},warn(){}}); console.log('migrated'); db.close(); process.exit(0); } catch(e) { console.error(e); db.close(); process.exit(1); } });`;
  const outcomes: Promise<{ code: number | null; output: string }>[] = [];
  const ready: Promise<void>[] = [];
  for (let i = 0; i < 6; i++) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
    let output = "";
    ready.push(new Promise<void>((resolve, reject) => {
      child.stdout!.on("data", (chunk) => { output += chunk; if (output.includes("ready")) resolve(); });
      child.once("error", reject); child.once("exit", () => { if (!output.includes("ready")) reject(new Error(output)); });
    }));
    child.stderr!.on("data", (chunk) => output += chunk);
    outcomes.push(new Promise((resolve) => child.once("exit", (code) => resolve({ code, output }))));
  }
  await Promise.all(ready); for (const child of children) child.stdin!.write("go\n");
  for (const result of await Promise.all(outcomes)) { expect(result.output).toContain("migrated"); expect(result.code, result.output).toBe(0); }
  const check = new DatabaseSync(path, { readOnly: true });
  try { expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(7); expect(check.prepare("SELECT body FROM owner_data").get()!.body).toBe("keep"); } finally { check.close(); }
  const snapshots = readdirSync(join(home, ".migration-snapshots")); expect(snapshots).toHaveLength(1);
  const before = new DatabaseSync(join(home, ".migration-snapshots", snapshots[0]!), { readOnly: true });
  try { expect(before.prepare("PRAGMA user_version").get()!.user_version).toBe(6); expect(before.prepare("SELECT body FROM owner_data").get()!.body).toBe("keep"); } finally { before.close(); }
});

it("recovers an exited writer lock without expiring a living process", () => {
  const path = join(home, "bridge.db");
  writeFileSync(`${path}.migration-lock`, JSON.stringify({ pid: 2147483647, nonce: "exited" }));
  const release = migrationLock(path);
  expect(JSON.parse(readFileSync(`${path}.migration-lock`, "utf8")).pid).toBe(process.pid);
  release(); expect(readdirSync(home)).toEqual([]);
});
