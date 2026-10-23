import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { CONNECT_TIMEOUT_MS, MAX_FRAME_BYTES, PROTOCOL_VERSION } from "../src/core/constants.js";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import { guardPriorEndpoints, priorEndpoints } from "../src/core/prior-endpoints.js";
import { BridgeError, encodeFrame, FrameDecoder, type RequestFrame } from "../src/core/protocol.js";
import { assertCompatibleMailboxReaders, storageLease } from "../src/core/storage-lock.js";
import { deliveryFailure } from "../src/mcp/delivery-evidence.js";
import * as processIdentity from "../src/core/process-identity.js";

const io = vi.hoisted(() => ({ connect: vi.fn(), lstat: vi.fn(), write: vi.fn(), read: vi.fn(), stat: vi.fn(), fds: new Map<number, string>(), actualLstat: undefined as any, actualWrite: undefined as any, actualRead: undefined as any, actualStat: undefined as any }));
vi.mock("node:timers/promises", async original => ({ ...await original<typeof import("node:timers/promises")>(),
  setTimeout: (ms: number, value: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(value); }, ms);
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(signal!.reason); };
    signal?.addEventListener("abort", aborted, { once: true });
  }) }));
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(), connect: io.connect }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>(); io.actualLstat = actual.lstatSync; io.actualWrite = actual.writeSync;
  io.actualRead = actual.readFileSync; io.actualStat = actual.statSync;
  return { ...actual, lstatSync: io.lstat, writeSync: io.write, readFileSync: io.read, statSync: io.stat,
    openSync: (...args: Parameters<typeof actual.openSync>) => { const fd = actual.openSync(...args); io.fds.set(fd, String(args[0])); return fd; },
    closeSync: (fd: number) => { try { actual.closeSync(fd); } finally { io.fds.delete(fd); } },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const path = io.fds.get(fd);
      if (path?.includes(".storage-users")) return Buffer.from(io.read(path, "utf8")).copy(buffer, offset, position, position + length);
      return actual.readSync(fd, buffer, offset, length, position);
    } };
});
let home: string, file: string, original: Buffer, live: string | undefined;
let inspections = 0, busy = 0;
const sockets: { destroyed: boolean }[] = [];
const wireRequests: RequestFrame[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
beforeEach(() => {
  live = undefined; inspections = 0; busy = 0; sockets.length = 0; wireRequests.length = 0;
  io.write.mockImplementation(io.actualWrite);
  io.read.mockImplementation(io.actualRead); io.stat.mockImplementation(io.actualStat);
  io.lstat.mockImplementation((path: string, ...args: any[]) => {
    if (path === live || live && path === dirname(live)) return {
      isSocket: () => path === live, isDirectory: () => path !== live, isSymbolicLink: () => false,
      uid: process.getuid?.(), mode: 0o700,
    };
    return io.actualLstat(path, ...args);
  });
  io.connect.mockImplementation((path: string) => {
    const decoder = new FrameDecoder(MAX_FRAME_BYTES);
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false,
      setEncoding(encoding: string) { expect(encoding).toBe("utf8"); return this; },
      end() { return this; },
      destroy(this: EventEmitter & { destroyed: boolean }) { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; },
      write(bytes: string) {
        for (const frame of decoder.push(bytes)) {
          if (frame.t !== "req") throw new Error("Fixture accepts request frames only");
          wireRequests.push(frame);
          const reply = encodeFrame({ t: "res", id: frame.id, ok: false, error: { code: "protocol_mismatch", message: "Fixture prior protocol", details: { brokerProtocol: 7 } } });
          // Split the reply: exercise the real BridgeClient decoder/settlement,
          // rather than returning a stubbed request rejection.
          queueMicrotask(() => { if (!socket.destroyed) { socket.emit("data", reply.slice(0, 9)); socket.emit("data", reply.slice(9)); } });
        }
        return true;
      },
    }); sockets.push(socket);
    queueMicrotask(() => { if (!socket.destroyed) path === live ? socket.emit("connect") : socket.emit("error", Object.assign(new Error("fixture absent"), { code: "ENOENT" })); });
    return socket;
  });
  home = mkdtempSync(join(tmpdir(), "ab-prior-inspection-")); file = join(home, "bridge.db");
  const db = new DatabaseSync(file); db.exec("PRAGMA user_version=14; CREATE TABLE retained(body TEXT); INSERT INTO retained VALUES ('accepted original bytes')"); db.close();
  original = readFileSync(file);
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql === "PRAGMA user_version") {
      inspections++;
      if (busy-- > 0) throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    }
    return prepare.call(this, sql);
  });
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  if (getuid) Object.defineProperty(process, "getuid", getuid); else Reflect.deleteProperty(process, "getuid");
  closeMetadataDbs(); expect(io.fds.size).toBe(0); expect(sockets.every(socket => socket.destroyed)).toBe(true);
  io.connect.mockReset(); io.lstat.mockReset(); rmSync(home, { recursive: true, force: true });
});
const guard = (signal?: AbortSignal) => guardPriorEndpoints(home, "fixture-current", "fixture-only-token", nullLogger, signal);
const unchanged = () => { expect(readFileSync(file).equals(original)).toBe(true); expect(readdirSync(home)).toEqual(["bridge.db"]); };

it("retains bounded phase evidence when identity plus actual fresh schema work exhausts admission", async () => {
  const { openMessageStore } = await import("../src/core/store.js"), migrations = await import("../src/core/sqlite-migrations.js");
  const fs = await import("node:fs"), fresh = join(home, "owned-fresh"); fs.mkdirSync(fresh);
  let clock = Date.now(); const start = clock;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(processIdentity, "ownProcessIdentity").mockImplementation(async () => { clock += 1750; return "bounded-fixture"; });
  const migrate = migrations.migrateSqlite;
  vi.spyOn(migrations, "migrateSqlite").mockImplementation((...args) => {
    migrate(...args); if (args[1] === join(fresh, "bridge.db")) clock += 300;
  });
  const error = await openMessageStore(join(fresh, "bridge.db"), nullLogger, "fixture-current", "fixture-only-token").then(() => undefined, failure => failure);
  expect(error).toMatchObject({ code: "timeout", details: { admission: {
    elapsedMs: 2050, phases: expect.arrayContaining([
      { phase: "identity", calls: 1, ms: 1750, pending: 0 },
      { phase: "main-schema", calls: 1, ms: 300, pending: 0 },
    ]) } } });
  expect(clock - start).toBe(2050); expect(JSON.stringify(error.details)).not.toContain(fresh);
  // Native schema effects already returned; this evidence cannot claim a clean
  // no-effects refusal or admit a handle after the original deadline.
  const retained = new DatabaseSync(join(fresh, "bridge.db"), { readOnly: true });
  try { expect(retained.prepare("PRAGMA user_version").get()!.user_version).toBe(14); }
  finally { retained.close(); }
  expect(readFileSync(file)).toEqual(original);
});

it.each(["linux", "darwin", "win32"] as const)("rechecks prior endpoints after a suspended successful census before admitting storage on %s", async target => {
  Object.defineProperty(process, "platform", { ...platform, value: target });
  if (!getuid) Object.defineProperty(process, "getuid", { configurable: true, value: () => 42 });
  const fs = await import("node:fs"), dir = join(home, ".storage-users"), pid = process.pid + 2_000_000;
  fs.mkdirSync(dir); fs.writeFileSync(join(dir, `${pid}-original`), JSON.stringify({ pid, nonce: "original", createdAt: Date.now(), mailboxProtocol: 7, mailboxSchema: 14 }));
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.spyOn(processIdentity, "identityStartedAfter").mockReturnValue(true);
  let finish: ((identity: string) => void) | undefined;
  const stop = new AbortController();
  const query = vi.spyOn(processIdentity, "readProcessIdentity").mockImplementation((_pid, signal) => new Promise((resolve, reject) => {
    const aborted = () => { signal?.removeEventListener("abort", aborted); reject(signal!.reason); };
    signal?.addEventListener("abort", aborted, { once: true });
    finish = identity => { signal?.removeEventListener("abort", aborted); resolve(identity); };
  }));
  const effect = vi.fn(); const pending = guard(stop.signal).then(effect, error => error);
  try {
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    if (target !== "win32") expect(io.connect).not.toHaveBeenCalled();
    expect(wireRequests).toEqual([]); // Endpoint is not published yet.
    live = priorEndpoints(home).find(endpoint => endpoint.includes("p7"))!;
    finish!(new Date(Date.now() + 10_000).toString());
    const refusal = await pending;
    expect(refusal).toMatchObject({ code: "protocol_mismatch" });
    expect(deliveryFailure(refusal).protocol?.source).toBe("prior-endpoint");
    expect(effect).not.toHaveBeenCalled(); expect(readFileSync(file)).toEqual(original);
    expect(vi.isMockFunction(BridgeClient.connect)).toBe(false);
    expect(wireRequests).toEqual(target === "win32" ? [] : [{ t: "req", id: 1, op: "auth", args: { protocol: PROTOCOL_VERSION, token: "fixture-only-token" } }]);
  } finally {
    stop.abort(); finish?.(""); await pending;
  }
});

it("never repeats synchronous process creation queries at the actual store constructor boundary", async () => {
  const fs = await import("node:fs"), dir = join(home, ".storage-users"), pid = process.pid + 2_000_000;
  fs.mkdirSync(dir); fs.writeFileSync(join(dir, `${pid}-original`), JSON.stringify({ pid, nonce: "original", createdAt: Date.now(), mailboxProtocol: 7, mailboxSchema: 14 }));
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.spyOn(processIdentity, "identityStartedAfter").mockReturnValue(true);
  vi.spyOn(processIdentity, "readProcessIdentity").mockResolvedValue(new Date(Date.now() + 10_000).toString());
  const sync = vi.spyOn(processIdentity, "processStartMs").mockImplementation(() => { throw new Error("forbidden synchronous liveness query"); });
  await guard();
  const { MessageStore } = await import("../src/core/store.js");
  expect(() => new MessageStore(file, nullLogger)).toThrow(); // No transferable proof from an earlier guard.
  expect(sync).not.toHaveBeenCalled(); expect(readFileSync(file)).toEqual(original);
});

it.each(["success", "changed", "expired"])("keeps actual store construction inside the fresh bounded proof: %s", async phase => {
  const { MessageStore, openMessageStore } = await import("../src/core/store.js");
  // Canonical new-home schema/metadata/namespace, then a retained PID-reuse lease.
  const initial = new MessageStore(file + ".fresh", nullLogger); initial.close();
  closeMetadataDbs();
  const target = file + ".fresh", fs = await import("node:fs"), dir = join(home, ".storage-users"), pid = process.pid + 2_000_000;
  fs.mkdirSync(dir, { recursive: true }); const lease = join(dir, `${pid}-original`);
  const bytes = JSON.stringify({ pid, nonce: "original", createdAt: Date.now(), mailboxProtocol: 7, mailboxSchema: 14 });
  fs.writeFileSync(lease, bytes);
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.spyOn(processIdentity, "identityStartedAfter").mockReturnValue(true);
  vi.spyOn(processIdentity, "readProcessIdentity").mockResolvedValue(new Date(Date.now() + 10_000).toString());
  const sync = vi.spyOn(processIdentity, "processStartMs").mockImplementation(() => { throw new Error("forbidden synchronous liveness query"); });
  // At constructor's first SQL open the earlier proof has already been used.
  // Change evidence at its second census (after opening, before migration).
  const prepare = vi.mocked(DatabaseSync.prototype.prepare).getMockImplementation()!;
  let reads = 0;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql === "PRAGMA user_version" && ++reads === 3) {
      if (phase === "changed") fs.writeFileSync(lease, bytes.replace("original", "replaced"));
      if (phase === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + CONNECT_TIMEOUT_MS + 1);
    }
    return prepare.call(this, sql);
  });
  const pending = openMessageStore(target, nullLogger, "fixture-current", "fixture-only-token");
  if (phase === "success") {
    const store = await pending; expect(store.file).toBe(target);
    for (const db of [(store as any).db, (store as any).archiveDb, store.history.storageDatabase])
      expect(db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(3000);
    store.close();
    expect(() => new MessageStore(target, nullLogger)).toThrow(); // Scoped proof is no longer available.
  }
  else await expect(pending).rejects.toMatchObject({ code: phase === "expired" ? "timeout" : "STORE_READER_ACTIVE" });
  expect(sync).not.toHaveBeenCalled(); expect(readFileSync(lease, "utf8")).toBe(phase === "changed" ? bytes.replace("original", "replaced") : bytes);
  expect(readdirSync(dir)).toEqual([`${pid}-original`]);
});

it("refuses a nested migration lock without a synchronous wait or liveness query, preserving original bytes", async () => {
  const { MessageStore, openMessageStore } = await import("../src/core/store.js");
  const target = file + ".fresh", initial = new MessageStore(target, nullLogger); initial.close(); closeMetadataDbs();
  const db = new DatabaseSync(target); db.exec("PRAGMA user_version=13"); db.close();
  const fs = await import("node:fs"), lock = target + ".migration-lock", owner = JSON.stringify({ pid: process.pid + 2_000_000, identity: "foreign-original" });
  fs.writeFileSync(lock, owner); const bytes = readFileSync(target);
  vi.spyOn(process, "kill").mockReturnValue(true);
  const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => { throw new Error("synchronous wait forbidden during admission"); });
  await expect(openMessageStore(target, nullLogger, "fixture-current", "fixture-only-token")).rejects.toMatchObject({ code: "EBUSY" });
  expect(wait).not.toHaveBeenCalled(); expect(readFileSync(target)).toEqual(bytes); expect(readFileSync(lock, "utf8")).toBe(owner);
  expect(readdirSync(join(home, ".storage-users"))).toEqual([]);
});

it("cancels actual node store admission and closes only its reservation before construction", async () => {
  const fs = await import("node:fs"), dir = join(home, ".storage-users"), pid = process.pid + 2_000_000;
  fs.mkdirSync(dir); fs.writeFileSync(join(dir, `${pid}-original`), JSON.stringify({ pid, nonce: "original", createdAt: Date.now(), mailboxProtocol: 7, mailboxSchema: 14 }));
  vi.spyOn(process, "kill").mockReturnValue(true);
  const { EndpointReservation } = await import("../src/core/endpoint-reservation.js");
  const reservation = { close: vi.fn(async () => {}) };
  vi.spyOn(EndpointReservation, "bind").mockResolvedValue(reservation as any);
  const compatibility = await import("../src/core/store-compatibility.js");
  vi.spyOn(compatibility, "refreshStorePeerIdentities").mockResolvedValue();
  const query = vi.spyOn(processIdentity, "readProcessIdentity").mockImplementation((_pid, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  }));
  const node = new BridgeNode({ pipePath: "fixture-current", dbPath: file, token: "fixture-only-token", agent: "other", name: "fixture", cwd: home,
    autoWake: false, canHostBroker: true, log: nullLogger });
  const pending = (node as any).tryBecomeBroker().catch((error: unknown) => error);
  await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  await node.stop(); expect(await pending).toMatchObject({ name: "AbortError" });
  expect(reservation.close).toHaveBeenCalledOnce(); expect(node.isBroker).toBe(false); expect(node.listenerCount("stopped")).toBe(0);
  expect(readFileSync(file)).toEqual(original); expect(readdirSync(dir)).toEqual([`${pid}-original`]);
});

it("does not retry an effect after its construction callback reports failure", async () => {
  const failure = Object.assign(new Error("effect failed with retained evidence"), { code: "STORE_READER_ACTIVE", readerCompatibility: "unproven" });
  const effect = vi.fn(() => { throw failure; });
  await expect(guardPriorEndpoints(home, "fixture-current", "fixture-only-token", nullLogger, undefined, effect)).rejects.toBe(failure);
  expect(effect).toHaveBeenCalledOnce(); unchanged();
});

it("checks the original deadline after owned policy cleanup and closes an unadmitted constructed store", async () => {
  const { MessageStore, openMessageStore } = await import("../src/core/store.js");
  const initial = new MessageStore(file + ".fresh", nullLogger); initial.close(); closeMetadataDbs();
  const close = vi.spyOn(MessageStore.prototype, "close"), exec = DatabaseSync.prototype.exec;
  let crossed = false;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    const result = exec.call(this, sql);
    if (!crossed && sql === "PRAGMA busy_timeout=3000") {
      crossed = true; const later = Date.now() + CONNECT_TIMEOUT_MS + 1; vi.spyOn(Date, "now").mockReturnValue(later);
    }
    return result;
  });
  const outcome = await openMessageStore(file + ".fresh", nullLogger, "fixture-current", "fixture-only-token")
    .then(store => { store.close(); return { admitted: true, error: undefined }; }, error => ({ admitted: false, error }));
  expect(crossed).toBe(true); expect(outcome).toMatchObject({ admitted: false, error: { code: "timeout" } });
  expect(close).toHaveBeenCalledOnce();
  const rejected = close.mock.contexts[0] as InstanceType<typeof MessageStore>;
  expect([(rejected as any).db, (rejected as any).archiveDb, rejected.history.storageDatabase].every(db => !db.isOpen)).toBe(true);
  expect(readdirSync(join(home, ".storage-users"))).toEqual([]);
});

it.each(["deadline", "caller"])("preserves the original %s reason during census backoff", async phase => {
  vi.useFakeTimers(); const release = storageLease(home), stop = new AbortController();
  io.read.mockImplementation((path: unknown, ...args: any[]) => String(path).includes(".storage-users") ? "" : io.actualRead(path, ...args));
  let error: unknown; const pending = guard(stop.signal).catch(failure => { error = failure; });
  await vi.advanceTimersByTimeAsync(1);
  if (phase === "caller") stop.abort(new Error("explicit fixture cancellation"));
  else await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
  await pending;
  expect(error).toMatchObject(phase === "caller" ? { message: "explicit fixture cancellation" } : { code: "timeout" });
  release();
});

it("refuses a late census retry before another pass or effect even when the reader has become compatible", async () => {
  vi.useFakeTimers(); const release = storageLease(home), dir = join(home, ".storage-users"), lease = join(dir, readdirSync(dir)[0]!);
  let ready = false, observations = 0;
  io.read.mockImplementation((path: unknown, ...args: any[]) => {
    if (path === lease) { observations++; if (!ready) return ""; }
    return io.actualRead(path, ...args);
  });
  const effect = vi.fn(); let failure: unknown;
  const admission = guard().then(effect, error => { failure = error; });
  try {
    await vi.waitFor(() => expect(observations).toBeGreaterThan(0));
    const before = observations; ready = true; vi.setSystemTime(Date.now() + CONNECT_TIMEOUT_MS + 1);
    await vi.runAllTimersAsync(); await admission;
    expect(effect).not.toHaveBeenCalled(); expect(failure).toMatchObject({ code: "timeout" });
    expect(observations).toBe(before); expect(readFileSync(file)).toEqual(original);
  } finally { ready = true; await vi.runAllTimersAsync(); await admission; release(); }
});

it.each(["inspection", "endpoint", "census"])("refuses admission when a controlled %s stage returns after the aggregate deadline", async stage => {
  vi.useFakeTimers(); const release = stage === "census" ? storageLease(home) : undefined;
  let crossed = false;
  const cross = () => { if (!crossed) { crossed = true; vi.setSystemTime(Date.now() + CONNECT_TIMEOUT_MS + 1); } };
  if (stage === "inspection") {
    const prepare = vi.mocked(DatabaseSync.prototype.prepare).getMockImplementation()!;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
      if (sql === "PRAGMA user_version") cross(); return prepare.call(this, sql);
    });
  } else if (stage === "endpoint") {
    const connect = io.connect.getMockImplementation()!, lstat = io.lstat.getMockImplementation()!;
    io.connect.mockImplementation((...args: any[]) => { cross(); return connect(...args); });
    io.lstat.mockImplementation((...args: any[]) => { cross(); return lstat(...args); });
  } else {
    io.read.mockImplementation((path: unknown, ...args: any[]) => {
      if (String(path).includes(".storage-users")) cross(); return io.actualRead(path, ...args);
    });
  }
  const close = vi.spyOn(DatabaseSync.prototype, "close"), effect = vi.fn(); let failure: unknown;
  try {
    await guard().then(effect, error => { failure = error; });
    expect(crossed).toBe(true); expect(effect).not.toHaveBeenCalled(); expect(failure).toMatchObject({ code: "timeout" });
    expect(close).toHaveBeenCalledOnce(); expect(sockets.every(socket => socket.destroyed)).toBe(true); expect(readFileSync(file)).toEqual(original);
  } finally { release?.(); }
});

it.each(["success", "late", "cancel", "replacement"])("bounds the actual foreign reader identity query and fences its snapshot: %s", async phase => {
  vi.useFakeTimers(); const fs = await import("node:fs"), dir = join(home, ".storage-users"); fs.mkdirSync(dir);
  const pid = process.pid + 2_000_000, lease = join(dir, `${pid}-owned-fixture`);
  fs.writeFileSync(lease, JSON.stringify({ pid, nonce: "original-incarnation", createdAt: Date.now(), mailboxProtocol: 7, mailboxSchema: 14 }));
  const originalLease = readFileSync(lease), stop = new AbortController(), effect = vi.fn();
  vi.spyOn(process, "kill").mockImplementation(() => true);
  const sync = vi.spyOn(processIdentity, "processStartMs"), after = vi.spyOn(processIdentity, "identityStartedAfter").mockReturnValue(true);
  let complete!: (identity: string) => void, querySignal: AbortSignal | undefined;
  const query = vi.spyOn(processIdentity, "readProcessIdentity").mockImplementation((_pid, signal) => {
    querySignal = signal;
    return new Promise((resolve, reject) => {
      const abort = () => { signal?.removeEventListener("abort", abort); reject(signal!.reason); };
      signal?.addEventListener("abort", abort, { once: true });
      complete = identity => { signal?.removeEventListener("abort", abort); resolve(identity); };
    });
  });
  let failure: unknown; const admission = guard(stop.signal).then(effect, error => { failure = error; });
  await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  expect(effect).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled(); expect(querySignal).toBeDefined();
  if (phase === "cancel") stop.abort();
  else {
    if (phase === "late") vi.setSystemTime(Date.now() + CONNECT_TIMEOUT_MS + 1);
    if (phase === "replacement") {
      fs.writeFileSync(lease, JSON.stringify({ pid, nonce: "replacement-incarnation", createdAt: Date.now(), mailboxProtocol: 7, mailboxSchema: 14 }));
      after.mockReturnValueOnce(true).mockReturnValue(false);
      query.mockResolvedValueOnce(new Date(Date.now() - 10_000).toString());
    }
    complete(new Date(Date.now() + 10_000).toString());
  }
  await vi.runAllTimersAsync(); await admission;
  if (phase === "success") { expect(effect).toHaveBeenCalledOnce(); expect(failure).toBeUndefined(); }
  else {
    expect(effect).not.toHaveBeenCalled();
    expect(failure).toMatchObject(phase === "late" ? { code: "timeout" } : phase === "cancel" ? { name: "AbortError" } : { code: "protocol_mismatch" });
  }
  if (phase === "late" || phase === "cancel") expect(querySignal!.aborted).toBe(true);
  if (phase !== "replacement") expect(readFileSync(lease)).toEqual(originalLease);
  expect(readFileSync(file)).toEqual(original); expect(sync).not.toHaveBeenCalled();
});

it.each(["publication", "release"])("reinspects a suspended %s census before admitting effects, without latching a false protocol refusal", async phase => {
  vi.useFakeTimers(); const release = storageLease(home), dir = join(home, ".storage-users"), lease = join(dir, readdirSync(dir)[0]!);
  const originalLease = io.actualRead(lease), effect = vi.fn();
  let ready = false, observations = 0, failure: unknown;
  io.read.mockImplementation((path: unknown, ...args: any[]) => {
    if (path === lease && !ready) {
      observations++;
      if (phase === "publication") return "";
      throw Object.assign(new Error("fixture own lease disappearing after directory snapshot"), { code: "ENOENT" });
    }
    return io.actualRead(path, ...args);
  });
  io.stat.mockImplementation((path: unknown, ...args: any[]) => {
    if (path === lease && !ready && phase === "release") throw Object.assign(new Error("fixture absent after snapshot"), { code: "ENOENT" });
    return io.actualStat(path, ...args);
  });
  const admission = guard().then(effect, error => { failure = error; });
  try {
    await vi.waitFor(() => expect(observations).toBeGreaterThan(0));
    expect(effect).not.toHaveBeenCalled(); expect(failure).toBeUndefined();
    ready = true; await vi.runAllTimersAsync(); await admission;
    expect(effect).toHaveBeenCalledOnce(); expect(failure).toBeUndefined();
    expect(io.actualRead(lease)).toEqual(originalLease); expect(readFileSync(file)).toEqual(original);
  } finally { ready = true; await vi.runAllTimersAsync(); await admission; release(); }
});

it("cancels an unresolved reader observation without an effect or protocol-refusal substitution", async () => {
  vi.useFakeTimers(); const release = storageLease(home), dir = join(home, ".storage-users"), lease = join(dir, readdirSync(dir)[0]!);
  let observations = 0;
  io.read.mockImplementation((path: unknown, ...args: any[]) => {
    if (path === lease) { observations++; return ""; }
    return io.actualRead(path, ...args);
  });
  const stop = new AbortController(), effect = vi.fn();
  const admission = guard(stop.signal).then(effect, error => error);
  try {
    await vi.waitFor(() => expect(observations).toBeGreaterThan(0)); stop.abort();
    expect(await admission).toMatchObject({ name: "AbortError" }); expect(effect).not.toHaveBeenCalled(); expect(readFileSync(file)).toEqual(original);
  } finally { io.read.mockImplementation(io.actualRead); release(); }
});

it("fails closed during actual lease publication and admits only its completed current declaration", async () => {
  let unpublished: unknown;
  io.write.mockImplementationOnce((...args: any[]) => {
    // Simulate another process's census after exclusive open but before the
    // actual owner bytes are written. No threads, load or real process launch.
    try { assertCompatibleMailboxReaders(home); } catch (error) { unpublished = error; }
    return io.actualWrite(...args);
  });
  const release = storageLease(home);
  try {
    expect(unpublished).toMatchObject({ code: "STORE_READER_ACTIVE" });
    expect(() => assertCompatibleMailboxReaders(home)).not.toThrow();
    await guard();
    expect(readFileSync(file)).toEqual(original);
  } finally { release(); }
});

it("distinguishes incomplete reader refusal from an endpoint version without admitting or rewriting it", async () => {
  vi.useFakeTimers(); const began = Date.now();
  const fs = await import("node:fs"), dir = join(home, ".storage-users"); fs.mkdirSync(dir);
  const lease = join(dir, `${process.pid}-incomplete-publication`); fs.writeFileSync(lease, "");
  let refusal: unknown; const admission = guard().catch(error => { refusal = error; });
  await vi.runAllTimersAsync(); await admission;
  expect(refusal).toMatchObject({ code: "timeout" });
  expect(Date.now() - began).toBeLessThanOrEqual(CONNECT_TIMEOUT_MS);
  expect(readFileSync(lease)).toEqual(Buffer.alloc(0)); expect(readFileSync(file)).toEqual(original);
});

it.each([2, 3, 4, 5, 6, 7, PROTOCOL_VERSION])("never waits through or rewrites a completed incompatible protocol%s/schema reader", async protocol => {
  vi.useFakeTimers(); const release = storageLease(home), dir = join(home, ".storage-users"), lease = join(dir, readdirSync(dir)[0]!);
  const fs = await import("node:fs"), owner = JSON.parse(readFileSync(lease, "utf8"));
  fs.writeFileSync(lease, JSON.stringify({ ...owner, mailboxProtocol: protocol, mailboxSchema: protocol === PROTOCOL_VERSION ? 13 : 14 })); const bytes = readFileSync(lease), began = Date.now();
  try {
    await expect(guard()).rejects.toMatchObject({ code: "protocol_mismatch" });
    expect(Date.now()).toBe(began); expect(readFileSync(lease)).toEqual(bytes); expect(readFileSync(file)).toEqual(original);
  } finally { release(); }
});

it.each([1, 2])("refuses cached-writer metadata%s before probing or any reader-admission wait", async metadata => {
  vi.restoreAllMocks(); const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE bridge_components(name TEXT, version INTEGER); INSERT INTO bridge_components VALUES ('metadata', ${metadata})`); db.close();
  original = readFileSync(file);
  await expect(guard()).rejects.toMatchObject({ code: "protocol_mismatch" });
  expect(io.connect).not.toHaveBeenCalled(); unchanged();
});

it("rechecks a prior endpoint published while an incomplete reader census yields", async () => {
  vi.useFakeTimers(); const fs = await import("node:fs"), dir = join(home, ".storage-users"); fs.mkdirSync(dir);
  const lease = join(dir, `${process.pid}-incomplete-publication`); fs.writeFileSync(lease, "");
  let seen = false;
  io.read.mockImplementation((path: unknown, ...args: any[]) => { if (path === lease) seen = true; return io.actualRead(path, ...args); });
  const request = vi.fn().mockRejectedValue(new BridgeError("protocol_mismatch", "fixture incompatible p7")), close = vi.fn();
  const connect = vi.spyOn(BridgeClient, "connect").mockResolvedValue({ request, close } as any);
  let refusal: unknown; const admission = guard().catch(error => { refusal = error; });
  await vi.waitFor(() => expect(seen).toBe(true));
  live = priorEndpoints(home).find(path => /-p7(?:\.sock)?$/.test(path))!;
  fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, nonce: "fixture-current", createdAt: Date.now(), mailboxProtocol: PROTOCOL_VERSION, mailboxSchema: 14 }));
  await vi.runAllTimersAsync(); await admission;
  expect(refusal).toMatchObject({ code: "protocol_mismatch" });
  expect(deliveryFailure(refusal).protocol?.source).toBe("prior-endpoint");
  if (process.platform === "win32") expect(connect).not.toHaveBeenCalled(); else expect(close).toHaveBeenCalledOnce();
  expect(readFileSync(file)).toEqual(original);
});

it("yields through a transient read-only schema inspection busy error before admitting startup", async () => {
  busy = 1; const close = vi.spyOn(DatabaseSync.prototype, "close");
  let yielded = false; const timer = setTimeout(() => { yielded = true; }, 0);
  try { await guard(); } finally { clearTimeout(timer); }
  expect(yielded).toBe(true); expect(inspections).toBe(2); expect(close).toHaveBeenCalledTimes(2); unchanged();
});

it("refuses persistent schema inspection busy within the existing connect budget and never probes an endpoint", async () => {
  busy = Infinity;
  await expect(guard()).rejects.toMatchObject({ code: "timeout" });
  expect(inspections).toBeGreaterThan(1); expect(inspections).toBeLessThan(20);
  expect(io.connect).not.toHaveBeenCalled(); unchanged();
});

it("cancels a pending inspection wait without treating a locked schema as safe", async () => {
  busy = Infinity; const stop = new AbortController();
  const result = guard(stop.signal); const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  stop.abort(); await rejected;
  expect(inspections).toBe(1); expect(io.connect).not.toHaveBeenCalled(); unchanged();
});

it("does not retry a non-busy inspection failure or probe past it", async () => {
  const denied = Object.assign(new Error("fixture read permission denied"), { code: "EACCES" });
  vi.mocked(DatabaseSync.prototype.prepare).mockImplementationOnce(() => { throw denied; });
  await expect(guard()).rejects.toBe(denied); expect(io.connect).not.toHaveBeenCalled(); unchanged();
});

it("still refuses a pre-lease schema after transient busy without a backup or schema effect", async () => {
  vi.restoreAllMocks(); const db = new DatabaseSync(file); db.exec("PRAGMA user_version=3"); db.close(); original = readFileSync(file);
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql === "PRAGMA user_version" && ++inspections === 1) throw Object.assign(new Error("database is locked"), { errcode: 5 });
    return prepare.call(this, sql);
  });
  await expect(guard()).rejects.toMatchObject({ code: "protocol_mismatch" });
  expect(inspections).toBe(2); expect(io.connect).not.toHaveBeenCalled(); unchanged();
});

it.each([2, 3, 4, 5, 6, 7])("still refuses an active incompatible prior protocol%s endpoint after inspection recovers", async old => {
  busy = 1; live = priorEndpoints(home).find(path => new RegExp(`-p${old}(?:\\.sock)?$`).test(path))!;
  const close = vi.fn(), request = vi.fn().mockRejectedValue(new BridgeError("protocol_mismatch", "fixture old protocol"));
  const connect = vi.spyOn(BridgeClient, "connect").mockResolvedValue({ request, close } as any);
  await expect(guard()).rejects.toMatchObject({ code: "protocol_mismatch" });
  expect(inspections).toBe(2);
  if (process.platform === "win32") { expect(connect).not.toHaveBeenCalled(); expect(sockets.every(s => s.destroyed)).toBe(true); }
  else { expect(request).toHaveBeenCalledWith("auth", { protocol: PROTOCOL_VERSION, token: "fixture-only-token" }, expect.any(Number)); expect(close).toHaveBeenCalledOnce(); }
  unchanged();
});

it("stops actual node admission during a busy prior inspection without discovery or broker launch", async () => {
  busy = Infinity;
  const discovery = vi.spyOn(BridgeClient, "connect"), launch = vi.fn();
  const node = new BridgeNode({ pipePath: "fixture-current", dbPath: file, token: "fixture-only-token", agent: "other", name: "fixture", cwd: home,
    autoWake: false, canHostBroker: true, daemon: { cli: "fixture-unused", launch } as any, log: nullLogger });
  const started = node.start().then(() => ({ error: undefined }), error => ({ error }));
  await node.stop(); const result = await started;
  expect(result.error).toMatchObject({ name: "AbortError" }); expect(discovery).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  expect(readFileSync(file).equals(original)).toBe(true);
});

it.each([1, 2])("refuses component%s cached-writer uncertainty before endpoint discovery or metadata/backup mutation", async version => {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE bridge_components(name TEXT PRIMARY KEY,version INTEGER); INSERT INTO bridge_components VALUES('metadata',${version})`); db.close();
  original = readFileSync(file);
  await expect(guard()).rejects.toMatchObject({ code: "protocol_mismatch", message: expect.stringContaining(`component${version}`) });
  expect(io.connect).not.toHaveBeenCalled(); unchanged();
});
