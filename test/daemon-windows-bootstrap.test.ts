import { spawn } from "node:child_process";
import * as processes from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { EndpointReservation } from "../src/core/endpoint-reservation.js";
import { LifecycleJournal } from "../src/core/daemon-lifecycle.js";
import { pendingWindowsLifecycleVerifications } from "../src/core/lifecycle-windows.js";
import * as windowsLifecycle from "../src/core/lifecycle-windows.js";
import * as identities from "../src/core/process-identity.js";
import { MessageStore } from "../src/core/store.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

// Exact fixture-owned NEW HOME only. No real profile/ancestor ACL mutation.
const HOME = String.raw`
$ErrorActionPreference='Stop'
try {
  $r=[Console]::In.ReadToEnd() | ConvertFrom-Json
  if([IO.Directory]::Exists([string]$r.path)) { throw 'exists' }
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','None','None','Allow')))
  [void][IO.Directory]::CreateDirectory([string]$r.path,$acl)
  [Console]::WriteLine('fixture_ready')
} catch { [Console]::WriteLine('fixture_unknown'); exit 1 }
`;
let env: TestEnv, home: string, broker: Broker | undefined, reservation: EndpointReservation | undefined;
let journal: LifecycleJournal | undefined, captured: DatabaseSync | undefined;
const sqliteExec = DatabaseSync.prototype.exec;
beforeEach(async () => {
  env = makeEnv(); home = join(env.home, "home"); captured = undefined;
  if (process.platform !== "win32") return;
  const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(bin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(HOME, "utf16le").toString("base64")],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  let output = "";
  child.stdout.on("data", bytes => { output += String(bytes); });
  child.stdin.end(JSON.stringify({ path: home }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Owned bootstrap fixture unavailable")), 5000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Owned bootstrap fixture unavailable")); });
    child.once("close", code => { clearTimeout(timer); code === 0 && output.trim() === "fixture_ready" ? resolve() : reject(new Error("Owned bootstrap fixture unavailable")); });
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  // Exact isolated test handle disposal ONLY. No production rollback/force-close API.
  if (captured) { if (captured.isTransaction) sqliteExec.call(captured, "ROLLBACK"); captured.close(); captured = undefined; }
  if (journal) { expect(journal.close()).toBe(true); journal = undefined; }
  await broker?.close(); await reservation?.close(); broker = undefined; reservation = undefined;
  await until(() => pendingWindowsLifecycleVerifications() === 0); await env.cleanup();
});
async function serving() {
  const pipe = resolvePipePath(home, {});
  reservation = await EndpointReservation.bind(pipe);
  const store = new MessageStore(resolveDbPath(home), nullLogger);
  broker = new Broker(pipe, store, nullLogger, "fixture-token"); broker.setHostingMode("daemon");
  await broker.listen(reservation); return broker;
}
const directory = () => join(home, ".core-lifecycle");
const file = () => join(directory(), "receipts.sqlite");

describe.skipIf(process.platform !== "win32")("Windows exclusive-new serving bootstrap Boundary1 (not admission/restart acceptance)", () => {
  it("actual serving issuer publishes real committed lineage with protected new objects and a strict independent reader", async () => {
    const b = await serving(), end = performance.now() + 5000, cap = b.lifecycleServingCapability("prepare", end);
    const before = lstatSync(home, { bigint: true });
    journal = await LifecycleJournal.bootstrapServing(cap, end).catch(error => {
      const stages = ["configure", "schema", "commit", "file_flush", "journal_flush", "readonly_lineage", "final_guard"];
      if (error?.reason === "publication_unproved" && typeof error.bootstrapStage === "string" && stages.includes(error.bootstrapStage)) {
        const errnos = ["EPERM", "EBADF", "EACCES", "EIO", "unknown"];
        process.stderr.write("AB325 bootstrap fixture evidence " + JSON.stringify({ reason: "publication_unproved", bootstrapStage: error.bootstrapStage,
          flush_ok: typeof error.bootstrapFlushOk === "boolean" ? error.bootstrapFlushOk : undefined,
          flush_errno: typeof error.bootstrapFlushErrno === "string" && errnos.includes(error.bootstrapFlushErrno) ? error.bootstrapFlushErrno : undefined }) + "\n");
      }
      throw error;
    });
    expect(pendingWindowsLifecycleVerifications()).toBe(0);
    const after = lstatSync(home, { bigint: true });
    expect([after.dev, after.ino, after.birthtimeNs]).toEqual([before.dev, before.ino, before.birthtimeNs]);
    const reader = new DatabaseSync(file(), { readOnly: true });
    try {
      reader.exec("PRAGMA query_only=ON"); expect(reader.prepare("PRAGMA query_only").get()?.query_only).toBe(1);
      const lineage = JSON.parse(String(reader.prepare("SELECT json FROM lifecycle_lineage WHERE singleton=1").get()!.json));
      expect(lineage.schema).toBe(1); expect(lineage.lineage).toMatch(/^[a-f0-9-]{36}$/);
      for (const name of ["directory", "file", "journal"]) {
        expect(lineage[name].dev).toMatch(/^\d+$/); expect(lineage[name].ino).toMatch(/^[1-9]\d*$/); expect(lineage[name].creation).toMatch(/^\d+$/);
      }
      expect(() => reader.exec("UPDATE lifecycle_lineage SET json='untrusted' WHERE singleton=1")).toThrow();
    } finally { reader.close(); }
    // Boundary2's per-admission permission is deliberately absent: no guard bypass.
    expect(() => journal!.selected()).toThrow("lineage_unknown");
    expect(existsSync(file() + "-journal")).toBe(true);
  });
  it("copied authority, expired deadline and ordinary public Windows bootstrap cannot create objects", async () => {
    const b = await serving(), end = performance.now() + 5000, cap = b.lifecycleServingCapability("prepare", end);
    await expect(LifecycleJournal.bootstrapServing({ ...cap }, end)).rejects.toThrow("unavailable");
    await expect(LifecycleJournal.bootstrapServing(cap, performance.now() - 1)).rejects.toThrow("unavailable");
    const creationIdentity = await identities.readProcessIdentity(process.pid); expect(creationIdentity).toBeTruthy();
    await expect(LifecycleJournal.bootstrap(home, { nonce: "00000000-0000-4000-8000-000000000001", pid: process.pid, creationIdentity: creationIdentity! }))
      .rejects.toMatchObject({ reason: "publication_unproved" });
    expect(existsSync(directory())).toBe(false);
  });
  it("an existing partial directory and retained bytes are never adopted or repaired", async () => {
    const b = await serving(); mkdirSync(directory()); const sentinel = join(directory(), "retained"); writeFileSync(sentinel, Buffer.from([0, 255, 4]));
    const before = lstatSync(directory(), { bigint: true }), end = performance.now() + 5000;
    await expect(LifecycleJournal.bootstrapServing(b.lifecycleServingCapability("prepare", end), end)).rejects.toThrow("unavailable");
    expect(readFileSync(sentinel)).toEqual(Buffer.from([0, 255, 4])); expect(existsSync(file())).toBe(false);
    const after = lstatSync(directory(), { bigint: true }); expect([after.dev, after.ino, after.birthtimeNs]).toEqual([before.dev, before.ino, before.birthtimeNs]);
  });
  it("revocation during the real identity await refuses before object creation", async () => {
    const b = await serving(), end = performance.now() + 5000, cap = b.lifecycleServingCapability("prepare", end), real = windowsLifecycle.readOwnWindowsLifecycleIdentity;
    let entered!: () => void, resume!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(windowsLifecycle, "readOwnWindowsLifecycleIdentity").mockImplementation(async (sourceCap, deadline) => {
      const actual = real(sourceCap, deadline).then(value => ({ value }), error => ({ error }));
      entered(); await gate; const outcome = await actual;
      if ("error" in outcome) throw outcome.error; return outcome.value;
    });
    const start = LifecycleJournal.bootstrapServing(cap, end), failed = expect(start).rejects.toThrow("unavailable");
    await entering; await b.close(); resume(); await failed;
    expect(existsSync(directory())).toBe(false);
  });
  it("identity observer expiry retains the actual helper until its held real close, without creation or late promotion", async () => {
    const b = await serving(), cap = b.lifecycleServingCapability("prepare", performance.now() + 5000), realSpawn = processes.spawn;
    let actualClose!: () => void, deliverClose!: () => void, actualCode: number | null = null;
    const closed = new Promise<void>(resolve => { actualClose = resolve; });
    vi.spyOn(processes, "spawn").mockImplementation((...args: Parameters<typeof processes.spawn>) => {
      const child = Reflect.apply(realSpawn, processes, args) as ReturnType<typeof processes.spawn>, emit = child.emit.bind(child);
      vi.spyOn(child, "emit").mockImplementation((event: string | symbol, ...values: any[]) => {
        if (event !== "close") return Reflect.apply(emit, child, [event, ...values]);
        actualCode = values[0]; actualClose();
        let delivered = false;
        deliverClose = () => { expect(delivered).toBe(false); delivered = true; Reflect.apply(emit, child, [event, ...values]); };
        return true;
      });
      return child;
    });
    const end = performance.now() + 100;
    try {
      await expect(LifecycleJournal.bootstrapServing(cap, end)).rejects.toMatchObject({ reason: "budget" });
      expect(pendingWindowsLifecycleVerifications()).toBe(1); expect(existsSync(directory())).toBe(false);
    } finally { await closed; deliverClose(); }
    expect(actualCode).toBe(0); expect(pendingWindowsLifecycleVerifications()).toBe(0); expect(existsSync(directory())).toBe(false);
  });
  it("SIMULATED pre-COMMIT IO error retains actual owned transaction/objects without production cleanup or recreation", async () => {
    const b = await serving(), end = performance.now() + 5000, cap = b.lifecycleServingCapability("prepare", end);
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
      if (sql.includes("CREATE TABLE lifecycle_lineage")) captured = this;
      if (this === captured && sql === "COMMIT") throw new Error("SIMULATED VFS-style COMMIT error (not actual VFS fault)");
      return sqliteExec.call(this, sql);
    });
    await expect(LifecycleJournal.bootstrapServing(cap, end)).rejects.toMatchObject({ reason: "publication_unproved" });
    expect(captured).toBeInstanceOf(DatabaseSync); expect(captured!.isTransaction).toBe(true);
    const retained = [readFileSync(file()), readFileSync(file() + "-journal")];
    vi.restoreAllMocks();
    const againEnd = performance.now() + 5000;
    await expect(LifecycleJournal.bootstrapServing(b.lifecycleServingCapability("prepare", againEnd), againEnd)).rejects.toThrow("unavailable");
    expect([readFileSync(file()), readFileSync(file() + "-journal")]).toEqual(retained); expect(captured!.isTransaction).toBe(true);
  });
});
