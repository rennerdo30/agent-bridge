import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { worktreeLease } from "../src/core/worktree-state.js";

const identity = vi.hoisted(() => ({ current: vi.fn(), alive: vi.fn() }));
vi.mock("../src/core/process-identity.js", () => ({ processIdentity: identity.current, isProcessIdentityAlive: identity.alive }));

let home: string;
let wt: { path: string };
let leases: string;
let lease: string;
const ownIdentity = "boot:current-start";
const marker = (pid: number, start: string, kind = "owner") => `${kind}-v1.${pid}.${Buffer.from(start).toString("base64url")}.${randomUUID()}.json`;
const registry = () => join(leases, ".metadata-leases", createHash("sha256").update(lease.split(/[\\/]/).at(-1)!).digest("hex"));
const ownerDirectory = () => {
  const record = JSON.parse(readFileSync(lease, "utf8"));
  return join(registry(), record.ownerDirectory);
};
const staleLease = (pid = 12345, start = "boot:old-start", kind = "owner") => {
  worktreeLease(home, wt);
  const dir = ownerDirectory();
  const name = marker(pid, start, kind);
  const raw = readFileSync(lease, "utf8");
  renameSync(join(dir, readdirSync(dir)[0]!), join(dir, name));
  return { name, raw, dir };
};
const archives = () => readdirSync(join(registry(), "archive")).flatMap(name => {
  const dir = join(registry(), "archive", name);
  return readdirSync(dir).filter(file => file.startsWith("released-v2.")).map(file => join(dir, file));
});

beforeEach(() => {
  const fixtures = process.env.AGENT_BRIDGE_TEST_ROOT!;
  mkdirSync(fixtures, { recursive: true });
  home = mkdtempSync(join(fixtures, "lease-"));
  wt = { path: join(home, "worktrees", "owner-work") };
  mkdirSync(wt.path, { recursive: true });
  writeFileSync(join(wt.path, "owner-data.txt"), "unique owner bytes\n");
  leases = join(home, "worktree-leases");
  lease = join(leases, createHash("sha256").update(resolve(wt.path).toLowerCase()).digest("hex"));
  identity.current.mockReset().mockReturnValue(ownIdentity);
  identity.alive.mockReset().mockImplementation((pid, start) => pid === process.pid && start === ownIdentity);
});

afterEach(() => {
  expect(readFileSync(join(wt.path, "owner-data.txt"), "utf8")).toBe("unique owner bytes\n");
  // Only this test's newly created, checkout-contained fixture is removed.
  rmSync(home, { recursive: true, force: true });
});

describe("worktree lease ownership and recovery", () => {
  it("records a versioned PID/start-time/nonce marker, protects live owners and archives release", () => {
    const release = worktreeLease(home, wt);
    const dir = ownerDirectory();
    const name = readdirSync(dir)[0]!;
    expect(name).toMatch(new RegExp(`^owner-v1\\.${process.pid}\\.`));
    expect(name).toContain(Buffer.from(ownIdentity).toString("base64url"));
    const original = readFileSync(lease, "utf8");
    expect(JSON.parse(original)).toMatchObject({ version: 2, createdAt: expect.any(Number), pid: process.pid, identity: ownIdentity, nonce: name });
    expect(() => worktreeLease(home, wt)).toThrow("unreconciled lease");
    expect(archives()).toEqual([]);
    release();
    expect(existsSync(lease)).toBe(false);
    expect(archives()).toHaveLength(1);
    expect(readFileSync(archives()[0]!, "utf8")).toBe(original);
    const releaseNext = worktreeLease(home, wt);
    release();
    expect(existsSync(lease)).toBe(true);
    releaseNext();
    expect(archives()).toHaveLength(2);
  });

  it.each(["owner", "claim"])("recovers a dead %s owner after archiving all original metadata", (kind) => {
    const original = staleLease(12345, "boot:old-start", kind);
    const release = worktreeLease(home, wt);
    expect(identity.alive).toHaveBeenCalledWith(12345, "boot:old-start");
    expect(archives()).toHaveLength(1);
    const saved = archives()[0]!;
    expect(readFileSync(saved, "utf8")).toBe(original.raw);
    release();
  });

  it("recovers a reused PID only when the recorded process identity is confirmed gone", () => {
    staleLease(process.pid, "boot:previous-start");
    const release = worktreeLease(home, wt);
    expect(identity.alive).toHaveBeenCalledWith(process.pid, "boot:previous-start");
    expect(archives()).toHaveLength(1);
    release();
  });

  it.each([true, undefined])("retains an owner with liveness %s", (alive) => {
    const original = staleLease();
    identity.alive.mockReturnValue(alive);
    expect(() => worktreeLease(home, wt)).toThrow("unreconciled lease");
    expect(readFileSync(lease, "utf8")).toBe(original.raw);
    expect(archives()).toEqual([]);
  });

  it("retains an unversioned empty lease without inventing an owner", () => {
    mkdirSync(lease, { recursive: true });
    expect(() => worktreeLease(home, wt)).toThrow("unreconciled lease");
    expect(readdirSync(lease)).toEqual([]);
    expect(identity.alive).not.toHaveBeenCalled();
    expect(archives()).toEqual([]);
  });

  it.each(["corrupt", "newer", "extra-file"])("retains %s lease metadata unchanged", (kind) => {
    const original = staleLease();
    const raw = kind === "corrupt" ? "invalid json" : kind === "newer" ? '{"version":3,"createdAt":1}' : original.raw;
    writeFileSync(lease, raw);
    if (kind === "extra-file") writeFileSync(join(original.dir, "unknown-owner-data"), "keep");
    expect(() => worktreeLease(home, wt)).toThrow("unreconciled lease");
    expect(readFileSync(lease, "utf8")).toBe(raw);
    expect(archives()).toEqual([]);
  });

  it("fails closed before acquiring when the current process identity is unknown", () => {
    identity.current.mockReturnValue(undefined);
    expect(() => worktreeLease(home, wt)).toThrow("unreconciled lease");
    expect(existsSync(leases)).toBe(false);
  });

  it("does not archive a replacement lease when another reclaimer wins", () => {
    staleLease();
    let winner: (() => void) | undefined;
    identity.alive.mockImplementationOnce(() => {
      // Another caller wins between our stale-owner read and our atomic claim.
      winner = worktreeLease(home, wt);
      return false;
    });
    expect(() => worktreeLease(home, wt)).toThrow("unreconciled lease");
    expect(existsSync(lease)).toBe(true);
    expect(archives()).toHaveLength(1);
    expect(() => worktreeLease(home, wt)).toThrow("unreconciled lease");
    winner!();
    expect(archives()).toHaveLength(2);
  });

  it("never releases a replacement after its original lease has been archived elsewhere", () => {
    const oldRelease = worktreeLease(home, wt);
    renameSync(lease, join(home, "saved-original-lease"));
    const release = worktreeLease(home, wt);
    oldRelease();
    expect(existsSync(lease)).toBe(true);
    expect(archives()).toEqual([]);
    release();
  });

  it.each(["lease", "archive", "parent"])("refuses a linked %s directory without touching its target", (kind) => {
    const outside = join(home, "external-owner");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "linked owner bytes");
    mkdirSync(leases, { recursive: true });
    if (kind === "archive") mkdirSync(registry(), { recursive: true });
    const target = kind === "lease" ? lease : kind === "archive" ? join(registry(), "archive") : join(home, "linked-home", "worktree-leases");
    if (kind === "parent") mkdirSync(join(home, "linked-home"));
    symlinkSync(outside, target, "junction");
    expect(() => worktreeLease(kind === "parent" ? join(home, "linked-home") : home, wt)).toThrow("unreconciled lease");
    expect(readdirSync(outside)).toEqual(["keep.txt"]);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("linked owner bytes");
  });
});
