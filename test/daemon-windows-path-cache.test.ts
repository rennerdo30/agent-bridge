import { EventEmitter } from "node:events";
import * as processes from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker, assertLifecycleServingCapability } from "../src/core/broker.js";
import { EndpointReservation } from "../src/core/endpoint-reservation.js";
import { LifecycleJournal, LifecycleUnavailable } from "../src/core/daemon-lifecycle.js";
import { assertWindowsLifecyclePathProof, cachedWindowsLifecyclePathChecks, cachedWindowsLifecyclePathProof,
  hasVerifiedWindowsLifecyclePaths, pendingWindowsLifecycleVerifications, verifyWindowsLifecyclePaths } from "../src/core/lifecycle-windows.js";
import { MessageStore } from "../src/core/store.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

// SIMULATED helper processes at the existing spawn injection point. The ACL
// verdict itself is injected here (this machine's temp ancestors are not
// protected); hosted Windows CI judges the real INSPECT path elsewhere.
const originals = vi.hoisted(() => ({ spawn: undefined as typeof import("node:child_process").spawn | undefined }));
vi.mock("node:child_process", async importOriginal => {
  const native = await importOriginal<typeof import("node:child_process")>(); originals.spawn = native.spawn;
  const spawn = vi.fn(native.spawn);
  return { ...native, spawn, default: { ...(Reflect.get(native, "default") ?? native), spawn } };
});

type Helper = "inspect" | "identity" | "create";
let env: TestEnv, home: string, broker: Broker | undefined, reservation: EndpointReservation | undefined, journal: LifecycleJournal | undefined;
let spawned: Helper[], inspectVerdict: "verified" | "unsafe_acl";
const directory = () => join(home, ".core-lifecycle");

function helperOf(args: readonly string[] | undefined): Helper | undefined {
  const encoded = args?.[args.indexOf("-EncodedCommand") + 1];
  if (!encoded) return undefined;
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  return script.includes("GetAccessControl($path)") ? "inspect" : script.includes("Get-Process -Id") ? "identity"
    : script.includes("[IO.FileMode]::CreateNew") ? "create" : undefined;
}
function fakeHelper(helper: Helper) {
  const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end(input: string): void }; stdout: EventEmitter & { setEncoding(): void }; unref(): void; pid: number };
  child.pid = 0; child.unref = () => {};
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = Object.assign(new EventEmitter(), { end(input: string) {
    const request = JSON.parse(input) as { nonce: string; home?: string };
    let response: Record<string, unknown>;
    if (helper === "identity") response = { schema: 1, nonce: request.nonce, status: "verified", pid: process.pid, creationTicks: "638000000000000000" };
    else if (helper === "create") {
      for (const name of ["receipts.sqlite", "receipts.sqlite-journal"]) writeFileSync(join(request.home!, ".core-lifecycle", name), "", { flag: "wx" });
      response = { schema: 1, nonce: request.nonce, status: "created" };
    } else response = inspectVerdict === "verified" ? { schema: 1, nonce: request.nonce, status: "verified", filesystem: "NTFS" }
      : { schema: 1, nonce: request.nonce, status: "unsafe_acl", rule: "foreign_write", role: "directory", ancestorDepth: 0, ownerClass: "current" };
    setImmediate(() => { child.stdout.emit("data", JSON.stringify(response)); setImmediate(() => child.emit("close", 0)); });
  } });
  return child;
}
beforeEach(() => {
  spawned = []; inspectVerdict = "verified";
  vi.mocked(processes.spawn).mockReset().mockImplementation(((command: string, args?: readonly string[], options?: object) => {
    const helper = helperOf(args);
    if (!helper) return Reflect.apply(originals.spawn!, processes, [command, args, options]);
    spawned.push(helper); return fakeHelper(helper);
  }) as typeof processes.spawn);
  env = makeEnv(); home = join(env.home, "home"); mkdirSync(home);
});
afterEach(async () => {
  vi.mocked(processes.spawn).mockReset().mockImplementation(originals.spawn!);
  vi.restoreAllMocks();
  if (journal) { journal.close(); journal = undefined; }
  await broker?.close(); await reservation?.close(); broker = undefined; reservation = undefined;
  await until(() => pendingWindowsLifecycleVerifications() === 0); await env.cleanup();
});
function establishedObjects() {
  mkdirSync(directory());
  for (const name of ["receipts.sqlite", "receipts.sqlite-journal"]) writeFileSync(join(directory(), name), "");
}

describe.skipIf(process.platform !== "win32")("Windows lifecycle verified-path cache (no helper inside timed phases)", () => {
  it("reuses one fresh verdict for every phase without another helper spawn", async () => {
    establishedObjects(); const owner = randomUUID();
    expect(hasVerifiedWindowsLifecyclePaths(home, owner, "established")).toBe(false);
    await verifyWindowsLifecyclePaths(home, owner, "prepare", "established", performance.now() + 5000);
    expect(spawned).toEqual(["inspect"]); expect(hasVerifiedWindowsLifecyclePaths(home, owner, "established")).toBe(true);
    const before = cachedWindowsLifecyclePathChecks();
    for (const phase of ["admission", "prepare", "write"] as const) {
      const proof = cachedWindowsLifecyclePathProof(home, owner, phase, "established", performance.now() + 1000);
      assertWindowsLifecyclePathProof(proof, home, owner, phase, "established");
      expect(() => assertWindowsLifecyclePathProof(proof, home, owner, phase === "write" ? "admission" : "write", "established")).toThrow("unavailable");
    }
    expect(cachedWindowsLifecyclePathChecks() - before).toBe(3); expect(spawned).toEqual(["inspect"]);
    expect(() => cachedWindowsLifecyclePathProof(home, owner, "admission", "established", performance.now() - 1)).toThrow("budget");
  });
  it("refuses a never verified home, owner or scope without a helper", async () => {
    establishedObjects(); const owner = randomUUID();
    expect(() => cachedWindowsLifecyclePathProof(home, owner, "admission", "established", performance.now() + 1000)).toThrow("unavailable");
    await verifyWindowsLifecyclePaths(home, owner, "prepare", "established", performance.now() + 5000);
    expect(() => cachedWindowsLifecyclePathProof(home, randomUUID(), "admission", "established", performance.now() + 1000)).toThrow("unavailable");
    expect(() => cachedWindowsLifecyclePathProof(join(env.home, "other"), owner, "admission", "established", performance.now() + 1000)).toThrow("unavailable");
    expect(() => cachedWindowsLifecyclePathProof(home, owner, "admission", "home", performance.now() + 1000)).toThrow("unavailable");
    expect(spawned).toEqual(["inspect"]);
  });
  it("refuses and forgets a swapped lifecycle directory, recreated journal or touched directory", async () => {
    const owner = randomUUID(), verify = () => verifyWindowsLifecyclePaths(home, owner, "prepare", "established", performance.now() + 5000);
    const cached = () => cachedWindowsLifecyclePathProof(home, owner, "admission", "established", performance.now() + 1000);
    establishedObjects(); await verify(); cached();
    // Swapped directory: same names, new objects.
    renameSync(directory(), join(home, "retained-original")); establishedObjects();
    expect(cached).toThrow("unsafe_path"); expect(hasVerifiedWindowsLifecyclePaths(home, owner, "established")).toBe(false);
    expect(cached).toThrow("unavailable"); // Forgotten: only a fresh observation can restore it.
    await verify(); cached();
    // Recreated journal file inside the same directory.
    rmSync(join(directory(), "receipts.sqlite-journal")); writeFileSync(join(directory(), "receipts.sqlite-journal"), "");
    expect(cached).toThrow("unsafe_path"); expect(hasVerifiedWindowsLifecyclePaths(home, owner, "established")).toBe(false);
    await verify(); cached();
    // A directory entry change moves the directory stamps even when every object identity stays.
    writeFileSync(join(directory(), "fixture-entry"), ""); rmSync(join(directory(), "fixture-entry"));
    expect(cached).toThrow("unsafe_path");
    expect(spawned).toEqual(["inspect", "inspect", "inspect"]);
  });
  it("a refused fresh observation removes the earlier verdict", async () => {
    establishedObjects(); const owner = randomUUID();
    await verifyWindowsLifecyclePaths(home, owner, "prepare", "established", performance.now() + 5000);
    inspectVerdict = "unsafe_acl";
    await expect(verifyWindowsLifecyclePaths(home, owner, "prepare", "established", performance.now() + 5000)).rejects.toMatchObject({ reason: "unsafe_acl" });
    expect(hasVerifiedWindowsLifecyclePaths(home, owner, "established")).toBe(false);
    expect(() => cachedWindowsLifecyclePathProof(home, owner, "admission", "established", performance.now() + 1000)).toThrow("unavailable");
  });
  it("serving phases after bootstrap spawn no helper while the verdict holds, and refuse a changed directory", async () => {
    const pipe = resolvePipePath(home, {}); reservation = await EndpointReservation.bind(pipe);
    broker = new Broker(pipe, new MessageStore(resolveDbPath(home), nullLogger), nullLogger, "fixture-token"); broker.setHostingMode("daemon");
    await broker.listen(reservation);
    const end = performance.now() + 5000, initial = broker.lifecycleServingCapability("prepare", end);
    journal = await LifecycleJournal.bootstrapServing(initial, end);
    expect(spawned).toEqual(["identity", "inspect", "create", "inspect"]);
    const actual = assertLifecycleServingCapability(initial, "prepare");
    const input = { restartId: randomUUID(), operation: "restart" as const,
      oldInstance: { nonce: actual.ownerInstance, pid: process.pid, creationIdentity: "638000000000000000" },
      target: { immutableRuntimePath: join(home, "fixture-runtime.mjs"), version: "fixture", protocol: 1, fileManifestDigest: "a".repeat(64) } };
    const checks = cachedWindowsLifecyclePathChecks();
    const admitEnd = performance.now() + 1000;
    expect((await journal.admitServing(broker.lifecycleServingCapability("admission", admitEnd), input, admitEnd)).revision).toBe(1);
    const writeEnd = performance.now() + 2000;
    expect((await journal.advanceServing(broker.lifecycleServingCapability("write", writeEnd), input.restartId, 1, "preparing", {}, writeEnd)).revision).toBe(2);
    const readEnd = performance.now() + 5000;
    expect((await journal.selectedServing(broker.lifecycleServingCapability("prepare", readEnd), readEnd))?.revision).toBe(2);
    expect(spawned).toEqual(["identity", "inspect", "create", "inspect"]); expect(cachedWindowsLifecyclePathChecks() - checks).toBe(3);
    // Changed directory identity: refused in-phase, without a helper and without SQL effects.
    writeFileSync(join(directory(), "fixture-entry"), ""); rmSync(join(directory(), "fixture-entry"));
    const changedEnd = performance.now() + 1000;
    await expect(journal.admitServing(broker.lifecycleServingCapability("admission", changedEnd), { ...input, restartId: randomUUID() }, changedEnd))
      .rejects.toBeInstanceOf(LifecycleUnavailable);
    expect(spawned).toEqual(["identity", "inspect", "create", "inspect"]);
    expect(hasVerifiedWindowsLifecyclePaths(actual.home, actual.ownerInstance, "established")).toBe(false);
    // Next phase has no verdict: the unchanged fresh observation runs (and may refuse).
    inspectVerdict = "unsafe_acl";
    const refusedEnd = performance.now() + 5000;
    await expect(journal.selectedServing(broker.lifecycleServingCapability("prepare", refusedEnd), refusedEnd)).rejects.toBeInstanceOf(LifecycleUnavailable);
    expect(spawned).toEqual(["identity", "inspect", "create", "inspect", "inspect"]);
  });
});
