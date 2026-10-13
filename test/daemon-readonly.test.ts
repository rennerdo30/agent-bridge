import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { posix } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { shortSocketDirectory } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const location = vi.hoisted(() => ({ directory: "", requested: "", actual: "", home: "", state: "valid" }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, mkdirSync: vi.fn(fs.mkdirSync), chmodSync: vi.fn(fs.chmodSync),
    lstatSync: vi.fn((...args: Parameters<typeof fs.lstatSync>) => {
      if (String(args[0]) !== location.directory) return fs.lstatSync(...args);
      if (location.state === "missing") throw Object.assign(new Error("fixture directory missing"), { code: "ENOENT" });
      const stat = fs.lstatSync(location.home);
      return Object.assign(Object.create(stat), {
        mode: location.state === "loose" ? 0o755 : stat.mode,
        uid: location.state === "wrong_uid" ? Number(stat.uid) + 1 : stat.uid,
        isDirectory: () => location.state !== "not_directory",
        isSymbolicLink: () => location.state === "symlink",
      });
    }) };
});
vi.mock("node:net", async original => {
  const net = await original<typeof import("node:net")>();
  return { ...net, connect: vi.fn((...args: Parameters<typeof net.connect>) =>
    String(args[0]) === location.requested ? net.connect(location.actual) : net.connect(...args)) };
});

let env: TestEnv, token: string;
beforeEach(async () => {
  env = makeEnv();
  location.directory = shortSocketDirectory(); location.requested = posix.join(location.directory, `readonly-${randomUUID()}.sock`);
  location.actual = env.pipe; location.home = env.home; location.state = "valid";
  // Only the environment location is substituted. No shared per-UID directory
  // is created, chmodded or used as the real server endpoint by this fixture.
  if (process.platform !== "win32") expect(posix.dirname(env.pipe)).not.toBe(location.directory);
  token = loadOrCreateToken(env.home); await env.node("readonly-host").start();
  vi.clearAllMocks();
});
afterEach(async () => { await env.cleanup(); });
function noPreparationWrites() {
  expect(mkdirSync).not.toHaveBeenCalled(); expect(chmodSync).not.toHaveBeenCalled();
}
it("read-only connect validates the directory, preserves metadata and uses real broker authentication", async () => {
  const before = lstatSync(env.home);
  const client = await BridgeClient.connect(location.requested, nullLogger, undefined, { readOnlyDirectory: true });
  try {
    await client.request("auth", { protocol: PROTOCOL_VERSION, token });
    expect(await client.request("coreStatus", {})).toMatchObject({ mode: "embedded", pid: process.pid });
  } finally { client.close(); }
  const rejected = await BridgeClient.connect(location.requested, nullLogger, undefined, { readOnlyDirectory: true });
  try { await expect(rejected.request("auth", { protocol: PROTOCOL_VERSION, token: "wrong-fixture-token" })).rejects.toMatchObject({ code: "unauthorized" }); }
  finally { rejected.close(); }
  const after = lstatSync(env.home);
  expect([after.dev, after.ino, after.uid, after.mode, after.mtimeMs, after.ctimeMs])
    .toEqual([before.dev, before.ino, before.uid, before.mode, before.mtimeMs, before.ctimeMs]);
  if (process.platform !== "win32") expect(lstatSync).toHaveBeenCalledWith(location.directory);
  noPreparationWrites();
});
const unix = process.platform === "win32" ? it.skip : it;
unix.each(["missing", "loose", "symlink", "wrong_uid", "not_directory"])("read-only connect refuses %s directory without repair or connecting", async state => {
  location.state = state;
  await expect(BridgeClient.connect(location.requested, nullLogger, undefined, { readOnlyDirectory: true }))
    .rejects.toMatchObject({ code: state === "missing" ? "ENOENT" : "EUNSAFESOCKETDIR" });
  expect(connect).not.toHaveBeenCalled(); noPreparationWrites();
});
