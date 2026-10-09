import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLock } from "../src/mcp/jobs.js";

const state = vi.hoisted(() => ({
  current: vi.fn(), alive: vi.fn(), asyncIdentity: vi.fn(),
  beforeLink: undefined as ((source: string, target: string) => void) | undefined,
  afterRename: undefined as ((source: string, target: string) => void) | undefined,
  birthtimeOverride: undefined as number | undefined,
}));
vi.mock("../src/core/process-identity.js", () => ({ processIdentity: state.current, isProcessIdentityAlive: state.alive, readProcessIdentity: state.asyncIdentity }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => {
      const result = fs.lstatSync(...args);
      if (result && state.birthtimeOverride !== undefined && result.isFile()) Object.assign(result, { birthtimeMs: state.birthtimeOverride });
      return result;
    }) as typeof fs.lstatSync,
    linkSync: (...args: Parameters<typeof fs.linkSync>) => { state.beforeLink?.(String(args[0]), String(args[1])); fs.linkSync(...args); },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => { fs.renameSync(...args); state.afterRename?.(String(args[0]), String(args[1])); },
  };
});

let home: string, path: string;
const currentIdentity = "boot:current-start";
const registry = () => join(home, ".metadata-leases", createHash("sha256").update(basename(path)).digest("hex"));
const ownerDir = () => join(registry(), JSON.parse(readFileSync(path, "utf8")).ownerDirectory);
const archives = () => readdirSync(join(registry(), "archive")).flatMap(name => {
  const dir = join(registry(), "archive", name);
  return readdirSync(dir).filter(file => file.startsWith("released-v2.")).map(file => join(dir, file));
});

beforeEach(() => {
  const root = join(process.cwd(), ".agent-bridge-test");
  mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "job-lock-"));
  path = join(home, "jobs.json.lock");
  writeFileSync(join(home, "owner-data.txt"), "unique user bytes");
  state.current.mockReset().mockReturnValue(currentIdentity);
  state.alive.mockReset().mockImplementation((pid, identity) => pid === process.pid && identity === currentIdentity);
  state.asyncIdentity.mockReset().mockResolvedValue(null);
  state.beforeLink = undefined;
  state.afterRename = undefined;
  state.birthtimeOverride = undefined;
});
afterEach(() => {
  state.birthtimeOverride = undefined;
  state.beforeLink = undefined;
  state.afterRename = undefined;
  expect(readFileSync(join(home, "owner-data.txt"), "utf8")).toBe("unique user bytes");
  rmSync(home, { recursive: true, force: true });
});

describe("job-store metadata locks", () => {
  it("releases the same inode after a birthtime change without releasing a newer nonce", () => {
    const release = acquireLock(path, 0);
    const original = readFileSync(path, "utf8");
    // Darwin utimes can move birthtime backwards without changing the inode.
    state.birthtimeOverride = 0;
    expect(() => acquireLock(path, 0)).toThrow("locking jobs store");
    release();
    expect(existsSync(path)).toBe(false);
    expect(archives()).toHaveLength(1);
    expect(readFileSync(archives()[0]!, "utf8")).toBe(original);
    const next = acquireLock(path, 0);
    const newer = readFileSync(path, "utf8");
    release();
    expect(readFileSync(path, "utf8")).toBe(newer);
    expect(newer).not.toBe(original);
    next();
    expect(archives()).toHaveLength(2);
  });

  it("publishes complete versioned owner metadata exclusively and archives release", () => {
    state.beforeLink = (source, target) => {
      expect(target).toBe(path);
      expect(existsSync(path)).toBe(false);
      expect(JSON.parse(readFileSync(source, "utf8"))).toMatchObject({ version: 2, pid: process.pid, identity: currentIdentity, nonce: expect.any(String) });
    };
    const release = acquireLock(path, 0);
    state.beforeLink = undefined;
    const original = readFileSync(path, "utf8");
    expect(() => acquireLock(path, 0)).toThrow("locking jobs store");
    release();
    expect(existsSync(path)).toBe(false);
    expect(archives()).toHaveLength(1);
    expect(readFileSync(archives()[0]!, "utf8")).toBe(original);
    const next = acquireLock(path, 0);
    release();
    expect(existsSync(path)).toBe(true);
    next();
  });

  it("an interruption before publication leaves no empty lock and retains staged metadata", () => {
    state.beforeLink = () => { throw Object.assign(new Error("interrupted before publication"), { code: "EINTR" }); };
    expect(() => acquireLock(path, 0)).toThrow("interrupted before publication");
    expect(existsSync(path)).toBe(false);
    const stagedArchive = join(registry(), "archive");
    expect(readdirSync(stagedArchive)).toHaveLength(1);
    const saved = join(stagedArchive, readdirSync(stagedArchive)[0]!);
    expect(JSON.parse(readFileSync(join(saved, readdirSync(saved)[0]!), "utf8"))).toMatchObject({ pid: process.pid, identity: currentIdentity });
    state.beforeLink = undefined;
    acquireLock(path, 0)();
  });

  it("an atomic-publication loser retains its staging record and cannot replace the winner", () => {
    let winner: (() => void) | undefined;
    state.beforeLink = () => {
      state.beforeLink = undefined;
      winner = acquireLock(path, 0);
    };
    expect(() => acquireLock(path, 0)).toThrow("locking jobs store");
    expect(existsSync(path)).toBe(true);
    expect(archives()).toEqual([]);
    expect(readdirSync(join(registry(), "archive"))).toHaveLength(1);
    winner!();
    expect(archives()).toHaveLength(1);
  });

  it("unsupported hard-link publication fails closed and retains the complete staged metadata", () => {
    state.beforeLink = () => { throw Object.assign(new Error("hard links unavailable"), { code: "EOPNOTSUPP" }); };
    expect(() => acquireLock(path, 0)).toThrow("hard links unavailable");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(registry(), "archive"))).toHaveLength(1);
  });

  it("refuses writes through a linked ancestor before creating a nested lock directory", () => {
    const target = join(home, "retained-target"); mkdirSync(target);
    writeFileSync(join(target, "owner-data.txt"), "preserved target bytes");
    const link = join(home, "ancestor-link");
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => acquireLock(join(link, "new-nested", "jobs.json.lock"), 0)).toThrow("locking jobs store");
    expect(readdirSync(target)).toEqual(["owner-data.txt"]);
    expect(readFileSync(join(target, "owner-data.txt"), "utf8")).toBe("preserved target bytes");
  });

  it("recovers a confirmed reused PID and preserves the original metadata bytes", () => {
    state.current.mockReturnValue("boot:previous-start");
    acquireLock(path, 0);
    const raw = readFileSync(path, "utf8");
    state.current.mockReturnValue(currentIdentity);
    const release = acquireLock(path, 0);
    expect(state.alive).toHaveBeenCalledWith(process.pid, "boot:previous-start");
    expect(readFileSync(archives()[0]!, "utf8")).toBe(raw);
    release();
  });

  it("zero-wait foreign PID recovery defers verification without a synchronous process query", async () => {
    acquireLock(path, 0);
    const dir = ownerDir();
    const oldMarker = readdirSync(dir)[0]!;
    const oldIdentity = `boot:foreign-old-${randomUUID()}`;
    const marker = `owner-v1.${process.ppid}.${Buffer.from(oldIdentity).toString("base64url")}.${randomUUID()}.json`;
    renameSync(join(dir, oldMarker), join(dir, marker));
    state.alive.mockClear();
    let resolve!: (identity: string | null) => void;
    state.asyncIdentity.mockImplementation(() => new Promise<string | null>(done => { resolve = done; }));
    expect(() => acquireLock(path, 0)).toThrow("locking jobs store");
    expect(() => acquireLock(path, 0)).toThrow("locking jobs store");
    expect(state.alive).not.toHaveBeenCalled();
    expect(state.asyncIdentity).toHaveBeenCalledOnce();
    resolve("boot:foreign-reused");
    await Promise.resolve(); await Promise.resolve();
    acquireLock(path, 0)();
    expect(archives()).toHaveLength(2);
  });

  it("a killed reclaimer's exact owner claim can be recovered by the next process identity", () => {
    state.current.mockReturnValue("boot:dead-owner-start");
    acquireLock(path, 0);
    state.current.mockReturnValue(currentIdentity);
    state.afterRename = (source, target) => {
      if (basename(source).startsWith("owner-v1.") && basename(target).startsWith("claim-v1.")) throw new Error("interrupted after claim");
    };
    expect(() => acquireLock(path, 0)).toThrow("locking jobs store");
    expect(readdirSync(ownerDir())[0]).toMatch(/^claim-v1\./);
    expect(archives()).toEqual([]);
    state.afterRename = undefined;
    // The claim stays exclusive while its owner lives, then recovers after verified identity loss.
    expect(() => acquireLock(path, 0)).toThrow("locking jobs store");
    state.current.mockReturnValue("boot:replacement-start");
    state.alive.mockImplementation((pid, identity) => pid === process.pid && identity === "boot:replacement-start");
    const release = acquireLock(path, 0);
    expect(archives()).toHaveLength(1);
    release();
  });

  it.each(["", "invalid json", '{"version":1,"pid":12345,"nonce":"legacy"}', '{"version":3,"pid":12345}'])("retains unknown legacy/newer lock %j", (raw) => {
    writeFileSync(path, raw);
    mkdirSync(`${path}.recovery`);
    expect(() => acquireLock(path, 0)).toThrow("locking jobs store");
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(existsSync(`${path}.recovery`)).toBe(true);
    expect(state.alive).not.toHaveBeenCalled();
  });

  it("an unrelated old recovery guard does not pin a new complete lock", () => {
    mkdirSync(`${path}.recovery`);
    const release = acquireLock(path, 0);
    expect(existsSync(`${path}.recovery`)).toBe(true);
    release();
  });

  it("a stale reclaimer cannot archive a replacement won by another caller", () => {
    state.current.mockReturnValue("boot:previous-start");
    acquireLock(path, 0);
    state.current.mockReturnValue(currentIdentity);
    let winner: (() => void) | undefined;
    state.alive.mockImplementationOnce(() => { winner = acquireLock(path, 0); return false; });
    expect(() => acquireLock(path, 0)).toThrow("locking jobs store");
    expect(existsSync(path)).toBe(true);
    expect(archives()).toHaveLength(1);
    winner!();
  });

  it("a delayed release leaves a replacement lock and its marker untouched", () => {
    const oldRelease = acquireLock(path, 0);
    renameSync(path, join(home, "saved-original-lock"));
    const release = acquireLock(path, 0);
    const original = readFileSync(path, "utf8");
    const marker = readdirSync(ownerDir())[0];
    oldRelease();
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(ownerDir())).toEqual([marker]);
    release();
  });
});
