import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import { guardPriorEndpoints, priorEndpoints } from "../src/core/prior-endpoints.js";
import { BridgeError } from "../src/core/protocol.js";

const io = vi.hoisted(() => ({ connect: vi.fn(), lstat: vi.fn(), actualLstat: undefined as any }));
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(), connect: io.connect }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>(); io.actualLstat = actual.lstatSync;
  return { ...actual, lstatSync: io.lstat };
});
let home: string, file: string, original: Buffer, live: string | undefined;
let inspections = 0, busy = 0;
const sockets: { destroyed: boolean }[] = [];
beforeEach(() => {
  live = undefined; inspections = 0; busy = 0; sockets.length = 0;
  io.lstat.mockImplementation((path: string) => {
    if (path === live || live && path === dirname(live)) return {
      isSocket: () => path === live, isDirectory: () => path !== live, isSymbolicLink: () => false,
      uid: process.getuid?.(), mode: 0o700,
    };
    return io.actualLstat(path);
  });
  io.connect.mockImplementation((path: string) => {
    const socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } }); sockets.push(socket);
    queueMicrotask(() => path === live ? socket.emit("connect") : socket.emit("error", Object.assign(new Error("fixture absent"), { code: "ENOENT" })));
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
afterEach(() => { vi.restoreAllMocks(); closeMetadataDbs(); io.connect.mockReset(); io.lstat.mockReset(); rmSync(home, { recursive: true, force: true }); });
const guard = (signal?: AbortSignal) => guardPriorEndpoints(home, "fixture-current", "fixture-only-token", nullLogger, signal);
const unchanged = () => { expect(readFileSync(file).equals(original)).toBe(true); expect(readdirSync(home)).toEqual(["bridge.db"]); };

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
