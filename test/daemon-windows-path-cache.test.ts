import { EventEmitter } from "node:events";
import * as processes from "node:child_process";
import * as files from "node:fs";
import { existsSync, linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

// Pass-through lstat adapter: the ORIGINAL native call unless a test SIMULATES a
// swapped object (Windows refuses renaming a HOME whose store is open).
const fsOriginals = vi.hoisted(() => ({ lstatSync: undefined as typeof import("node:fs").lstatSync | undefined }));
vi.mock("node:fs", async importOriginal => {
  const native = await importOriginal<typeof import("node:fs")>(); fsOriginals.lstatSync = native.lstatSync;
  const lstatSync = vi.fn(native.lstatSync);
  return { ...native, lstatSync, default: { ...(Reflect.get(native, "default") ?? native), lstatSync } };
});
function simulateSwapped(path: string) {
  vi.mocked(files.lstatSync).mockImplementation(((target: string, options?: object) => {
    const stat = Reflect.apply(fsOriginals.lstatSync!, files, [target, options]) as files.BigIntStats;
    if (target !== path) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: stat.ino + 1n });
  }) as typeof files.lstatSync);
}
async function serving(at = home) {
  const pipe = resolvePipePath(at, {}), ownReservation = await EndpointReservation.bind(pipe);
  const owned = new Broker(pipe, new MessageStore(resolveDbPath(at), nullLogger), nullLogger, "fixture-token"); owned.setHostingMode("daemon");
  await owned.listen(ownReservation);
  return { owned, ownReservation };
}
const fresh = (b: Broker) => { const end = performance.now() + 5000; return { end, cap: b.lifecycleServingCapability("prepare", end) }; };

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
  vi.mocked(files.lstatSync).mockReset().mockImplementation(fsOriginals.lstatSync!);
  vi.mocked(processes.spawn).mockReset().mockImplementation(((command: string, args?: readonly string[], options?: object) => {
    const helper = helperOf(args);
    if (!helper) return Reflect.apply(originals.spawn!, processes, [command, args, options]);
    spawned.push(helper); return fakeHelper(helper);
  }) as typeof processes.spawn);
  env = makeEnv(); home = join(env.home, "home"); mkdirSync(home);
});
afterEach(async () => {
  vi.mocked(processes.spawn).mockReset().mockImplementation(originals.spawn!);
  vi.mocked(files.lstatSync).mockReset().mockImplementation(fsOriginals.lstatSync!);
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
  it("a bootstrap preparation moves the identity and HOME helpers out of the timed bootstrap, bound to its exact owner", async () => {
    const pipe = resolvePipePath(home, {}); reservation = await EndpointReservation.bind(pipe);
    broker = new Broker(pipe, new MessageStore(resolveDbPath(home), nullLogger), nullLogger, "fixture-token"); broker.setHostingMode("daemon");
    await broker.listen(reservation);
    const prepareEnd = performance.now() + 5000;
    const preparation = await LifecycleJournal.prepareServingBootstrap(broker.lifecycleServingCapability("prepare", prepareEnd), prepareEnd);
    expect(spawned).toEqual(["identity", "inspect"]);
    // Only the exact source-minted record works; a caller-made object is refused before any helper.
    const forgedEnd = performance.now() + 5000;
    await expect(LifecycleJournal.bootstrapServing(broker.lifecycleServingCapability("prepare", forgedEnd), forgedEnd, Object.freeze({})))
      .rejects.toThrow("unavailable");
    expect(spawned).toEqual(["identity", "inspect"]); expect(existsSync(directory())).toBe(false);
    const end = performance.now() + 5000;
    journal = await LifecycleJournal.bootstrapServing(broker.lifecycleServingCapability("prepare", end), end, preparation);
    expect(spawned).toEqual(["identity", "inspect", "create", "inspect"]);
  });
  it("a HOME verdict (the preparation's) refuses and forgets a swapped HOME without a helper", async () => {
    const owner = randomUUID();
    await verifyWindowsLifecyclePaths(home, owner, "prepare", "home", performance.now() + 5000);
    expect(spawned).toEqual(["inspect"]); expect(hasVerifiedWindowsLifecyclePaths(home, owner, "home")).toBe(true);
    const proof = cachedWindowsLifecyclePathProof(home, owner, "prepare", "home", performance.now() + 5000);
    assertWindowsLifecyclePathProof(proof, home, owner, "prepare", "home");
    renameSync(home, join(env.home, "retained-home")); mkdirSync(home);
    expect(() => cachedWindowsLifecyclePathProof(home, owner, "prepare", "home", performance.now() + 5000)).toThrow("unsafe_path");
    expect(hasVerifiedWindowsLifecyclePaths(home, owner, "home")).toBe(false); expect(spawned).toEqual(["inspect"]);
  });
  it("a journal hardlinked from outside the lifecycle directory is refused by the cached check", async () => {
    establishedObjects(); const owner = randomUUID();
    await verifyWindowsLifecyclePaths(home, owner, "prepare", "established", performance.now() + 5000);
    cachedWindowsLifecyclePathProof(home, owner, "admission", "established", performance.now() + 1000);
    linkSync(join(directory(), "receipts.sqlite-journal"), join(env.home, "outside-journal-link"));
    expect(() => cachedWindowsLifecyclePathProof(home, owner, "admission", "established", performance.now() + 1000)).toThrow("unsafe_path");
    expect(hasVerifiedWindowsLifecyclePaths(home, owner, "established")).toBe(false);
    await expect(verifyWindowsLifecyclePaths(home, owner, "prepare", "established", performance.now() + 5000)).rejects.toMatchObject({ reason: "unsafe_path" });
    expect(spawned).toEqual(["inspect"]);
  });
  it("a HOME swapped between preparation and bootstrap refuses before creating objects", async () => {
    ({ owned: broker, ownReservation: reservation } = await serving());
    const setup = fresh(broker), preparation = await LifecycleJournal.prepareServingBootstrap(setup.cap, setup.end);
    const run = fresh(broker); // Minted before the swap; the serving binding also re-checks HOME identity.
    simulateSwapped(assertLifecycleServingCapability(setup.cap, "prepare").home);
    await expect(LifecycleJournal.bootstrapServing(run.cap, run.end, preparation)).rejects.toThrow("unavailable");
    expect(existsSync(directory())).toBe(false); expect(spawned).toEqual(["identity", "inspect"]);
  });
  it("a preparation is single-use: reuse after a bootstrap attempt is refused", async () => {
    ({ owned: broker, ownReservation: reservation } = await serving());
    const setup = fresh(broker), preparation = await LifecycleJournal.prepareServingBootstrap(setup.cap, setup.end);
    mkdirSync(directory()); // The first attempt consumes the preparation, then refuses the existing directory.
    const first = fresh(broker);
    await expect(LifecycleJournal.bootstrapServing(first.cap, first.end, preparation)).rejects.toMatchObject({ reason: "publication_unproved" });
    rmSync(directory(), { recursive: true });
    const again = fresh(broker);
    await expect(LifecycleJournal.bootstrapServing(again.cap, again.end, preparation)).rejects.toThrow("unavailable");
    expect(existsSync(directory())).toBe(false); expect(spawned).toEqual(["identity", "inspect"]);
  });
  it("a preparation is refused for another broker, after expiry, after revocation and after a new owner generation", async () => {
    ({ owned: broker, ownReservation: reservation } = await serving());
    const forOther = await (async () => { const setup = fresh(broker!); return LifecycleJournal.prepareServingBootstrap(setup.cap, setup.end); })();
    const forExpiry = await (async () => { const setup = fresh(broker!); return LifecycleJournal.prepareServingBootstrap(setup.cap, setup.end); })();
    const forRevoked = await (async () => { const setup = fresh(broker!); return LifecycleJournal.prepareServingBootstrap(setup.cap, setup.end); })();
    // Another broker (other owner and HOME).
    const otherHome = join(env.home, "other-home"); mkdirSync(otherHome);
    const other = await serving(otherHome);
    try {
      const run = fresh(other.owned);
      await expect(LifecycleJournal.bootstrapServing(run.cap, run.end, forOther)).rejects.toThrow("unavailable");
      expect(existsSync(join(otherHome, ".core-lifecycle"))).toBe(false);
    } finally { await other.owned.close(); await other.ownReservation.close(); }
    // Expired: SIMULATED clock past the setup deadline plus one bootstrap budget.
    const realNow = performance.now.bind(performance), offset = 10_001;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset);
    try {
      const late = fresh(broker);
      await expect(LifecycleJournal.bootstrapServing(late.cap, late.end, forExpiry)).rejects.toThrow("unavailable");
    } finally { clock.mockRestore(); }
    // Revoked: the serving binding closes; a pre-revocation capability is dead.
    const before = fresh(broker);
    await broker.close(); await reservation!.close(); broker = undefined; reservation = undefined;
    await expect(LifecycleJournal.bootstrapServing(before.cap, before.end, forRevoked)).rejects.toThrow("unavailable");
    // A new broker on the same HOME is a new owner generation; the old preparation stays refused.
    ({ owned: broker, ownReservation: reservation } = await serving());
    const replay = fresh(broker);
    await expect(LifecycleJournal.bootstrapServing(replay.cap, replay.end, forRevoked)).rejects.toThrow("unavailable");
    expect(existsSync(directory())).toBe(false);
    expect(spawned).toEqual(["identity", "inspect", "identity", "inspect", "identity", "inspect"]);
  });
});
